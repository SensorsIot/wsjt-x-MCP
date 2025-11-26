import * as net from 'net';
import { EventEmitter } from 'events';

/**
 * TS-2000 CAT Server over TCP
 *
 * Provides CAT control for WSJT-X via TCP network connection.
 * WSJT-X connects as "Kenwood TS-2000" with "Network Server" mode.
 *
 * Per Rig-control.md spec:
 * - Port 60001 → Slice A
 * - Port 60002 → Slice B
 * - Port 60003 → Slice C
 * - Port 60004 → Slice D
 */

export interface SliceState {
    frequency: number;      // Hz
    mode: string;           // USB, LSB, DIGU, DIGL, CW, etc.
    tx: boolean;            // PTT state
}

// TS-2000 mode numbers to Flex mode names
const TS2000_TO_FLEX: Record<string, string> = {
    '1': 'LSB',
    '2': 'USB',
    '3': 'CW',
    '4': 'FM',
    '5': 'AM',
    '6': 'RTTY',
    '7': 'CW-R',
    '9': 'DIGU',
};

// Flex mode names to TS-2000 mode numbers
const FLEX_TO_TS2000: Record<string, string> = {
    'lsb': '1',
    'usb': '2',
    'cw': '3',
    'fm': '4',
    'am': '5',
    'rtty': '6',
    'cw-r': '7',
    'digu': '9',
    'digl': '6',
};

export class CatServer extends EventEmitter {
    private server: net.Server | null = null;
    private clients: Set<net.Socket> = new Set();
    private port: number;
    private sliceIndex: number;
    private state: SliceState;
    private buffers: Map<net.Socket, string> = new Map();
    private dataMode: boolean = false;

    constructor(port: number, sliceIndex: number, initialState?: Partial<SliceState>) {
        super();
        this.port = port;
        this.sliceIndex = sliceIndex;
        this.state = {
            frequency: initialState?.frequency ?? 14074000,
            mode: initialState?.mode ?? 'DIGU',
            tx: initialState?.tx ?? false
        };

        const mode = this.state.mode.toLowerCase();
        this.dataMode = mode === 'digu' || mode === 'digl';
    }

    public async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = net.createServer((socket) => {
                this.handleConnection(socket);
            });

            this.server.on('error', (err) => {
                console.error(`CAT[${this.port}] Server error:`, err.message);
                reject(err);
            });

