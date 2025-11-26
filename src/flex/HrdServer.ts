import * as net from 'net';
import { EventEmitter } from 'events';

/**
 * HRD Server - Ham Radio Deluxe protocol implementation
 * Provides TCP server for WSJT-X to control FlexRadio slices
 *
 * WSJT-X uses HRD protocol with:
 * - Binary message format: [4-byte length][UTF-16LE payload]
 * - Text protocol (older): commands terminated by \r
 *
 * Based on WSJT-X HRDTransceiver.cpp implementation
 */

// HRD protocol magic numbers (not used in message framing, but for identification)
const HRD_MAGIC_SEND = 0x1234ABCD;
const HRD_MAGIC_RECV = 0xABCD1234;

export interface SliceState {
    frequency: number;      // Hz
    mode: string;           // USB, LSB, DIGU, DIGL, CW, etc.
    tx: boolean;            // PTT state
}

export class HrdServer extends EventEmitter {
    private server: net.Server | null = null;
    private clients: Set<net.Socket> = new Set();
    private port: number;
    private sliceIndex: number;
    private state: SliceState;
    private radioName: string;
    private radioId: string;
    private useBinaryProtocol: boolean = false;  // Auto-detect based on first message

    constructor(port: number, sliceIndex: number, initialState?: Partial<SliceState>) {
        super();
        this.port = port;
        this.sliceIndex = sliceIndex;
        this.radioName = `FlexRadio~Slice~${String.fromCharCode(65 + sliceIndex)}`; // Slice A, B, C, D
        this.radioId = `slice_${sliceIndex}`;

        // Set initial state with provided values, using sensible defaults
        this.state = {
            frequency: initialState?.frequency ?? 14074000,
            mode: initialState?.mode ?? 'DIGU',
            tx: initialState?.tx ?? false
        };
        console.log(`HRD Server created for slice ${sliceIndex} with initial freq: ${this.state.frequency} Hz`);
    }

    /**
     * Start the HRD server
     */
    public start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = net.createServer((socket) => {
                this.handleConnection(socket);
            });

            this.server.on('error', (err) => {
                console.error(`HRD Server error on port ${this.port}:`, err);
                reject(err);
            });

