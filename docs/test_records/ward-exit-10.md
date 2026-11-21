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
| Unit `test/unit/geofence_door.test.js` (20 tests: door zone; leaving: walk out, lost mid-room, back within 10 s, door next to a bed, wristband no longer heard, no door, coming back in; door watch: 10 s, passing through, short step out, one per visit, held position; live service from simulated LiDAR turns; headset first; unbound wristband; alert texts; CSV and shift report) | pass |
| Integration `test/integration/geofence_alerts.test.js` (5 tests on `shiro_test`: migration, one incident per event with its kind, patient, ward and position; unbound wristband; incident history) | pass |
| Unit `websocket_commands.test.js`, integration `http_hardening.test.js`: the 1 Hz command and its answer carry 120 s | pass |
| Wristband V5.3 compile (XIAO ESP32-C6) | 60 % of flash, 8 % of RAM |

## Live check, 21 November 2026, 19:29–19:44

Edge server `fbc41f7`, wristband V5.3, one tester wearing the wristband bound to a test patient in WARD-005. The times and incidents below are from the server log.

### A. Live mode length

| Try | Started | Ended after |
| :---: | :--- | :--- |
| 1 | 19:31:13 (server: "1 Hz monitoring … 120s … through anchor-006") | about 120 s (tester) |

### B. Walking out of the ward and coming back in

"Lost" is when the LiDAR's tracker let the tester go (1.5 s after the last sighting); "back in" is when the LiDAR linked the wristband again to a person first seen at the door.

| Run | Last seen at (x, y) | Lost | LEFT THE WARD (incident) | Last seen → alert | AT THE DOOR | Back in |
| :---: | :--- | :--- | :--- | ---: | :---: | :--- |
| 1 | 2.07, 2.86 | 19:34:12.5 | 19:34:22.6 (…0027) | 12 s | no | 19:34:29.9 |
| 2 | 2.04, 2.81 | 19:35:34.6 | 19:35:44.7 (…0028) | 12 s | no | 19:35:55.7 |
| 3 | 2.05, 2.87 | 19:36:04.3 | 19:36:14.4 (…0029) | 12 s | no | 19:36:32.6 |
| 4 | 2.03, 2.94 | 19:36:40.7 | 19:36:50.7 (…0030) | 12 s | no | 19:36:54.7 |
| 5 | 2.04, 2.89 | 19:37:05.5 | 19:37:15.5 (…0031) | 12 s | no | 19:37:26.1 |
| 6 | 2.04, 2.91 | 19:37:36.8 | 19:37:46.8 (…0032) | 12 s | no | 19:37:51.9 |
| 7 | 2.05, 2.86 | 19:43:55.8 | 19:44:05.8 (…0036) | 12 s | no | 19:44:12.4 |

- 7 walk-outs, 7 alerts, one each. Every alert came 10.0 s after "lost", 12 s (rounded) after the last sighting. The tester timed about 11 s from passing the door.
- The last sightings were all within 0.3 m of the door wall (x 2.03–2.07; the wall is at x 2.29), well inside the door zone.
- No AT THE DOOR while walking out.
- The patient was picked up again on every return through the door (7 / 7).

### C. Standing in the doorway, then walking back into the room

| Run | AT THE DOOR (incident) | In the doorway for | LEFT THE WARD |
| :---: | :--- | ---: | :---: |
| 1 | 19:38:10.6 (…0033) | 10 s | no |
| 2 | 19:39:10.7 (…0034) | **18 s** | no |
| 3 | 19:41:25.5 (…0035) | 10 s | no |

Run 2 came 60.1 s after run 1. The once-a-minute limit of `fbc41f7` held it back until then, which does not match the rule "more than 10 s at the door gives an alert". The limit was removed after this check: each visit to the door raises its own alert after 10 s (unit test "one event per visit").

### D. No alert expected

| Check | Alerts |
| :--- | :---: |
| In the doorway for 5 s, then back into the room | 0 |
| Normal moving in the room | 0 |
| Lie on the bed, get up (2 ×; held in bed 19:42:00 and 19:42:22, picked up on getting up 19:42:13 and 19:42:42) | 0 |
| Stand at the foot of the bed for 15 s | 0 |

### Observation: the link dropped twice while the tester was in the room

At 19:40:24 and 19:40:50 the wristband's LiDAR link ended without the LiDAR losing the tester: the same person (`lidar-001#20`) before and after. The map showed Bluetooth for 10 s and 16 s, until the link was made again (19:40:34, 19:41:06). The log does not say which rule ended it. Either the Bluetooth position stayed more than 2.5 m from the tester for 5 s, or there was no fresh Bluetooth position for 3.5 s. While unlinked, neither door alert can be raised for that patient. Not changed in this phase.

## Limits

- **No LiDAR, no door alerts.** Bluetooth cannot tell the door zone from the rest of the room. An LD2450 radar would work with the same rule, because it also reports where people are.
- **A wristband taken off is not followed.** If the patient takes the wristband off and walks out, the alert may or may not come, depending on whether the link to the person has already ended.
- **A wrong link is reported for the patient.** When the wristband is linked to the wrong person (two people close together), that person's door events are reported for the patient.
- **One room, one tester**, and the door is on the LiDAR's own wall.

## Result

- **Left the ward:** 7 / 7 walk-outs raised one alert each, 12 s after the last sighting, and no false alert.
- **At the door:** 3 / 3 doorway stays raised an alert. One came late (18 s) because of the once-a-minute limit, which was removed afterwards.
- **No alert expected:** none in the checks of D.
- **Live mode:** 120 s.
- **Status:** UC-02 A1 works in WARD-005 with the LiDAR, within the limits above.
