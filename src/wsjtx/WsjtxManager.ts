import { EventEmitter } from 'events';
import { Config } from '../config';
import { WsjtxUdpListener } from './UdpListener';
import { WsjtxDecode, WsjtxStatus, SliceState } from './types';
import { ProcessManager, WsjtxInstanceConfig } from './ProcessManager';
import { QsoStateMachine, QsoConfig } from './QsoStateMachine';
import { SliceMasterLogic } from './SliceMasterLogic';
import { StationTracker } from './StationTracker';

export class WsjtxManager extends EventEmitter {
    private config: Config;
    private instances: Map<string, any> = new Map();
    private udpListener: WsjtxUdpListener;
    private processManager: ProcessManager;
    private activeQsos: Map<string, QsoStateMachine> = new Map();
    private sliceMaster?: SliceMasterLogic;
    private stationTracker: StationTracker;

    constructor(config: Config) {
        super();
        this.config = config;
        this.udpListener = new WsjtxUdpListener(2237);
        this.processManager = new ProcessManager();
        this.stationTracker = new StationTracker(config);
        this.setupListeners();
    }

    private setupListeners() {
        this.udpListener.on('decode', (decode: WsjtxDecode) => {
            console.log(`[${decode.id}] Decode: ${decode.message} (SNR: ${decode.snr})`);

            // Forward to station tracker for dashboard
            this.stationTracker.handleDecode(decode);

            // Forward to active QSO state machines
            const qso = this.activeQsos.get(decode.id);
            if (qso) {
                qso.handleDecode(decode);
            }

            this.emit('decode', decode);
        });

        this.udpListener.on('status', (status: WsjtxStatus) => {
            console.log(`[${status.id}] Status: ${status.mode} @ ${status.dialFrequency} Hz`);

            // Forward to station tracker for dashboard
            this.stationTracker.handleStatus(status);

            this.emit('status', status);
        });

        this.udpListener.on('heartbeat', ({ id }: { id: string }) => {
            console.log(`[${id}] Heartbeat`);
        });

        this.processManager.on('instance-started', (instance) => {
            console.log(`Process manager: Instance ${instance.name} started`);
        });

        this.processManager.on('instance-stopped', (instance) => {
            console.log(`Process manager: Instance ${instance.name} stopped`);
        });

        // Forward station tracker updates
        this.stationTracker.on('update', (slices: SliceState[]) => {
            this.emit('stations-update', slices);
        });
    }

    public async start(): Promise<void> {
        if (this.config.mode === 'STANDARD') {
            console.log('Starting WSJT-X Manager in STANDARD mode.');
            // Auto-start a default instance for Standard mode
            this.startInstance({
                name: this.config.standard.rigName || 'IC-7300',
                rigName: this.config.standard.rigName,
            });
        } else {
            console.log('Starting WSJT-X Manager in FLEX mode.');
            // Slice Master will be initialized when FlexClient is connected
        }

        this.udpListener.start();
    }

    public setFlexClient(flexClient: any): void {
        // Initialize Slice Master logic for FlexRadio mode
        this.sliceMaster = new SliceMasterLogic(this.processManager);

        // Handle slice events from FlexRadio
        flexClient.on('slice-added', (slice: any) => {
            if (this.sliceMaster) {
                this.sliceMaster.handleSliceAdded(slice);
            }
        });

        flexClient.on('slice-removed', (slice: any) => {
            if (this.sliceMaster) {
                this.sliceMaster.handleSliceRemoved(slice);
            }
        });

        flexClient.on('slice-updated', (slice: any) => {
            if (this.sliceMaster) {
                this.sliceMaster.handleSliceUpdated(slice);
            }
        });

        // Handle CAT events from WSJT-X (via CatServer) -> send to FlexRadio
        this.sliceMaster.on('cat-frequency-change', (sliceIndex: number, freq: number) => {
            console.log(`Forwarding frequency change to FlexRadio: slice ${sliceIndex} -> ${freq} Hz`);
            flexClient.tuneSlice(sliceIndex, freq);
        });

        this.sliceMaster.on('cat-mode-change', (sliceIndex: number, mode: string) => {
            console.log(`Forwarding mode change to FlexRadio: slice ${sliceIndex} -> ${mode}`);
            flexClient.setSliceMode(sliceIndex, mode);
        });

        this.sliceMaster.on('cat-ptt-change', (sliceIndex: number, tx: boolean) => {
            console.log(`Forwarding PTT to FlexRadio: slice ${sliceIndex} -> ${tx ? 'TX' : 'RX'}`);
            flexClient.setSliceTx(sliceIndex, tx);
        });
    }

    public startInstance(config: WsjtxInstanceConfig): void {
        try {
            this.processManager.startInstance(config);
        } catch (error) {
            console.error('Failed to start instance:', error);
            throw error;
        }
    }

    public stopInstance(name: string): boolean {
        return this.processManager.stopInstance(name);
    }

    public executeQso(instanceId: string, targetCallsign: string, myCallsign: string, myGrid: string): void {
        if (this.activeQsos.has(instanceId)) {
            throw new Error(`QSO already in progress for instance ${instanceId}`);
        }

        const qsoConfig: QsoConfig = {
            instanceId,
            targetCallsign,
            myCallsign,
            myGrid,
        };

        const qso = new QsoStateMachine(qsoConfig);

        qso.on('complete', (result) => {
            console.log(`QSO completed: ${JSON.stringify(result)}`);
            this.activeQsos.delete(instanceId);
            this.emit('qso-complete', { instanceId, ...result });
        });

        qso.on('failed', (result) => {
            console.log(`QSO failed: ${JSON.stringify(result)}`);
            this.activeQsos.delete(instanceId);
            this.emit('qso-failed', { instanceId, ...result });
        });

        this.activeQsos.set(instanceId, qso);
        qso.start();
    }

    public getInstances(): any[] {
        return this.processManager.getAllInstances().map(instance => ({
            name: instance.name,
            udpPort: instance.udpPort,
            running: instance.isRunning(),
        }));
    }

    public getSliceStates(): SliceState[] {
        return this.stationTracker.getSliceStates();
    }

    public getStationTracker(): StationTracker {
        return this.stationTracker;
    }

    public reloadAdifLog(): void {
        this.stationTracker.reloadAdifLog();
    }

    public async stop(): Promise<void> {
        console.log('Stopping WSJT-X Manager...');

        // Abort all active QSOs
        for (const qso of this.activeQsos.values()) {
            qso.abort();
        }
        this.activeQsos.clear();

        // Stop CAT servers
        if (this.sliceMaster) {
            this.sliceMaster.stopAllCatServers();
        }

        this.stationTracker.stop();
        this.processManager.stopAll();
        this.udpListener.stop();
    }
}