            this.server.listen(this.port, '127.0.0.1', () => {
                console.log(`HRD Server for slice ${this.sliceIndex} listening on port ${this.port}`);
                resolve();
            });
        });
    }

    /**
     * Stop the HRD server
     */
    public stop(): void {
        for (const client of this.clients) {
            client.destroy();
        }
        this.clients.clear();

        if (this.server) {
            this.server.close();
            this.server = null;
        }
        console.log(`HRD Server on port ${this.port} stopped`);
    }

    /**
     * Update the slice state (called when FlexRadio reports changes)
     */
    public updateState(state: Partial<SliceState>): void {
        if (state.frequency !== undefined) this.state.frequency = state.frequency;
        if (state.mode !== undefined) this.state.mode = state.mode;
        if (state.tx !== undefined) this.state.tx = state.tx;
    }

    /**
     * Handle a new client connection
     */
    private handleConnection(socket: net.Socket): void {
        const clientAddr = `${socket.remoteAddress}:${socket.remotePort}`;
        console.log(`HRD client connected on port ${this.port}: ${clientAddr}`);
        this.clients.add(socket);

        let binaryBuffer = Buffer.alloc(0);
        let textBuffer = '';
        let protocolDetected = false;
        let isBinary = false;

        socket.on('data', (data) => {
            // Auto-detect protocol on first data
            if (!protocolDetected && data.length >= 4) {
                protocolDetected = true;
                // HRD binary protocol: [4-byte LE length][8-byte magic][4-byte seq][UTF-16LE command]
                // Magic numbers: 0xCDAB3412 0x3412CDAB (as bytes: cd ab 34 12 34 12 cd ab)
                const firstByte = data[0];
                const possibleLength = data.readUInt32LE(0);

                // Binary if bytes 4-8 contain the magic number
                if (data.length >= 8) {
                    const magic1 = data.readUInt32BE(4);
                    if (magic1 === 0xCDAB3412 || magic1 === 0x1234ABCD) {
                        isBinary = true;
                    }
                }

                // Or check if it looks like a binary length field
                if (!isBinary && possibleLength > 0 && possibleLength < 65536 && firstByte < 128) {
                    isBinary = true;
                }
            }

            if (isBinary) {
                // HRD Binary protocol (v5):
                // [4-byte LE total_length][8-byte magic][4-byte seq][UTF-16LE command]
                // total_length INCLUDES the 4-byte length field itself
                binaryBuffer = Buffer.concat([binaryBuffer, data]);

                while (binaryBuffer.length >= 4) {
                    const totalLen = binaryBuffer.readUInt32LE(0);

                    if (binaryBuffer.length < totalLen) {
                        break;  // Wait for more data
                    }

                    // Extract the message: payload starts after length field (byte 4)
                    const payload = binaryBuffer.subarray(4, totalLen);

                    // HRD binary format within payload: [8-byte magic][4-byte seq][UTF-16LE command]
                    let cmd = '';
                    if (payload.length > 12) {
                        // Skip magic (8 bytes) and sequence (4 bytes)
                        const commandPayload = payload.subarray(12);
                        cmd = commandPayload.toString('utf16le').replace(/\0/g, '').trim();
                    }

                    binaryBuffer = binaryBuffer.subarray(totalLen);

                    if (cmd.length > 0) {
                        this.processCommand(socket, cmd, true);
                    }
                }
            } else {
                // Text protocol: commands terminated by \r
                textBuffer += data.toString();

                let cmdEnd: number;
                while ((cmdEnd = textBuffer.indexOf('\r')) !== -1) {
                    const cmd = textBuffer.substring(0, cmdEnd);
                    textBuffer = textBuffer.substring(cmdEnd + 1);
                    if (cmd.length > 0) {
                        this.processCommand(socket, cmd, false);
                    }
                }
            }
        });

        socket.on('close', () => {
            console.log(`HRD client disconnected from port ${this.port}: ${clientAddr}`);
            this.clients.delete(socket);
        });

        socket.on('error', (err) => {
            console.error(`HRD client error on port ${this.port}:`, err.message);
            this.clients.delete(socket);
        });
    }

    /**
     * Send response in appropriate format
     */
    private sendResponse(socket: net.Socket, response: string, binary: boolean): void {
        if (binary) {
            // Binary format: [4-byte LE total_length][8-byte magic][4-byte seq][UTF-16LE payload]
            // total_length includes the 4-byte length field itself
            // Magic for response: 0x3412CDAB 0xCDAB3412 (reverse of request)
            const textPayload = Buffer.from(response + '\0', 'utf16le');  // Null-terminated UTF-16LE

            // Calculate total message length (including the 4-byte length field)
            const totalLen = 4 + 8 + 4 + textPayload.length;  // length + magic + seq + text

            // Build the full message
            const fullMsg = Buffer.alloc(totalLen);
            fullMsg.writeUInt32LE(totalLen, 0);              // Total length (includes this field)
            fullMsg.writeUInt32BE(0x3412CDAB, 4);            // Magic 1 (reversed from request)
            fullMsg.writeUInt32BE(0xCDAB3412, 8);            // Magic 2 (reversed from request)
            fullMsg.writeUInt32LE(0, 12);                     // Sequence (0)
            textPayload.copy(fullMsg, 16);

            socket.write(fullMsg);
        } else {
            // Text format: response + \r
            socket.write(response + '\r');
        }
    }

    /**
     * Process an HRD protocol command
     */
    private processCommand(socket: net.Socket, cmd: string, binary: boolean = false): void {

        // Parse command - commands may have prefixed context like "[radioId] command"
        let command = cmd.trim();

        // Strip radio ID prefix if present (e.g., "[slice_0] get frequency")
        if (command.startsWith('[')) {
            const endBracket = command.indexOf(']');
            if (endBracket > 0) {
                command = command.substring(endBracket + 1).trim();
            }
        }

        let response = '';

        // Handle different HRD commands
        if (command === 'get context') {
            // Return context identifier
            response = this.radioId;
        }
        else if (command === 'get id') {
            response = this.radioId;
        }
        else if (command === 'get version') {
            response = '1.0.0';
        }
        else if (command === 'get radios') {
            // Return list of available radios: "id:name"
            response = `${this.radioId}:${this.radioName}`;
        }
        else if (command === 'get radio') {
            response = this.radioName;
        }
        else if (command === 'get vfo-count') {
            response = '1';
        }
        else if (command === 'get buttons') {
            // Return available buttons
            response = 'TX,Split';
        }
        else if (command === 'get dropdowns') {
            // Return available dropdowns
            response = 'Mode,Band';
        }
        else if (command.startsWith('get dropdown-list ')) {
            const name = command.substring(18).replace(/[{}]/g, '');
            if (name.toLowerCase() === 'mode') {
                response = 'USB,LSB,CW,DIGU,DIGL,AM,FM';
            } else if (name.toLowerCase() === 'band') {
                response = '160m,80m,60m,40m,30m,20m,17m,15m,12m,10m,6m';
            } else {
                response = '';
            }
        }
        else if (command.startsWith('get dropdown-text ')) {
            const name = command.substring(18).replace(/[{}]/g, '');
            if (name.toLowerCase() === 'mode') {
                response = `Mode: ${this.state.mode}`;
            } else if (name.toLowerCase() === 'band') {
                response = `Band: ${this.getBandFromFrequency(this.state.frequency)}`;
            } else {
                response = `${name}: Unknown`;
            }
        }
        else if (command === 'get frequency') {
            response = this.state.frequency.toString();
        }
        else if (command === 'get frequencies') {
            // Return both VFO frequencies separated by hyphen
            response = `${this.state.frequency}-${this.state.frequency}`;
        }
        else if (command.startsWith('set frequency-hz ')) {
            const freq = parseInt(command.substring(17), 10);
            if (!isNaN(freq)) {
                this.state.frequency = freq;
                this.emit('frequency-change', this.sliceIndex, freq);
                response = 'OK';
            } else {
                response = 'ERROR';
            }
        }
        else if (command.startsWith('set frequencies-hz ')) {
            const parts = command.substring(19).split(' ');
            const freq = parseInt(parts[0], 10);
            if (!isNaN(freq)) {
                this.state.frequency = freq;
                this.emit('frequency-change', this.sliceIndex, freq);
                response = 'OK';
            } else {
                response = 'ERROR';
            }
        }
        else if (command.startsWith('get button-select ')) {
            const name = command.substring(18).replace(/~/g, ' ');
            if (name.toLowerCase() === 'tx') {
                response = this.state.tx ? '1' : '0';
            } else if (name.toLowerCase() === 'split') {
                response = '0';
            } else {
                response = '0';
            }
        }
        else if (command.startsWith('set button-select ')) {
            const parts = command.substring(18).split(' ');
            const name = parts[0].replace(/~/g, ' ');
            const value = parts[1];

            if (name.toLowerCase() === 'tx') {
                this.state.tx = value === '1';
                this.emit('ptt-change', this.sliceIndex, this.state.tx);
                response = 'OK';
            } else if (name.toLowerCase() === 'split') {
                // Acknowledge but don't do anything
                response = 'OK';
            } else {
                response = 'OK';
            }
        }
        else if (command.startsWith('set dropdown ')) {
            const parts = command.substring(13).split(' ');
            const name = parts[0];
            const value = parts[1];

            if (name.toLowerCase() === 'mode') {
                this.state.mode = value;
                this.emit('mode-change', this.sliceIndex, value);
                response = 'OK';
            } else {
                response = 'OK';
            }
        }
        else if (command === 'get sliders') {
            response = '';
        }
        else {
            // Unknown command - return empty
            response = '';
        }

        if (response !== '') {
            this.sendResponse(socket, response, binary);
        }
    }

    /**
     * Get band name from frequency
     */
    private getBandFromFrequency(freq: number): string {
        const freqMHz = freq / 1000000;
        if (freqMHz >= 1.8 && freqMHz < 2) return '160m';
        if (freqMHz >= 3.5 && freqMHz < 4) return '80m';
        if (freqMHz >= 5.3 && freqMHz < 5.5) return '60m';
        if (freqMHz >= 7 && freqMHz < 7.3) return '40m';
        if (freqMHz >= 10.1 && freqMHz < 10.15) return '30m';
        if (freqMHz >= 14 && freqMHz < 14.35) return '20m';
        if (freqMHz >= 18.068 && freqMHz < 18.168) return '17m';
        if (freqMHz >= 21 && freqMHz < 21.45) return '15m';
        if (freqMHz >= 24.89 && freqMHz < 24.99) return '12m';
        if (freqMHz >= 28 && freqMHz < 29.7) return '10m';
        if (freqMHz >= 50 && freqMHz < 54) return '6m';
        return 'Unknown';
    }
}

