// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Live 2D ward map on the hand slate ("Live Map" tab)
//
// Top view of the loaded ward: walls, door, beds, BLE anchors, each wristband's
// position as the edge server reports it, and this headset's own position and
// heading. Patients with a pending alert blink red.
// What it shows is what was received: a wristband not heard for a while is
// drawn grey with "last seen", and nothing is drawn for a ward that is not loaded.
// =============================================================================
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

namespace ShiroMR
{
    public class ShiroWardMiniMap : MonoBehaviour
    {
        // Area of the map inside the tab panel (canvas pixels)
        private const float MapMaxW = 1000f;
        private const float MapMaxH = 370f;
        private const float StaleAfterSeconds = 10f;

        private RectTransform _mapRoot;      // origin = ward SW corner (bottom-left)
        private Text _legend;
        private Text _status;
        private Font _font;
        private float _scale = 1f;           // canvas pixels per metre
        private string _drawnWardKey = "";
        private RectTransform _headset;
        private Text _headsetLabel;
        private float _refreshTimer;
        private float _blinkTimer;

        private class TagMark
        {
            public RectTransform dot;
            public Image dotImage;
            public Text label;
            public float x, y;
            public float lastSeen;
            public string motion;
        }
        private readonly Dictionary<string, TagMark> _tags = new Dictionary<string, TagMark>();
        private readonly List<GameObject> _staticParts = new List<GameObject>();
        private bool _subscribed;

        /// <summary>Builds the map inside the given tab panel (1080 × 480).</summary>
        public void Build(Transform panel)
        {
            _font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");

            _legend = MakeText(panel, "MapLegend", "", 19, TextAnchor.MiddleLeft, new Color(0.75f, 0.85f, 0.95f));
            _legend.rectTransform.anchoredPosition = new Vector2(0, 215f);
            _legend.rectTransform.sizeDelta = new Vector2(1040f, 32f);

            _status = MakeText(panel, "MapStatus", "", 19, TextAnchor.MiddleLeft, new Color(0.95f, 0.80f, 0.35f));
            _status.rectTransform.anchoredPosition = new Vector2(0, -222f);
            _status.rectTransform.sizeDelta = new Vector2(1040f, 30f);

            var rootObj = new GameObject("MapRoot", typeof(RectTransform));
            rootObj.transform.SetParent(panel, false);
            _mapRoot = rootObj.GetComponent<RectTransform>();
            _mapRoot.sizeDelta = Vector2.zero;
            _mapRoot.pivot = new Vector2(0, 0);
        }

        private void Update()
        {
            if (!_subscribed) TrySubscribe();
            if (_mapRoot == null || !gameObject.activeInHierarchy) return;

            _blinkTimer += Time.deltaTime;
            _refreshTimer += Time.deltaTime;
            if (_refreshTimer < 0.25f) return; // 4 Hz
            _refreshTimer = 0f;
            Refresh();
        }

        private void TrySubscribe()
        {
            var net = ShiroNetworkManager.Instance;
            if (net == null) return;
            net.OnPositionUpdated += HandlePosition;
            net.OnTagPurged += HandlePurge;
            _subscribed = true;
        }

        private void OnDestroy()
        {
            var net = ShiroNetworkManager.Instance;
            if (_subscribed && net != null)
            {
                net.OnPositionUpdated -= HandlePosition;
                net.OnTagPurged -= HandlePurge;
            }
        }

        // Positions arrive also while the tab is not shown: the map is current when opened
        private void HandlePosition(IpsPositionUpdate pos)
        {
            if (pos == null || string.IsNullOrEmpty(pos.tag_id)) return;
            string key = pos.tag_id.ToUpper().Trim();
            if (!_tags.TryGetValue(key, out var mark))
            {
                mark = new TagMark();
                _tags[key] = mark;
            }
            mark.x = pos.x;
            mark.y = pos.y;
            mark.motion = pos.motion_state;
            mark.lastSeen = Time.time;
        }

        private void HandlePurge(string tagId)
        {
            if (string.IsNullOrEmpty(tagId)) return;
            string key = tagId.ToUpper().Trim();
            if (_tags.TryGetValue(key, out var mark))
            {
                if (mark.dot != null) Destroy(mark.dot.gameObject);
                if (mark.label != null) Destroy(mark.label.gameObject);
                _tags.Remove(key);
            }
        }

