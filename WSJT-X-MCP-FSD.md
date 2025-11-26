# WSJT-X MCP Server - Functional Specification Document

## 1. Introduction
This document outlines the functional specifications for the WSJT-X Model Context Protocol (MCP) server. The system acts as a bridge between AI agents and multiple instances of WSJT-X software, enabling the agent to monitor radio traffic, analyze signals, and autonomously conduct QSOs on digital modes like FT8 and FT4.

## 2. Scope
The system provides:
- **Multi-Instance Support**: Launch and control multiple WSJT-X instances simultaneously
- **Friendly Addressing**: Identify instances by rig name or friendly identifiers
- **Live Monitoring**: Real-time stream of decoded messages and status updates from all instances
- **Autonomous QSO Execution**: Fire-and-forget QSO management with full state machine handling the complete exchange sequence
- **Dual Operation Modes**:
    - **FlexRadio Mode**: Dynamic "Slice Master" integration for SmartSDR
    - **Standard Mode**: Direct control for traditional rigs (default: IC-7300)
- **Web Dashboard**: Real-time monitoring and manual control interface

## 3. Architecture

### 3.1. System Components
- **Co-location Requirement**: MCP Server and all WSJT-X instances run on the same physical machine (Windows PC or Raspberry Pi). AI Agent can be remote.
- **MCP Server** (Node.js/TypeScript):
    - Manages WSJT-X process lifecycle (spawn/terminate)
    - Aggregates UDP traffic from localhost on port 2237
    - Implements QSO state machine for autonomous operation
    - Exposes MCP protocol via stdio transport
    - Hosts web dashboard on port 3000
- **WSJT-X Instances**: Multiple WSJT-X processes, each identified by `--rig-name` parameter
- **FlexRadio Integration** (Mode A only): Connects to SmartSDR via VITA 49 protocol
- **MCP Client**: AI agent (Claude, ChatGPT, Gemini) connecting via MCP protocol

### 3.2. Operation Modes

#### Mode A: FlexRadio (Advanced)
- Connects to FlexRadio via VITA 49 protocol (UDP port 4992)
- Monitors slice additions/removals/updates in real-time
- Automatically launches WSJT-X instance for each digital slice
- Automatically terminates WSJT-X when slice is removed
- Syncs frequency/mode configuration between SmartSDR and WSJT-X
- Managed by `SliceMasterLogic` component

#### Mode B: Standard (Basic)
- Default configuration for IC-7300 (configurable for other rigs)
- AI agent or user manually starts/stops WSJT-X instances via MCP tools
- Single instance operation (can manage multiple if manually configured)
- Fixed rig configuration per instance

### 3.3. Message Flow
```
AI Agent <--MCP/stdio--> McpServer
                           ↓
                      WsjtxManager
                      ↓         ↓
                UdpListener  ProcessManager
                      ↓         ↓
              QsoStateMachine  WSJT-X Process(es)
                      ↓         ↓
                  UdpSender ←---
```

## 4. Exposed Functionalities

### 4.1. Instance Management
- **List Instances**: View all running WSJT-X instances with name, UDP port, and running status
- **Start Instance** (Standard Mode only): Launch new WSJT-X process with specific rig configuration
- **Stop Instance**: Gracefully terminate a running WSJT-X instance

### 4.2. Monitoring & Decoding
- **Live Decodes**: Real-time stream of decoded messages including:
    - Message text
    - SNR (Signal-to-Noise Ratio)
    - Delta time
    - Delta frequency
    - Decode time
    - Instance ID
- **Status Updates**: Monitor operational state:
    - Current frequency (dial frequency in Hz)
    - Operating mode (FT8, FT4, etc.)
    - Transmit/Receive state
    - Configuration status
- **Heartbeat Monitoring**: Track instance health via periodic heartbeat messages

### 4.3. Operation & Automation

#### Execute Full QSO (Autonomous)
The system provides a complete autonomous QSO capability that manages the entire contact sequence:

**Functionality**: Fire-and-forget QSO execution. AI agent provides target callsign, own callsign, and grid locator. The server autonomously completes the QSO.

**State Machine Sequence**:
1. **IDLE**: Initial state
2. **CALLING_CQ**: Transmits "CQ [MYCALL] [MYGRID]"
3. **WAITING_REPLY**: Listens for station calling us (15-second timeout, max 3 retries)
4. **SENDING_REPORT**: Transmits "[THEIRCALL] [MYCALL] [REPORT]" (e.g., +15, -03)
5. **WAITING_REPORT**: Listens for their signal report (15-second timeout)
6. **SENDING_RR73**: Transmits "[THEIRCALL] [MYCALL] RR73"
7. **WAITING_73**: Listens for final 73 acknowledgment (15-second timeout)
8. **COMPLETE**: QSO successfully completed
9. **FAILED**: QSO failed (timeout, max retries exceeded)

