# MCP for wsjt-x
Multi-Slice Rig, Decode, and Logging Control Framework  
Functional Specification Document (FSD) – Code-Ready Version

This document defines a complete architecture and specification for a **Multi‑Slice Control Platform (MCP)** designed to let an AI:

- Select the **best available contact** across up to **4 slices/bands**.
- Set and **lock the transmitting frequency**.
- Command WSJT‑X to **call**, **complete a QSO**, and **log it**.
- Maintain its **own logbook** and keep an **external logger** (e.g. Log4OM) in sync.
- Start and supervise **one WSJT‑X instance per slice**.
- Avoid calling stations already worked on the **same band & mode** (FT8 / FT4).
- Operate mainly on **Windows**, later portable to **Linux/x86 and Raspberry Pi**.

MCP acts as a **single point of contact** for:

- WSJT‑X instances  
- The FlexRadio (SmartSDR v4.x API)  
- External logbook software (e.g. Log4OM)

The specification is written so that an AI can implement MCP without needing external documentation.

The system is TCP/UDP based. **No serial port emulation (COM ports) is used.**

---

# 1. Core Purpose

MCP is a daemon/service that:

1. Controls up to **4 Flex slices** (A–D), each representing a **channel**.
2. Launches and manages **4 WSJT‑X instances**, one per channel.
3. Aggregates **all decodes** from all WSJT‑X instances.
4. Lets an AI choose which station to call and on which band, while MCP selects and manages the appropriate slice internally.
5. Commands WSJT‑X (via rig control and, later, WSJT‑X UDP) to **TX / RX**.
6. Logs QSOs in a **local ADIF logbook** and **forwards enriched QSOs** to an external logger.
7. Ensures that **already-worked stations** (per band/mode) are not called again unless explicitly allowed.

MCP is designed as the **control brain**; WSJT‑X, Flex, and Log4OM become **I/O devices** from the AI’s perspective.

---

# 2. High-Level Architecture

                                         ┌─────────────────────────────┐
                                         │           AI / LLM          │
                                         │   (Tools / REST → MCP)      │
                                         └──────────────▲──────────────┘
                                                        │
                                                        │
                                                        ▼
    
      ┌──────────────────────────────────────────────────────────────────────────┐
      │                                   MCP                                    │
      │                 Multi-Slice Control Platform (Central Hub)               │
      │                                                                          │
      │   • Flex Backend (SmartSDR v4.x)                                         │
      │   • Channel Manager (Slices A–D)                                         │
      │   • WSJT-X Launcher + INI Builder                                        │
      │   • HRD Servers (4 WSJT-X + 1 Logger)                                    │
      │   • UDP Decode Aggregator                                                │
      │   • WorkedIndex / Duplicate Detector                                     │
      │   • ADIF Logbook Writer                                                  │
      │   • MCP / REST interface for LLM tools                                   │
      └───────────────▲──────────────────────────────────────────────▲──────────┘
                      │                                              │
                      │ HRD TCP + UDP                                │ Flex API
                      │                                              │
                      │                                              │
    
     ┌────────────────┴─────────────┐                    ┌────────────┴────────────────┐
     │           WSJT-X A           │                    │        Flex Slice A         │
     │    (Instance for Slice A)    │◀──────────────────▶│    (Freq / Mode / PTT)      │
     └──────────────────────────────┘                    └──────────────────────────────┘
    
     ┌──────────────────────────────┐                    ┌──────────────────────────────┐
     │           WSJT-X B           │                    │        Flex Slice B         │
     │    (Instance for Slice B)    │◀──────────────────▶│    (Freq / Mode / PTT)      │
     └──────────────────────────────┘                    └──────────────────────────────┘
    
     ┌──────────────────────────────┐                    ┌──────────────────────────────┐
     │           WSJT-X C           │                    │        Flex Slice C         │
     │    (Instance for Slice C)    │◀──────────────────▶│    (Freq / Mode / PTT)      │
     └──────────────────────────────┘                    └──────────────────────────────┘
    
     ┌──────────────────────────────┐                    ┌──────────────────────────────┐
     │           WSJT-X D           │                    │        Flex Slice D         │
     │    (Instance for Slice D)    │◀──────────────────▶│    (Freq / Mode / PTT)      │
     └──────────────────────────────┘                    └──────────────────────────────┘
     
     
     
     
     


                      ┌───────────────────────────┐
                      │         Logger            │
                      │        (Log4OM)           │
                      │  • HRD rig via MCP        │
                      │  • Imports ADIF from MCP  │
                      └───────────────────────────┘

---

# 3. Channels and Slices

MCP operates on **channels**. A channel is an abstraction over a **Flex slice** or, in the future, another radio’s VFO.

For v3:

- Support **exactly 4 channels:** indices 0–3, mapped to Flex slices A–D.
- Each channel may run one WSJT‑X instance.

### 3.1 Channel State Object

Each channel has a state object (language-agnostic struct):

```jsonc
ChannelState {
  id: string,            // "A", "B", "C", "D"
  index: number,         // 0–3
  freq_hz: number,       // current dial frequency in Hz
  mode: "FT8" | "FT4" | "DIGU" | "USB" | "LSB" | "CW" | "FM" | string,
  is_tx: boolean,        // true if this is TX slice
  dax_rx: number | null, // DAX RX channel number
  dax_tx: number | null, // DAX TX channel (global)
  wsjtx_udp_port: number,// UDP port WSJT‑X instance uses
  hrd_port: number,      // HRD TCP port for this channel
  status: "idle" | "decoding" | "calling" | "in_qso" | "error",
  last_decode_time: string | null // ISO8601
}
```

The MCP maintains:

```jsonc
McpState {
  channels: ChannelState[],
  flex_connected: boolean,
  wsjtx_instances: WsjtxInstanceState[],
  logbook: LogbookIndex,
  config: McpConfig
}
```

---

# 4. Rig Control Protocol (HRD TCP)

WSJT‑X and the logger both control the radio **only via MCP’s HRD TCP server(s)**.

## 4.1 HRD Connections

- **Per-channel HRD servers**: one port per WSJT‑X instance.
- **One main HRD server**: for the external logger (Log4OM).

All HRD servers share the same **command grammar** and **case-insensitive** parsing.

## 4.2 Command Grammar

Commands are ASCII lines, terminated by **CRLF** (`\r\n`). MCP must accept both `\n` and `\r\n` for robustness.