        private void Refresh()
        {
            var net = ShiroNetworkManager.Instance;
            WardConfig ward = net != null && net.IsWardLoaded ? net.LastLoadedWardConfig : null;
            if (ward == null || ward.length_x <= 0 || ward.width_y <= 0)
            {
                ClearStatic();
                _legend.text = "🗺️ LIVE WARD MAP";
                _status.text = net == null || !net.HasWard
                    ? "No ward chosen: choose one on the Ward Setup tab."
                    : $"Ward {net.targetWardId} is not loaded yet (edge server not reachable?).";
                SetTagsVisible(false);
                if (_headset != null) _headset.gameObject.SetActive(false);
                return;
            }

            string key = $"{ward.ward_id}|{ward.length_x}|{ward.width_y}|{ward.beds?.Count}|{ward.anchors?.Count}|{ward.door?.wall}";
            if (key != _drawnWardKey) DrawStatic(ward, key);

            int shown = 0, stale = 0;
            foreach (var kvp in _tags)
            {
                UpdateTag(kvp.Key, kvp.Value, ward);
                if (kvp.Value.dot != null && kvp.Value.dot.gameObject.activeSelf)
                {
                    shown++;
                    if (Time.time - kvp.Value.lastSeen > StaleAfterSeconds) stale++;
                }
            }
            UpdateHeadset(ward);

            bool connected = net != null && net.IsConnected;
            _status.text = (connected ? "" : "⚠ Not connected: positions are not updated. ")
                + (shown == 0 ? "No wristband position received for this ward yet." : $"{shown} wristband(s){(stale > 0 ? $", {stale} not heard for >{StaleAfterSeconds:F0} s (grey)" : "")}.")
                + " Positions are BLE estimates (about ±1 m or worse).";
            _status.color = connected ? new Color(0.75f, 0.85f, 0.95f) : new Color(0.95f, 0.65f, 0.25f);
        }

        // ----- static layout -----

        private void ClearStatic()
        {
            foreach (var go in _staticParts) if (go != null) Destroy(go);
            _staticParts.Clear();
            _drawnWardKey = "";
        }

        private void DrawStatic(WardConfig ward, string key)
        {
            ClearStatic();
            _drawnWardKey = key;
            float L = ward.length_x, W = ward.width_y;
            _scale = Mathf.Min(MapMaxW / L, MapMaxH / W);
            float mapW = L * _scale, mapH = W * _scale;
            // Centre the room in the panel; the map root sits at its bottom-left corner
            _mapRoot.anchoredPosition = new Vector2(-mapW / 2f, -mapH / 2f - 5f);

            _legend.text = $"🗺️ {(string.IsNullOrEmpty(ward.room_title) ? ward.ward_id : ward.room_title)} ({ward.ward_id}) · {L:F1} m × {W:F1} m   " +
                           "green: patient · cyan ◆: you · purple: anchor · yellow: door";

            // Floor and walls
            AddRect("Floor", 0, 0, L, W, new Color(0.10f, 0.16f, 0.24f, 0.95f));
            float t = 0.06f; // wall thickness in metres on the map
            AddRect("WallS", 0, 0, L, t, new Color(0.55f, 0.65f, 0.75f));
            AddRect("WallN", 0, W - t, L, t, new Color(0.55f, 0.65f, 0.75f));
            AddRect("WallW", 0, 0, t, W, new Color(0.55f, 0.65f, 0.75f));
            AddRect("WallE", L - t, 0, t, W, new Color(0.55f, 0.65f, 0.75f));

            // Door
            if (ward.door != null && ward.door.width > 0 && !string.IsNullOrEmpty(ward.door.wall))
            {
                string wall = ward.door.wall.ToUpper();
                float d = ward.door.x, dw = ward.door.width;
                var doorColor = new Color(0.95f, 0.75f, 0.20f);
                if (wall == "SOUTH") AddRect("Door", d, 0, dw, t * 2f, doorColor);
                else if (wall == "NORTH") AddRect("Door", d, W - t * 2f, dw, t * 2f, doorColor);
                else if (wall == "EAST") AddRect("Door", L - t * 2f, d, t * 2f, dw, doorColor);
                else if (wall == "WEST") AddRect("Door", 0, d, t * 2f, dw, doorColor);
            }

            // Beds (x, y = corner nearest the origin; 90/270 degrees swap width and length)
            if (ward.beds != null)
            {
                foreach (var b in ward.beds)
                {
                    if (b == null) continue;
                    float bw = b.width > 0 ? b.width : 0f, bl = b.length > 0 ? b.length : 0f;
                    if (bw <= 0 || bl <= 0) continue; // a bed without a size is not drawn with an invented one
                    bool turned = b.rotation_deg == 90 || b.rotation_deg == 270;
                    float sx = turned ? bl : bw, sy = turned ? bw : bl;
                    AddRect($"Bed_{b.bed_id}", b.x, b.y, sx, sy, new Color(0.20f, 0.38f, 0.55f, 0.95f));
                    var lbl = MakeText(_mapRoot, $"BedLbl_{b.bed_id}", string.IsNullOrEmpty(b.bed_code) ? b.bed_id : b.bed_code, 16, TextAnchor.MiddleCenter, new Color(0.85f, 0.92f, 1f));
                    PlaceAt(lbl.rectTransform, b.x + sx / 2f, b.y + sy / 2f);
                    lbl.rectTransform.sizeDelta = new Vector2(Mathf.Max(60f, sx * _scale), 24f);
                    _staticParts.Add(lbl.gameObject);
                }
            }

            // BLE anchors
            if (ward.anchors != null)
            {
                foreach (var a in ward.anchors)
                {
                    if (a == null) continue;
                    var sq = AddMarker($"Anchor_{a.anchor_id}", a.x, a.y, 12f, new Color(0.65f, 0.45f, 0.95f));
                    _staticParts.Add(sq.gameObject);
                }
            }

            // Patients and headset above the layout
            foreach (var m in _tags.Values)
            {
                if (m.dot != null) m.dot.SetAsLastSibling();
                if (m.label != null) m.label.rectTransform.SetAsLastSibling();
            }
            if (_headset != null) _headset.SetAsLastSibling();
            if (_headsetLabel != null) _headsetLabel.rectTransform.SetAsLastSibling();
        }

