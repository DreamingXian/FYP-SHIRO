# Person Detection and Linking on the Headset (Phase 8D)

Test record of the headset feature that links a patient's wristband to a person seen by the headset's depth sensor (FR-MR-05). It covers the automated tests, a stress test over 100 random variations of each simulated scene, and the device tests on the Meta Quest 3, with the problems each device test found and how they were fixed.

## Set-up

| Item | Value |
| :--- | :--- |
| Dates | 17 to 19 November 2026 |
| Tester | Project author |
| Code | branch `fix/phase-8-features`; last feature commit `e5a8557` |
| Headset | Meta Quest 3 via Quest Link (USB cable), Unity `6000.3.28f1`, Meta XR SDK v207; "Spatial Data over Meta Quest Link" switched on in the Meta Quest Link app |
| Edge server | Development laptop, Windows 11, Node.js 24, MariaDB 10.4 |
| Ward | WARD-004, a room of about 4 m × 3 m, 3 anchors |
| Test objects | A clothes rack (clothes up to the bar, about 1.6 m), the tester, a desk with a monitor and a speaker |

## 1. What is tested

1. **Depth points.** The headset casts a grid of 40 × 30 rays into the depth sensor's view five times per second, up to 6 m away. It uses distances only: no camera image is read and nothing is recorded.
2. **Person detector** (`ShiroPersonDetection.cs`, plain C#):
   - It measures the floor from the points, removes walls and the wearer's own hands, and groups the remaining points on a 10 cm floor grid into objects with a position and a height.
   - An object is a **person candidate** (green) when it is person-sized (0.9–2.1 m tall, at most 1.2 m² and 1.4 m long) and has **moved**. Moved means at least 0.4 m of confirmed steps within 10 s.
   - A step is a shift of at least 0.3 m, held for 1 s. It is proven either by the old spot being seen empty, or by the object now standing where empty space had been seen for at least 2 s.
   - A person-sized object that has not moved is **still** (yellow). Anything else is **not a person** (grey).
3. **Linker** (`ShiroPersonLinking.cs`, plain C#):
   - **Starting a link.** For each patient panel away from its bed, a person candidate within 0.5 m of the wristband's Bluetooth position can be linked. Candidates are scored on that distance, on height against the patient's recorded height, and on movement against the wristband's motion state.
   - **Ending or moving a link.** A link holds while the Bluetooth position stays within 1.5 m, and ends when it stays farther away for 5 s or the person is lost from view. Another person takes over only when clearly better for 2 s.
   - **Choosing by hand.** The clinician can aim at a person and pinch to choose them.
4. **Maps.** While a wristband is linked, the headset sends the person's position to the edge server. The dashboard's live map and the headset's Live Map then show the patient where the headset sees them, with the Bluetooth estimate as a faint dot alongside.

## 2. Automated tests

`dotnet run --project "quest3_client/Tests~/DetectionTests"` runs these tests. GitHub Actions also runs them on every push.

| Group | Tests | What they check |
| :--- | ---: | :--- |
| Detector | 32 | Height measured from the visible side; floor, walls and the wearer's hands left out; still furniture never a person; low objects (trolley, pet) and objects taller than a person rejected; steps and pacing; memory of a moved object out of view; floor measured even when the headset's guess is 25 cm off; restart after the headset is taken off and put on |
| Simulated scenes | 23 | A ray-cast simulation of a room with a rack, a cabinet, a monitor and a chair, seen by a moving wearer with depth noise; each scene once with a fixed seed |
| Linking | 12 | One person linked; only within 0.5 m (not 0.6 m, not 1.5 m); a wandering Bluetooth position up to 1.2 m off keeps the link for 60 s; 1.4 m kept, beyond 1.5 m for 5 s ends it; still objects never linked; two similar people: "unclear", no guess; height and motion pick the right one; hysteresis; a person lost: back to Bluetooth |
| Choosing by hand | 2 | The pointing ray picks the person it points at (a still person too), and nobody when it passes between two people, over a head or behind the wearer; a person chosen 4 m from the wristband is kept; Auto returns to automatic linking |
| **Total** | **69** | 69 passed at `e5a8557` |

## 3. Stress test: 100 random variations per scene

`dotnet run --project "quest3_client/Tests~/DetectionTests" -c Release -- --seeds 100` runs each scene with 100 random seeds. The seed changes the wearer's path, the depth noise and the timing. The run takes about 8 minutes.

Results on the detector of `f0e93b7`, which is unchanged in `e5a8557`:

| Scene | Passed |
| :--- | ---: |
| Walking around a room for 2 minutes (rack, cabinet, monitor, chair): nobody is a person | 100/100 |
| Walking a full circle around a still rack at 1.2 m: not a person | 100/100 |
| An object seen for the first time is never green at once | 100/100 |
| A rack pushed 0.5 m sideways becomes a person candidate | 100/100 |
| A rack pushed 0.5 m away with a foot while looking down, then stepped back: moved | 100/100 |
| A person walking across the room becomes a person candidate | 100/100 |
| A person pacing 0.35 m back and forth becomes a person candidate | 98/100 |
| A rack pulled 0.5 m straight toward the wearer becomes a person candidate | 100/100 |
| A rack pulled 0.45 m toward the wearer, then pushed back: two steps | 100/100 |
| A person walking straight toward the wearer becomes a person candidate | 100/100 |
| A person walking straight away from the wearer becomes a person candidate | 100/100 |
| A person pacing 0.4 m toward and away from the wearer becomes a person candidate | 100/100 |
| Walking up to a still rack and back, three times: not a person | 100/100 |
| Walking around the room with noisy depth (±3 cm at 2 m): nobody is a person | 100/100 |
| A rack pushed sideways with noisy depth becomes a person candidate | 100/100 |
| Fed row by row as on the headset: walking around the room, nobody is a person | 100/100 |
| Fed row by row as on the headset: a rack pulled toward the wearer becomes a person candidate | 100/100 |
| Two still things of similar height side by side, the gap between them filled now and then, 3 minutes: neither is a person | 100/100 |
| A monitor whose dark screen the sensor often misses, next to a speaker, 3 minutes: not a person | 98/100 |
| A person walking past a still rack of the same height becomes a person candidate, the rack does not | 99/100 |
| A pushed rack, looked away from and back at for 3 minutes: green until 2 minutes after its last step | 100/100 |
| A rack 14 cm in front of a wall pulled 0.5 m toward the wearer becomes a person candidate | 100/100 |
| A person with their back to a wall walks toward the wearer (wall top out of view) and becomes a person candidate | 100/100 |

The failures:

- **Pacing 0.35 m (2 of 100).** The pacing is barely more than one 0.3 m step, so it is borderline by design. A person walking a little farther counts every time.
- **Monitor (2 of 100).** The screen was missed long enough for the speaker beside it to seem to arrive in empty space. Before the fix of `f0e93b7` this scene passed 75 of 100.
- **Walking past a rack (1 of 100).** The person's track stayed on the rack as the two passed close together (identity swap), so the rack turned green.

## 4. Device tests on the Quest 3

| # | Date | Code | Check | Result |
| :--- | :--- | :--- | :--- | :--- |
| 4.1 | 17 Nov | `339fd1c` | Depth view: points, objects and labels in the room | Fail: objects measured about 2.4 m (even a 30 cm bed), a still rack became a person candidate, frame spikes of 30–40 ms. Fixed in `0756dde` and `5a02f9c`: the floor is measured instead of guessed, walls are not merged into objects, the ray grid is spread over five frames |
| 4.2 | 17 Nov | `5a02f9c` | Pacing in a small area | Fail: pacing within about 0.5 m of the first spot never counted as moved. Fixed in `78ac73e`: movement counted in steps |
| 4.3 | 17 Nov | `2b24db6` | Linking with the fake wristband (a simulated Bluetooth position wandering near the moved rack) | Pass, finding: the panel linked to the moved rack and stayed with it while the fake position wandered. Finding: the panel stood in front of the person and hid them. Changed in `5988c9a`: the patient's name floats above the person's head, the panel beside them |
| 4.4 | 17–18 Nov | `5988c9a`, `fd4bb21` | A rack pushed with a foot; headset taken off and put on; standing away from still objects | Mixed. Confirmed: the name above the head, and detection restarting after the headset is taken off and put on (before, the floor was then 0.3 m off). Worse: a pushed rack stayed yellow with no movement shown, still objects flickered grey, and places not yet looked at turned green. Back to the tested detector in `84fefe1`, keeping only the confirmed parts |
| 4.5 | 18 Nov | `84fefe1` | A rack pulled toward the wearer and pushed back | Fail: stayed "waiting to see that spot empty" (the old spot is hidden behind the rack). Fixed in `e91a036`: memory of empty space, a step proven from either side |
| 4.6 | 19 Nov | `e91a036` | Moves toward and away from the wearer; looking away and back | Pass, finding: moves in the wearer's own direction were detected, and the green mark stayed linked to the wristband panel after looking away and back. Finding: a still spot next to the monitor turned green from time to time. Fixed in `f0e93b7` (steps expire after 10 s, merged objects kept in place, no proof while another object stands at the old spot, 2 s of empty space before an arrival counts, a remembered green expires 2 minutes after the last step) |
| 4.7 | 19 Nov | `f0e93b7`, `ea28b81` | Monitor for 3–5 minutes; rack tests; dashboard and headset maps with a linked real wristband; linking off | Pass, finding: no false green at the monitor; the maps showed the patient at the headset's position with "seen by headset" and the Bluetooth estimate alongside; linking off returned to Bluetooth. Finding: a person 1.5 m from the wristband's Bluetooth position was still linked, so in a small ward the first person seen would take any wristband. Fixed in `e5a8557` (links start within 0.5 m only) |
| 4.8 | 19 Nov | `e5a8557` | Range test with the fake wristband and a real one; choosing by hand (Re-Attach, aim, pinch); Auto; pinning a spot; the chosen person out of view | Pass |
| 4.9 | 19 Nov | `e5a8557` | Ward alignment after the headset sleeps (regression finding F-5) | Pass: the overlay is back in place and saving the anchor works |
| 4.10 | 19 Nov | `e5a8557` | Automatic ward detection (8D-2) | Pass in one room: "Find My Current Ward" recognises WARD-004. Walking between two calibrated rooms: **Not run**. Only one room is equipped, and the cable of Quest Link keeps the headset in it. To be run with the standalone APK |

**Frame rate over Quest Link.** After the ray grid was spread over five frames (4.1), one depth update took 7–9 ms. The frame rate over Link still varied between about 36 and 69 fps. In the Meta Quest Link app's cable test, the USB-C cable measured only 2.6–3 Gbps, and a USB 2.0 cable gave under 10 fps. So the frame rate over Link depends on the cable, and NFR-PERF-02 (≥ 72 fps) is to be measured on the standalone APK.

The test of the fake wristband reporting "walking" or "still" (8D-6) was removed for now. It will be run after the wristband's motion-state detection is improved (regression finding F-3).

## 5. Known limitations

1. **Things side by side.** Two objects of similar height closer than about 20 cm can be seen as one. While merged, both keep their places, so this does not create a false move. While merged, though, they are one object.
2. **Screens, mirrors and glass.** The depth sensor misses dark, glossy or transparent surfaces now and then. The detector tolerates this (section 3, monitor scene), but a rare false green next to a screen is still possible.
3. **Identity swaps.** A person walking very close past a still object of the same height can leave their track on that object (1 in 100 in the stress test).
4. **Only what the headset sees.** A person out of view (behind the wearer, behind a curtain, more than 6 m away) is lost after 2 s. The panel then goes back to the Bluetooth position until the person is seen and linked again.
5. **A link depends on the Bluetooth position.** A link starts only when the Bluetooth estimate is within 0.5 m of the person. With the current positioning accuracy (regression finding F-2), a patient may stay unlinked until the estimate comes close. Choosing by hand is the fallback.
6. **A person who never moves.** A patient standing still since the headset came on stays "still" (yellow) and is not linked automatically. They can be chosen by hand.
7. **Motion state.** The motion factor of the score uses the wristband's motion state, which often reports hand movement while walking (F-3). It only lowers a score by half; it cannot link anyone on its own.

## Result

| | Count |
| :--- | ---: |
| Automated tests | 69 of 69 passed |
| Stress test | 23 scenes; 20 at 100/100, the other three at 98, 98 and 99 of 100 |
| Device checks | 10 rounds: 6 passed (4.3, 4.6 to 4.10; 4.10 in one room only); 3 failed and were fixed in later commits (4.1, 4.2, 4.5); 1 mixed, partly undone (4.4). The walk between two rooms is not run yet |

The headset now links a patient's wristband to the person it sees, without a camera image. The panel and both maps follow that person, and the clinician can choose the person by hand when the system cannot tell. FR-MR-05 is met, with the limitations above.