All commands and keywords are **case-insensitive**; arguments (numbers) are decimal.

### Supported commands (minimal set)

From clients (WSJT‑X, Logger):

- `get frequency`  
- `set frequency <Hz>`  
- `get mode`  
- `set mode <MODE>`  
- `get ptt`  
- `set ptt on`  
- `set ptt off`  

### Responses

- For `get` commands: plain value + CRLF, then `RPRT 0` + CRLF. Example:

  ```text
  7074000
  RPRT 0
  ```

- For successful `set` commands: `RPRT 0` + CRLF.

- For unsupported/invalid commands: `RPRT -1` + CRLF.

Error codes for internal failures (Flex not connected, etc.): `RPRT -9` (generic backend error).

## 4.3 Unsolicited Updates

To keep WSJT‑X and the logger synchronized with Flex when frequencies/modes change via other means, MCP MAY send **unsolicited updates**:

```text
frequency <Hz>\r\n
mode <MODE>\r\n
ptt <on|off>\r\n
```

These are sent when:

- Channel dial frequency changes due to AI actions.
- Flex slice changes frequency or mode outside MCP (if monitored).
- PTT state changes.

The unsolicited updates do **not** modify SmartSDR UI directly; they just reflect Flex slice state.

---

# 5. Flex Backend (SmartSDR v4.x)

The Flex backend is the only component that talks directly to the Flex radio.

## 5.1 Assumptions

- Flex SmartSDR **v4.x** compatible protocol.  
- MCP uses the official TCP/WebSocket API.  
- MCP may auto-discover the radio via UDP, or a fixed IP can be configured.

## 5.2 Flex Backend Interface

Internally, MCP code must expose an interface similar to:

```ts
interface FlexBackend {
  connect(host: string): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  getSlices(): Promise<FlexSliceState[]>;

  ensureFourSlicesOnBands(bands: string[]): Promise<void>;
  setSliceFrequency(index: number, freq_hz: number): Promise<void>;
  setSliceMode(index: number, mode: string): Promise<void>;
  setTxSlice(index: number): Promise<void>;

  onSliceUpdated(callback: (sliceIndex: number, state: FlexSliceState) => void): void;
  onConnectionLost(callback: () => void): void;
}
```

- `ensureFourSlicesOnBands` creates/configures up to 4 slices (A–D) on **different bands**, as configured or by default (e.g., 80/40/20/10m FT8).
- MCP must only control **slices**; panadapters and other UI aspects are considered out of scope for v3, except what’s strictly necessary to operate slices.

## 5.3 Connection & Recovery

- On startup, MCP attempts to connect to the Flex radio (IP from config or discovery).  
- On disconnection, MCP retries with exponential backoff (e.g., 1s, 2s, 4s … up to 60s, then stays at 60s).  
- During Flex disconnect:
  - HRD commands return `RPRT -9`.  
  - Status API reflects `flex_connected = false`.

---

# 6. WSJT‑X Instance Management & INI Generation

MCP must manage **up to 4 WSJT‑X processes** – one per active channel.

## 6.1 Lifecycle

- On MCP startup:
  1. Connect to Flex.
  2. Ensure 4 slices on configured/default bands.
  3. For each channel:
     - Generate/patch WSJT‑X INI.
     - Launch WSJT‑X with `--rig-name=<channel-id>`.
- When MCP settings change (via UI):
  - MCP writes updated config to JSON.
  - MCP **gracefully stops all WSJT‑X instances**, regenerates INIs, and relaunches them.

- If a WSJT‑X instance crashes:
  - MCP restarts it up to N times (configurable, e.g. N=5) with a small delay.

## 6.2 INI Management (Summary)

MCP uses the INI logic already defined in the integrated configuration spec:

- Maintains a `base_template.ini`.  
- For each rig-name (e.g., `SliceA`), MCP:
  - Ensures the target folder exists.  
  - Copies `base_template.ini` → `WSJT-X - SliceA.ini` if missing.  
  - Reads existing INI and overwrites **only** critical sections:

    - `[General]`: callsign, grid.  
    - `[Radio]`: Rig = HRD, NetworkServer = MCP HRD port, PTT = CAT.  
    - `[Audio]`: DAX input/output names.  
    - `[Configuration]`: UDP server & port.

- WSJT‑X is allowed to change **UI-related settings** (colors, window layout), which MCP preserves on next launch using a **read-modify-write** approach.

The MCP is the **source of truth** for radio/audio/network settings.

## 6.3 Audio Device Resolution

On Windows, MCP must:

- Enumerate audio devices.  
- For each channel, find the device whose name best matches `DAX Audio RX {n}` (or a configurable pattern).  
- Use exact device name strings in `[Audio]` section.  
- If no matching DAX device is found, log a warning and still launch WSJT‑X with a placeholder value.

---

# 7. Decode Aggregation Module

Each WSJT‑X instance broadcasts UDP packets on a dedicated port:

- Channel 0 / Slice A → 2237  
- Channel 1 / Slice B → 2238  
- Channel 2 / Slice C → 2239  
- Channel 3 / Slice D → 2240  

Ports may be auto-assigned with this pattern and stored in config.

## 7.1 Supported WSJT‑X Messages

For v3, MCP must support at least these WSJT‑X UDP message types:

- **Decode** (new decoded message)  
- **Status** (current dial, mode, etc.)  
- **QSO Logged / LoggedContact** (QSO completed)

Messages are parsed from the WSJT‑X standard binary UDP format.

## 7.2 Decode Representation

For each decode, MCP produces an internal record with enriched metadata. This internal representation includes channel/slice information for routing and all fields needed to construct the MCP-facing `DecodeRecord` (see Chapter 11).

```typescript
InternalDecodeRecord {
  // Internal routing fields (not exposed to MCP clients)
  channel_index: number,         // 0–3
  slice_id: string,              // "A".."D"

  // Core decode data
  timestamp: string,             // ISO8601 UTC
  band: string,                  // e.g. "20m", "40m"
  mode: string,                  // e.g. "FT8", "FT4"
  dial_hz: number,               // WSJT-X dial frequency in Hz
  audio_offset_hz: number,       // Audio offset (DF) in Hz
  rf_hz: number,                 // RF frequency (dial_hz + audio_offset_hz)
  snr_db: number,                // SNR in dB
  dt_sec: number,                // Timing offset in seconds
  call: string,                  // Decoded primary callsign (non-null after filtering)
  grid: string | null,           // Maidenhead locator or null
  is_cq: boolean,                // True if this is a CQ-type message
  is_my_call: boolean,           // True if message is addressed to our callsign
  raw_text: string,              // Raw WSJT-X decoded message text

  // Enriched CQ targeting fields (computed by §7.3)
  is_directed_cq_to_me: boolean, // True if station is allowed to answer
  cq_target_token: string | null,// CQ target keyword ("DX", "NA", etc.) or null

  // Optional WSJT-X flags
  is_new?: boolean,              // WSJT-X "new" flag
  low_confidence?: boolean,      // WSJT-X lowConfidence flag
  off_air?: boolean              // WSJT-X offAir flag
}
```

