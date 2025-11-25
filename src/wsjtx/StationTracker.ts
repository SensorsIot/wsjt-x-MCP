import { EventEmitter } from 'events';
import { Config } from '../config';
import { WsjtxDecode, WsjtxStatus, TrackedStation, SliceState, StationStatus } from './types';
import { AdifLogReader } from './AdifLogReader';

// Helper to extract callsign from WSJT-X message
function extractCallsign(message: string): string | null {
    // Common FT8/FT4 message patterns:
    // CQ DX W1ABC FN42
    // CQ W1ABC FN42
    // W1ABC DL2XYZ +05
    // DL2XYZ W1ABC R-12
    // W1ABC DL2XYZ RR73
    // 73 W1ABC DL2XYZ

    const parts = message.trim().split(/\s+/);

    // Skip CQ messages - extract the calling station
    if (parts[0] === 'CQ') {
        // CQ [DX/NA/EU/etc] CALLSIGN GRID
        if (parts.length >= 3) {
            // Check if second part is a CQ modifier (DX, NA, EU, etc.) or callsign
            const potentialCall = parts[1].length <= 3 ? parts[2] : parts[1];
            if (isValidCallsign(potentialCall)) {
                return potentialCall;
            }
        }
        return null;
    }

    // For other messages, first part is usually a callsign
    if (parts.length >= 1 && isValidCallsign(parts[0])) {
        return parts[0];
    }

    // Try second part
    if (parts.length >= 2 && isValidCallsign(parts[1])) {
        return parts[1];
    }

    return null;
}

// Helper to extract grid square from message
function extractGrid(message: string): string {
    const parts = message.trim().split(/\s+/);

    // Grid squares are 4-6 characters: AA00 to RR99 followed by optional aa-xx
    const gridPattern = /^[A-R]{2}[0-9]{2}([a-x]{2})?$/i;

    for (const part of parts) {
        if (gridPattern.test(part)) {
            return part.toUpperCase();
        }
    }

    return '';
}

// Simple callsign validation
function isValidCallsign(str: string): boolean {
    if (!str || str.length < 3 || str.length > 10) return false;

    // Basic callsign pattern: prefix (1-3 chars) + number + suffix (1-4 chars)
    // Also handles special prefixes like VK, ZL, etc.
    const callPattern = /^[A-Z0-9]{1,3}[0-9][A-Z]{1,4}(\/[A-Z0-9]+)?$/i;
    return callPattern.test(str);
}

// Helper to convert frequency to band
function frequencyToBand(freqHz: number): string {
    const freqMhz = freqHz / 1_000_000;

    if (freqMhz >= 1.8 && freqMhz < 2.0) return '160m';
    if (freqMhz >= 3.5 && freqMhz < 4.0) return '80m';
    if (freqMhz >= 5.3 && freqMhz < 5.5) return '60m';
    if (freqMhz >= 7.0 && freqMhz < 7.3) return '40m';
    if (freqMhz >= 10.1 && freqMhz < 10.15) return '30m';
    if (freqMhz >= 14.0 && freqMhz < 14.35) return '20m';
    if (freqMhz >= 18.068 && freqMhz < 18.168) return '17m';
    if (freqMhz >= 21.0 && freqMhz < 21.45) return '15m';
    if (freqMhz >= 24.89 && freqMhz < 24.99) return '12m';
    if (freqMhz >= 28.0 && freqMhz < 29.7) return '10m';
    if (freqMhz >= 50.0 && freqMhz < 54.0) return '6m';
    if (freqMhz >= 144.0 && freqMhz < 148.0) return '2m';
    if (freqMhz >= 420.0 && freqMhz < 450.0) return '70cm';

    return `${freqMhz.toFixed(3)} MHz`;
}

interface SliceData {
    id: string;
    name: string;
    mode: string;
    dialFrequency: number;
    isTransmitting: boolean;
    txEnabled: boolean;
    stations: Map<string, TrackedStation>;
}

export class StationTracker extends EventEmitter {
    private config: Config;
    private slices: Map<string, SliceData> = new Map();
    private adifReader: AdifLogReader;
    private cleanupInterval: NodeJS.Timeout | null = null;

    constructor(config: Config) {
        super();
        this.config = config;
        this.adifReader = new AdifLogReader(config.dashboard.adifLogPath);

        // Start periodic cleanup of expired stations
        this.startCleanup();
    }

    private startCleanup(): void {
        // Run cleanup every 10 seconds
        this.cleanupInterval = setInterval(() => {
            this.cleanupExpiredStations();
        }, 10000);
    }

    private cleanupExpiredStations(): void {
        const now = Date.now();
        const lifetimeMs = this.config.dashboard.stationLifetimeSeconds * 1000;
        let changed = false;

        for (const slice of this.slices.values()) {
            for (const [callsign, station] of slice.stations) {
                if (now - station.lastSeen > lifetimeMs) {
                    slice.stations.delete(callsign);
                    changed = true;
                }
            }
        }

        if (changed) {
            this.emitUpdate();
        }
    }

