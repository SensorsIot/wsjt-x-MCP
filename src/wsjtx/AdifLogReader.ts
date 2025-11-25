import fs from 'fs';
import path from 'path';

interface WorkedEntry {
    callsign: string;
    band: string;
    mode: string;
    date: string;
}

export class AdifLogReader {
    private logPath: string;
    private workedStations: Map<string, WorkedEntry> = new Map();
    private lastModified: number = 0;
    private watchInterval: NodeJS.Timeout | null = null;

    constructor(logPath: string) {
        this.logPath = logPath;
        if (logPath) {
            this.load();
            this.startWatching();
        }
    }

    private startWatching(): void {
        // Check for file changes every 30 seconds
        this.watchInterval = setInterval(() => {
            this.checkForUpdates();
        }, 30000);
    }

    private checkForUpdates(): void {
        if (!this.logPath || !fs.existsSync(this.logPath)) return;

        try {
            const stats = fs.statSync(this.logPath);
            if (stats.mtimeMs > this.lastModified) {
                console.log('ADIF log file changed, reloading...');
                this.load();
            }
        } catch (error) {
            // Ignore errors during file check
        }
    }

    public setPath(logPath: string): void {
        this.logPath = logPath;
        this.workedStations.clear();
        this.lastModified = 0;

        if (logPath) {
            this.load();
        }
    }

    public reload(): void {
        this.workedStations.clear();
        this.lastModified = 0;
        if (this.logPath) {
            this.load();
        }
    }

    private load(): void {
        if (!this.logPath || !fs.existsSync(this.logPath)) {
            console.log(`ADIF log file not found: ${this.logPath}`);
            return;
        }

        try {
            const stats = fs.statSync(this.logPath);
            this.lastModified = stats.mtimeMs;

            const content = fs.readFileSync(this.logPath, 'utf-8');
            this.parseAdif(content);

            console.log(`Loaded ${this.workedStations.size} QSOs from ADIF log`);
        } catch (error) {
            console.error('Error loading ADIF log:', error);
        }
    }

    private parseAdif(content: string): void {
        // Skip header (everything before <eoh>)
        const headerEnd = content.toLowerCase().indexOf('<eoh>');
        const records = headerEnd >= 0 ? content.substring(headerEnd + 5) : content;

        // Split into QSO records (each ends with <eor>)
        const qsoPattern = /<eor>/gi;
        const qsos = records.split(qsoPattern);

        for (const qso of qsos) {
            if (!qso.trim()) continue;

            const entry = this.parseQsoRecord(qso);
            if (entry) {
                // Create composite key: callsign_band_mode
                const key = this.makeKey(entry.callsign, entry.band, entry.mode);
                this.workedStations.set(key, entry);
            }
        }
    }

    private parseQsoRecord(record: string): WorkedEntry | null {
        const fields = this.extractAdifFields(record);

        const callsign = fields['call']?.toUpperCase();
        if (!callsign) return null;

        const band = this.normalizeBand(fields['band'] || '');
        const mode = this.normalizeMode(fields['mode'] || '');
        const date = fields['qso_date'] || '';

        return { callsign, band, mode, date };
    }

    private extractAdifFields(record: string): Record<string, string> {
        const fields: Record<string, string> = {};

        // ADIF format: <FIELDNAME:LENGTH>VALUE or <FIELDNAME:LENGTH:TYPE>VALUE
        const fieldPattern = /<([A-Za-z_]+):(\d+)(?::[A-Za-z])?>/gi;
        let match;

        while ((match = fieldPattern.exec(record)) !== null) {
            const fieldName = match[1].toLowerCase();
            const length = parseInt(match[2], 10);
            const valueStart = match.index + match[0].length;
            const value = record.substring(valueStart, valueStart + length);
            fields[fieldName] = value;
        }

        return fields;
    }

    private normalizeBand(band: string): string {
        // Normalize band names (e.g., "20M" -> "20m", "20 m" -> "20m")
        return band.toLowerCase().replace(/\s+/g, '').replace('m', 'm');
    }

    private normalizeMode(mode: string): string {
        // Normalize mode names
        const normalized = mode.toUpperCase();

        // Map submodes to main modes for matching
        const modeMap: Record<string, string> = {
            'FT8': 'FT8',
            'FT4': 'FT4',
            'JT65': 'JT65',
            'JT9': 'JT9',
            'WSPR': 'WSPR',
            'MSK144': 'MSK144',
            'Q65': 'Q65',
            'FST4': 'FST4',
            'FST4W': 'FST4W',
        };

        return modeMap[normalized] || normalized;
    }

    private makeKey(callsign: string, band: string, mode: string): string {
        return `${callsign.toUpperCase()}_${band.toLowerCase()}_${mode.toUpperCase()}`;
    }

    public isWorked(callsign: string, band: string, mode: string): boolean {
        const key = this.makeKey(callsign, band, mode);
        return this.workedStations.has(key);
    }

    public isWorkedOnBand(callsign: string, band: string): boolean {
        // Check if callsign was worked on this band (any mode)
        const prefix = `${callsign.toUpperCase()}_${band.toLowerCase()}_`;
        for (const key of this.workedStations.keys()) {
            if (key.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    public isWorkedAnywhere(callsign: string): boolean {
        // Check if callsign was worked anywhere (any band, any mode)
        const prefix = `${callsign.toUpperCase()}_`;
        for (const key of this.workedStations.keys()) {
            if (key.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    public getWorkedCount(): number {
        return this.workedStations.size;
    }

    public stop(): void {
        if (this.watchInterval) {
            clearInterval(this.watchInterval);
            this.watchInterval = null;
        }
    }
}