**Note:** The MCP-facing `DecodeRecord` (exposed via `wsjt-x://decodes` in Chapter 11) is derived from this by:
- Dropping `channel_index` and `slice_id` (internal routing details)
- Adding a unique `id` field for client-side referencing
- Filtering out records where `call` is null

## 7.3 CQ Target Enrichment (Server-Side Logic)

The MCP server enriches each decode with CQ targeting information to enable intelligent station selection by AI agents. This logic is implemented server-side and clients MUST NOT reimplement it.

### 7.3.1 Station Profile

Station configuration that MCP uses to evaluate CQ targets. Values come from MCP settings (callsign, grid, DXCC info, etc.).

```typescript
type StationProfile = {
  my_call: string;          // e.g. "HB9BLA"
  my_continent: string;     // "EU", "NA", "SA", "AF", "AS", "OC", "AN"
  my_dxcc: string;          // e.g. "HB9"
  my_prefixes: string[];    // all known prefixes that map to this station
  // optional: CQ zone, ITU zone, custom regions, etc.
};
```

### 7.3.2 CQ Target Token Extraction

Parse a CQ message and extract the CQ target token, if any.

**Examples:**
- `"CQ HB9XYZ JN36"` → `null`
- `"CQ DX HB9XYZ JN36"` → `"DX"`
- `"CQ NA W1ABC FN31"` → `"NA"`
- `"CQ EU DL1ABC JO62"` → `"EU"`
- `"CQ JA JA1XYZ PM95"` → `"JA"`

**Implementation:**
```typescript
function extractCqTargetToken(raw_text: string): string | null {
  // Very simple parsing strategy (can be extended as needed):
  // 1. Must start with "CQ " (case-insensitive, trimmed).
  // 2. Split on whitespace.
  // 3. Tokens[0] = "CQ"
  // 4. Tokens[1]:
  //    - if it looks like a region keyword (DX, NA, EU, SA, AS, AF, OC, JA, ...),
  //      return that token uppercased.
  //    - otherwise, treat it as part of the callsign and return null.
  const text = raw_text.trim().toUpperCase();
  if (!text.startsWith("CQ ")) return null;

  const tokens = text.split(/\s+/);
  if (tokens.length < 2) return null;

  const t1 = tokens[1]; // token after "CQ"

  const REGION_KEYWORDS = new Set([
    "DX", "NA", "SA", "EU", "AS", "AF", "OC", "JA"
    // can be extended with e.g. "ASIA", "EUROPE" if needed
  ]);

  if (REGION_KEYWORDS.has(t1)) {
    return t1;
  }

  // Otherwise treat tokens[1] as a callsign -> no explicit CQ target token.
  return null;
}
```

### 7.3.3 CQ Targeting Rules

Decide if this station is allowed to answer a given CQ message. This function encapsulates all rules that convert the raw CQ target token + station location into `is_directed_cq_to_me`.

**Implementation:**
```typescript
function isDirectedCqToMe(
  snapshotStation: StationProfile,
  cq_target_token: string | null
): boolean {
  // No explicit target token => general CQ => always allowed.
  if (cq_target_token === null) return true;

  const continent = snapshotStation.my_continent.toUpperCase();

  switch (cq_target_token) {
    case "DX":
      // "CQ DX" means "stations that are DX to me", i.e., not in the caller's
      // own DXCC/region. The strict, symmetric version would require the
      // caller's DXCC. For a first implementation, we can approximate DX by
      // "not in the caller's continent" if that information is available.
      //
      // Since we don't have the caller's profile here, MCP may implement
      // CQ DX logic as a simple station-level policy. For many operators it's
      // acceptable to consider everyone "eligible" for CQ DX, or allow users
      // to configure this policy.
      //
      // Minimal safe default: treat CQ DX as allowed for all stations.
      return true;

    case "NA":
      return continent === "NA";
    case "SA":
      return continent === "SA";
    case "EU":
      return continent === "EU";
    case "AS":
      return continent === "AS";
    case "AF":
      return continent === "AF";
    case "OC":
      return continent === "OC";
    case "JA":
      // For JA you can either:
      //  - require my_dxcc / prefix to be JA,
      //  - or a mapping "JA" -> continent "AS" AND prefix starts with "JA", "JR", "7J", etc.
      return snapshotStation.my_dxcc.toUpperCase().startsWith("JA");

    default:
      // Unknown or unsupported CQ target token:
      // Conservative approach: do NOT answer.
      return false;
  }
}
```

### 7.3.4 Integration into DecodeRecord Construction

Given a raw WSJT-X decode and the station profile, MCP does:

```typescript
const cq_target_token = extractCqTargetToken(raw_text);
const is_directed_cq_to_me = isDirectedCqToMe(stationProfile, cq_target_token);
```

and then fills:

```typescript
record.cq_target_token = cq_target_token;
record.is_directed_cq_to_me = is_directed_cq_to_me;
```

**Important:** If the message is not a CQ at all (`is_cq = false`), MCP MUST set:
```typescript
cq_target_token = null;
is_directed_cq_to_me = false;    // only CQ messages can be "directed to me"
```

The enriched `InternalDecodeRecord` objects are collected into a `DecodesSnapshot` object (assigning each record a unique `id` and removing internal routing fields), which is then exposed via the `wsjt-x://decodes` resource and embedded in `resources/updated` events (see Chapter 11).

## 7.4 Storage & Lifetime

- MCP maintains an **in-memory ring buffer per channel**, storing decodes from a **configurable time window** (e.g., last 15 minutes).
- The actual implementation may use:
  - Time-based eviction (drop records older than `config.decode_history_minutes`).

No persistent storage for decodes is required in v3.

## 7.5 Duplicate Detection

MCP must be able to answer: *“Have we already worked CALL on BAND and MODE?”*

