# SliceMaster 6000 – CAT & HRD Protocol Technical Reference

This document provides a full engineering-level overview of how SliceMaster 6000 implements **TS-2000 CAT**, **Ham Radio Deluxe (HRD) protocol**, signal routing to FlexRadio SmartSDR, and best?practice configurations for common digital?mode applications.

---

## 1. Supported TS-2000 CAT Commands

SliceMaster supports the subset of Kenwood CAT commands needed by digital?mode applications. All commands are ASCII and terminate with `;`.

### Frequency Control

| Command          | Description         | Supported |
| ---------------- | ------------------- | --------- |
| `FA;`            | Get VFO A frequency | ?         |
| `FAxxxxxxxxxxx;` | Set VFO A frequency | ?         |
| `FB;`            | Get VFO B frequency | ?         |
| `FBxxxxxxxxxxx;` | Set VFO B frequency | ?         |

**Mapping:** TS-2000 VFO A/B ? Flex slice frequency.

### Mode Control

| Command | Meaning       | Supported              |
| ------- | ------------- | ---------------------- |
| `MD;`   | Get mode      | ?                      |
| `MDn;`  | Set mode      | ?                      |
| `OM0;`  | Data mode OFF | ? ? DIGU/DIGL disabled |
| `OM1;`  | Data mode ON  | ? ? DIGU/DIGL enabled  |

**TS-2000 to Flex Mode Mapping**

* `MD1` ? LSB ? `lsb`
* `MD2` ? USB ? `usb`
* `MD3` ? CW ? `cw`
* `MD4` ? FM ? `fm`
* `MD5` ? AM ? `am`
* `MD6` ? FSK ? `rtty`
* `MD7` ? CWR ? `cw-r`
* `MD9` ? DATA LSB ? `digl`
* `MD10` ? DATA USB ? `digu`

### PTT

| Command | Meaning       | Supported |
| ------- | ------------- | --------- |
| `TX;`   | Get PTT state | ?         |
| `TX0;`  | PTT OFF       | ?         |
| `TX1;`  | PTT ON        | ?         |

**Mapping:** ? `radio transmit 1/0`.

### Split Operation

| Command | Meaning   | Supported |
| ------- | --------- | --------- |
| `SP0;`  | Split OFF | ?         |
| `SP1;`  | Split ON  | ?         |

Split is implemented by switching the slice TX flag or maintaining an internal TX offset.

### S-Meter

| Command | Description | Supported |
| ------- | ----------- | --------- |
| `SM;`   | Get S-meter | ?         |

Values returned follow Kenwood’s `00–30` scale.

### Filter / Bandwidth

| Command  | Meaning          | Supported |
| -------- | ---------------- | --------- |
| `FLnnn;` | Set filter width | ?         |

Mapped to Flex filter low/high settings.

### Unsupported or Stubbed Commands

SliceMaster ignores:

* Memory functions
* DTMF
* Satellite mode
* Menu items
* TS-2000 hardware commands
* DSP presets

---

## 2. HRD Protocol Specification (SliceMaster Implementation)

SliceMaster implements the older/tested HRD TCP protocol used by logging and contest software.

### Message Format

```
<sequence>|<command>|<payload>
```

**Examples:**

```
000001|GetFreq
000002|SetFreq|14074000
000003|GetMode
000004|SetMode|USB
```

### Supported HRD Commands

| HRD Command    | Description          | Supported           |   |
| -------------- | -------------------- | ------------------- | - |
| `GetFreq`      | Read slice frequency | ?                   |   |
| `SetFreq       | nnnnnnnn`            | Set slice frequency | ? |
| `GetMode`      | Read mode            | ?                   |   |
| `SetMode       | USB`                 | Set mode            | ? |
| `GetPTT`       | 0/1                  | ?                   |   |
| `SetPTT        | On/Off`              | TX control          | ? |
| `GetSmeter`    | S-meter              | ?                   |   |
| `GetRadioInfo` | Static metadata      | ?                   |   |

### HRD Event Callbacks

When frequency/mode/PTT changes:

```
000100|Event|Freq|14074000
000101|Event|Mode|USB
000102|Event|PTT|On
```

Used by Log4OM, DXKeeper, N1MM+, etc.

---

## 3. Command Routing Architecture