        // ----- live marks -----

        private void SetTagsVisible(bool visible)
        {
            foreach (var m in _tags.Values)
            {
                if (m.dot != null) m.dot.gameObject.SetActive(visible);
                if (m.label != null) m.label.gameObject.SetActive(visible);
            }
        }

        private void UpdateTag(string tag, TagMark m, WardConfig ward)
        {
            if (m.dot == null)
            {
                m.dot = AddMarker($"Tag_{tag}", 0, 0, 22f, Color.white);
                m.dotImage = m.dot.GetComponent<Image>();
                m.label = MakeText(_mapRoot, $"TagLbl_{tag}", tag, 17, TextAnchor.MiddleLeft, Color.white);
                m.label.rectTransform.sizeDelta = new Vector2(260f, 24f);
            }
            // Outside the room by more than 1 m: another ward's wristband, not drawn here
            bool inRoom = m.x > -1f && m.y > -1f && m.x < ward.length_x + 1f && m.y < ward.width_y + 1f;
            m.dot.gameObject.SetActive(inRoom);
            m.label.gameObject.SetActive(inRoom);
            if (!inRoom) return;

            float cx = Mathf.Clamp(m.x, 0f, ward.length_x), cy = Mathf.Clamp(m.y, 0f, ward.width_y);
            PlaceAt(m.dot, cx, cy);
            PlaceAt(m.label.rectTransform, cx, cy, 145f, 0f);

            var holo = ShiroMRManager.Instance != null ? ShiroMRManager.Instance.GetHologram(tag) : null;
            string name = holo != null && !string.IsNullOrEmpty(holo.fullName) ? holo.fullName : tag;
            float age = Time.time - m.lastSeen;
            bool stale = age > StaleAfterSeconds;
            bool alarm = holo != null && holo.isAlarmActive;

            if (alarm)
            {
                bool on = Mathf.Repeat(_blinkTimer, 0.6f) < 0.3f;
                m.dotImage.color = on ? new Color(1f, 0.15f, 0.15f) : new Color(0.5f, 0.05f, 0.05f);
                m.label.text = $"🚨 {name}";
                m.label.color = new Color(1f, 0.45f, 0.45f);
            }
            else if (stale)
            {
                m.dotImage.color = new Color(0.5f, 0.5f, 0.55f);
                m.label.text = $"{name} (last seen {age:F0} s ago)";
                m.label.color = new Color(0.6f, 0.6f, 0.65f);
            }
            else
            {
                m.dotImage.color = new Color(0.15f, 0.95f, 0.55f);
                m.label.text = string.IsNullOrEmpty(m.motion) ? name : $"{name} · {m.motion.ToLower().Replace('_', ' ')}";
                m.label.color = Color.white;
            }
        }