- MCP maintains a **LogbookIndex** with entries:

```jsonc
WorkedIndexEntry {
  call: string,
  band: string,  // "20m"
  mode: string,  // "FT8", "FT4"
  last_qso_time: string // ISO8601
}
```

- Before proposing or initiating a call, MCP (or the AI via tools) can query this index.  
- MCP updates this index on each successfully logged QSO (see QSO Relay).

---

# 8. QSO Relay & Internal Logbook

MCP becomes the **single QSO hub** for WSJT‑X and external loggers.

## 8.1 QSO Ingestion

When WSJT‑X logs a QSO (via UDP QSO Logged / LoggedContact), MCP:

1. Identifies the channel (via source UDP port).  
2. Reads the current channel state (freq, mode, band).  
3. Combines WSJT‑X QSO info (call, grid, report, time) with Flex state.  
4. Produces a **QsoRecord**:

```jsonc
QsoRecord {
  timestamp_start: string, // from WSJT-X or approximated
  timestamp_end: string,
  call: string,
  grid: string | null,
  band: string,
  freq_hz: number,
  mode: string,          // FT8/FT4 primarily
  rst_sent: string | null,
  rst_recv: string | null,
  tx_power_w: number | null,
  slice_id: string,
  channel_index: number,
  wsjtx_instance: string,
  notes: string | null
}
```

5. Appends this QSO to a **local ADIF log file** (single unified file for all slices, e.g. `mcp_logbook.adi`).  
6. Updates the **WorkedIndex** for duplicate detection.

## 8.2 External Logbook Forwarding

To feed external loggers (e.g. Log4OM), MCP supports:

1. **ADIF File Feed (primary)**  
   - External logger is configured to periodically import from `mcp_logbook.adi`.

2. **JSON QSO API (optional)**  
   - REST: `GET /api/qsos` for tailing recent QSOs or `POST /api/qsos` for future manual additions.

3. **Optional WSJT‑X-compatible UDP relay (future)**  
   - Out of scope for v3 unless explicitly enabled; design must leave room for its addition.

MCP aims to be the **primary source of QSO data**; direct WSJT‑X → logger integration is not required in v3.

---

# 9. Logging Program Integration (Rig Control)

External logging software connects to MCP as if it were an HRD server.

## 9.1 Connection

- **Logger Rig:** “Ham Radio Deluxe”  
- **Server:** `MCP_HOST:HRD_MAIN_PORT` (configurable, e.g. 7800)  
- MCP must allow **multiple logger clients** on this main HRD port, all seeing the same state.

## 9.2 Behavior

- Logger can read current frequency/mode and possibly set them.  
- MCP maps logger HRD commands to the **current TX channel** by default.  
- MCP must ensure that logger operations do not conflict with AI/WSJT‑X operations; if conflict is detected, MCP may:
  - Ignore certain logger `set` commands (config option), or  
  - Accept but expose this via the AI tooling.

v3: simplest behavior: allow logger `set frequency` / `set mode`, treat them like operator actions.

---

# 10. Internal Modules & Process Model

MCP runs as a **single process** with asynchronous I/O and worker components. Only one binary/installation is required.

Recommended module structure (TypeScript implementation):

```text
src/
├── index.ts                    # Entry point, startup orchestration
├── SettingsManager.ts          # Configuration loading/saving, change detection

├── wsjtx/                      # WSJT-X management
│   ├── WsjtxManager.ts         # Top-level orchestrator
│   ├── ProcessManager.ts       # Process spawning/lifecycle
│   ├── FlexRadioManager.ts     # FlexRadio slice-to-instance mapping
│   ├── WindowManager.ts        # WSJT-X window positioning
│   ├── WsjtxConfig.ts          # INI file generation
│   ├── UdpListener.ts          # WSJT-X UDP message parsing
│   ├── UdpSender.ts            # WSJT-X UDP message encoding
│   ├── QsoStateMachine.ts      # Autonomous QSO state transitions
│   └── types.ts                # WSJT-X type definitions

├── state/                      # MCP state management
│   ├── StateManager.ts         # Aggregate MCP state
│   ├── ChannelUdpManager.ts    # Per-channel UDP communication
│   ├── types.ts                # State type definitions
│   └── index.ts

├── logbook/                    # Logbook operations
│   ├── LogbookManager.ts       # ADIF read/write, WorkedIndex, HRD server for loggers
│   └── index.ts

├── dashboard/                  # Web dashboard state
│   ├── DashboardManager.ts     # Station tracking, status computation
│   └── index.ts

├── cat/                        # CAT control
│   └── HrdCatServer.ts         # HRD protocol server for WSJT-X and loggers

├── flex/                       # FlexRadio backend
│   ├── FlexClient.ts           # High-level Flex wrapper
│   ├── Vita49Client.ts         # VITA 49 protocol to SmartSDR
│   └── FlexDiscovery.ts        # Broadcast discovery

├── mcp/                        # MCP protocol
│   └── McpServer.ts            # MCP stdio transport, tools, resources

├── web/                        # Web interface
│   └── server.ts               # Express + WebSocket server

└── frontend/                   # React web dashboard (separate build)
```

### Manager Summary

| Manager | Purpose |
|---------|---------|
| **WsjtxManager** | Top-level WSJT-X orchestration |
| **ProcessManager** | WSJT-X process spawning/lifecycle |
| **FlexRadioManager** | FlexRadio slice-to-instance mapping |
| **StateManager** | MCP state aggregation |
| **ChannelUdpManager** | Per-channel UDP communication |
| **LogbookManager** | ADIF, WorkedIndex, HRD server for external loggers |
| **DashboardManager** | Station tracking for web UI |
| **WindowManager** | WSJT-X window positioning |
| **SettingsManager** | Configuration file management |

- All network components (HRD servers, UDP listeners, REST) are non-blocking.  
- Each WSJT‑X instance is supervised by a **WSJT-X Worker** that handles spawn, restart, and shutdown.

---

# 11. MCP Protocol Interface

The AI interacts with MCP via the **Model Context Protocol (MCP)** using stdio transport. This chapter defines the transport layer, canonical data types, resources, events, and tools that AI agents use to consume decoded FT8/FT4 messages and initiate QSOs.

## 11.1 Transport & Protocol Compliance

### 11.1.1 Basic Transport

