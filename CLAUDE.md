# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

### Backend (MCP Server)
```bash
# Install dependencies
npm install

# Build TypeScript
npx tsc

# Run the server
npm start
# or
node dist/index.js

# For development with ts-node
npx ts-node src/index.ts
```

### Frontend (Web Dashboard)
```bash
cd frontend

# Install dependencies
npm install

# Development server (hot reload)
npm run dev

# Build for production
npm run build

# Lint
npm run lint

# Preview production build
npm run preview
```

## Configuration

The server uses environment variables for configuration:

- `WSJTX_MODE`: Set to `FLEX` for FlexRadio mode, defaults to `STANDARD`
- `FLEX_HOST`: FlexRadio host address (default: broadcast discovery at 255.255.255.255)
- `RIG_NAME`: Standard rig name (default: `IC-7300`)
- `RIG_PORT`: Standard rig port (e.g., `COM3`)

Configuration is validated using Zod schemas in `src/config.ts`.

## Architecture

### Operation Modes

Two operation modes configured via `src/config.ts`:
- **STANDARD Mode** (Default): Uses `ProcessManager` for manual instance management
- **FLEX Mode**: Uses `SliceMasterLogic` (src/wsjtx/SliceMasterLogic.ts) for dynamic instance management

### Core Components

**Entry Point** (`src/index.ts`):
- Initializes FlexClient, WsjtxManager, WsjtxMcpServer, and WebServer
- Handles mode-specific startup logic
- Manages graceful shutdown

**WSJT-X Process Management** (`src/wsjtx/`):
- `ProcessManager.ts`: Child process spawning and lifecycle
- `UdpListener.ts`: UDP port 2237 listener, parses incoming WSJT-X messages
- `UdpSender.ts`: UDP sender, encodes outgoing WSJT-X commands
- `WsjtxManager.ts`: Top-level orchestrator, EventEmitter for decode/status events

**QSO State Machine** (`src/wsjtx/QsoStateMachine.ts`):
- State machine with transitions: IDLE → CALLING_CQ → WAITING_REPLY → SENDING_REPORT → WAITING_REPORT → SENDING_RR73 → WAITING_73 → COMPLETE
- EventEmitter for state changes, completion, and failure

**FlexRadio Integration** (`src/flex/`):
- `FlexClient.ts`: High-level wrapper, EventEmitter for slice events
- `Vita49Client.ts`: VITA 49 protocol implementation
- `SliceMasterLogic.ts`: Handles slice-to-instance mapping

**MCP Server** (`src/mcp/McpServer.ts`):
- Tools: `start_instance`, `stop_instance`, `execute_qso`
- Resources: `wsjt-x://instances`
- Transport: stdio (StdioServerTransport)

**Web Dashboard** (`src/web/server.ts`):
- Express server on port 3000
- WebSocket support
- Serves React frontend from `frontend/dist/`

### Message Flow

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

### WSJT-X UDP Protocol

The server communicates with WSJT-X via UDP on port 2237 using Qt QDataStream format:
- Magic number: `0xadbccbda`
- Schema version: 2
- Message types defined in `src/wsjtx/types.ts`
- Parsing in `UdpListener.ts`, encoding in `UdpSender.ts`

## Key Implementation Details

### Process Management
- Instance identification: `--rig-name` command-line flag
- Default WSJT-X path: `C:\WSJT\wsjtx\bin\wsjtx.exe` (Windows)
- UDP port assignment: auto-increments from 2237
- Shutdown: SIGTERM with 5-second timeout before SIGKILL

### QSO State Machine
- State timeout: 15 seconds (configurable)
- Max retries: 3 (configurable)
- Uses regex for message pattern matching
- Signal report formatting: `+XX` or `-XX`

## TypeScript Configuration

- Target: ES2022
- Module: CommonJS (backend), ESM (frontend)
- Strict mode enabled
- Output directory: `dist/` (backend)

## Dependencies

Key dependencies:
- `@modelcontextprotocol/sdk`: MCP protocol implementation
- `zod`: Runtime schema validation
- `express` + `ws`: Web server and WebSocket support
- `react` + `vite`: Frontend framework and build tool
- `tailwindcss`: Frontend styling (v4 with PostCSS)

## Frontend Structure

- Built with React 19 + TypeScript + Vite
- Tailwind CSS v4 for styling (PostCSS configuration in `postcss.config.js`)
- Main components in `frontend/src/`
- ESLint configured with React-specific rules

## Development Notes

- WSJT-X must be installed and accessible at the configured path
- UDP port 2237 must be available for WSJT-X communication
- For FlexRadio mode, SmartSDR must be running and discoverable
- The MCP server communicates via stdio (not HTTP)
- Web dashboard runs independently on port 3000
