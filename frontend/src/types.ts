// Station status for dashboard coloring (hierarchical priority)
export type StationStatus = 'worked' | 'normal' | 'weak' | 'strong' | 'priority' | 'new_dxcc';

// Tracked station with all relevant data for dashboard display
export interface TrackedStation {
    callsign: string;
    grid: string;
    snr: number;
    frequency: number;        // Audio frequency offset (deltaFrequency)
    mode: string;
    lastSeen: number;         // Timestamp of last decode
    firstSeen: number;        // Timestamp of first decode in this session
    decodeCount: number;      // Number of decodes received
    status: StationStatus;    // Computed status for coloring
    message: string;          // Last decoded message
}

// Slice/Instance state for dashboard
export interface SliceState {
    id: string;               // Instance/slice ID
    name: string;             // Display name
    band: string;             // Band (e.g., "20m", "40m")
    mode: string;             // Operating mode (FT8, FT4, etc.)
    dialFrequency: number;    // Dial frequency in Hz
    stations: TrackedStation[];
    isTransmitting: boolean;
    txEnabled: boolean;
}

// Dashboard configuration from server
export interface DashboardConfig {
    stationLifetimeSeconds: number;
    colors: Record<StationStatus, string>;
}

// WebSocket message types
export interface StationsUpdateMessage {
    type: 'STATIONS_UPDATE';
    slices: SliceState[];
    config: DashboardConfig;
}

export interface WelcomeMessage {
    type: 'WELCOME';
    message: string;
}

export interface InstancesUpdateMessage {
    type: 'INSTANCES_UPDATE';
    instances: Array<{
        name: string;
        status: string;
        freq: string;
    }>;
}

export type WebSocketMessage = StationsUpdateMessage | WelcomeMessage | InstancesUpdateMessage;
