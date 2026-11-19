# Standalone Headset App (APK) on the Meta Quest 3 (Phase 9D)

Test record of the first standalone build of the headset app. Until Phase 9 the app ran only from the Unity editor over a Quest Link cable. As an APK it runs on the Meta Quest 3 alone and reaches the edge server over Wi-Fi. This record lists what the device tests found and how each problem was fixed.

## Set-up

| Item | Value |
| :--- | :--- |
| Date | 20 November 2026 |
| Tester | Project author |
| Code | branch `fix/phase-9-easy-fixes`; preparation `29d60ad`, fixes `926c2dc` and `acad927` |
| Build | Unity `6000.3.28f1`, URP, Meta XR SDK v207 (OpenXR), IL2CPP ARM64; package `com.shiro.mrpatientconnect` 1.1.0; `quest3_client/Builds/SHIRO_MR.apk`, settings applied with **SHIRO → Apply APK build settings** |
| Headset | Meta Quest 3, app installed over USB as in the startup guide, section 6.3 (Method B) |
| Edge server | Development laptop on the same Wi-Fi network; address typed on the hand slate's keypad, headset paired with a 6-digit code |
| Ward | WARD-004, a room of about 4 m × 3 m |

## Results

| # | Check | Build 1 | Fix | Final build |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Connects to the edge server after pairing; patient data arrives | Pass | – | Pass |
| 2 | Ward alignment; ward objects (walls, door frame, beds) shown | **Fail**: objects magenta (pink-purple) in both eyes; text labels ("Door", "Bed 1") correct | `926c2dc`: the objects get their materials from templates that are always included in the build (`ShiroMaterials`, `Assets/Resources/ShiroMR/`) | Pass |
| 3 | The user can close the app | **Fail**: no way out except switching the headset off | `926c2dc`: **System → ✖ Quit app** on the hand slate, with a confirmation | Pass |
| 4 | Works anywhere in the clinic | **Fail**: the app stopped at the edge of the boundary area set up on the headset | `acad927`: Boundary Visibility Support switched on, so the headset hides the boundary while passthrough is on (Meta Boundary API) | Pass: used outside the boundary area |
| 5 | Person detection and linking | Works inside the aligned ward only | None: by design (see below) | As designed |
| 6 | Button click sound | **Fail**: no sound | Open: moved to Phase 11 (UI/UX) | Open |

**Cause of 2.** In a build, objects made with `GameObject.CreatePrimitive` get the built-in Standard material, which URP cannot draw (magenta). The URP shaders the code found by name were also removed from the build, because no scene or asset used them. Over Quest Link the editor has every shader, so the problem showed only in the APK.

**Cause of 4.** The app already asked the headset to hide the boundary. Without Boundary Visibility Support, however, the build leaves the permission `com.oculus.permission.BOUNDARY_VISIBILITY` out of the app manifest, and the headset ignores the request.

**Decision on 5 (20 Nov).** Person detection and linking stay limited to the calibrated ward:
- the wristband's Bluetooth position, which a link needs, exists only inside a ward with anchors;
- in corridors anyone (staff, visitors) would be detected;
- alignment errors grow with distance from the ward.

## Not tested yet

- Walking between two calibrated rooms (automatic ward detection). Planned for the final APK after Phase 11.
- Frame rate on the headset (NFR-PERF-02, at least 72 FPS) and battery runtime. To be measured on the final APK with the OVR Metrics Tool.
  - The scene's OVRManager has dynamic resolution on: the eye-buffer scale moves between 0.7 and 1.6 with the GPU load.
- The alert tone in the APK (checked together with item 6).