**Error Handling**:
- Configurable timeout per state (default: 15 seconds, matching FT8 cycle)
- Configurable retry count (default: 3 attempts)
- Automatic failure on timeout or max retries
- Events emitted on completion/failure for AI awareness

**Message Parsing**:
- Regex-based pattern matching to identify callsigns and reports
- Auto-formats signal reports (SNR to +XX or -XX format)
- Validates message structure at each state transition

## 5. MCP Protocol Interface

### 5.1. MCP Tools
Tools exposed to AI agents via MCP protocol:

#### `start_instance`
**Parameters**:
- `name` (string, required): Friendly name for the instance
- `band` (string, optional): Target band (e.g., "20m", "40m")
- `rigName` (string, optional): Rig name configuration

**Behavior**:
- Only available in STANDARD mode (returns error in FLEX mode)
- Spawns new WSJT-X process with `--rig-name` parameter
- Auto-assigns UDP port starting from 2237

**Returns**: Success message or error

#### `stop_instance`
**Parameters**:
- `name` (string, required): Friendly name of instance to stop

**Behavior**:
- Sends SIGTERM to WSJT-X process
- Force kills with SIGKILL after 5-second timeout if needed
- Removes instance from active registry

**Returns**: Success or "Instance not found" error

#### `execute_qso`
**Parameters**:
- `instanceId` (string, required): Instance ID (rig name)
- `targetCallsign` (string, required): Target station callsign
- `myCallsign` (string, required): Your callsign
- `myGrid` (string, required): Your grid locator (e.g., "FN20")

**Behavior**:
- Creates new QsoStateMachine for the instance
- Fails if QSO already in progress for that instance
- Autonomously manages complete QSO sequence
- Emits events on completion/failure

**Returns**: Success message or error

### 5.2. MCP Resources
Resources exposed for AI agent queries:

#### `wsjt-x://instances`
**Type**: JSON list
**Content**: Array of instance objects containing:
- `name`: Instance friendly name
- `udpPort`: UDP port number
- `running`: Boolean status

**Use Case**: AI agent queries active instances before starting operations

### 5.3. Event Stream
The system emits events via WsjtxManager EventEmitter:
- `decode`: New decoded message from any instance
- `status`: Status update from any instance
- `qso-complete`: QSO successfully completed
- `qso-failed`: QSO failed (with reason)

## 6. WSJT-X Integration

### 6.1. UDP Protocol
- **Port**: 2237 (WSJT-X default)
- **Format**: Qt QDataStream (QQT encoding)
- **Magic Number**: 0xadbccbda
- **Schema Version**: 2

### 6.2. Message Types
Handled message types (defined in `src/wsjtx/types.ts`):
- **Heartbeat** (0): Instance health check
- **Status** (1): Operational status updates
- **Decode** (2): Decoded message data
- **Clear** (3): Clear decode window
- **Reply** (4): Reply to specific station (outgoing)
- **QSO Logged** (5): QSO logged to file
- **Close** (6): Instance closing
- **Replay** (7): Replay request
- **Halt Tx** (8): Stop transmission (outgoing)
- **Free Text** (9): Free text message (outgoing)
- **WSPR Decode** (10): WSPR-specific decode

### 6.3. Process Management
- **WSJT-X Path**: Default `C:\WSJT\wsjtx\bin\wsjtx.exe` (Windows), configurable
- **Instance Identification**: Uses `--rig-name` command-line parameter
- **Lifecycle**: Spawned via Node.js `child_process`, detached=false, stdio=ignore
- **Shutdown**: Graceful SIGTERM, force SIGKILL after 5 seconds

## 7. FlexRadio Integration

### 7.1. VITA 49 Protocol
- **Default Host**: 255.255.255.255 (broadcast discovery), configurable
- **Default Port**: 4992
- **Protocol**: VITA 49 packet format for SDR control

### 7.2. Slice Master Logic
- **Slice Detection**: Monitors `slice-added`, `slice-removed`, `slice-updated` events
- **Auto-Launch**: Creates WSJT-X instance when digital slice added
- **Auto-Terminate**: Stops WSJT-X instance when slice removed
- **Configuration Sync**: Updates WSJT-X when slice frequency/mode changes
- **Instance Mapping**: Maintains slice ID to WSJT-X instance mapping

## 8. Web Dashboard

### 8.1. Server Configuration
- **Framework**: Express 5.x
- **Port**: 3000 (configurable via environment)
- **WebSocket**: ws library for real-time updates
- **CORS**: Enabled for development

### 8.2. Frontend
- **Framework**: React 19 with TypeScript
- **Build Tool**: Vite 6.x
- **Styling**: Tailwind CSS v4 with PostCSS
- **Dev Server**: Hot module replacement via Vite

