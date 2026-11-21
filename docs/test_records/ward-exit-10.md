# Door alerts and the 120 s live mode (Phase 10)

**Requirement:** UC-02 alternative flow A1 (geofence alert), FR-MR-06 (geofence alert on the headset), FR-IOT-03 (1 Hz live mode).
**Ward:** WARD-005 (2.29 × 3.39 m), door on the east wall at y 2.57–3.36 m, LiDAR on the east wall at (2.12, 2.12).
**Software:** edge server and wristband firmware V5.3 of this commit; anchors unchanged.
**Tester:** Project author.

## What was built

A patient whose wristband the LiDAR has linked raises one of two geofence alerts (`GEOFENCE_BREACH` with a `geofence_kind`). The rules are in `docs/protocol.md`, section 5, "At the door and leaving the ward".

| Alert | When |
| :--- | :--- |
| 🚪 **AT THE DOOR** | The LiDAR has seen the patient in the door zone for 10 s. The door zone is the doorway plus 0.1 m on each side, reaching 1 m into the room; in WARD-005 that is x 1.29–2.29 m, y 2.47–3.39 m. |
| 🚪 **LEFT THE WARD** | The LiDAR lost the patient in the door zone and did not see them again: about 11.5 s after it last saw them. |

- **Exceptions:** no alert while a headset sees the patient elsewhere in the room, and none for a wristband that is not bound to a patient.
- **After "left the ward":** the wristband is linked again only to a person who comes in through the door.
- **Live mode:** the wristband streams at 1 Hz for 120 s per trigger (V5.3; 60 s before). The same 120 s applies after a fall.

## Automated tests

| Test | Result |
| :--- | :--- |
| Unit `test/unit/geofence_door.test.js` (20 tests: door zone; leaving: walk out, lost mid-room, back within 10 s, door next to a bed, wristband no longer heard, no door, coming back in; door watch: 10 s, passing through, short step out, once a minute, held position; live service from simulated LiDAR turns; headset first; unbound wristband; alert texts; CSV and shift report) | pass |
| Integration `test/integration/geofence_alerts.test.js` (5 tests on `shiro_test`: migration, one incident per event with its kind, patient, ward and position; unbound wristband; incident history) | pass |
| Unit `websocket_commands.test.js`, integration `http_hardening.test.js`: the 1 Hz command and its answer carry 120 s | pass |
| Wristband V5.3 compile (XIAO ESP32-C6) | 60 % of flash, 8 % of RAM |

## Live check (to be filled in)

Before you start: flash the wristband with V5.3, restart the edge server, bind the wristband to a patient in WARD-005, and check the LiDAR shows the patient as a violet 📡 dot.

### A. Live mode length

| Try | Started (time) | "1 Hz ACTIVE STREAM" ended after (s) |
| :---: | :--- | ---: |
| 1 | | |

Expected: about 120 s.

### B. Walking out of the ward (stay outside 30 s, then come back in)

| Run | AT THE DOOR alert | LEFT THE WARD alert after (s) | Alerts in total | Violet dot again after coming back in |
| :---: | :---: | ---: | :---: | :---: |
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |

Expected: no AT THE DOOR (walking through the doorway takes less than 10 s), one LEFT THE WARD about 11–12 s after passing the door, and the violet dot back within about 2 s of coming in.

### C. Standing in the doorway for 15 s, then walking back into the room

| Run | AT THE DOOR alert after (s) | LEFT THE WARD alert |
| :---: | ---: | :---: |
| 1 | | |
| 2 | | |
| 3 | | |

Expected: AT THE DOOR after about 10 s, no LEFT THE WARD. A LEFT THE WARD here would mean the LiDAR lost the tester in the doorway. It sits on the same wall as the door and sees the doorway almost edge-on.

### D. No alert expected

| Check | Tries | Alerts |
| :--- | :---: | :---: |
| In the doorway for 5 s, then back into the room | 5 | |
| 2 minutes of normal moving in the room | 1 | |
| Lie on the bed, get up | 2 | |
| Stand at the foot of the bed for 15 s (just south of the door zone) | 2 | |

## Limits

- **No LiDAR, no door alerts.** Bluetooth cannot tell the door zone from the rest of the room. An LD2450 radar would work with the same rule, because it also reports where people are.
- **A wristband taken off is not followed.** If the patient takes the wristband off and walks out, the alert may or may not come, depending on whether the link to the person has already ended.
- **A wrong link is reported for the patient.** When the wristband is linked to the wrong person (two people close together), that person's door events are reported for the patient.
- **One room, one tester**, and the door is on the LiDAR's own wall.

## Result

(to be written after the live check)