            this.server.listen(this.port, '127.0.0.1', () => {
                console.log(`CAT Server for slice ${this.sliceIndex} listening on port ${this.port}`);
                resolve();
            });
        });
    }

    public stop(): void {
        for (const client of this.clients) {
            client.destroy();
        }
        this.clients.clear();
        this.buffers.clear();

        if (this.server) {
            this.server.close();
            this.server = null;
        }
        console.log(`CAT Server on port ${this.port} stopped`);
    }

    public updateState(state: Partial<SliceState>): void {
        if (state.frequency !== undefined) this.state.frequency = state.frequency;
        if (state.mode !== undefined) {
            this.state.mode = state.mode;
            const mode = state.mode.toLowerCase();
            this.dataMode = mode === 'digu' || mode === 'digl';
        }
        if (state.tx !== undefined) this.state.tx = state.tx;
    }

    private handleConnection(socket: net.Socket): void {
        console.log(`CAT[${this.port}] Client connected`);
        this.clients.add(socket);
        this.buffers.set(socket, '');

        socket.on('data', (data) => {
            let buffer = this.buffers.get(socket) || '';
            buffer += data.toString('ascii');

            let cmdEnd: number;
            while ((cmdEnd = buffer.indexOf(';')) !== -1) {
                const cmd = buffer.substring(0, cmdEnd);
                buffer = buffer.substring(cmdEnd + 1);
                if (cmd.length > 0) {
                    const response = this.processCommand(cmd);
                    if (response) {
                        socket.write(response);
                    }
                }
            }
            this.buffers.set(socket, buffer);
        });

        socket.on('close', () => {
            console.log(`CAT[${this.port}] Client disconnected`);
            this.clients.delete(socket);
            this.buffers.delete(socket);
        });

        socket.on('error', (err) => {
            console.error(`CAT[${this.port}] Client error:`, err.message);
            this.clients.delete(socket);
            this.buffers.delete(socket);
        });
    }

    private formatFrequency(freq: number): string {
        return freq.toString().padStart(11, '0');
    }

    private parseFrequency(freqStr: string): number {
        return parseInt(freqStr, 10);
    }

    private getModeNumber(): string {
        return FLEX_TO_TS2000[this.state.mode.toLowerCase()] ?? '2';
    }

    private getModeFromNumber(modeNum: string): string {
        return TS2000_TO_FLEX[modeNum] ?? 'USB';
    }

    private processCommand(cmd: string): string {
        const prefix = cmd.substring(0, 2).toUpperCase();
        const param = cmd.substring(2);

        switch (prefix) {
            case 'FA':
                if (param === '') {
                    return `FA${this.formatFrequency(this.state.frequency)};`;
                } else {
                    const freq = this.parseFrequency(param);
                    if (freq > 0) {
                        this.state.frequency = freq;
                        this.emit('frequency-change', this.sliceIndex, freq);
                    }
                }
                break;

            case 'FB':
                if (param === '') {
                    return `FB${this.formatFrequency(this.state.frequency)};`;
                } else {
                    const freq = this.parseFrequency(param);
                    if (freq > 0) {
                        this.state.frequency = freq;
                        this.emit('frequency-change', this.sliceIndex, freq);
                    }
                }
                break;

            case 'IF':
                const ifFreq = this.formatFrequency(this.state.frequency);
                const ifMode = this.getModeNumber();
                const ifTx = this.state.tx ? '1' : '0';
                return `IF${ifFreq}     +00000000${ifTx}${ifMode}0000  ;`;

            case 'MD':
                if (param === '') {
                    return `MD${this.getModeNumber()};`;
                } else {
                    let modeName = this.getModeFromNumber(param);
                    if (this.dataMode) {
                        if (param === '2') modeName = 'DIGU';
                        else if (param === '1') modeName = 'DIGL';
                    }
                    this.state.mode = modeName;
                    this.emit('mode-change', this.sliceIndex, modeName);
                }
                break;

            case 'TX':
                if (param === '') {
                    return `TX${this.state.tx ? '1' : '0'};`;
                } else {
                    const txOn = param !== '0';
                    this.state.tx = txOn;
                    this.emit('ptt-change', this.sliceIndex, txOn);
                }
                break;

            case 'RX':
                this.state.tx = false;
                this.emit('ptt-change', this.sliceIndex, false);
                break;

            case 'TQ':
                return `TQ${this.state.tx ? '1' : '0'};`;

            case 'ID':
                return 'ID019;';

            case 'PS':
                return 'PS1;';

            case 'AI':
                if (param === '') return 'AI0;';
                break;

            case 'SP':
                if (param === '') return 'SP0;';
                break;

            case 'FT':
                if (param === '') return 'FT0;';
                break;

            case 'FR':
                if (param === '') return 'FR0;';
                break;

            case 'SM':
                return 'SM00015;';

            case 'RS':
                return 'RS0;';

            case 'AG':
                return 'AG0128;';

            case 'NB':
                return 'NB0;';

            case 'NR':
                return 'NR0;';

            case 'RA':
                return 'RA00;';

            case 'PA':
                return 'PA0;';

            case 'RT':
                return 'RT0;';

            case 'XT':
                return 'XT0;';

            case 'AN':
                return 'AN1;';

            case 'FL':
                return 'FL1;';

            case 'FW':
                return 'FW0000;';

            case 'SH':
                return 'SH00;';

            case 'SL':
                return 'SL00;';

            case 'VX':
                return 'VX0;';
        }

        return '';
    }
}

/**
 * CAT Server Manager - manages TCP CAT servers for all slices
 */
export class CatServerManager extends EventEmitter {
    private servers: Map<number, CatServer> = new Map();
    private basePort: number;

    constructor(basePort: number = 60001) {
        super();
        this.basePort = basePort;
    }

    public getPort(sliceIndex: number): number {
        return this.basePort + sliceIndex;
    }

    public async startServer(sliceIndex: number, initialState?: Partial<SliceState>): Promise<CatServer> {
        const port = this.getPort(sliceIndex);

        if (this.servers.has(sliceIndex)) {
            console.log(`CAT server for slice ${sliceIndex} already running on port ${port}`);
            return this.servers.get(sliceIndex)!;
        }

        const server = new CatServer(port, sliceIndex, initialState);

        server.on('frequency-change', (slice, freq) => this.emit('frequency-change', slice, freq));
        server.on('mode-change', (slice, mode) => this.emit('mode-change', slice, mode));
        server.on('ptt-change', (slice, tx) => this.emit('ptt-change', slice, tx));

        await server.start();
        this.servers.set(sliceIndex, server);

        return server;
    }

    public stopServer(sliceIndex: number): void {
        const server = this.servers.get(sliceIndex);
        if (server) {
            server.stop();
            this.servers.delete(sliceIndex);
        }
    }

    public updateSliceState(sliceIndex: number, state: Partial<SliceState>): void {
        const server = this.servers.get(sliceIndex);
        if (server) {
            server.updateState(state);
        }
    }

    public getServer(sliceIndex: number): CatServer | undefined {
        return this.servers.get(sliceIndex);
    }

    public stopAll(): void {
        for (const server of this.servers.values()) {
            server.stop();
        }
        this.servers.clear();
    }
}