- **Protocol:** Model Context Protocol (MCP) v2024-11-05
- **Transport:** stdio (stdin/stdout) - MCP ONLY uses stdio
- **Server Name:** `wsjt-x-mcp`
- **Server Version:** `1.0.0` (semantic versioning)
- **Format:** JSON-RPC 2.0
- **SDK:** `@modelcontextprotocol/sdk` (official MCP SDK)

**Important:** The MCP interface is ONLY available via stdio. Other interfaces (HTTP REST API, HRD TCP servers, WSJT-X UDP listeners) are backend services that MCP uses internally but are NOT part of the MCP transport.

### 11.1.2 MCP Lifecycle

The server implements the full MCP lifecycle using the official SDK:

1. **initialize** - Client sends initialization request
   - Server responds with `serverInfo`:
     - `name`: "wsjt-x-mcp"
     - `version`: "1.0.0"
     - `protocolVersion`: "2024-11-05"
   - Server declares `capabilities`:
     - `tools`: true
     - `resources`: true

2. **initialized** - Client confirms initialization complete
   - Server waits for this notification before sending `resources/updated` events

3. **shutdown** - Clean shutdown request
   - Server gracefully stops all WSJT-X instances
   - Server closes FlexRadio connection

4. **exit** - Final termination notification

### 11.1.3 Tool & Resource Discovery

- **listTools** - Returns all available tools with full JSON Schema definitions (SDK auto-generates from Zod schemas)
- **listResources** - Returns all resources with URIs, types, and MIME types

## 11.2 Canonical Types

### 11.2.1 DecodeRecord Type

One decoded FT8/FT4 message, enriched by MCP for AI use. This type is the canonical shape used in both:
- The `wsjt-x://decodes` resource
- The `resources/updated` event payload (snapshot)

**TypeScript Definition:**
```typescript
type DecodeRecord = {
  id: string;               // Opaque ID, unique within this snapshot

  timestamp: string;        // ISO8601 UTC decode time

  band: string;             // e.g. "20m", "40m"
  mode: string;             // e.g. "FT8", "FT4"

  dial_hz: number;          // WSJT-X dial frequency in Hz
  audio_offset_hz: number;  // Audio offset (DF) in Hz
  rf_hz: number;            // RF frequency in Hz (dial_hz + audio_offset_hz)

  snr_db: number;           // SNR in dB
  dt_sec: number;           // Timing offset in seconds

  call: string;             // Decoded primary callsign in the message
  grid: string | null;      // Maidenhead locator or null if unknown

  is_cq: boolean;           // True if this is a CQ-type message
  is_my_call: boolean;      // True if this message is addressed to our own callsign

  /**
   * True if THIS station (the configured operator) is allowed to answer this CQ
   * according to the CQ pattern (CQ DX, CQ NA, CQ EU, CQ JA, etc.) and the
   * operator's own location (DXCC, continent, etc.).
   *
   * The MCP server is responsible for evaluating this field based on station
   * configuration. The client MUST treat this as authoritative and MUST NOT
   * reimplement CQ-target logic itself.
   */
  is_directed_cq_to_me: boolean;

  /**
   * Raw CQ target token extracted from the message, if any.
   *
   * Examples:
   *   "CQ DX HB9XYZ JN36"   -> cq_target_token = "DX"
   *   "CQ NA W1ABC FN31"    -> cq_target_token = "NA"
   *   "CQ EU DL1ABC JO62"   -> cq_target_token = "EU"
   *   "CQ JA JA1XYZ PM95"   -> cq_target_token = "JA"
   *
   * Null if no explicit CQ-target token was present (plain CQ).
   * This is informational only; clients do not need to interpret it.
   */
  cq_target_token: string | null;

  raw_text: string;         // Raw WSJT-X decoded message text

  // Optional flags derived from WSJT-X UDP fields.
  is_new?: boolean;         // WSJT-X "new" flag
  low_confidence?: boolean; // WSJT-X lowConfidence flag
  off_air?: boolean;        // WSJT-X offAir flag
};
```

### 11.2.2 DecodesSnapshot Type

A full, self-contained snapshot of the current decode state. This snapshot is the canonical representation and MUST be used:
- As the body of the `wsjt-x://decodes` resource
- As the snapshot object embedded in `resources/updated` events for `uri = "wsjt-x://decodes"`

At each update, the snapshot used for the resource and the event MUST be bitwise identical (modulo JSON serialization).

**TypeScript Definition:**
```typescript
type DecodesSnapshot = {
  snapshot_id: string;      // Unique ID for this snapshot (e.g. UUID)
  generated_at: string;     // ISO8601 UTC time when this snapshot was built
  decodes: DecodeRecord[];  // Full decode list MCP exposes to the client
};
```

**Example:**
```json
{
  "snapshot_id": "2025-11-29T10:30:00Z-001",
  "generated_at": "2025-11-29T10:30:00Z",
  "decodes": [
    {
      "id": "decode-001",
      "timestamp": "2025-11-29T10:29:45Z",
      "band": "20m",
      "mode": "FT8",
      "dial_hz": 14074000,
      "audio_offset_hz": 1234,
      "rf_hz": 14075234,
      "snr_db": -8,
      "dt_sec": 0.3,
      "call": "DL1ABC",
      "grid": "JO62",
      "is_cq": true,
      "is_my_call": false,
      "is_directed_cq_to_me": true,
      "cq_target_token": null,
      "raw_text": "CQ DL1ABC JO62"
    }
  ]
}
```

## 11.3 MCP Resources

### 11.3.1 Resource: `wsjt-x://decodes`

Read-only JSON resource that returns the current `DecodesSnapshot`. This is primarily used for recovery, debugging, and late joiners. Normal operation relies on the `resources/updated` event.

**Resource Definition:**
- **URI:** `wsjt-x://decodes`
- **MIME Type:** `application/json`
- **Content:** `DecodesSnapshot` (as defined in §11.1.2)

**Example Response:**
```json
{
  "snapshot_id": "2025-11-29T10:30:00Z-001",
  "generated_at": "2025-11-29T10:30:00Z",
  "decodes": [
    {
      "id": "decode-001",
      "timestamp": "2025-11-29T10:29:45Z",
      "band": "20m",
      "mode": "FT8",
      "dial_hz": 14074000,
      "audio_offset_hz": 1234,
      "rf_hz": 14075234,
      "snr_db": -8,
      "dt_sec": 0.3,
      "call": "DL1ABC",
      "grid": "JO62",
      "is_cq": true,
      "is_my_call": false,
      "is_directed_cq_to_me": true,
      "cq_target_token": null,
      "raw_text": "CQ DL1ABC JO62"
    }
  ]
}
```

