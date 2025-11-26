import { EventEmitter } from 'events';
import { Config } from '../config';
import { WsjtxUdpListener } from './UdpListener';
import { UdpSender } from './UdpSender';
import { WsjtxDecode, WsjtxStatus, SliceState } from './types';
import { ProcessManager, WsjtxInstanceConfig } from './ProcessManager';
import { QsoStateMachine, QsoConfig } from './QsoStateMachine';
import { SliceMasterLogic } from './SliceMasterLogic';
import { StationTracker } from './StationTracker';

export class WsjtxManager extends EventEmitter {
    private config: Config;
    private instances: Map<string, any> = new Map();
    private udpListener: WsjtxUdpListener;
    private udpSender: UdpSender;
    private processManager: ProcessManager;
    private activeQsos: Map<string, QsoStateMachine> = new Map();
    private sliceMaster?: SliceMasterLogic;
    private stationTracker: StationTracker;

    constructor(config: Config) {
        super();
        this.config = config;
        this.udpListener = new WsjtxUdpListener(2237);
        this.udpSender = new UdpSender(2237);
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
        // Pass station config (callsign, grid) for WSJT-X INI configuration
        this.sliceMaster = new SliceMasterLogic(
            this.processManager,
            undefined, // use default HRD CAT base port
            {
                callsign: this.config.station.callsign,
                grid: this.config.station.grid,
            }
        );

        // Handle slice events from FlexRadio
        flexClient.on('slice-added', (slice: any) => {
            // Auto-tune slice to default band frequency if configured
            const defaultBands = this.config.flex.defaultBands;
            if (defaultBands && slice.id) {
                // Extract slice index from ID (e.g., "slice_0" -> 0)
                const match = slice.id.match(/slice_(\d+)/);
                if (match) {
                    const sliceIndex = parseInt(match[1]);
                    if (sliceIndex < defaultBands.length) {
                        const targetFreq = defaultBands[sliceIndex];
                        const freqMHz = (targetFreq / 1e6).toFixed(3);
                        console.log(`Auto-tuning slice ${sliceIndex} to ${freqMHz} MHz (default band)`);

                        // Tune to FT8 frequency and set DIGU mode
                        flexClient.tuneSlice(sliceIndex, targetFreq);
                        flexClient.setSliceMode(sliceIndex, 'DIGU');
                    }
                }
            }

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

        // Handle instance launch - HRD CAT server provides initial frequency
        // No need to send UDP frequency command since WSJT-X gets it from HRD CAT
        this.sliceMaster.on('instance-launched', (data: {
            sliceId: string;
            instanceName: string;
            sliceLetter: string;
            daxChannel: number;
            catPort: number;
            frequency: number;
            udpPort: number;
        }) => {
            console.log(`Instance ${data.instanceName} launched for slice ${data.sliceId}`);
            console.log(`  HRD CAT server on port ${data.catPort} will provide frequency ${(data.frequency / 1e6).toFixed(3)} MHz`);
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

    // === WSJT-X UDP Control Methods ===

    /**
     * Configure WSJT-X instance mode and settings
     * Note: This cannot change dial frequency - only CAT/SmartSDR can do that
     */
    public configureInstance(
        instanceId: string,
        options: {
            mode?: string;           // e.g., "FT8", "FT4"
            frequencyTolerance?: number;
            submode?: string;
            fastMode?: boolean;
            trPeriod?: number;       // T/R period in seconds
            rxDF?: number;           // RX audio frequency offset
            dxCall?: string;
            dxGrid?: string;
            generateMessages?: boolean;
        }
    ): void {
        this.udpSender.sendConfigure(instanceId, options);
    }

    /**
     * Switch WSJT-X to a named configuration profile
     * This can effectively change bands if the profile has different frequency settings
     */
    public switchConfiguration(instanceId: string, configurationName: string): void {
        this.udpSender.sendSwitchConfiguration(instanceId, configurationName);
    }

    /**
     * Clear decode windows in WSJT-X
     * window: 0 = Band Activity, 1 = Rx Frequency, 2 = Both
     */
    public clearDecodes(instanceId: string, window: 0 | 1 | 2 = 2): void {
        this.udpSender.sendClear(instanceId, window);
    }

    /**
     * Set the station's Maidenhead grid location
     */
    public setLocation(instanceId: string, grid: string): void {
        this.udpSender.sendLocation(instanceId, grid);
    }

    /**
     * Highlight a callsign in the WSJT-X band activity window
     */
    public highlightCallsign(
        instanceId: string,
        callsign: string,
        backgroundColor: { r: number; g: number; b: number; a?: number },
        foregroundColor: { r: number; g: number; b: number; a?: number },
        highlightLast: boolean = true
    ): void {
        this.udpSender.sendHighlightCallsign(instanceId, callsign, backgroundColor, foregroundColor, highlightLast);
    }

    /**
     * Halt TX in WSJT-X
     */
    public haltTx(instanceId: string, autoTxOnly: boolean = true): void {
        this.udpSender.sendHaltTx(instanceId, autoTxOnly);
    }

    /**
     * Set free text message in WSJT-X
     */
    public setFreeText(instanceId: string, text: string, send: boolean = false): void {
        this.udpSender.sendFreeText(instanceId, text, send);
    }

    /**
     * Reply to a station (simulate double-click on decode)
     */
    public replyToStation(
        instanceId: string,
        time: number,
        snr: number,
        deltaTime: number,
        deltaFrequency: number,
        mode: string,
        message: string
    ): void {
        this.udpSender.sendReply(instanceId, time, snr, deltaTime, deltaFrequency, mode, message);
    }

    /**
     * Set dial frequency in WSJT-X (Rig Control Command)
     * This will tune WSJT-X to the specified frequency, which will then
     * command the radio via CAT. Band changes automatically if frequency
     * is on a different band.
     *
     * @param instanceId - Instance ID (rig name)
     * @param frequencyHz - Dial frequency in Hz (e.g., 14074000 for 20m FT8)
     * @param mode - Optional mode to set (e.g., "USB", "DIGU")
     */
    public setFrequency(instanceId: string, frequencyHz: number, mode?: string): void {
        this.udpSender.sendSetFrequency(instanceId, frequencyHz, mode);
    }

    public async stop(): Promise<void> {
        console.log('Stopping WSJT-X Manager...');

        // Abort all active QSOs
        for (const qso of this.activeQsos.values()) {
            qso.abort();
        }
        this.activeQsos.clear();

        // Stop HRD CAT servers
        if (this.sliceMaster) {
            this.sliceMaster.stopAll();
        }

        this.stationTracker.stop();
        this.processManager.stopAll();
        this.udpListener.stop();
    }
}
