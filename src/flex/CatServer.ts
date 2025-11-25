import * as net from 'net';
import { EventEmitter } from 'events';

/**
 * CAT Server - Kenwood TS-2000 compatible CAT interface
 * Provides TCP server for WSJT-X to control FlexRadio slices
 */

export interface SliceState {
    frequency: number;      // Hz
    mode: string;           // USB, LSB, DIGU, DIGL, CW, etc.
    tx: boolean;            // PTT state
}

export class CatServer extends EventEmitter {
    private server: net.Server | null = null;
    private clients: Set<net.Socket> = new Set();
    private port: number;
    private sliceIndex: number;
    private state: SliceState;

    constructor(port: number, sliceIndex: number) {
        super();
        this.port = port;
        this.sliceIndex = sliceIndex;
        this.state = {
            frequency: 14074000,
            mode: 'DIGU',
            tx: false
        };
    }

    /**
     * Start the CAT server
     */
    public start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = net.createServer((socket) => {
                this.handleConnection(socket);
            });

            this.server.on('error', (err) => {
                console.error(`CAT Server error on port ${this.port}:`, err);
                reject(err);
            });

            this.server.listen(this.port, '127.0.0.1', () => {
                console.log(`CAT Server for slice ${this.sliceIndex} listening on port ${this.port}`);
                resolve();
            });
        });
    }

    /**
     * Stop the CAT server
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
        console.log(`CAT Server on port ${this.port} stopped`);
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
        console.log(`CAT client connected on port ${this.port}: ${clientAddr}`);
        this.clients.add(socket);

        let buffer = '';

        socket.on('data', (data) => {
            buffer += data.toString();

            // Process complete commands (terminated by ;)
            let cmdEnd: number;
            while ((cmdEnd = buffer.indexOf(';')) !== -1) {
                const cmd = buffer.substring(0, cmdEnd + 1);
                buffer = buffer.substring(cmdEnd + 1);
                this.processCommand(socket, cmd);
            }
        });

        socket.on('close', () => {
            console.log(`CAT client disconnected from port ${this.port}: ${clientAddr}`);
            this.clients.delete(socket);
        });

        socket.on('error', (err) => {
            console.error(`CAT client error on port ${this.port}:`, err.message);
            this.clients.delete(socket);
        });
    }

    /**
     * Process a Kenwood CAT command
     */
    private processCommand(socket: net.Socket, cmd: string): void {
        const cmdType = cmd.substring(0, 2);
        const cmdData = cmd.substring(2, cmd.length - 1); // Remove trailing ;

        // console.log(`CAT[${this.port}] << ${cmd}`);

        let response = '';

        switch (cmdType) {
            case 'FA': // VFO A frequency
                if (cmdData === '') {
                    // Query frequency
                    response = `FA${this.formatFrequency(this.state.frequency)};`;
                } else {
                    // Set frequency
                    const newFreq = parseInt(cmdData, 10);
                    if (!isNaN(newFreq)) {
                        this.state.frequency = newFreq;
                        this.emit('frequency-change', this.sliceIndex, newFreq);
                    }
                    // No response for set commands
                }
                break;

            case 'FB': // VFO B frequency (treat same as VFO A for simplex)
                if (cmdData === '') {
                    response = `FB${this.formatFrequency(this.state.frequency)};`;
                } else {
                    const newFreq = parseInt(cmdData, 10);
                    if (!isNaN(newFreq)) {
                        this.state.frequency = newFreq;
                        this.emit('frequency-change', this.sliceIndex, newFreq);
                    }
                }
                break;

            case 'IF': // Transceiver info (comprehensive status)
                response = this.buildIfResponse();
                break;

            case 'MD': // Mode
                if (cmdData === '') {
                    // Query mode
                    response = `MD${this.modeToKenwood(this.state.mode)};`;
                } else {
                    // Set mode
                    const newMode = this.kenwoodToMode(cmdData);
                    if (newMode) {
                        this.state.mode = newMode;
                        this.emit('mode-change', this.sliceIndex, newMode);
                    }
                }
                break;

            case 'TX': // Transmit
                this.state.tx = true;
                this.emit('ptt-change', this.sliceIndex, true);
                break;

            case 'RX': // Receive
                this.state.tx = false;
                this.emit('ptt-change', this.sliceIndex, false);
                break;

            case 'TQ': // TX state query
                response = `TQ${this.state.tx ? '1' : '0'};`;
                break;

            case 'AI': // Auto-information
                // Just acknowledge, we don't use auto-info
                if (cmdData === '') {
                    response = 'AI0;';
                }
                break;

            case 'ID': // Radio ID
                response = 'ID019;'; // TS-2000 ID
                break;

            case 'PS': // Power status
                response = 'PS1;'; // Power on
                break;

            case 'RS': // Reset - ignore
                break;

            case 'XT': // XIT
                if (cmdData === '') {
                    response = 'XT0;';
                }
                break;

            case 'RT': // RIT
                if (cmdData === '') {
                    response = 'RT0;';
                }
                break;

            case 'AN': // Antenna
                if (cmdData === '') {
                    response = 'AN1;';
                }
                break;

            case 'FR': // RX VFO select
            case 'FT': // TX VFO select
                if (cmdData === '') {
                    response = `${cmdType}0;`; // VFO A
                }
                break;

            case 'SH': // Filter high
            case 'SL': // Filter low
                if (cmdData === '') {
                    response = `${cmdType}00;`;
                }
                break;

            default:
                // Unknown command - log but don't respond
                console.log(`CAT[${this.port}] Unknown command: ${cmd}`);
                break;
        }

        if (response) {
            // console.log(`CAT[${this.port}] >> ${response}`);
            socket.write(response);
        }
    }

    /**
     * Format frequency as 11-digit string (Kenwood format)
     */
    private formatFrequency(freq: number): string {
        return freq.toString().padStart(11, '0');
    }

    /**
     * Build IF (transceiver info) response
     * Format: IFaaaaaaaaaaaoccccrrrrrttmmmvfbdRSeee;
     */
    private buildIfResponse(): string {
        const freq = this.formatFrequency(this.state.frequency);
        const mode = this.modeToKenwood(this.state.mode);
        const tx = this.state.tx ? '1' : '0';

        // IF response format for TS-2000:
        // P1: 11-digit frequency
        // P2: 5 spaces (step size, not used)
        // P3: RIT/XIT offset (+/-9999)
        // P4: RIT on/off
        // P5: XIT on/off
        // P6: Memory channel bank
        // P7: Memory channel
        // P8: TX/RX
        // P9: Mode
        // P10: VFO A/B
        // P11: Scan status
        // P12: Split
        // P13: CTCSS/DCS
        // P14: 2 spaces
        return `IF${freq}     +00000000${tx}${mode}0000000 ;`;
    }

    /**
     * Convert FlexRadio mode to Kenwood mode number
     */
    private modeToKenwood(mode: string): string {
        const modeMap: { [key: string]: string } = {
            'LSB': '1',
            'USB': '2',
            'CW': '3',
            'FM': '4',
            'AM': '5',
            'DIGL': '6',  // FSK
            'CWR': '7',
            'DIGU': '9',  // FSK-R (used for digital modes)
            'FMN': '4',   // FM Narrow
        };
        return modeMap[mode.toUpperCase()] || '2'; // Default to USB
    }

    /**
     * Convert Kenwood mode number to FlexRadio mode
     */
    private kenwoodToMode(modeNum: string): string | null {
        const modeMap: { [key: string]: string } = {
            '1': 'LSB',
            '2': 'USB',
            '3': 'CW',
            '4': 'FM',
            '5': 'AM',
            '6': 'DIGL',
            '7': 'CWR',
            '9': 'DIGU',
        };
        return modeMap[modeNum] || null;
    }
}

/**
 * CAT Server Manager - manages multiple CAT servers for multiple slices
 */
export class CatServerManager extends EventEmitter {
    private servers: Map<number, CatServer> = new Map();
    private basePort: number;

    constructor(basePort: number = 7831) {
        super();
        this.basePort = basePort;
    }

    /**
     * Start a CAT server for a specific slice
     */
    public async startServer(sliceIndex: number, initialState?: Partial<SliceState>): Promise<CatServer> {
        const port = this.basePort + sliceIndex;

        if (this.servers.has(sliceIndex)) {
            console.log(`CAT server for slice ${sliceIndex} already running on port ${port}`);
            return this.servers.get(sliceIndex)!;
        }

        const server = new CatServer(port, sliceIndex);

        if (initialState) {
            server.updateState(initialState);
        }

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
     * Stop a CAT server for a specific slice
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
    public getServer(sliceIndex: number): CatServer | undefined {
        return this.servers.get(sliceIndex);
    }

    /**
     * Stop all CAT servers
     */
    public stopAll(): void {
        for (const server of this.servers.values()) {
            server.stop();
        }
        this.servers.clear();
    }
}