## 11.4 MCP Events

### 11.4.1 Event: `resources/updated` for `wsjt-x://decodes`

Whenever MCP receives a new batch of decodes (e.g. at the end of an FT8/FT4 decoding cycle), it MUST:

1. Build a new `DecodesSnapshot` in memory
2. Store it as the current snapshot for `wsjt-x://decodes`
3. Emit a JSON-RPC notification:
   - **Method:** `resources/updated`
   - **Params:**
     - `uri`: `"wsjt-x://decodes"`
     - `snapshot`: `<DecodesSnapshot>`

The snapshot embedded in the event MUST be exactly the same object that is returned by reading `wsjt-x://decodes` (same `snapshot_id`, same `decodes` array).

**Event Payload:**
```json
{
  "jsonrpc": "2.0",
  "method": "resources/updated",
  "params": {
    "uri": "wsjt-x://decodes",
    "snapshot": {
      "snapshot_id": "2025-11-29T10:30:00Z-001",
      "generated_at": "2025-11-29T10:30:00Z",
      "decodes": [
        {
          "id": "decode-001",
          "timestamp": "2025-11-29T10:29:45Z",
          "band": "20m",
          "mode": "FT8",
          "dial_hz": 14074000,
          "audio_offset_hz": 1234,
          "rf_hz": 14075234,
          "snr_db": -8,
          "dt_sec": 0.3,
          "call": "DL1ABC",
          "grid": "JO62",
          "is_cq": true,
          "is_my_call": false,
          "is_directed_cq_to_me": true,
          "cq_target_token": null,
          "raw_text": "CQ DL1ABC JO62"
        }
      ]
    }
  }
}
```

**Implementation Notes:**
- The MCP server MUST wait for the `initialized` notification before sending `resources/updated` events
- Events are sent automatically whenever WSJT-X completes a decoding cycle (typically every 15 seconds for FT8, 7.5 seconds for FT4)
- Clients subscribe to these events to maintain real-time awareness of decoded stations

## 11.5 MCP Tools

AI agents SHOULD primarily use `call_cq`, `answer_decoded_station`, and `log_get_worked`, along with the `wsjt-x://decodes` resource. These tools provide a clean, high-level interface for autonomous FT8/FT4 operation. Slice and instance selection are handled automatically by MCP based on band and frequency.

### 11.5.1 Tool: `call_cq`

Start or continue calling CQ. The server is responsible for selecting the appropriate transmit path (slice / WSJT-X instance) and configuring it.

**Parameters:**
```typescript
{
  "band"?:   string;  // optional, e.g. "20m"
  "freq_hz"?: number; // optional dial frequency in Hz
  "mode"?:   string;  // optional, "FT8" or "FT4" (default: "FT8")
}
```

**Output:**
```typescript
{
  "status":  string;  // human-readable status
  "band":    string;  // actual band used
  "freq_hz": number;  // actual dial frequency used
  "mode":    string;  // actual mode used
}
```

**Example Request:**
```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "method": "tools/call",
  "params": {
    "name": "call_cq",
    "arguments": {
      "band": "20m",
      "mode": "FT8"
    }
  }
}
```

**Example Response:**
```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"status\": \"Calling CQ on 20m FT8\", \"band\": \"20m\", \"freq_hz\": 14074000, \"mode\": \"FT8\"}"
    }]
  }
}
```

### 11.5.2 Tool: `answer_decoded_station`

Answer one of the currently decoded stations. The client passes only the `decode_id` from the latest `DecodesSnapshot`; MCP resolves all rig/slice details internally and uses WSJT-X Reply to initiate the QSO.

**Parameters:**
```typescript
{
  "decode_id":    string;  // DecodeRecord.id to answer
  "force_mode"?:  string;  // optional override: "FT8" | "FT4"
}
```

**Output:**
```typescript
{
  "status":       string;  // e.g. "Reply sent, QSO in progress"
  "band":         string;  // band used for the reply
  "freq_hz":      number;  // dial frequency used
  "mode":         string;  // mode used
  "target_call":  string;  // callsign being answered
}
```

**Example Request:**
```json
{
  "jsonrpc": "2.0",
  "id": "req-002",
  "method": "tools/call",
  "params": {
    "name": "answer_decoded_station",
    "arguments": {
      "decode_id": "decode-001"
    }
  }
}
```

**Example Response:**
```json
{
  "jsonrpc": "2.0",
  "id": "req-002",
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"status\": \"Reply sent, QSO in progress\", \"band\": \"20m\", \"freq_hz\": 14074000, \"mode\": \"FT8\", \"target_call\": \"DL1ABC\"}"
    }]
  }
}
```

**Implementation Notes:**
- The MCP server uses the WSJT-X Reply protocol (message type 4 with Shift modifier 0x02) to initiate the QSO
- The server automatically selects the correct WSJT-X instance and slice based on the decode's band/frequency
- Requires `HoldTxFreq=true` and `AutoSeq=true` in WSJT-X INI files (see §11.5.4)

### 11.5.3 Tool: `log_get_worked`

Check if a station has been worked on a specific band and mode. AI agents MUST use this tool before answering CQ calls to avoid duplicate contacts.

**Parameters:**
```typescript
{
  "call": string;  // Callsign to check
  "band": string;  // Band (e.g., "20m", "40m")
  "mode": string;  // Mode (e.g., "FT8", "FT4")
}
```

**Output:**
```typescript
{
  "worked": boolean;           // True if station has been worked
  "call": string;              // Callsign checked
  "band": string;              // Band checked
  "mode": string;              // Mode checked
  "last_qso_time"?: string;    // ISO8601 time of last QSO (if worked)
}
```

**Example Request:**
```json
{
  "jsonrpc": "2.0",
  "id": "req-003",
  "method": "tools/call",
  "params": {
    "name": "log_get_worked",
    "arguments": {
      "call": "DL1ABC",
      "band": "20m",
      "mode": "FT8"
    }
  }
}
```

**Example Response (not worked):**
```json
{
  "jsonrpc": "2.0",
  "id": "req-003",
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"worked\": false, \"call\": \"DL1ABC\", \"band\": \"20m\", \"mode\": \"FT8\"}"
    }]
  }
}
```

