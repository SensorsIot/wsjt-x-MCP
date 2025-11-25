import type { SliceState, DashboardConfig } from '../types';
import { StationRow } from './StationRow';

interface SlicePanelProps {
    slice: SliceState;
    config: DashboardConfig;
}

// Format frequency for display (Hz to MHz)
function formatDialFrequency(freqHz: number): string {
    if (freqHz === 0) return '?.??? MHz';
    const mhz = freqHz / 1_000_000;
    return `${mhz.toFixed(3)} MHz`;
}

export function SlicePanel({ slice, config }: SlicePanelProps) {
    const stationCount = slice.stations.length;
    const workedCount = slice.stations.filter(s => s.status === 'worked').length;
    const newCount = stationCount - workedCount;

    return (
        <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-lg overflow-hidden">
            {/* Header */}
            <div className="px-4 py-3 border-b border-gray-700 bg-gray-800/80">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        {/* Transmit indicator */}
                        <div
                            className={`w-3 h-3 rounded-full ${
                                slice.isTransmitting
                                    ? 'bg-red-500 animate-pulse'
                                    : slice.txEnabled
                                    ? 'bg-yellow-500'
                                    : 'bg-gray-600'
                            }`}
                            title={
                                slice.isTransmitting
                                    ? 'Transmitting'
                                    : slice.txEnabled
                                    ? 'TX Enabled'
                                    : 'TX Disabled'
                            }
                        />

                        {/* Band and mode */}
                        <div>
                            <h3 className="text-lg font-semibold text-blue-400">
                                {slice.band} {slice.mode}
                            </h3>
                            <p className="text-xs text-gray-400 font-mono">
                                {formatDialFrequency(slice.dialFrequency)}
                            </p>
                        </div>
                    </div>

                    {/* Station counts */}
                    <div className="flex items-center gap-3 text-sm">
                        <span className="text-gray-400">
                            <span className="text-green-400 font-semibold">{newCount}</span> new
                        </span>
                        <span className="text-gray-500">
                            <span className="text-gray-400">{workedCount}</span> wrkd
                        </span>
                    </div>
                </div>

                {/* Instance name */}
                <p className="text-xs text-gray-500 mt-1">
                    Instance: {slice.name}
                </p>
            </div>

            {/* Station list */}
            <div className="p-2 max-h-80 overflow-y-auto">
                {stationCount === 0 ? (
                    <div className="text-center py-8 text-gray-500">
                        <p>No stations decoded yet</p>
                        <p className="text-xs mt-1">Waiting for decodes...</p>
                    </div>
                ) : (
                    <div className="space-y-1">
                        {slice.stations.map((station) => (
                            <StationRow
                                key={station.callsign}
                                station={station}
                                config={config}
                            />
                        ))}
                    </div>
                )}
            </div>

            {/* Footer with stats */}
            {stationCount > 0 && (
                <div className="px-4 py-2 border-t border-gray-700 bg-gray-800/40 text-xs text-gray-500">
                    <div className="flex justify-between">
                        <span>
                            Total: {stationCount} station{stationCount !== 1 ? 's' : ''}
                        </span>
                        <span>
                            Lifetime: {config.stationLifetimeSeconds}s
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}
