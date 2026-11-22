// =============================================================================
// Project SHIRO - headset app version 2: preview images of the new interface
//
// SHIRO → v2: Save UI preview images. Builds the new parts with sample data in an
// empty scene and saves a PNG of each (Builds/ui_preview/), over a light grey
// background like a ward wall seen through the passthrough. For checking the look
// without a headset; the headset is still the real test.
// Batch mode (not -nographics):
//   Unity.exe -batchmode -quit -projectPath <quest3_client_v2>
//     -executeMethod ShiroMR.EditorTools.ShiroV2Preview.SaveAll
// =============================================================================
using System;
using System.IO;
using System.Reflection;
using ShiroMR.UI;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace ShiroMR.EditorTools
{
    public static class ShiroV2Preview
    {
        private const BindingFlags Any = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
        private static readonly Color Wall = new Color32(214, 208, 198, 255);

        [MenuItem("SHIRO/v2: Save UI preview images")]
        public static void SaveAll()
        {
            string dir = Path.GetFullPath("Builds/ui_preview");
            Directory.CreateDirectory(dir);
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            // Alert card: a fall waiting for a response
            var card = new GameObject("PreviewAlert").AddComponent<ShiroAlertCard>();
            Call(card, "Build");
            var pending = new ShiroAlertManager.HeadsetAlert
            {
                incident = new IncidentAlert
                {
                    incident_id = "INC-1", patient_id = "P-002", patient_name = "Siti Nurhaliza", ward_id = "WARD-001",
                    bed_id = "BED-001-02", incident_category = "FALL_ACCIDENT",
                    trigger_timestamp = DateTime.UtcNow.AddSeconds(-40).ToString("o")
                }
            };
            Call(card, "Fill", pending, 2);
            Shoot(Child(card.transform, "AlertCard"), Path.Combine(dir, "alert_card.png"));

            // Answered on the dashboard
            pending.status = ShiroAlertManager.AlertStatus.AcknowledgedElsewhere;
            pending.acknowledgedBy = "Nurse Aisyah (dashboard)";
            pending.acknowledgedAt = "10:42";
            Call(card, "Fill", pending, 1);
            Shoot(Child(card.transform, "AlertCard"), Path.Combine(dir, "alert_answered.png"));
            Shoot(Child(card.transform, "AlertBar"), Path.Combine(dir, "alert_bar.png"), true);

            // Patient tag: live value, then measuring, then the details
            var holo = new GameObject("PreviewTag").AddComponent<PatientHologram>();
            holo.fullName = "Tan Ah Kow";
            holo.assignedBed = "BED-001-01";
            Call(holo, "BuildHologramVisuals");
            Child(holo.transform, "FloorFootprintRing").gameObject.SetActive(false);   // on the floor in the room, not on the tag
            var tag = Child(holo.transform, "PatientTag");
            tag.localScale = Vector3.one * 0.001f;
            holo.UpdateTelemetry(72, 97, 80);
            Call(holo, "RefreshUiText");
            Shoot(tag, Path.Combine(dir, "tag_live.png"));

            holo.UpdateTelemetryState(new TelemetryData { touch = 1, active = false, battery = 15 });
            holo.UpdateTelemetry(0, 0, 15);
            Call(holo, "RefreshUiText");
            Shoot(tag, Path.Combine(dir, "tag_measuring_battery_low.png"));

            Call(holo, "ToggleDetails");
            Shoot(tag, Path.Combine(dir, "tag_details.png"));

            holo.SetAlarm(true, "FALL");
            Call(holo, "UpdateAlarmVisuals");
            Shoot(tag, Path.Combine(dir, "tag_alarm.png"));

            Debug.Log($"[SHIRO v2] UI previews saved in {dir}");
        }

        private static object Call(object target, string method, params object[] args)
        {
            var m = target.GetType().GetMethod(method, Any);
            if (m == null) throw new MissingMethodException(target.GetType().Name, method);
            return m.Invoke(target, args);
        }

        private static Transform Child(Transform root, string name)
        {
            foreach (var t in root.GetComponentsInChildren<Transform>(true)) if (t.name == name) return t;
            throw new Exception($"No child {name} under {root.name}");
        }

        /// <summary>Renders one canvas (4 px per mm) with an orthographic camera into a PNG.</summary>
        private static void Shoot(Transform canvasTransform, string file, bool activate = false)
        {
            var go = canvasTransform.gameObject;
            if (activate) go.SetActive(true);
            // Buttons draw their colours in LateUpdate, which edit mode does not run
            foreach (var b in go.GetComponentsInChildren<ShiroButton>(true)) Call(b, "ApplyLook");
            // Only this canvas is visible
            var others = UnityEngine.Object.FindObjectsByType<Canvas>(FindObjectsInactive.Exclude, FindObjectsSortMode.None);
            var hidden = new System.Collections.Generic.List<GameObject>();
            foreach (var c in others) if (c.gameObject != go && c.renderMode == RenderMode.WorldSpace) { c.gameObject.SetActive(false); hidden.Add(c.gameObject); }

            canvasTransform.SetPositionAndRotation(Vector3.zero, Quaternion.identity);
            var rt = (RectTransform)canvasTransform;
            Canvas.ForceUpdateCanvases();
            foreach (var t in go.GetComponentsInChildren<TMP_Text>(true)) t.ForceMeshUpdate();

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
            foreach (var h in hidden) h.SetActive(true);
            if (activate) go.SetActive(false);
        }
    }
}
