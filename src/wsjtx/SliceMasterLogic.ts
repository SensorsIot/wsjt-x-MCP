import { EventEmitter } from 'events';
import { FlexSlice } from '../flex/Vita49Client';
import { ProcessManager } from './ProcessManager';
import { positionWsjtxWindows, calculateLayout } from './WindowManager';
import { configureWideGraph, configureRigForSmartCat, SMARTCAT_BASE_PORT } from './WsjtxConfig';
import { CatServerManager } from '../flex/CatServer';

// WSJT-X uses ~1.46 Hz per bin for FT8 (sample rate 12000 / 8192 FFT bins)
const HZ_PER_BIN = 1.4648;

export class SliceMasterLogic extends EventEmitter {
    private processManager: ProcessManager;
    private sliceToInstance: Map<string, string> = new Map();
    private smartCatHost: string;
    private catServerManager: CatServerManager;
    private sliceIndexMap: Map<string, number> = new Map(); // sliceId -> sliceIndex

    constructor(processManager: ProcessManager, smartCatHost: string = '127.0.0.1') {
        super();
        this.processManager = processManager;
        this.smartCatHost = smartCatHost;
        this.catServerManager = new CatServerManager(SMARTCAT_BASE_PORT);

        // Forward CAT events for frequency/mode changes from WSJT-X
        this.catServerManager.on('frequency-change', (sliceIndex, freq) => {
            console.log(`CAT: Slice ${sliceIndex} frequency change request: ${freq} Hz`);
            this.emit('cat-frequency-change', sliceIndex, freq);
        });
        this.catServerManager.on('mode-change', (sliceIndex, mode) => {
            console.log(`CAT: Slice ${sliceIndex} mode change request: ${mode}`);
            this.emit('cat-mode-change', sliceIndex, mode);
        });
        this.catServerManager.on('ptt-change', (sliceIndex, tx) => {
            console.log(`CAT: Slice ${sliceIndex} PTT: ${tx ? 'TX' : 'RX'}`);
            this.emit('cat-ptt-change', sliceIndex, tx);
        });
    }

    /**
     * Get the CAT server manager (for external integration)
     */
    public getCatServerManager(): CatServerManager {
        return this.catServerManager;
    }

    /**
     * Extract slice index from slice ID (e.g., "slice_0" -> 0)
     */
    private getSliceIndex(sliceId: string): number {
        const match = sliceId.match(/slice_(\d+)/);
        return match ? parseInt(match[1]) : 0;
    }

    /**
     * Get DAX channel for a slice (1-indexed, slice 0 = DAX 1)
     */
    private getDaxChannel(sliceIndex: number): number {
        return sliceIndex + 1;
    }

    /**
     * Get SmartCAT port for a slice
     */
    private getSmartCatPort(sliceIndex: number): number {
        return SMARTCAT_BASE_PORT + sliceIndex;
    }

    /**
     * Get slice letter from index (0=A, 1=B, etc.)
     */
    private getSliceLetter(sliceIndex: number): string {
        return String.fromCharCode(65 + sliceIndex); // 65 = 'A'
    }

