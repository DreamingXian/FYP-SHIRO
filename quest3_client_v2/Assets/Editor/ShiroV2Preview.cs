// =============================================================================
// Project SHIRO - headset app version 2: preview images of the new interface
//
// SHIRO → v2: Save UI preview images. Builds the new parts with sample data (the
// longest wording included: test alarms, long names, two-line states) in a
// temporary scene and saves a PNG of each (Builds/ui_preview/), over a light grey
// background like a ward wall seen through the passthrough. Then it lists every
// text that did not fit its box ("Text cut"), or says none was cut.
// Safe to run in the open editor (not in Play mode): the open scene is kept.
// For checking the look without a headset; the headset is still the real test.
// Batch mode (not -nographics):
//   Unity.exe -batchmode -quit -projectPath <quest3_client_v2>
//     -executeMethod ShiroMR.EditorTools.ShiroV2Preview.SaveAll
// =============================================================================
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using ShiroMR.UI;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace ShiroMR.EditorTools
{
    public static class ShiroV2Preview
    {
        private const BindingFlags Any = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
        private const int PreviewLayer = 31;   // only the shot canvas is on it
        private static readonly Color Wall = new Color32(214, 208, 198, 255);
        private static readonly List<string> Cut = new List<string>();

        [MenuItem("SHIRO/v2: Save UI preview images")]
        public static void SaveAll()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode)
            {
                Debug.LogWarning("[SHIRO v2] Stop Play mode first, then save the previews.");
                return;
            }
            string dir = Path.GetFullPath("Builds/ui_preview");
            Directory.CreateDirectory(dir);
            Cut.Clear();

            // A temporary scene next to the open one (closed again at the end). With only an
            // untitled scene open (batch mode), Unity cannot add one: that scene is replaced.
            Scene before = SceneManager.GetActiveScene();
            bool additive = before.IsValid() && !string.IsNullOrEmpty(before.path);
            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, additive ? NewSceneMode.Additive : NewSceneMode.Single);
            SceneManager.SetActiveScene(scene);
            try
            {
                ShootAlerts(dir);
                ShootTags(dir);
                ShootWardPanel(dir);
                ShootWristChip(dir);
            }
            finally
            {
                if (additive)
                {
                    if (before.IsValid()) SceneManager.SetActiveScene(before);
                    EditorSceneManager.CloseScene(scene, true);
                }
            }

            Debug.Log($"[SHIRO v2] UI previews saved in {dir}");
            if (Cut.Count == 0) Debug.Log("[SHIRO v2] Text check: no text cut in any preview.");
            else foreach (var c in Cut) Debug.LogWarning($"[SHIRO v2] Text cut: {c}");
        }

        private static void ShootAlerts(string dir)
        {
            var card = new GameObject("PreviewAlert").AddComponent<ShiroAlertCard>();
            Call(card, "Build");
            Transform cardCanvas = Child(card.transform, "AlertCard");

            // Test alarms, as the dashboard's Test tools send them (the longest titles)
            var fall = Alert("INC-1", "FALL_ACCIDENT", null, "Siti Nurhaliza", true, -40);
            Call(card, "Fill", fall, 2);
            Get<ShiroButton>(card, "_mute").SetText("Unmute");   // muted: the longest label
            Shoot(cardCanvas, Path.Combine(dir, "alert_test_fall_muted.png"));

            var vitals = Alert("INC-2", "CRITICAL_VITALS", null, "Muhammad Hafiz bin Abdullah", true, -75);
            vitals.incident.heart_rate = 142;
            vitals.incident.spo2 = 88;
            Call(card, "Fill", vitals, 3);
            Shoot(cardCanvas, Path.Combine(dir, "alert_test_vitals.png"));

            var left = Alert("INC-3", "GEOFENCE_BREACH", "LEFT_WARD", "Tan Ah Kow", true, -600);
            Call(card, "Fill", left, 1);
            Shoot(cardCanvas, Path.Combine(dir, "alert_test_left_ward.png"));

            // Answered on the dashboard (the longest state line)
            var answered = Alert("INC-4", "GEOFENCE_BREACH", "AT_DOOR", "Siti Nurhaliza binti Ahmad", true, -30);
            answered.status = ShiroAlertManager.AlertStatus.AcknowledgedElsewhere;
            answered.acknowledgedBy = "Nurse Aisyah Binti Kamarudin (dashboard)";
            answered.acknowledgedAt = "10:42";
            Call(card, "Fill", answered, 3);
            Shoot(cardCanvas, Path.Combine(dir, "alert_answered.png"));

            Call(card, "Fill", vitals, 1);
            Shoot(Child(card.transform, "AlertBar"), Path.Combine(dir, "alert_bar.png"), true);
        }

        private static ShiroAlertManager.HeadsetAlert Alert(string id, string category, string geofence, string name, bool test, int secondsAgo)
        {
            return new ShiroAlertManager.HeadsetAlert
            {
                incident = new IncidentAlert
                {
                    incident_id = id, patient_id = "P-" + id, patient_name = name, ward_id = "WARD-001",
                    bed_id = "BED-001-02", incident_category = category, geofence_kind = geofence,
                    alert_message = test ? "[SIMULATION] preview" : "preview",
                    trigger_timestamp = DateTime.UtcNow.AddSeconds(secondsAgo).ToString("o")
                }
            };
        }

        private static void ShootTags(string dir)
        {
            var holo = new GameObject("PreviewTag").AddComponent<PatientHologram>();
            holo.fullName = "Siti Nurhaliza binti Ahmad";
            holo.assignedBed = "BED-001-02";
            Call(holo, "BuildHologramVisuals");
            Child(holo.transform, "FloorFootprintRing").gameObject.SetActive(false);   // on the floor in the room, not on the tag
            var tag = Child(holo.transform, "PatientTag");
            tag.localScale = Vector3.one * 0.001f;

            // Live value
            holo.UpdateTelemetryState(new TelemetryData { touch = 1, active = true, battery = 80 });
            holo.UpdateTelemetry(72, 97, 80);
            Refresh(holo);
            Shoot(tag, Path.Combine(dir, "tag_live.png"));

            // Measuring, battery low
            holo.UpdateTelemetryState(new TelemetryData { touch = 1, active = false, battery = 15 });
            holo.UpdateTelemetry(0, 0, 15);
            Refresh(holo);
            Shoot(tag, Path.Combine(dir, "tag_measuring_battery_low.png"));

            // Resting between readings: the last value, two lines
            holo.UpdateTelemetry(68, 97, 80);
            holo.UpdateTelemetryState(new TelemetryData { touch = 0, active = false, battery = 80 });
            holo.UpdateTelemetry(0, 0, 80);
            Refresh(holo);
            Shoot(tag, Path.Combine(dir, "tag_resting.png"));

            // Not heard: two lines
            holo.NoteSignal(false);
            Refresh(holo);
            Shoot(tag, Path.Combine(dir, "tag_no_signal.png"));
            holo.NoteSignal(true);

            // Details open
            holo.UpdateTelemetryState(new TelemetryData { touch = 1, active = true, battery = 100, charging = true });
            holo.UpdateTelemetry(72, 97, 100);
            Call(holo, "ToggleDetails");
            Refresh(holo);
            Shoot(tag, Path.Combine(dir, "tag_details.png"));

            // An alert waiting (the longest alert line)
            holo.SetAlarm(true, "CRITICAL VITALS");
            Call(holo, "UpdateAlarmVisuals");
            Call(holo, "FitHeartLine");
            Shoot(tag, Path.Combine(dir, "tag_alarm.png"));
        }

        // ----- Ward panel and wrist chip (stage 2) -----

        private static void ShootWardPanel(string dir)
        {
            var panel = new GameObject("PreviewWardPanel").AddComponent<ShiroWardPanel>();
            Call(panel, "Build");
            Transform canvas = Child(panel.transform, "WardPanel");
            Get<TextMeshProUGUI>(panel, "_title").text = "Ward A - Medical";
            Get<TextMeshProUGUI>(panel, "_status").text = "Connected · used by Nurse Aisyah Binti Kamarudin";
            Get<UnityEngine.UI.Image>(panel, "_statusDot").color = ShiroTheme.Good;
            var tabs = Get<ShiroButton[]>(panel, "_tabs");
            tabs[0].SetText("Patients (6)");

            // Patients: an alert, a check, fine, resting, not heard, no position (two pages)
            var rows = new List<ShiroWardPanel.PatientRow>
            {
                Row("Siti Nurhaliza binti Ahmad", "Fall detected: waiting for a response", "88", false, ShiroTheme.Alert, ShiroTheme.AlertText, true),
                Row("Muhammad Hafiz bin Abdullah", "Bed 3 · No skin contact · battery 15 %", "--", true, ShiroTheme.Warn, ShiroTheme.WarnText, false),
                Row("Tan Ah Kow", "Bed 1 · Live, every second", "72", false, ShiroTheme.Ok, ShiroTheme.TextDim, false),
                Row("Lim Mei Ling", "Bed 12 · Next reading within 3 min · battery 15 %", "68", true, ShiroTheme.Warn, ShiroTheme.WarnText, false),
                Row("Rajesh Kumar", "Bed 5 · No signal for 5 min", "--", true, ShiroTheme.Off, ShiroTheme.TextDim, false),
                Row("Nur Aina", "Bed 6 · no position yet", "--", true, ShiroTheme.Off, ShiroTheme.TextDim, false),
            };
            SelectPage(panel, 0);
            Call(panel, "ShowRows", rows);
            Shoot(canvas, Path.Combine(dir, "panel_patients.png"), true);

            // A "Show me" note while there are pages (the longest note)
            Get<TextMeshProUGUI>(panel, "_note").text = "Muhammad: no position yet; the arrow shows their bed.";
            Get<TextMeshProUGUI>(panel, "_note").color = ShiroTheme.OkText;
            Shoot(canvas, Path.Combine(dir, "panel_patients_note.png"), true);

            // Page 2 of the same six patients (the pager as on the web dashboard)
            Get<TextMeshProUGUI>(panel, "_note").color = ShiroTheme.TextDim;
            Call(panel, "GoToPage", 2);
            Call(panel, "ShowRows", rows);
            Shoot(canvas, Path.Combine(dir, "panel_patients_page2.png"), true);

            // Fourteen patients: four pages, "…" between the page numbers
            var many = new List<ShiroWardPanel.PatientRow>(rows);
            for (int i = 7; i <= 14; i++)
                many.Add(Row($"Sample patient {i}", $"Bed {i} · Measured 2 min ago", "70", true, ShiroTheme.Ok, ShiroTheme.TextDim, false));
            Call(panel, "GoToPage", 1);
            Call(panel, "ShowRows", many);
            Shoot(canvas, Path.Combine(dir, "panel_patients_many.png"), true);
            Call(panel, "GoToPage", 1);

            // Map: a 6 × 5 m ward, door on the south wall, four beds, three patients (one not heard)
            SelectPage(panel, 1);
            var ward = new WardConfig
            {
                ward_id = "WARD-001", room_title = "Ward A - Medical", length_x = 6f, width_y = 5f,
                door = new WardDoor { wall = "SOUTH", x = 2.5f, width = 1f },
                beds = new List<WardBed>
                {
                    new WardBed { bed_id = "BED-001-01", bed_code = "Bed 1", x = 0.3f, y = 3.0f, width = 0.9f, length = 1.9f },
                    new WardBed { bed_id = "BED-001-02", bed_code = "Bed 2", x = 1.6f, y = 3.0f, width = 0.9f, length = 1.9f },
                    new WardBed { bed_id = "BED-001-03", bed_code = "Bed 3", x = 3.5f, y = 3.0f, width = 0.9f, length = 1.9f },
                    new WardBed { bed_id = "BED-001-04", bed_code = "Bed 4", x = 4.8f, y = 3.0f, width = 0.9f, length = 1.9f },
                }
            };
            var subjects = new List<TrackedSubject>
            {
                new TrackedSubject { full_name = "Tan Ah Kow", device_id = "TAG-001", assigned_bed_id = "BED-001-01" },
                new TrackedSubject { full_name = "Siti Nurhaliza binti Ahmad", device_id = "TAG-002", assigned_bed_id = "BED-001-02" },
                new TrackedSubject { full_name = "Rajesh Kumar", device_id = "TAG-003", assigned_bed_id = "BED-001-03" },
            };
            object map = Get<object>(panel, "_map");
            Call(map, "PreviewMark", "TAG-001", 0.75f, 3.9f, 1f);
            Call(map, "PreviewMark", "TAG-002", 2.6f, 1.4f, 1f);
            Call(map, "PreviewMark", "TAG-003", 4.4f, 2.2f, 30f);
            Call(map, "Refresh", ward, subjects, true);
            Shoot(canvas, Path.Combine(dir, "panel_map.png"), true);

            // Settings: the ward found automatically (the longest status); not paired
            SelectPage(panel, 2);
            Get<TextMeshProUGUI>(panel, "_wardName").text = "Ward A - Medical";
            Get<TextMeshProUGUI>(panel, "_wardAuto").text = "No aligned ward found here. A new ward needs its room set up once (Room setup and tools).";
            var conn = Get<TextMeshProUGUI>(panel, "_connection");
            conn.text = "Not connected to the edge server at 192.168.1.229:3000.\nHS-7F3A2C1B is not paired yet: Server and pairing.";
            conn.color = ShiroTheme.WarnText;
            Shoot(canvas, Path.Combine(dir, "panel_settings.png"), true);

            // Settings, choose by hand: three wards, this one shown
            Call(panel, "ShowSettingsList", true);
            var wards = new List<WardSummary>
            {
                new WardSummary { ward_id = "WARD-001", room_title = "Ward A - Medical" },
                new WardSummary { ward_id = "WARD-002", room_title = "Ward B - Surgical Recovery" },
                new WardSummary { ward_id = "WARD-003", room_title = "" },
            };
            Call(panel, "ShowWards", wards, "WARD-001");
            Shoot(canvas, Path.Combine(dir, "panel_settings_by_hand.png"), true);
        }

        private static ShiroWardPanel.PatientRow Row(string name, string line, string value, bool dim, Color stripe, Color lineColour, bool alert)
        {
            return new ShiroWardPanel.PatientRow
            {
                Name = name, Line = line, Value = value, ValueDim = dim, Stripe = stripe, LineColour = lineColour, Alert = alert
            };
        }

        private static void SelectPage(ShiroWardPanel panel, int page)
        {
            var pageType = typeof(ShiroWardPanel).GetNestedType("Page", BindingFlags.NonPublic);
            Call(panel, "SelectPage", Enum.ToObject(pageType, page));
        }

        private static void ShootWristChip(string dir)
        {
            var chip = new GameObject("PreviewWristChip").AddComponent<ShiroWristChip>();
            Call(chip, "Build");
            Transform canvas = Child(chip.transform, "WristChip");
            Get<TextMeshProUGUI>(chip, "_text").text = "Ward A - Medical";
            Get<UnityEngine.UI.Image>(chip, "_dot").color = ShiroTheme.Good;
            Shoot(canvas, Path.Combine(dir, "wrist_chip.png"), true);

            Get<TextMeshProUGUI>(chip, "_text").text = "2 alerts";
            Get<UnityEngine.UI.Image>(chip, "_dot").color = Color.white;
            Get<ShiroButton>(chip, "_button").SetColorOverride(ShiroTheme.Alert);
            Shoot(canvas, Path.Combine(dir, "wrist_chip_alert.png"), true);
        }

        private static void Refresh(PatientHologram holo)
        {
            Call(holo, "RefreshUiText");
            Call(holo, "FitHeartLine");
        }

        private static object Call(object target, string method, params object[] args)
        {
            var m = target.GetType().GetMethod(method, Any);
            if (m == null) throw new MissingMethodException(target.GetType().Name, method);
            return m.Invoke(target, args);
        }

        private static T Get<T>(object target, string field) where T : class
        {
            var f = target.GetType().GetField(field, Any);
            if (f == null) throw new MissingFieldException(target.GetType().Name, field);
            return f.GetValue(target) as T;
        }

        private static Transform Child(Transform root, string name)
        {
            foreach (var t in root.GetComponentsInChildren<Transform>(true)) if (t.name == name) return t;
            throw new Exception($"No child {name} under {root.name}");
        }

        /// <summary>Renders one canvas (4 px per mm) with an orthographic camera into a PNG, and checks its text.</summary>
        private static void Shoot(Transform canvasTransform, string file, bool activate = false)
        {
            var go = canvasTransform.gameObject;
            bool wasActive = go.activeSelf;
            if (activate) go.SetActive(true);
            // Buttons draw their colours in LateUpdate, which edit mode does not run
            foreach (var b in go.GetComponentsInChildren<ShiroButton>(true)) Call(b, "ApplyLook");
            int oldLayer = go.layer;
            foreach (var t in go.GetComponentsInChildren<Transform>(true)) t.gameObject.layer = PreviewLayer;

            Vector3 oldPos = canvasTransform.position;
            Quaternion oldRot = canvasTransform.rotation;
            canvasTransform.SetPositionAndRotation(new Vector3(0f, -500f, 0f), Quaternion.identity);   // away from anything in the open scene
            var rt = (RectTransform)canvasTransform;
            Canvas.ForceUpdateCanvases();
            foreach (var t in go.GetComponentsInChildren<TMP_Text>(true)) t.ForceMeshUpdate();

            // Text that did not fit its box
            foreach (var t in go.GetComponentsInChildren<TMP_Text>(false))
            {
                string c = ShiroTextCheck.Check(t);
                if (c != null) Cut.Add($"{Path.GetFileName(file)}: {c}");
            }

            Vector3[] corners = new Vector3[4];
            rt.GetWorldCorners(corners);
            Vector3 centre = (corners[0] + corners[2]) / 2f;
            float wM = Vector3.Distance(corners[0], corners[3]);
            float hM = Vector3.Distance(corners[0], corners[1]);
            float margin = 0.012f;
            int pxW = Mathf.RoundToInt((wM + 2 * margin) * 4000f);
            int pxH = Mathf.RoundToInt((hM + 2 * margin) * 4000f);

            var camGo = new GameObject("PreviewCamera");
            var cam = camGo.AddComponent<Camera>();
            cam.orthographic = true;
            cam.orthographicSize = (hM + 2 * margin) / 2f;
            cam.aspect = (float)pxW / pxH;
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = Wall;
            cam.cullingMask = 1 << PreviewLayer;
            cam.nearClipPlane = 0.01f;
            cam.farClipPlane = 5f;
            camGo.transform.SetPositionAndRotation(centre - Vector3.forward * 1f, Quaternion.identity);

            var rtex = new RenderTexture(pxW, pxH, 24, RenderTextureFormat.ARGB32) { antiAliasing = 4 };
            cam.targetTexture = rtex;
            cam.Render();
            var prev = RenderTexture.active;
            RenderTexture.active = rtex;
            var img = new Texture2D(pxW, pxH, TextureFormat.RGB24, false);
            img.ReadPixels(new Rect(0, 0, pxW, pxH), 0, 0);
            img.Apply();
            RenderTexture.active = prev;
            File.WriteAllBytes(file, img.EncodeToPNG());

            cam.targetTexture = null;
            UnityEngine.Object.DestroyImmediate(rtex);
            UnityEngine.Object.DestroyImmediate(camGo);
            UnityEngine.Object.DestroyImmediate(img);
            canvasTransform.SetPositionAndRotation(oldPos, oldRot);
            foreach (var t in go.GetComponentsInChildren<Transform>(true)) t.gameObject.layer = oldLayer;
            if (activate) go.SetActive(wasActive);
        }
    }
}