```
                 FlexRadio (SmartSDR API)
                     TCP port 4992
                          ?
                          ? SmartSDR commands
                          ?
               ???????????????????????
               ?   SliceMaster 6000  ?
               ? CAT + HRD Router    ?
               ???????????????????????
                       ?       ?
            TS-2000 CAT ?       ? HRD TCP Server
                       ?       ?
        ?????????????????       ??????????????????
        ?                                        ?
   WSJT-X/JTDX                          N1MM+, Log4OM, fldigi
   (per-slice COM ports)                (HRD-compatible clients)
```

Each slice gets its own virtual TS-2000 CAT interface.

HRD clients receive instant push notifications.

CAT-only clients poll SliceMaster.

---

## 4. Best Practices for Common Applications

### WSJT-X / JTDX

```
Rig: Kenwood TS-2000
PTT: CAT
CAT Rate: 38400 or 115200
Serial: COMx (from SliceMaster)
Split: Rig
```

Audio: DAX TX / DAX RX

### N1MM+

```
Config ? Hardware ? Add Radio
Radio Type: Ham Radio Deluxe
IP: 127.0.0.1
Port: HRD Port from SliceMaster
```

Best because HRD gives push updates.

### CW Skimmer

```
Radio: TS-2000
CAT Port: COMx from SliceMaster
Audio: DAX IQ or AF
```

Tracks Flex slice frequency.

### fldigi

```
Rig: TS-2000
PTT: CAT
Serial Port: COMx from SliceMaster
```

HRD mode also works, but TS-2000 is cleaner.

### Multi-Slice Example

* **Slice A (20m FT8)** ? WSJT-X on COM5
* **Slice B (30m WSPR)** ? WSJT-X instance #2 on COM6
* **Slice C (40m CW)** ? CW Skimmer on COM7

All slices operate independently.

---

## 5. Notes

* SliceMaster does not replicate *all* TS-2000 features — only the functions needed for digital and contest software.
* TS-2000 is chosen because it is the most universally implemented CAT dialect.
* HRD protocol provides push events that many logging programs rely on.

---

---

# Appendix A: Complete TS-2000 CAT Command Reference and Flex Mapping

Below is a full PDF?style reference section containing:

* full TS?2000 CAT command list
* SliceMaster support status
* exact FlexRadio SmartSDR API mapping
* notes and exceptions

## A.1 Frequency Commands

| TS?2000 Command  | Description     | Example          | SliceMaster | Flex Mapping                          |
| ---------------- | --------------- | ---------------- | ----------- | ------------------------------------- |
| `FA;`            | Read VFO A freq | `FA;`            | ?           | `slice <n> freq` (query)              |
| `FAxxxxxxxxxxx;` | Set VFO A freq  | `FA00014074000;` | ?           | `slice <n> tune <freq>`               |
| `FB;`            | Read VFO B freq | `FB;`            | ?           | `slice <n> freq` (alternate)          |
| `FBxxxxxxxxxxx;` | Set VFO B freq  | `FB00014075000;` | ?           | `slice <n> tx_freq <freq>` (if split) |

### Notes

* SliceMaster uses **VFO A = primary slice frequency**.
* VFO B is used only when split mode is enabled.

## A.2 Mode Commands

| TS?2000 | Meaning  | SliceMaster | Flex Mode |
| ------- | -------- | ----------- | --------- |
| `MD1`   | LSB      | ?           | `lsb`     |
| `MD2`   | USB      | ?           | `usb`     |
| `MD3`   | CW       | ?           | `cw`      |
| `MD4`   | FM       | ?           | `fm`      |
| `MD5`   | AM       | ?           | `am`      |
| `MD6`   | FSK      | ?           | `rtty`    |
| `MD7`   | CWR      | ?           | `cw-r`    |
| `MD9`   | Data LSB | ?           | `digl`    |
| `MD10`  | Data USB | ?           | `digu`    |

**SmartSDR command example:**

```
slice set <n> mode usb
```

## A.3 PTT / Transmission

| TS?2000 | Meaning  | SliceMaster | Flex Mapping       |
| ------- | -------- | ----------- | ------------------ |
| `TX;`   | Query TX | ?           | `transmit` state   |
| `TX0;`  | PTT OFF  | ?           | `radio transmit 0` |
| `TX1;`  | PTT ON   | ?           | `radio transmit 1` |

## A.4 Split Mode

| Command | Meaning   | SliceMaster | Flex Mapping            |
| ------- | --------- | ----------- | ----------------------- |
| `SP0;`  | Split OFF | ?           | `slice <n> tx=primary`  |
| `SP1;`  | Split ON  | ?           | `slice <n> tx_freq=<B>` |

SliceMaster manages split by either:

* activating a dedicated TX slice, or
* using VFO B as TX frequency source.

## A.5 Filter Commands

| TS?2000  | Meaning      | SliceMaster | Flex Mapping                    |
| -------- | ------------ | ----------- | ------------------------------- |
| `FLnnn;` | Filter width | ? Approx.   | `slice filter_lo` / `filter_hi` |

**Note:** TS?2000 uses preset widths; Flex uses variable values.
SliceMaster converts presets ? nearest Flex filter.

## A.6 S?Meter

| Command | Meaning                    | SliceMaster |
| ------- | -------------------------- | ----------- |
| `SM;`   | Read S?meter (00–30 scale) | ?           |

Flex returns dBm; SliceMaster converts ? Kenwood scale.

## A.7 Unsupported Commands

SliceMaster ignores the following TS?2000 commands entirely:

* `ME` (memory), `MR`, `MW`
* `DT` (DTMF)
* `AN` (antenna switching)
* `PA`, `RA`, `NB`, `NR`, `AG`, `SQ` DSP functions
* `PS` power state
* `RT` RIT/XIT
* Satellite mode commands

---

# Appendix B: HRD Protocol – Full Reference

## B.1 Message Format

```
<Sequence>|<Command>|<Payload>
```

**Examples:**

```
000002|GetFreq
000003|SetFreq|14074000
000004|GetMode
000005|SetPTT|On
```

## B.2 Supported HRD Commands

| HRD Command    | Description       | Payload    | SliceMaster |
| -------------- | ----------------- | ---------- | ----------- |
| `GetFreq`      | Read current freq | —          | ?           |
| `SetFreq`      | Set freq (Hz)     | integer    | ?           |
| `GetMode`      | Read mode         | —          | ?           |
| `SetMode`      | Set mode          | USB/LSB/CW | ?           |
| `GetPTT`       | Query PTT         | —          | ?           |
| `SetPTT`       | On/Off            | On / Off   | ?           |
| `GetSmeter`    | Read S?meter      | —          | ?           |
| `GetRadioInfo` | Static radio info | —          | ?           |

## B.3 HRD Event Callbacks

SliceMaster generates:

```
<Event>|Freq|nnnnnnnn
<Event>|Mode|USB
<Event>|PTT|On
```

These keep N1MM+, Log4OM, DXKeeper synchronized.

---

# Appendix C: SmartSDR API Mapping Summary

| Function      | SmartSDR API Example         |
| ------------- | ---------------------------- |
| Set Frequency | `slice tune 0 14.074000`     |
| Set Mode      | `slice set 0 mode usb`       |
| Set TX        | `radio transmit 1`           |
| Query Slice   | `display pan` / `slice list` |
| Get Meter     | `meter list`                 |

---

# Appendix D: Expanded Routing Diagram (Multi?Slice)

```
                         FlexRadio (API 4992)
                                ?
                                ?
              ?????????????????????????????????????
              ?           SliceMaster 6000        ?
              ? CAT + HRD Translator + Router     ?
              ????????????????????????????????????
                          ?           ?
                          ?           ? HRD TCP Server
                TS?2000 CAT            ? (Per?slice or global)
                          ?           ?
        ???????????????????           ????????????????????
        ?                                               ?
   WSJT?X (Slice A)                              N1MM+ (HRD)
   COM5 ? Slice 0                               HRD: 127.0.0.1:7809

   WSJT?X #2 (Slice B)                           Log4OM / DXKeeper
   COM6 ? Slice 1

   CW Skimmer (Slice C)
   COM7 ? Slice 2
```

---

# Appendix E: Best?Practice Configuration Summary

## WSJT?X / JTDX

```
Rig: Kenwood TS?2000
PTT: CAT
Split: Rig
Baud: 38400–115200
Port: COMx from SliceMaster
Audio: DAX RX/TX
```

## N1MM+

```
Rig Type: Ham Radio Deluxe
Host: 127.0.0.1
Port: SliceMaster HRD TCP port
```

## CW Skimmer

```
Radio: TS?2000
CAT: COMx from SliceMaster
IQ Audio: DAX IQ
```

## fldigi

```
Rig: TS?2000
PTT: CAT
Port: COMx from SliceMaster
```

---

# Appendix F: Troubleshooting Notes

* If CAT fails: ensure **COM port assigned to correct slice**.
* HRD conflicts: ensure no real HRD server is running.
* WSJT?X double?PTT: disable VOX and use CAT only.
* S?meter stuck: enable metering in SmartSDR.

---

End of Document.