**Example Response (already worked):**
```json
{
  "jsonrpc": "2.0",
  "id": "req-003",
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"worked\": true, \"call\": \"DL1ABC\", \"band\": \"20m\", \"mode\": \"FT8\", \"last_qso_time\": \"2025-11-26T18:42:05Z\"}"
    }]
  }
}
```

### 11.5.4 WSJT-X Reply Protocol Requirements

For automatic TX to start after answering a decoded station, the following MUST be set in the WSJT-X INI file:

- `HoldTxFreq=true` in [Common] section - Prevents frequency changes and enables auto-TX after Reply
- `AutoSeq=true` in [Common] section - Enables automatic FT8 sequencing (handles RR73, 73, etc.)

The MCP automatically configures these settings when generating INI files for managed instances (see WsjtxConfig.ts:825). If TX does not start after a Reply message, verify these settings in the instance's INI file.

**Reply Message Behavior:**
When WSJT-X receives a Reply message (type 4) with the Shift modifier (0x02), it:
1. Populates the DX Call and DX Grid fields
2. Sets the audio frequency (DF) to the decode's frequency
3. Arms the TX sequencer (Halt TX is unchecked)
4. Enables transmit for the next TX period (if `HoldTxFreq=true`)

This is the same mechanism used by GridTracker, N1MM Logger+, and VARA to control WSJT-X.

## 11.6 Autonomous QSO Workflow & Examples

This section demonstrates how AI agents should implement autonomous FT8/FT4 operation using the canonical MCP interface.

### 11.6.1 Standard Workflow

The canonical autonomous QSO workflow is:

1. **Receive decodes** via `resources/updated` event (uri: `wsjt-x://decodes`)
   - Event contains full `DecodesSnapshot` with all current decodes
   - Clients cache this snapshot for processing

2. **Filter candidates**:
   - `d.is_cq === true` - Only CQ messages
   - `d.is_directed_cq_to_me === true` - Only CQs we're allowed to answer
   - **IMPORTANT**: AI agents MUST respect `is_directed_cq_to_me`. Answering when this is `false` violates amateur radio etiquette.

3. **Check duplicates**:
   - For each candidate, call `log_get_worked(d.call, d.band, d.mode)`
   - Skip stations that have already been worked

4. **Select best candidate**:
   - Sort by SNR, new grids, priority rules, etc.
   - Select the optimal station to call

5. **Answer the station**:
   - Call `answer_decoded_station({ decode_id: best.id })`
   - MCP handles all slice/instance selection automatically

6. **Optional: Call CQ when idle**:
   - If no good candidates, call `call_cq({ band: "20m", mode: "FT8" })`

**Critical Rule**: Clients MUST NOT:
- Reimplement CQ targeting logic
- Reference slice, channel, or instance IDs
- Use low-level tools like `wsjtx_reply_to_station` or `execute_qso`

### 11.6.2 Example: Basic Autonomous Hunt

**Listening for decodes and answering the strongest new station:**

```typescript
// Step 1: Listen for resources/updated events
onResourcesUpdated((event) => {
  if (event.params.uri !== "wsjt-x://decodes") return;

  const snapshot = event.params.snapshot as DecodesSnapshot;

  // Step 2: Filter candidates
  const candidates = snapshot.decodes.filter(d =>
    d.is_cq && d.is_directed_cq_to_me
  );

  // Step 3: Check duplicates and collect new stations
  const newStations = [];
  for (const decode of candidates) {
    const result = await call_tool("log_get_worked", {
      call: decode.call,
      band: decode.band,
      mode: decode.mode
    });

    if (!result.worked) {
      newStations.push(decode);
    }
  }

  // Step 4: Select best candidate (strongest SNR)
  newStations.sort((a, b) => b.snr_db - a.snr_db);

  // Step 5: Answer the best station
  if (newStations.length > 0) {
    const best = newStations[0];
    console.log(`Answering ${best.call} on ${best.band} (SNR: ${best.snr_db}dB)`);

    await call_tool("answer_decoded_station", {
      decode_id: best.id
    });
  }
});
```

### 11.6.3 Example: Multi-Band Hunt with Priority

**Working new grids across multiple bands with prioritization:**

```typescript
onResourcesUpdated(async (event) => {
  if (event.params.uri !== "wsjt-x://decodes") return;

  const snapshot = event.params.snapshot as DecodesSnapshot;

  // Filter: CQs directed to us, SNR > -10dB
  const candidates = snapshot.decodes.filter(d =>
    d.is_cq &&
    d.is_directed_cq_to_me &&
    d.snr_db > -10
  );

  // Check which are new
  const newStations = [];
  for (const decode of candidates) {
    const result = await call_tool("log_get_worked", {
      call: decode.call,
      band: decode.band,
      mode: decode.mode
    });

    if (!result.worked) {
      newStations.push({
        ...decode,
        priority: calculatePriority(decode)  // Custom priority logic
      });
    }
  }

  // Sort by priority, then SNR
  newStations.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return b.snr_db - a.snr_db;
  });

  // Answer the highest priority station
  if (newStations.length > 0) {
    const best = newStations[0];
    await call_tool("answer_decoded_station", {
      decode_id: best.id
    });
  } else {
    // No good candidates - call CQ on preferred band
    await call_tool("call_cq", {
      band: "20m",
      mode: "FT8"
    });
  }
});

function calculatePriority(decode: DecodeRecord): number {
  let priority = 0;

  // Prefer new grids
  if (decode.grid && !isGridWorked(decode.grid)) {
    priority += 100;
  }

  // Prefer higher bands (DX potential)
  if (decode.band === "10m") priority += 50;
  if (decode.band === "15m") priority += 40;
  if (decode.band === "20m") priority += 30;

  // Prefer strong signals
  priority += decode.snr_db;

  return priority;
}
```

### 11.6.4 Example: Respecting CQ Targeting

**Demonstrating proper use of `is_directed_cq_to_me`:**

```typescript
onResourcesUpdated(async (event) => {
  if (event.params.uri !== "wsjt-x://decodes") return;

  const snapshot = event.params.snapshot as DecodesSnapshot;

  // CORRECT: Filter using is_directed_cq_to_me
  const allowed = snapshot.decodes.filter(d =>
    d.is_cq && d.is_directed_cq_to_me
  );

  // INCORRECT: Do NOT reimplement targeting logic
  // ❌ BAD CODE (do not use):
  // const allowed = snapshot.decodes.filter(d => {
  //   if (!d.is_cq) return false;
  //   if (d.cq_target_token === null) return true;
  //   if (d.cq_target_token === "EU" && MY_CONTINENT === "EU") return true;
  //   return false;
  // });

  // The server has already evaluated is_directed_cq_to_me correctly.
  // Clients MUST trust this field and MUST NOT reimplement the logic.

  // ... rest of workflow
});
```