    public handleDecode(decode: WsjtxDecode): void {
        const callsign = extractCallsign(decode.message);
        if (!callsign) return;

        // Get or create slice data
        let slice = this.slices.get(decode.id);
        if (!slice) {
            slice = {
                id: decode.id,
                name: decode.id,
                mode: decode.mode,
                dialFrequency: 0,
                isTransmitting: false,
                txEnabled: false,
                stations: new Map(),
            };
            this.slices.set(decode.id, slice);
        }

        // Update mode from decode
        slice.mode = decode.mode;

        const now = Date.now();
        const existing = slice.stations.get(callsign);

        // Compute station status
        const status = this.computeStatus(callsign, decode.snr, slice.dialFrequency, slice.mode);

        if (existing) {
            // Update existing station
            existing.snr = decode.snr;
            existing.frequency = decode.deltaFrequency;
            existing.lastSeen = now;
            existing.decodeCount++;
            existing.status = status;
            existing.message = decode.message;

            const grid = extractGrid(decode.message);
            if (grid) {
                existing.grid = grid;
            }
        } else {
            // Add new station
            const station: TrackedStation = {
                callsign,
                grid: extractGrid(decode.message),
                snr: decode.snr,
                frequency: decode.deltaFrequency,
                mode: decode.mode,
                lastSeen: now,
                firstSeen: now,
                decodeCount: 1,
                status,
                message: decode.message,
            };
            slice.stations.set(callsign, station);
        }

        this.emitUpdate();
    }

    public handleStatus(status: WsjtxStatus): void {
        let slice = this.slices.get(status.id);
        if (!slice) {
            slice = {
                id: status.id,
                name: status.id,
                mode: status.mode,
                dialFrequency: status.dialFrequency,
                isTransmitting: status.transmitting,
                txEnabled: status.txEnabled,
                stations: new Map(),
            };
            this.slices.set(status.id, slice);
        } else {
            slice.mode = status.mode;
            slice.dialFrequency = status.dialFrequency;
            slice.isTransmitting = status.transmitting;
            slice.txEnabled = status.txEnabled;
        }

        // Re-compute status for all stations when frequency changes (band might change)
        for (const station of slice.stations.values()) {
            station.status = this.computeStatus(
                station.callsign,
                station.snr,
                slice.dialFrequency,
                slice.mode
            );
        }

        this.emitUpdate();
    }

    private computeStatus(callsign: string, snr: number, dialFrequency: number, mode: string): StationStatus {
        // Hierarchical status computation (highest priority first)

        // 1. Check if already worked (lowest display priority but checked first for "worked" status)
        const band = frequencyToBand(dialFrequency);
        if (this.adifReader.isWorked(callsign, band, mode)) {
            return 'worked';
        }

        // 2. Contest priority (placeholder - always false for now)
        // TODO: Implement contest rules engine
        // if (this.isContestPriority(callsign)) {
        //     return 'priority';
        // }

        // 3. New DXCC (placeholder - always false for now)
        // TODO: Implement DXCC lookup
        // if (this.isNewDxcc(callsign)) {
        //     return 'new_dxcc';
        // }

        // 4. Signal strength
        if (snr >= this.config.dashboard.snrStrongThreshold) {
            return 'strong';
        }
        if (snr <= this.config.dashboard.snrWeakThreshold) {
            return 'weak';
        }

        // 5. Default
        return 'normal';
    }

    public getSliceStates(): SliceState[] {
        const states: SliceState[] = [];

        for (const slice of this.slices.values()) {
            const stations = Array.from(slice.stations.values())
                .sort((a, b) => b.lastSeen - a.lastSeen); // Most recent first

            states.push({
                id: slice.id,
                name: slice.name,
                band: frequencyToBand(slice.dialFrequency),
                mode: slice.mode,
                dialFrequency: slice.dialFrequency,
                stations,
                isTransmitting: slice.isTransmitting,
                txEnabled: slice.txEnabled,
            });
        }

        return states;
    }

    private emitUpdate(): void {
        this.emit('update', this.getSliceStates());
    }

    public reloadAdifLog(): void {
        this.adifReader.reload();

        // Re-compute all station statuses
        for (const slice of this.slices.values()) {
            for (const station of slice.stations.values()) {
                station.status = this.computeStatus(
                    station.callsign,
                    station.snr,
                    slice.dialFrequency,
                    slice.mode
                );
            }
        }

        this.emitUpdate();
    }

    public updateConfig(config: Config): void {
        this.config = config;
        this.adifReader.setPath(config.dashboard.adifLogPath);
    }

    public stop(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
}