        private void UpdateHeadset(WardConfig ward)
        {
            var spatial = WardSpatialManager.Instance;
            Camera cam = Camera.main;
            if (spatial == null || spatial.wardOrigin == null || cam == null) return;

            if (_headset == null)
            {
                _headset = AddMarker("Headset", 0, 0, 20f, new Color(0.1f, 0.85f, 0.95f));
                _headsetLabel = MakeText(_mapRoot, "HeadsetLbl", "you", 17, TextAnchor.MiddleLeft, new Color(0.1f, 0.85f, 0.95f));
                _headsetLabel.rectTransform.sizeDelta = new Vector2(120f, 24f);
            }
            Vector3 local = spatial.wardOrigin.InverseTransformPoint(cam.transform.position);
            Vector3 fwd = spatial.wardOrigin.InverseTransformDirection(cam.transform.forward);
            bool inRoom = local.x > -1f && local.z > -1f && local.x < ward.length_x + 1f && local.z < ward.width_y + 1f;
            _headset.gameObject.SetActive(inRoom);
            _headsetLabel.gameObject.SetActive(inRoom);
            if (!inRoom) return;

            float cx = Mathf.Clamp(local.x, 0f, ward.length_x), cy = Mathf.Clamp(local.z, 0f, ward.width_y);
            PlaceAt(_headset, cx, cy);
            PlaceAt(_headsetLabel.rectTransform, cx, cy, 75f, 0f);
            // A diamond that points where the clinician looks
            float heading = Mathf.Atan2(fwd.x, fwd.z) * Mathf.Rad2Deg;
            _headset.localRotation = Quaternion.Euler(0, 0, 45f - heading);
        }

        // ----- drawing helpers (map coordinates in metres, origin bottom-left) -----

        private void PlaceAt(RectTransform rt, float x, float y, float offsetX = 0f, float offsetY = 0f)
        {
            rt.anchoredPosition = new Vector2(x * _scale + offsetX, y * _scale + offsetY);
        }

        private void AddRect(string name, float x, float y, float w, float h, Color color)
        {
            var go = new GameObject(name, typeof(RectTransform), typeof(Image));
            go.transform.SetParent(_mapRoot, false);
            var rt = go.GetComponent<RectTransform>();
            rt.anchorMin = rt.anchorMax = Vector2.zero;
            rt.pivot = Vector2.zero;
            rt.anchoredPosition = new Vector2(x * _scale, y * _scale);
            rt.sizeDelta = new Vector2(Mathf.Max(2f, w * _scale), Mathf.Max(2f, h * _scale));
            go.GetComponent<Image>().color = color;
            _staticParts.Add(go);
        }

        private RectTransform AddMarker(string name, float x, float y, float sizePx, Color color)
        {
            var go = new GameObject(name, typeof(RectTransform), typeof(Image));
            go.transform.SetParent(_mapRoot, false);
            var rt = go.GetComponent<RectTransform>();
            rt.anchorMin = rt.anchorMax = Vector2.zero;
            rt.pivot = new Vector2(0.5f, 0.5f);
            rt.sizeDelta = new Vector2(sizePx, sizePx);
            go.GetComponent<Image>().color = color;
            PlaceAt(rt, x, y);
            return rt;
        }

        private Text MakeText(Transform parent, string name, string content, int size, TextAnchor align, Color color)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var txt = go.AddComponent<Text>();
            txt.font = _font;
            txt.text = content;
            txt.fontSize = size;
            txt.alignment = align;
            txt.color = color;
            txt.horizontalOverflow = HorizontalWrapMode.Overflow;
            var rt = txt.rectTransform;
            if (parent == _mapRoot)
            {
                rt.anchorMin = rt.anchorMax = Vector2.zero;
                rt.pivot = new Vector2(0.5f, 0.5f);
            }
            return txt;
        }
    }
}