### 11.6.5 Error Handling

**Common errors and how to handle them:**

```typescript
try {
  await call_tool("answer_decoded_station", {
    decode_id: "decode-001"
  });
} catch (error) {
  if (error.message.includes("Decode not found")) {
    // Decode expired from snapshot - normal, move to next candidate
    console.log("Decode expired, trying next station");
  } else if (error.message.includes("Instance busy")) {
    // WSJT-X instance is in active QSO - wait for completion
    console.log("Instance busy with QSO, will try later");
  } else {
    console.error("Unexpected error:", error);
  }
}
```

**Important Notes:**
- Decode IDs are only valid within their snapshot
- If a decode expires before you answer, try the next candidate
- MCP handles all slice/instance conflicts automatically
- Clients should gracefully handle errors and continue operation

---

# 12. MCP Configuration (JSON)

MCP stores its configuration in a single JSON file, **owned and managed by MCP** (no manual editing required, though it should remain human-readable).

Example: `mcp-config.json`

```jsonc
{
  "flex": {
    "host": "192.168.1.50",
    "auto_discover": true,
    "default_bands": ["80m", "40m", "20m", "10m"]
  },
  "network": {
    "bind_address": "0.0.0.0",
    "hrd_main_port": 7800,
    "hrd_channel_base_port": 7801,
    "wsjtx_udp_base_port": 2237,
    "rest_port": 8080
  },
  "station": {
    "callsign": "HB9BL",
    "grid": "JN36",
    "audio_api": "MME"
  },
  "decode": {
    "history_minutes": 15
  },
  "logbook": {
    "adif_file": "mcp_logbook.adi"
  }
}
```

- MCP exposes a **settings screen** in its frontend where the user edits these values.
- MCP validates settings (e.g., with JSON Schema) before saving.
- MCP is the only component that writes to this JSON file.

## 12.1 Smart Config Reload

When the user saves configuration changes via the UI, MCP determines the appropriate action based on what changed:

### Change Levels

1. **Live Reload** (`live`) - Applied immediately, no restart needed:
   - Dashboard settings (colors, thresholds, station lifetime)
   - Station callsign/grid
   - ADIF log path

2. **WSJT-X Restart** (`wsjtx_restart`) - Instances are gracefully restarted:
   - WSJT-X executable path (`wsjtx.path`)
   - HRD CAT base port (`flex.catBasePort`)
   - Default bands (`flex.defaultBands`)
   - Standard rig name (`standard.rigName`)

3. **App Restart** (`app_restart`) - User must manually restart MCP:
   - Operation mode (`mode`: FLEX/STANDARD)
   - Web server port (`web.port`)
   - FlexRadio host (`flex.host`)

### API Response

The config save endpoint returns change level information:

```jsonc
{
  "success": true,
  "config": { /* updated config */ },
  "message": "Config applied immediately.",
  "changeLevel": "live",      // "live" | "wsjtx_restart" | "app_restart"
  "changedFields": ["dashboard.colors.worked"],
  "action": "none"            // "none" | "wsjtx_restart" | "app_restart"
}
```

### Restart Behavior

For `wsjtx_restart` level changes:
- MCP saves current state (frequencies, slice mappings)
- Gracefully stops all WSJT-X processes
- Regenerates INI files with new settings
- Relaunches instances in the same order
- HRD CAT servers remain running (no reconnection needed)

This minimizes disruption during configuration changes.

---

# 13. Runtime & Error Model

## 13.1 Process Model

- Single process binary.  
- Inside: asynchronous event loops for HRD servers, UDP listeners, Flex backend, and REST API.  
- WSJT‑X instances are external processes supervised by MCP.

## 13.2 Error Handling Policies

- **WSJT‑X crash:** restart up to N times (configurable), then mark channel as `status="error"` and surface in API/UI.  
- **Flex disconnect:**  
  - Attempt reconnect with backoff.  
  - HRD commands return `RPRT -9`.  
  - API reports `flex_connected=false`.  
- **UDP parse error:** drop packet, increment error counter, log debug message.  
- **INI corruption:** if WSJT‑X fails repeatedly for one instance, MCP can regenerate that instance’s INI from `base_template.ini` and log a warning.

---

# 14. Security & Networking

- MCP ports (HRD, REST) bind to `network.bind_address`, which is **configurable**.  
  - For a typical shack setup, user may choose `127.0.0.1` (local only) or `0.0.0.0` (LAN).  
- No authentication or TLS is required in v3; environment is assumed trusted LAN.  
- Design should keep room for future auth/TLS, but no implementation is needed now.

---

# 15. Non-Goals for v3

- No CW Skimmer or RBN integration.  
- No Telnet cluster server.  
- No Prometheus/metrics.  
- No panadapter/waterfall control beyond what Flex requires for a slice.  
- No non-Flex radio backend implementation (Hamlib backend can be a stub).

---

# 16. Implementation Deliverables (For AI)

The AI implementation should produce at least:

1. **Core Daemon**
   - Implements this FSD on Windows (first target).  
   - Provides executable `mcp.exe` (or equivalent).

2. **Flex Backend Stub/Implementation**
   - Real SmartSDR v4.x implementation OR a clearly separated stub plus an interface that can later be bound to the real API.

3. **HRD TCP Servers**
   - 1 main HRD port for logger.  
   - 4 per-channel HRD ports for WSJT‑X instances.

4. **WSJT‑X Manager**
   - INI generator/patcher.  
   - Process launcher and supervisor.

5. **UDP Decode Listener**
   - Parsing WSJT‑X UDP messages.  
   - Maintaining per-channel decode history.

6. **QSO Logbook**
   - ADIF writer.  
   - WorkedIndex for (call, band, mode) checks.

7. **Config Manager**
   - JSON read/write.  
   - Integration with a minimal settings UI (or at least REST endpoints).

8. **LLM Tool / REST Layer**
   - JSON-based commands for rig state, decodes, logbook queries, and basic rig operations.

All modules MUST adhere to the data structures and flows defined here so that future AI agents can safely reason about, extend, and regenerate MCP code without ambiguity.

---

# End of MCP-fsd.md (Version 3)