    public async handleSliceAdded(slice: FlexSlice): Promise<void> {
        // Launch WSJT-X for ANY slice - WSJT-X will control the mode (set to DIGU)
        // The user doesn't need to pre-select digital mode; WSJT-X handles it

        if (this.sliceToInstance.has(slice.id)) {
            console.log(`Instance already exists for slice ${slice.id}`);
            return;
        }

        const sliceIndex = this.getSliceIndex(slice.id);
        const sliceLetter = this.getSliceLetter(sliceIndex);
        const daxChannel = slice.daxChannel || this.getDaxChannel(sliceIndex);
        const smartCatPort = this.getSmartCatPort(sliceIndex);

        // Generate instance name matching SliceMaster convention: "Slice-A", "Slice-B", etc.
        const instanceName = `Slice-${sliceLetter}`;
        const freqMHz = (slice.frequency / 1e6).toFixed(3);

        console.log(`\n=== Auto-launching WSJT-X for slice ${slice.id} ===`);
        console.log(`  Instance Name: ${instanceName}`);
        console.log(`  Slice Letter: ${sliceLetter}`);
        console.log(`  Frequency: ${freqMHz} MHz`);
        console.log(`  Mode: ${slice.mode}`);
        console.log(`  DAX Channel: ${daxChannel}`);
        console.log(`  SmartCAT Port: ${smartCatPort}`);
        console.log(`  SmartCAT Host: ${this.smartCatHost}`);

        // Start CAT server for this slice BEFORE launching WSJT-X
        try {
            await this.catServerManager.startServer(sliceIndex, {
                frequency: slice.frequency,
                mode: slice.mode,
                tx: false
            });
            this.sliceIndexMap.set(slice.id, sliceIndex);
        } catch (err) {
            console.error(`Failed to start CAT server for slice ${sliceIndex}:`, err);
            return;
        }

        // Calculate layout to get BinsPerPixel for 2500 Hz display
        const layout = calculateLayout({ sliceIndex });

        // Configure Wide Graph settings BEFORE launching WSJT-X
        // Calculate plotWidth for 2500 Hz display: plotWidth = targetHz / (binsPerPixel * HZ_PER_BIN)
        const targetFreqHz = 2500;
        const plotWidth = Math.ceil(targetFreqHz / (layout.binsPerPixel * HZ_PER_BIN));

        console.log(`  Configuring Wide Graph for ${targetFreqHz} Hz display...`);
        console.log(`  BinsPerPixel: ${layout.binsPerPixel}`);
        console.log(`  PlotWidth: ${plotWidth} pixels`);
        configureWideGraph(instanceName, {
            binsPerPixel: layout.binsPerPixel,
            startFreq: 0,
            hideControls: true,
            plotWidth: plotWidth,
        });

        // Configure Rig/CAT settings for SmartCAT
        configureRigForSmartCat(instanceName, {
            smartCatHost: this.smartCatHost,
            smartCatPort: smartCatPort,
            daxChannel: daxChannel,
        });

        try {
            this.processManager.startInstance({
                name: instanceName,
                rigName: instanceName,
                sliceIndex: sliceIndex,
                daxChannel: daxChannel,
                smartCatPort: smartCatPort,
                smartCatHost: this.smartCatHost,
            });

            this.sliceToInstance.set(slice.id, instanceName);
            this.emit('instance-launched', {
                sliceId: slice.id,
                instanceName,
                sliceLetter,
                daxChannel,
                smartCatPort
            });

            // Position windows after launch (async, don't block)
            positionWsjtxWindows(instanceName, sliceIndex).catch(err => {
                console.error(`Failed to position windows for ${instanceName}:`, err);
            });
        } catch (error) {
            console.error(`Failed to launch instance for slice ${slice.id}:`, error);
        }
    }

    public handleSliceRemoved(slice: FlexSlice): void {
        const instanceName = this.sliceToInstance.get(slice.id);
        if (!instanceName) {
            return;
        }

        console.log(`\n=== Stopping instance ${instanceName} for removed slice ${slice.id} ===`);

        // Stop CAT server for this slice
        const sliceIndex = this.sliceIndexMap.get(slice.id);
        if (sliceIndex !== undefined) {
            this.catServerManager.stopServer(sliceIndex);
            this.sliceIndexMap.delete(slice.id);
        }

        this.processManager.stopInstance(instanceName);
        this.sliceToInstance.delete(slice.id);
        this.emit('instance-stopped', { sliceId: slice.id, instanceName });
    }

    public handleSliceUpdated(slice: FlexSlice): void {
        const instanceName = this.sliceToInstance.get(slice.id);
        if (instanceName) {
            const freqMHz = (slice.frequency / 1e6).toFixed(3);
            console.log(`Slice ${slice.id} updated: ${freqMHz} MHz, ${slice.mode}`);

            // Update CAT server state so WSJT-X sees current frequency/mode
            const sliceIndex = this.sliceIndexMap.get(slice.id);
            if (sliceIndex !== undefined) {
                this.catServerManager.updateSliceState(sliceIndex, {
                    frequency: slice.frequency,
                    mode: slice.mode
                });
            }
        }
    }

    /**
     * Stop all CAT servers (call on shutdown)
     */
    public stopAllCatServers(): void {
        this.catServerManager.stopAll();
    }

    public getSliceMapping(): Map<string, string> {
        return new Map(this.sliceToInstance);
    }
}