### 8.3. Features
- **Mission Control**: Unified view of all WSJT-X instances
- **Real-time Updates**: WebSocket-driven status updates
- **Live Decodes**: Streaming decode display
- **Manual Control**: Override AI actions when needed
- **Action Log**: System event history

## 9. Technical Implementation

### 9.1. Technology Stack
- **Runtime**: Node.js v18+
- **Language**: TypeScript (ES2022 target)
- **Module System**: CommonJS (backend), ESM (frontend)
- **MCP SDK**: @modelcontextprotocol/sdk v1.22+
- **Validation**: Zod v4.x for schema validation
- **Process Control**: Node.js child_process module

### 9.2. Configuration
Environment variables:
- `WSJTX_MODE`: "FLEX" or "STANDARD" (default: STANDARD)
- `FLEX_HOST`: FlexRadio host IP (default: 255.255.255.255)
- `RIG_NAME`: Standard mode rig name (default: IC-7300)
- `RIG_PORT`: Standard mode serial port (optional)

Configuration validated via Zod schemas in `src/config.ts`

### 9.3. State Management
- **EventEmitter Pattern**: All major components extend EventEmitter
- **Async/Await**: Promise-based async operations throughout
- **Error Handling**: Try-catch blocks with error propagation to AI agent
- **Timeout Management**: NodeJS.Timeout for state machine timeouts

### 9.4. Deployment
- **Development**: `npm install && npm start`
- **Production Build**: `npx tsc` to compile TypeScript
- **Output**: dist/ directory with CommonJS modules
- **Frontend Build**: `cd frontend && npm run build`
- **Single Binary**: pkg or bun compilation for standalone distribution

## 10. Additional MCP Tools

### `set_parameter`
**Parameters**:
- `name` (string, required): Instance name
- `parameter` (string, required): Parameter to set
- `value` (any, required): Parameter value

**Behavior**: Sets generic WSJT-X configuration parameters

**Returns**: Success message or error

### `call_cq`
**Parameters**:
- `name` (string, required): Instance name
- `message` (string, optional): Custom CQ message

**Behavior**: Initiates standalone CQ call sequence without full QSO automation

**Returns**: Success message or error

### `reply_to_station`
**Parameters**:
- `name` (string, required): Instance name
- `callsign` (string, required): Station callsign to reply to

**Behavior**: Sends direct reply to specific station without full QSO automation

**Returns**: Success message or error

### `halt_tx`
**Parameters**:
- `name` (string, required): Instance name

**Behavior**: Emergency stop of active transmission

**Returns**: Success message or error

### `set_frequency`
**Parameters**:
- `name` (string, required): Instance name
- `frequency` (number, required): Frequency in Hz

**Behavior**: Tunes radio to specified frequency

**Returns**: Success message or error

### `set_mode`
**Parameters**:
- `name` (string, required): Instance name
- `mode` (string, required): Operating mode (FT8, FT4, JT65, etc.)

**Behavior**: Switches WSJT-X operating mode

**Returns**: Success message or error

## 11. Additional MCP Resources

### `wsjt-x://{name}/decodes`
**Type**: JSON stream
**Content**: Real-time decoded messages for specific instance
**Use Case**: Monitor decode activity for single instance

### `wsjt-x://{name}/status`
**Type**: JSON object
**Content**: Current operational status for specific instance including frequency, mode, Tx/Rx state
**Use Case**: Query status of individual instance

### `wsjt-x://{name}/station-info`
**Type**: JSON object
**Content**: Station configuration including callsign and grid locator
**Use Case**: Retrieve station identification information

### `wsjt-x://{name}/config`
**Type**: JSON object
**Content**: Current WSJT-X configuration parameters
**Use Case**: Query instance configuration settings

## 12. Distribution

### Binary Packages
- **Windows x64**: Standalone executable for Windows systems
- **Raspberry Pi ARM64**: Optimized binary for Raspberry Pi deployment
- **Cross-platform**: npm package for any Node.js v18+ environment

### Packaging
- Single binary compilation using pkg or bun
- Embedded Node.js runtime
- No external dependencies required for binary distribution

## 13. Enhanced Features

### QSO State Machine
- Advanced error recovery with exponential backoff
- Configurable retry strategies per state
- Multiple QSO patterns (contest mode, casual mode, DX mode)
- Signal quality-based decision making

### Logging
- QSO logging to ADIF format
- System event logging to file
- Structured JSON logs for analysis
- Log rotation and archival

### Web Dashboard
- Configuration UI for system settings
- Real-time waterfall display integration
- QSO history viewer
- Statistics and analytics dashboard
- Multi-user access with authentication
