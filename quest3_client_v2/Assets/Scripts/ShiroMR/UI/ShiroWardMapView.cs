// =============================================================================
// Project SHIRO - headset app version 2: the ward map on the ward panel
//
// The ward from above: walls, door, beds (with their names), each patient where
// the edge server last placed their wristband (status colour; red and blinking
// with an alert; grey when not heard for 10 s), and the clinician (a blue arrow,
// where they look). A tap on a patient: "Show me" in the room.
// Positions are kept while the map is hidden (the panel passes them on).
// The version 1 map (other wards, 1 Hz vitals) stays in the version 1 menu.
// =============================================================================
using System;
using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace ShiroMR.UI
{
    internal class ShiroWardMapView
    {
        private const float StaleAfter = 10f;
        private const float Margin = 16f;      // mm around the room, for names at the walls
        private const float DotSize = 16f;

        private RectTransform _area;
        private RectTransform _room;           // origin: the room's corner at ward (0, 0), bottom-left
        private TextMeshProUGUI _status;
        private Image _you;
        private Action<string, string, string> _onTap;
        private float _areaW, _areaH, _scale = 1f;
        private string _drawnKey = "";
        private readonly List<GameObject> _static = new List<GameObject>();

        private class Mark
        {
            public string Tag, Ward;
            public float X, Y, Seen;
            public ShiroButton Dot;
            public TextMeshProUGUI Label;
        }
        private readonly Dictionary<string, Mark> _marks = new Dictionary<string, Mark>();

        public void Build(Transform page, float x, float w, float pageH, Action<string, string, string> onTap)
        {
            _onTap = onTap;
            _areaW = w;
            _areaH = pageH - 42f;
            var areaGo = new GameObject("MapArea", typeof(RectTransform));
            areaGo.transform.SetParent(page, false);
            _area = ShiroUIKit.Place(areaGo.transform as RectTransform, x, 0, w, _areaH);

            var roomGo = new GameObject("Room", typeof(RectTransform));
            roomGo.transform.SetParent(_area, false);
            _room = (RectTransform)roomGo.transform;
            _room.anchorMin = _room.anchorMax = Vector2.zero;
            _room.pivot = Vector2.zero;
            _room.sizeDelta = Vector2.zero;

            _status = ShiroUIKit.Label(page, "MapStatus", "", 12f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.TopLeft, true).Fit(9f);
            ShiroUIKit.Place(_status, x, _areaH + 6f, w, 34f);
        }

        /// <summary>A position from the edge server (any ward; kept while the map is hidden).</summary>
        public void OnPosition(IpsPositionUpdate pos)
        {
            if (pos == null || string.IsNullOrEmpty(pos.tag_id)) return;
            string key = pos.tag_id.ToUpper().Trim();
            if (!_marks.TryGetValue(key, out var m)) { m = new Mark { Tag = key }; _marks[key] = m; }
            m.X = pos.x;
            m.Y = pos.y;
            m.Ward = pos.ward_id;
            m.Seen = Time.time;
        }

        /// <summary>Draws the ward shown on this headset (null: not loaded).</summary>
        public void Refresh(WardConfig ward, List<TrackedSubject> subjects, bool connected)
        {
            if (ward == null || ward.length_x <= 0 || ward.width_y <= 0)
            {
                ClearStatic();
                foreach (var m in _marks.Values) Show(m, false);
                if (_you != null) _you.gameObject.SetActive(false);
                _status.text = connected ? "No ward loaded yet: choose one in Settings." : "Not connected: the map comes from the edge server.";
                return;
            }
            string key = $"{ward.ward_id}|{ward.length_x}|{ward.width_y}|{ward.beds?.Count}|{ward.door?.wall}|{ward.door?.x}";
            if (key != _drawnKey) DrawRoom(ward, key);

            var mr = ShiroMRManager.Instance;
            int shown = 0, stale = 0;
            bool blinkOn = Mathf.Repeat(Time.time, 0.6f) < 0.3f;
            foreach (var m in _marks.Values)
            {
                bool thisWard = string.IsNullOrEmpty(m.Ward) || string.Equals(m.Ward, ward.ward_id, StringComparison.OrdinalIgnoreCase);
                bool inRoom = m.X > -1f && m.Y > -1f && m.X < ward.length_x + 1f && m.Y < ward.width_y + 1f;
                if (!thisWard || !inRoom) { Show(m, false); continue; }
                var subject = FindSubject(subjects, m.Tag);
                EnsureMark(m, subject);
                Show(m, true);
                float cx = Mathf.Clamp(m.X, 0f, ward.length_x), cy = Mathf.Clamp(m.Y, 0f, ward.width_y);
                At(m.Dot.transform as RectTransform, cx, cy);
                At(m.Label.rectTransform, cx, cy, DotSize / 2f + 3f + 35f, 0f);

                bool isStale = Time.time - m.Seen > StaleAfter;
                var holo = mr != null ? mr.GetHologram(m.Tag) : null;
                Color c;
                if (HasPendingAlert(m.Tag, subject)) c = blinkOn ? ShiroTheme.Alert : ShiroTheme.AlertDark;
                else if (isStale) c = ShiroTheme.Off;
                else c = holo != null ? holo.GetListState().Colour : ShiroTheme.Ok;
                m.Dot.SetColorOverride(c);
                m.Label.color = isStale ? ShiroTheme.TextDim : ShiroTheme.Text;
                shown++;
                if (isStale) stale++;
            }
            UpdateYou(ward);

            string title = !string.IsNullOrEmpty(ward.room_title) ? ward.room_title : ward.ward_id;
            string who = shown == 0 ? "No wristband position yet."
                : $"{shown} patient{(shown > 1 ? "s" : "")}{(stale > 0 ? $", {stale} not heard (grey)" : "")}. Tap one to see them in the room.";
            _status.text = (connected ? "" : "Not connected: positions are not updated. ")
                + $"{title}, {ward.length_x:0.#} × {ward.width_y:0.#} m. {who} Bluetooth positions: about ±1 m.";
            _status.color = connected ? ShiroTheme.TextDim : ShiroTheme.WarnText;
        }

        // ----- Drawing -----

        private void DrawRoom(WardConfig ward, string key)
        {
            ClearStatic();
            _drawnKey = key;
            float L = ward.length_x, Wd = ward.width_y;
            _scale = Mathf.Min((_areaW - 2 * Margin) / L, (_areaH - 2 * Margin) / Wd);
            _room.anchoredPosition = new Vector2((_areaW - L * _scale) / 2f, (_areaH - Wd * _scale) / 2f);

            AddRect("Floor", 0, 0, L, Wd, ShiroTheme.GlassRaised, 4f);
            float t = 1.6f / _scale;   // walls 1.6 mm
            var wall = new Color(ShiroTheme.TextDim.r, ShiroTheme.TextDim.g, ShiroTheme.TextDim.b, 0.8f);
            AddRect("WallS", 0, 0, L, t, wall, 0f);
            AddRect("WallN", 0, Wd - t, L, t, wall, 0f);
            AddRect("WallW", 0, 0, t, Wd, wall, 0f);
            AddRect("WallE", L - t, 0, t, Wd, wall, 0f);

            if (ward.door != null && ward.door.width > 0 && !string.IsNullOrEmpty(ward.door.wall))
            {
                string side = ward.door.wall.ToUpperInvariant();
                float d = ward.door.x, dw = ward.door.width, dt = 4f / _scale;
                if (side == "SOUTH") AddRect("Door", d, 0, dw, dt, ShiroTheme.Warn, 0f);
                else if (side == "NORTH") AddRect("Door", d, Wd - dt, dw, dt, ShiroTheme.Warn, 0f);
                else if (side == "EAST") AddRect("Door", L - dt, d, dt, dw, ShiroTheme.Warn, 0f);
                else if (side == "WEST") AddRect("Door", 0, d, dt, dw, ShiroTheme.Warn, 0f);
            }

            if (ward.beds != null)
            {
                foreach (var b in ward.beds)
                {
                    if (b == null || b.width <= 0 || b.length <= 0) continue;   // no invented sizes
                    bool turned = b.rotation_deg == 90 || b.rotation_deg == 270;
                    float sx = turned ? b.length : b.width, sy = turned ? b.width : b.length;
                    AddRect($"Bed_{b.bed_id}", b.x, b.y, sx, sy, new Color(1f, 1f, 1f, 0.10f), 3f);
                    var lbl = ShiroUIKit.Label(_room, $"BedName_{b.bed_id}", string.IsNullOrEmpty(b.bed_code) ? b.bed_id : b.bed_code,
                        10f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.Center).Fit(7f);
                    var rt = lbl.rectTransform;
                    rt.anchorMin = rt.anchorMax = Vector2.zero;
                    rt.pivot = new Vector2(0.5f, 0.5f);
                    rt.sizeDelta = new Vector2(Mathf.Max(30f, sx * _scale - 2f), 14f);
                    rt.anchoredPosition = new Vector2((b.x + sx / 2f) * _scale, (b.y + sy / 2f) * _scale);
                    _static.Add(lbl.gameObject);
                }
            }

            // Patients and you above the room
            foreach (var m in _marks.Values)
            {
                if (m.Dot != null) m.Dot.transform.SetAsLastSibling();
                if (m.Label != null) m.Label.transform.SetAsLastSibling();
            }
            if (_you != null) _you.transform.SetAsLastSibling();
        }

        private void ClearStatic()
        {
            foreach (var go in _static) if (go != null) UnityEngine.Object.Destroy(go);
            _static.Clear();
            _drawnKey = "";
        }

        private void AddRect(string name, float x, float y, float w, float h, Color c, float radius)
        {
            var img = ShiroUIKit.Panel(_room, name, c, radius);
            var rt = img.rectTransform;
            rt.anchorMin = rt.anchorMax = Vector2.zero;
            rt.pivot = Vector2.zero;
            rt.anchoredPosition = new Vector2(x * _scale, y * _scale);
            rt.sizeDelta = new Vector2(Mathf.Max(0.8f, w * _scale), Mathf.Max(0.8f, h * _scale));
            _static.Add(img.gameObject);
        }

        /// <summary>Places a mark at ward (x, y), offset in mm.</summary>
        private void At(RectTransform rt, float x, float y, float dx = 0f, float dy = 0f)
        {
            rt.anchoredPosition = new Vector2(x * _scale + dx, y * _scale + dy);
        }

        private void EnsureMark(Mark m, TrackedSubject subject)
        {
            string name = subject != null && !string.IsNullOrEmpty(subject.full_name) ? FirstName(subject.full_name) : m.Tag;
            if (m.Dot == null)
            {
                string tag = m.Tag;
                m.Dot = ShiroUIKit.Button(_room, $"Patient_{tag}", null, ButtonKind.Surface, () => Tap(tag));
                m.Dot.Background.sprite = ShiroUIKit.CircleSprite;
                m.Dot.Background.type = Image.Type.Simple;
                var rt = (RectTransform)m.Dot.transform;
                rt.anchorMin = rt.anchorMax = Vector2.zero;
                rt.pivot = new Vector2(0.5f, 0.5f);
                rt.sizeDelta = new Vector2(DotSize, DotSize);
                m.Label = ShiroUIKit.Label(_room, $"PatientName_{tag}", name, 11f, ShiroTheme.Text, FontStyles.Bold).Fit(8f);
                var lr = m.Label.rectTransform;
                lr.anchorMin = lr.anchorMax = Vector2.zero;
                lr.pivot = new Vector2(0.5f, 0.5f);
                lr.sizeDelta = new Vector2(70f, 14f);
            }
            if (m.Label.text != name) m.Label.text = name;
        }

        private static string FirstName(string full)
        {
            string s = full.Trim();
            int sp = s.IndexOf(' ');
            return sp > 0 ? s.Substring(0, sp) : s;
        }

        private static void Show(Mark m, bool on)
        {
            if (m.Dot != null && m.Dot.gameObject.activeSelf != on) m.Dot.gameObject.SetActive(on);
            if (m.Label != null && m.Label.gameObject.activeSelf != on) m.Label.gameObject.SetActive(on);
        }

        private void Tap(string tag)
        {
            var net = ShiroNetworkManager.Instance;
            var s = FindSubject(net != null ? net.LastLoadedSubjects : null, tag);
            _onTap?.Invoke(tag, s != null ? s.assigned_bed_id : null, s != null && !string.IsNullOrEmpty(s.full_name) ? s.full_name : tag);
        }

        private void UpdateYou(WardConfig ward)
        {
            var spatial = WardSpatialManager.Instance;
            Camera cam = Camera.main;
            if (spatial == null || spatial.wardOrigin == null || cam == null) { if (_you != null) _you.gameObject.SetActive(false); return; }
            if (_you == null)
            {
                _you = ShiroUIKit.Panel(_room, "You", ShiroTheme.OkText, 0f);
                _you.sprite = ShiroUIKit.TriangleSprite;
                _you.type = Image.Type.Simple;
                var rt = _you.rectTransform;
                rt.anchorMin = rt.anchorMax = Vector2.zero;
                rt.pivot = new Vector2(0.5f, 0.5f);
                rt.sizeDelta = new Vector2(13f, 15f);
            }
            Vector3 local = spatial.wardOrigin.InverseTransformPoint(cam.transform.position);
            Vector3 fwd = spatial.wardOrigin.InverseTransformDirection(cam.transform.forward);
            bool inRoom = local.x > -1f && local.z > -1f && local.x < ward.length_x + 1f && local.z < ward.width_y + 1f;
            _you.gameObject.SetActive(inRoom);
            if (!inRoom) return;
            At(_you.rectTransform, Mathf.Clamp(local.x, 0f, ward.length_x), Mathf.Clamp(local.z, 0f, ward.width_y));
            _you.rectTransform.localRotation = Quaternion.Euler(0f, 0f, -Mathf.Atan2(fwd.x, fwd.z) * Mathf.Rad2Deg);
        }

        // ----- Data -----

        private static TrackedSubject FindSubject(List<TrackedSubject> subjects, string tag)
        {
            if (subjects == null || string.IsNullOrEmpty(tag)) return null;
            foreach (var s in subjects)
            {
                if (s == null) continue;
                if (!string.IsNullOrEmpty(s.device_id) && string.Equals(s.device_id, tag, StringComparison.OrdinalIgnoreCase)) return s;
                if (!string.IsNullOrEmpty(s.mac_address) && string.Equals(s.mac_address, tag, StringComparison.OrdinalIgnoreCase)) return s;
            }
            return null;
        }

        private static bool HasPendingAlert(string tag, TrackedSubject subject)
        {
            var am = ShiroAlertManager.Instance;
            if (am == null) return false;
            foreach (var a in am.Alerts)
            {
                if (a == null || a.incident == null || a.status == ShiroAlertManager.AlertStatus.AcknowledgedElsewhere) continue;
                if (string.Equals(a.incident.device_id, tag, StringComparison.OrdinalIgnoreCase)) return true;
                if (subject != null && !string.IsNullOrEmpty(subject.patient_id) &&
                    string.Equals(a.incident.patient_id, subject.patient_id, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        // ----- Preview (sample data, editor tool) -----

        internal void PreviewMark(string tag, float x, float y, float secondsAgo)
        {
            if (!_marks.TryGetValue(tag, out var m)) { m = new Mark { Tag = tag }; _marks[tag] = m; }
            m.X = x; m.Y = y; m.Ward = null; m.Seen = Time.time - secondsAgo;
        }
    }
}
