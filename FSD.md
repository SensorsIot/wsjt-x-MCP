# MCP Specification — HRD-Based Rig Control (Short Version)

This specification defines a minimal MCP interface for controlling amateur radio software (WSJT-X, loggers, digital?mode tools) using **Ham Radio Deluxe (HRD) TCP protocol** as the universal rig control layer.

The goal:  
**One MCP ? many radios (Flex, IC-7300, etc.)**  
**One interface ? WSJT-X, JTDX, N1MM, Log4OM**

---

# 1. Architecture Overview

```
WSJT-X / N1MM / Loggers
         ?  HRD TCP
         ?
     MCP HRD Server
         ?
         ??? Flex backend (native API)
         ??? Hamlib backend (IC-7300 etc.)
         ??? Optional TS-2000 backend
```

MCP exposes multiple **HRD TCP listeners**, usually one per radio channel/slice:

```
:7801 ? channel A
:7802 ? channel B
:7803 ? channel C
```

Each connected client receives full rig control.

---

# 2. HRD TCP Protocol (MCP Side)

MCP implements a subset of HRD TCP:

### Incoming (from WSJT-X or logger)

- `get frequency`
- `set frequency <hz>`
- `get mode`
- `set mode <LSB|USB|DIGU|FM>`
- `get ptt`
- `set ptt on|off`

### Outgoing (MCP ? client)

- `RPRT 0` (success)
- `RPRT <err>` (error)
- Optional polling updates (`frequency <hz>`, `mode <m>`)

---

# 3. MCP Tool API (LLM-Facing)

Tools are radio?agnostic. Backend routing happens inside MCP.

### `rig_get_state()`

Returns channels and radio metadata.

### `rig_tune_channel(channel_index, freq_hz)`

Tells backend to re-tune the channel, updates HRD clients.

### `rig_set_mode(channel_index, mode)`

Sets radio mode and updates connected HRD clients.

### `rig_set_tx_channel(channel_index)`

Selects TX channel (Flex) or no-op (IC-7300).

### `rig_emergency_stop()`

PTT off, TX inhibited, optionally reduce RF power.

---

# 4. Backends

## 4.1 Flex Backend (recommended)

- Use **Flex SmartSDR TCP API**
- Channels map to slices A–F
- MCP sends slice freq/mode/PTT updates to HRD clients
- Full multi-slice support

## 4.2 Hamlib Backend (standard radios)

- For IC-7300, TS-590, FT?991A, etc.
- Use rigctld/hamlib calls
- Channels usually = 1 (VFO A)
- HRD commands translated to hamlib operations

## 4.3 TS-2000 Backend (optional)

- For old software needing Kenwood commands
- MCP converts HRD calls ? TS?2000 CAT ? rig

---

# 5. WSJT-X Settings (Client Side)

```
Rig: Ham Radio Deluxe
Network Server: <MCP_IP>:<HRD_PORT>
PTT: CAT
Mode: Data/Pkt
Split: Rig
```

Multiple WSJT-X instances ? multiple HRD ports.

---

# 6. Minimal Behavior

- MCP ensures **state consistency** between radio backends and HRD clients.
- HRD server responds instantly to CAT-like commands.
- Backend is responsible for:
  - Correct frequency/mode enforcement
  - Slice or VFO selection
  - TX safety

---

# 7. Files & Ports

- HRD ports: configurable (`7801`, `7802`, ...)
- Audio routing is out of scope (handled by DAX/OS)
- UDP telemetry from WSJT-X (`2237+`) is optional for decode monitoring

---

# End of Document