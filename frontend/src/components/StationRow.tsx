import type { TrackedStation, StationStatus, DashboardConfig } from '../types';

interface StationRowProps {
    station: TrackedStation;
    config: DashboardConfig;
}

// Status labels for display
const STATUS_LABELS: Record<StationStatus, string> = {
    worked: 'WRKD',
    normal: '',
    weak: 'WEAK',
    strong: 'STRG',
    priority: 'PRIO',
    new_dxcc: 'NEW!',
};

// Format frequency for display (Hz to kHz offset)
function formatFrequency(freq: number): string {
    return freq.toString().padStart(4, ' ');
}

// Format time since last decode
function formatAge(lastSeen: number): string {
    const seconds = Math.floor((Date.now() - lastSeen) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m`;
}

// Format SNR with sign
function formatSnr(snr: number): string {
    const sign = snr >= 0 ? '+' : '';
    return `${sign}${snr}`.padStart(3, ' ');
}

export function StationRow({ station, config }: StationRowProps) {
    const statusColor = config.colors[station.status] || config.colors.normal;
    const statusLabel = STATUS_LABELS[station.status];
    const isWorked = station.status === 'worked';

    return (
        <div
            className={`flex items-center gap-2 px-2 py-1 rounded text-sm font-mono transition-colors ${
                isWorked ? 'opacity-50' : ''
            }`}
            style={{
                borderLeft: `3px solid ${statusColor}`,
                backgroundColor: `${statusColor}10`,
            }}
        >
            {/* Callsign */}
            <span
                className="w-24 font-semibold truncate"
                style={{ color: statusColor }}
                title={station.callsign}
            >
                {station.callsign}
            </span>

            {/* SNR */}
            <span
                className={`w-10 text-right ${
                    station.snr >= 0 ? 'text-green-400' : station.snr <= -15 ? 'text-yellow-400' : 'text-gray-300'
                }`}
                title="Signal-to-Noise Ratio"
            >
                {formatSnr(station.snr)}
            </span>

            {/* Frequency offset */}
            <span className="w-12 text-right text-gray-400" title="Audio frequency offset (Hz)">
                {formatFrequency(station.frequency)}
            </span>

            {/* Grid square */}
            <span className="w-14 text-gray-400" title="Grid square">
                {station.grid || '----'}
            </span>

            {/* Status badge */}
            {statusLabel && (
                <span
                    className="px-1.5 py-0.5 text-xs rounded font-bold"
                    style={{
                        backgroundColor: statusColor,
                        color: '#000',
                    }}
                >
                    {statusLabel}
                </span>
            )}

            {/* Age indicator */}
            <span className="w-8 text-right text-gray-500 text-xs" title="Time since last decode">
                {formatAge(station.lastSeen)}
            </span>

            {/* Decode count */}
            {station.decodeCount > 1 && (
                <span className="text-gray-500 text-xs" title="Number of decodes">
                    x{station.decodeCount}
                </span>
            )}
        </div>
    );
}