/**
 * HRD Server Manager - manages multiple HRD servers for multiple slices
 */
export class HrdServerManager extends EventEmitter {
    private servers: Map<number, HrdServer> = new Map();
    private basePort: number;

    constructor(basePort: number = 7831) {
        super();
        this.basePort = basePort;
    }

    /**
     * Start an HRD server for a specific slice
     */
    public async startServer(sliceIndex: number, initialState?: Partial<SliceState>): Promise<HrdServer> {
        const port = this.basePort + sliceIndex;

        if (this.servers.has(sliceIndex)) {
            console.log(`HRD server for slice ${sliceIndex} already running on port ${port}`);
            return this.servers.get(sliceIndex)!;
        }

        const server = new HrdServer(port, sliceIndex, initialState);

        // Forward events
        server.on('frequency-change', (slice, freq) => {
            this.emit('frequency-change', slice, freq);
        });
        server.on('mode-change', (slice, mode) => {
            this.emit('mode-change', slice, mode);
        });
        server.on('ptt-change', (slice, tx) => {
            this.emit('ptt-change', slice, tx);
        });

        await server.start();
        this.servers.set(sliceIndex, server);

        return server;
    }

    /**
     * Stop an HRD server for a specific slice
     */
    public stopServer(sliceIndex: number): void {
        const server = this.servers.get(sliceIndex);
        if (server) {
            server.stop();
            this.servers.delete(sliceIndex);
        }
    }

    /**
     * Update state for a specific slice
     */
    public updateSliceState(sliceIndex: number, state: Partial<SliceState>): void {
        const server = this.servers.get(sliceIndex);
        if (server) {
            server.updateState(state);
        }
    }

    /**
     * Get server for a slice
     */
    public getServer(sliceIndex: number): HrdServer | undefined {
        return this.servers.get(sliceIndex);
    }

    /**
     * Stop all HRD servers
     */
    public stopAll(): void {
        for (const server of this.servers.values()) {
            server.stop();
        }
        this.servers.clear();
    }
}
