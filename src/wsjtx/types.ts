// WSJT-X UDP Message Types (QQT encoding)
// Reference: https://sourceforge.net/p/wsjt/wsjtx/ci/master/tree/Network/NetworkMessage.hpp
export enum WsjtxMessageType {
    HEARTBEAT = 0,          // Out/In - heartbeat with version info
    STATUS = 1,             // Out - status update (frequency, mode, etc.)
    DECODE = 2,             // Out - decoded message
    CLEAR = 3,              // Out/In - clear decode windows
    REPLY = 4,              // In - reply to a CQ/QRZ
    QSO_LOGGED = 5,         // Out - QSO logged
    CLOSE = 6,              // Out/In - application closing
    REPLAY = 7,             // In - request decode replay
    HALT_TX = 8,            // In - halt transmission
    FREE_TEXT = 9,          // In - set free text message
    WSPR_DECODE = 10,       // Out - WSPR decode
    LOCATION = 11,          // In - set grid location
    LOGGED_ADIF = 12,       // Out - ADIF log entry / In - Rig Control Command
    RIG_CONTROL = 12,       // In - Rig control command (set frequency, mode, PTT)
    HIGHLIGHT_CALLSIGN = 13, // In - highlight a callsign
    SWITCH_CONFIGURATION = 14, // In - switch to named configuration
    CONFIGURE = 15,         // In - configure mode, frequency, etc.
}

export interface WsjtxDecode {
    id: string;
    newDecode: boolean;
    time: number;
    snr: number;
    deltaTime: number;
    deltaFrequency: number;
    mode: string;
    message: string;
    lowConfidence: boolean;
    offAir: boolean;
}

export interface WsjtxStatus {
    id: string;
    dialFrequency: number;
    mode: string;
    dxCall: string;
    report: string;
    txMode: string;
    txEnabled: boolean;
    transmitting: boolean;
    decoding: boolean;
    rxDF: number;
    txDF: number;
    deCall: string;
    deGrid: string;
    dxGrid: string;
    txWatchdog: boolean;
    subMode: string;
    fastMode: boolean;
    specialOpMode: number;
    frequencyTolerance: number;
    trPeriod: number;
    configurationName: string;
}

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

// WebSocket message types for frontend
export interface StationsUpdateMessage {
    type: 'STATIONS_UPDATE';
    slices: SliceState[];
    config: {
        stationLifetimeSeconds: number;
        colors: Record<StationStatus, string>;
    };
}
