// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Live 2D ward map on the hand slate ("Live Map" tab)
//
// Top view of a ward: walls, door, beds, BLE anchors and each wristband's
// position as the edge server reports it. By default the ward this headset is
// in (with the headset's own position and heading); the ward bar shows any
// other ward without changing the active ward or the room alignment.
// Tapping a patient opens their card (patient, bed, wristband, live vitals)
// and asks the edge server for 1 Hz vitals through the strongest anchor.
// Patients with a pending alert blink red. What it shows is what was
// received: a wristband not heard for a while is grey with "last seen".
// =============================================================================
using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

namespace ShiroMR
{
    public class ShiroWardMiniMap : MonoBehaviour
    {
        // Area of the map inside the tab panel (canvas pixels)
        private const float MapMaxW = 1000f;
        private const float MapMaxH = 320f;
        private const float StaleAfterSeconds = 10f;
        private const float ActiveModeRepeatSeconds = 20f;

        // Buttons are made by the hand slate, so its fingertip touch reaches them
        private Func<Transform, string, string, Vector2, Color, Action, Button> _makeButton;
        private Action<Button> _dropButton;

        private Transform _panel;
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
        private bool _subscribed;

        // Which ward is shown: null = the active ward (where this headset is)
        private string _viewWardId;
        private WardInitResponse _viewData;  // layout and patients of another ward
        private string _viewError;
        private readonly List<Button> _wardButtons = new List<Button>();
        private string _wardBarKey = "";
        private GameObject _wardBar;

        private class TagMark
        {
            public string tag;
            public Button button;
            public Image dotImage;
            public Text label;
            public float x, y;
            public string wardId;
            public float lastSeen;
            public string motion;
        }
        private readonly Dictionary<string, TagMark> _tags = new Dictionary<string, TagMark>();
        private readonly List<GameObject> _staticParts = new List<GameObject>();

        // Latest vitals per wristband (TELEMETRY), for the patient card
        private class Vitals { public int bpm, spo2, battery = -1; public string motion; public float at; }
        private readonly Dictionary<string, Vitals> _vitals = new Dictionary<string, Vitals>();

        // Patient card
        private GameObject _card;
        private Text _cardTitle, _cardBody, _cardLive;
        private string _selectedTag;
        private readonly Dictionary<string, float> _lastActiveRequest = new Dictionary<string, float>();
        private string _liveText = "";
        private float _liveUntil;

        /// <summary>Builds the map inside the given tab panel (1080 × 480).</summary>
        public void Build(Transform panel,
                          Func<Transform, string, string, Vector2, Color, Action, Button> makeButton,
                          Action<Button> dropButton)
        {
            _panel = panel;
            _makeButton = makeButton;
            _dropButton = dropButton;
            _font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");

            _wardBar = new GameObject("WardBar", typeof(RectTransform));
            _wardBar.transform.SetParent(panel, false);
            _wardBar.GetComponent<RectTransform>().anchoredPosition = new Vector2(0, 212f);

            _legend = MakeText(panel, "MapLegend", "", 18, TextAnchor.MiddleLeft, new Color(0.75f, 0.85f, 0.95f));
            _legend.rectTransform.anchoredPosition = new Vector2(0, 172f);
            _legend.rectTransform.sizeDelta = new Vector2(1040f, 28f);

            _status = MakeText(panel, "MapStatus", "", 18, TextAnchor.MiddleLeft, new Color(0.95f, 0.80f, 0.35f));
            _status.rectTransform.anchoredPosition = new Vector2(0, -225f);
            _status.rectTransform.sizeDelta = new Vector2(1040f, 28f);

            var rootObj = new GameObject("MapRoot", typeof(RectTransform));
            rootObj.transform.SetParent(panel, false);
            _mapRoot = rootObj.GetComponent<RectTransform>();
            _mapRoot.sizeDelta = Vector2.zero;
            _mapRoot.pivot = Vector2.zero;

            BuildCard(panel);
        }

        private void Update()
        {
            if (!_subscribed) TrySubscribe();
            if (_mapRoot == null || !gameObject.activeInHierarchy) return;

            _blinkTimer += Time.deltaTime;
            _refreshTimer += Time.deltaTime;
            if (_refreshTimer < 0.25f) return; // 4 Hz
            _refreshTimer = 0f;
            RebuildWardBarIfNeeded();
            Refresh();
            RefreshCard();
        }

        private void TrySubscribe()
        {
            var net = ShiroNetworkManager.Instance;
            if (net == null) return;
            net.OnAnyPositionUpdated += HandlePosition;
            net.OnTagPurged += HandlePurge;
            net.OnTelemetryUpdated += HandleTelemetry;
            net.OnActiveModeResult += HandleActiveModeResult;
            net.OnActiveWardChanged += HandleActiveWardChanged;
            _subscribed = true;
        }

        private void OnDestroy()
        {
            var net = ShiroNetworkManager.Instance;
            if (_subscribed && net != null)
            {
                net.OnAnyPositionUpdated -= HandlePosition;
                net.OnTagPurged -= HandlePurge;
                net.OnTelemetryUpdated -= HandleTelemetry;
                net.OnActiveModeResult -= HandleActiveModeResult;
                net.OnActiveWardChanged -= HandleActiveWardChanged;
            }
        }

        // ----- data from the edge server (also while the tab is hidden) -----

        private void HandlePosition(IpsPositionUpdate pos)
        {
            if (pos == null || string.IsNullOrEmpty(pos.tag_id)) return;
            string key = pos.tag_id.ToUpper().Trim();
            if (!_tags.TryGetValue(key, out var mark))
            {
                mark = new TagMark { tag = key };
                _tags[key] = mark;
            }
            mark.x = pos.x;
            mark.y = pos.y;
            mark.wardId = pos.ward_id;
            mark.motion = pos.motion_state;
            mark.lastSeen = Time.time;
        }

        private void HandlePurge(string tagId)
        {
            if (string.IsNullOrEmpty(tagId)) return;
            string key = tagId.ToUpper().Trim();
            if (_tags.TryGetValue(key, out var mark))
            {
                DestroyMark(mark);
                _tags.Remove(key);
                if (_selectedTag == key) CloseCard();
            }
        }

        private void HandleTelemetry(TelemetryUpdate t)
        {
            string key = t?.EffectiveTagId?.ToUpper().Trim();
            if (string.IsNullOrEmpty(key)) return;
            if (!_vitals.TryGetValue(key, out var v)) { v = new Vitals(); _vitals[key] = v; }
            v.bpm = t.EffectiveBpm;
            v.spo2 = t.EffectiveSpo2;
            v.battery = t.EffectiveBattery;
            v.motion = t.EffectiveMotion;
            v.at = Time.time;
        }

        private void HandleActiveModeResult(string tag, bool ok, string text, int seconds)
        {
            if (string.IsNullOrEmpty(tag) || _selectedTag == null || !string.Equals(tag, _selectedTag, StringComparison.OrdinalIgnoreCase)) return;
            _liveText = ok ? $"⚡ {text}" : $"⚠ 1 Hz not started: {text}";
            _liveUntil = ok ? Time.time + seconds : 0f;
            if (!ok) _lastActiveRequest.Remove(_selectedTag); // allow a retry at once
            RefreshCard();
        }

        private void HandleActiveWardChanged(string wardId)
        {
            // Following the active ward: the new one is shown
            if (_viewWardId == null) { _drawnWardKey = ""; CloseCard(); }
        }

        // ----- which ward is shown -----

        private string ActiveWardId => ShiroNetworkManager.Instance != null ? ShiroNetworkManager.Instance.targetWardId : "";
        private bool ViewingActiveWard => _viewWardId == null || string.Equals(_viewWardId, ActiveWardId, StringComparison.OrdinalIgnoreCase);
        private string ShownWardId => ViewingActiveWard ? ActiveWardId : _viewWardId;

        private void ShowWard(string wardId)
        {
            CloseCard();
            _drawnWardKey = "";
            _viewData = null;
            _viewError = null;
            if (string.IsNullOrEmpty(wardId) || string.Equals(wardId, ActiveWardId, StringComparison.OrdinalIgnoreCase))
            {
                _viewWardId = null;
            }
            else
            {
                _viewWardId = wardId;
                var net = ShiroNetworkManager.Instance;
                if (net != null)
                {
                    string requested = wardId;
                    net.StartCoroutine(net.FetchWardForViewRoutine(wardId, (resp, error) =>
                    {
                        if (_viewWardId != requested) return; // switched again meanwhile
                        _viewData = resp;
                        _viewError = error;
                        _drawnWardKey = "";
                    }));
                }
            }
            _wardBarKey = ""; // redraw the bar with the new highlight
        }

        private void RebuildWardBarIfNeeded()
        {
            var net = ShiroNetworkManager.Instance;
            if (net == null || _makeButton == null) return;
            var ids = new List<string>();
            foreach (var ws in net.AvailableWards) if (!string.IsNullOrEmpty(ws.ward_id)) ids.Add(ws.ward_id);
            string key = $"{string.Join(",", ids)}|{ActiveWardId}|{_viewWardId}";
            if (key == _wardBarKey) return;
            _wardBarKey = key;

            foreach (var b in _wardButtons) { if (b != null) { _dropButton?.Invoke(b); Destroy(b.gameObject); } }
            _wardButtons.Clear();

            int count = Mathf.Min(ids.Count, 6);
            float w = 165f, step = 172f;
            float startX = -step * (count - 1) / 2f;
            for (int i = 0; i < count; i++)
            {
                string id = ids[i];
                bool isActive = string.Equals(id, ActiveWardId, StringComparison.OrdinalIgnoreCase);
                bool isShown = string.Equals(id, ShownWardId, StringComparison.OrdinalIgnoreCase);
                string label = isActive ? $"📍 {id}" : id;
                Color c = isShown ? new Color(0.06f, 0.55f, 0.75f) : new Color(0.10f, 0.16f, 0.24f);
                Button btn = _makeButton(_wardBar.transform, $"MapWard_{id}", label, new Vector2(w, 40f), c, () => ShowWard(id));
                btn.transform.localPosition = new Vector3(startX + i * step, 0, 0);
                btn.GetComponentInChildren<Text>().fontSize = 19;
                _wardButtons.Add(btn);
            }
        }

        // ----- drawing -----

        private void Refresh()
        {
            var net = ShiroNetworkManager.Instance;
            WardConfig ward;
            List<TrackedSubject> subjects;
            if (ViewingActiveWard)
            {
                ward = net != null && net.IsWardLoaded ? net.LastLoadedWardConfig : null;
                subjects = net != null ? net.LastLoadedSubjects : null;
            }
            else
            {
                ward = _viewData?.ward;
                subjects = _viewData?.tracked_subjects;
            }

            if (ward == null || ward.length_x <= 0 || ward.width_y <= 0)
            {
                ClearStatic();
                _legend.text = "🗺️ LIVE WARD MAP";
                if (!ViewingActiveWard)
                    _status.text = _viewError != null ? $"Ward {_viewWardId} could not be loaded ({_viewError})." : $"Loading ward {_viewWardId}…";
                else
                    _status.text = net == null || !net.HasWard
                        ? "No ward chosen: choose one on the Ward Setup tab, or tap a ward above."
                        : $"Ward {net.targetWardId} is not loaded yet (edge server not reachable?).";
                foreach (var m in _tags.Values) SetMarkVisible(m, false);
                if (_headset != null) { _headset.gameObject.SetActive(false); _headsetLabel.gameObject.SetActive(false); }
                return;
            }

            string key = $"{ward.ward_id}|{ward.length_x}|{ward.width_y}|{ward.beds?.Count}|{ward.anchors?.Count}|{ward.door?.wall}";
            if (key != _drawnWardKey) DrawStatic(ward, key);

            int shown = 0, stale = 0;
            foreach (var m in _tags.Values)
            {
                bool inThisWard = string.IsNullOrEmpty(m.wardId)
                    ? ViewingActiveWard
                    : string.Equals(m.wardId, ward.ward_id, StringComparison.OrdinalIgnoreCase);
                if (!inThisWard) { SetMarkVisible(m, false); continue; }
                UpdateTag(m, ward, subjects);
                if (m.button != null && m.button.gameObject.activeSelf)
                {
                    shown++;
                    if (Time.time - m.lastSeen > StaleAfterSeconds) stale++;
                }
            }

            if (ViewingActiveWard) UpdateHeadset(ward);
            else if (_headset != null) { _headset.gameObject.SetActive(false); _headsetLabel.gameObject.SetActive(false); }

            bool connected = net != null && net.IsConnected;
            string viewNote = ViewingActiveWard ? "" : $"Viewing {ward.ward_id} (you are not placed on this map). ";
            _status.text = (connected ? "" : "⚠ Not connected: positions are not updated. ") + viewNote
                + (shown == 0 ? "No wristband position received for this ward yet." : $"{shown} wristband(s){(stale > 0 ? $", {stale} not heard for >{StaleAfterSeconds:F0} s (grey)" : "")}. Tap a patient for details and 1 Hz vitals.")
                + " Positions are BLE estimates (about ±1 m or worse).";
            _status.color = connected ? new Color(0.75f, 0.85f, 0.95f) : new Color(0.95f, 0.65f, 0.25f);
        }

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
            _mapRoot.anchoredPosition = new Vector2(-mapW / 2f, -mapH / 2f - 25f);

            _legend.text = $"🗺️ {(string.IsNullOrEmpty(ward.room_title) ? ward.ward_id : ward.room_title)} ({ward.ward_id}) · {L:F1} m × {W:F1} m   " +
                           "green: patient · cyan ◆: you · purple: anchor · yellow: door";

            AddRect("Floor", 0, 0, L, W, new Color(0.10f, 0.16f, 0.24f, 0.95f));
            float t = 0.06f;
            var wall = new Color(0.55f, 0.65f, 0.75f);
            AddRect("WallS", 0, 0, L, t, wall);
            AddRect("WallN", 0, W - t, L, t, wall);
            AddRect("WallW", 0, 0, t, W, wall);
            AddRect("WallE", L - t, 0, t, W, wall);

            if (ward.door != null && ward.door.width > 0 && !string.IsNullOrEmpty(ward.door.wall))
            {
                string side = ward.door.wall.ToUpper();
                float d = ward.door.x, dw = ward.door.width;
                var doorColor = new Color(0.95f, 0.75f, 0.20f);
                if (side == "SOUTH") AddRect("Door", d, 0, dw, t * 2f, doorColor);
                else if (side == "NORTH") AddRect("Door", d, W - t * 2f, dw, t * 2f, doorColor);
                else if (side == "EAST") AddRect("Door", L - t * 2f, d, t * 2f, dw, doorColor);
                else if (side == "WEST") AddRect("Door", 0, d, t * 2f, dw, doorColor);
            }

            if (ward.beds != null)
            {
                foreach (var b in ward.beds)
                {
                    if (b == null || b.width <= 0 || b.length <= 0) continue; // no invented sizes
                    bool turned = b.rotation_deg == 90 || b.rotation_deg == 270;
                    float sx = turned ? b.length : b.width, sy = turned ? b.width : b.length;
                    AddRect($"Bed_{b.bed_id}", b.x, b.y, sx, sy, new Color(0.20f, 0.38f, 0.55f, 0.95f));
                    var lbl = MakeText(_mapRoot, $"BedLbl_{b.bed_id}", string.IsNullOrEmpty(b.bed_code) ? b.bed_id : b.bed_code, 16, TextAnchor.MiddleCenter, new Color(0.85f, 0.92f, 1f));
                    PlaceAt(lbl.rectTransform, b.x + sx / 2f, b.y + sy / 2f);
                    lbl.rectTransform.sizeDelta = new Vector2(Mathf.Max(60f, sx * _scale), 24f);
                    _staticParts.Add(lbl.gameObject);
                }
            }

            if (ward.anchors != null)
            {
                foreach (var a in ward.anchors)
                {
                    if (a == null) continue;
                    _staticParts.Add(AddMarker($"Anchor_{a.anchor_id}", a.x, a.y, 12f, new Color(0.65f, 0.45f, 0.95f)).gameObject);
                }
            }

            // Patients, headset and card above the layout
            foreach (var m in _tags.Values)
            {
                if (m.button != null) m.button.transform.SetAsLastSibling();
                if (m.label != null) m.label.rectTransform.SetAsLastSibling();
            }
            if (_headset != null) _headset.SetAsLastSibling();
            if (_headsetLabel != null) _headsetLabel.rectTransform.SetAsLastSibling();
            if (_card != null) _card.transform.SetAsLastSibling();
        }

        private void SetMarkVisible(TagMark m, bool visible)
        {
            if (m.button != null) m.button.gameObject.SetActive(visible);
            if (m.label != null) m.label.gameObject.SetActive(visible);
        }

        private void DestroyMark(TagMark m)
        {
            if (m.button != null) { _dropButton?.Invoke(m.button); Destroy(m.button.gameObject); }
            if (m.label != null) Destroy(m.label.gameObject);
        }

        private static TrackedSubject FindSubject(List<TrackedSubject> subjects, string tag)
        {
            if (subjects == null) return null;
            foreach (var s in subjects)
            {
                if (s == null) continue;
                if ((!string.IsNullOrEmpty(s.device_id) && s.device_id.ToUpper() == tag) ||
                    (!string.IsNullOrEmpty(s.mac_address) && s.mac_address.ToUpper() == tag)) return s;
            }
            return null;
        }

        private bool HasPendingAlert(string tag, TrackedSubject subject)
        {
            var am = ShiroAlertManager.Instance;
            if (am == null) return false;
            foreach (var a in am.Alerts)
            {
                if (a.status == ShiroAlertManager.AlertStatus.AcknowledgedElsewhere || a.incident == null) continue;
                if (string.Equals(a.incident.device_id, tag, StringComparison.OrdinalIgnoreCase)) return true;
                if (subject != null && !string.IsNullOrEmpty(subject.patient_id) && a.incident.patient_id == subject.patient_id) return true;
            }
            return false;
        }

        private void UpdateTag(TagMark m, WardConfig ward, List<TrackedSubject> subjects)
        {
            if (m.button == null && _makeButton != null)
            {
                string tag = m.tag;
                m.button = _makeButton(_mapRoot, $"Tag_{tag}", "", new Vector2(30f, 30f), Color.white, () => SelectTag(tag));
                var rt = m.button.GetComponent<RectTransform>();
                rt.anchorMin = rt.anchorMax = Vector2.zero;
                rt.pivot = new Vector2(0.5f, 0.5f);
                m.dotImage = m.button.GetComponent<Image>();
                m.label = MakeText(_mapRoot, $"TagLbl_{tag}", tag, 17, TextAnchor.MiddleLeft, Color.white);
                m.label.rectTransform.sizeDelta = new Vector2(280f, 24f);
                if (_card != null) _card.transform.SetAsLastSibling();
            }
            if (m.button == null) return;

            // More than 1 m outside the room: not drawn on this ward
            bool inRoom = m.x > -1f && m.y > -1f && m.x < ward.length_x + 1f && m.y < ward.width_y + 1f;
            SetMarkVisible(m, inRoom);
            if (!inRoom) return;

            float cx = Mathf.Clamp(m.x, 0f, ward.length_x), cy = Mathf.Clamp(m.y, 0f, ward.width_y);
            PlaceAt(m.button.GetComponent<RectTransform>(), cx, cy);
            PlaceAt(m.label.rectTransform, cx, cy, 160f, 0f);

            var subject = FindSubject(subjects, m.tag);
            string name = subject != null && !string.IsNullOrEmpty(subject.full_name) ? subject.full_name : m.tag;
            float age = Time.time - m.lastSeen;
            bool stale = age > StaleAfterSeconds;
            bool alarm = HasPendingAlert(m.tag, subject);
            bool selected = m.tag == _selectedTag;

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
            if (selected) m.label.text = $"▶ {m.label.text}";
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
            float heading = Mathf.Atan2(fwd.x, fwd.z) * Mathf.Rad2Deg;
            _headset.localRotation = Quaternion.Euler(0, 0, 45f - heading); // a diamond pointing where you look
        }

        // ----- patient card -----

        private void BuildCard(Transform panel)
        {
            _card = new GameObject("PatientCard", typeof(RectTransform), typeof(Image));
            _card.transform.SetParent(panel, false);
            var rt = _card.GetComponent<RectTransform>();
            rt.sizeDelta = new Vector2(420f, 330f);
            rt.anchoredPosition = new Vector2(320f, -30f);
            _card.GetComponent<Image>().color = new Color(0.03f, 0.07f, 0.12f, 0.96f);

            _cardTitle = MakeText(_card.transform, "CardTitle", "", 24, TextAnchor.MiddleLeft, Color.white);
            _cardTitle.rectTransform.anchoredPosition = new Vector2(-20f, 135f);
            _cardTitle.rectTransform.sizeDelta = new Vector2(360f, 40f);

            _cardBody = MakeText(_card.transform, "CardBody", "", 19, TextAnchor.UpperLeft, new Color(0.85f, 0.92f, 1f));
            _cardBody.horizontalOverflow = HorizontalWrapMode.Wrap;
            _cardBody.rectTransform.anchoredPosition = new Vector2(0, 30f);
            _cardBody.rectTransform.sizeDelta = new Vector2(390f, 170f);

            _cardLive = MakeText(_card.transform, "CardLive", "", 18, TextAnchor.UpperLeft, new Color(1f, 0.85f, 0.4f));
            _cardLive.horizontalOverflow = HorizontalWrapMode.Wrap;
            _cardLive.rectTransform.anchoredPosition = new Vector2(0, -85f);
            _cardLive.rectTransform.sizeDelta = new Vector2(390f, 60f);

            if (_makeButton != null)
            {
                Button close = _makeButton(_card.transform, "CardClose", "✖", new Vector2(50f, 40f), new Color(0.35f, 0.18f, 0.20f), CloseCard);
                close.transform.localPosition = new Vector3(175f, 135f, 0);
                Button again = _makeButton(_card.transform, "CardLiveAgain", "⚡ Request 1 Hz again", new Vector2(390f, 46f), new Color(0.10f, 0.40f, 0.60f), () => RequestLive(true));
                again.transform.localPosition = new Vector3(0, -138f, 0);
                again.GetComponentInChildren<Text>().fontSize = 20;
            }
            _card.SetActive(false);
        }

        private void SelectTag(string tag)
        {
            _selectedTag = tag;
            _liveText = "";
            _liveUntil = 0f;
            _card.SetActive(true);
            _card.transform.SetAsLastSibling();
            RequestLive(false);
            RefreshCard();
        }

        private void CloseCard()
        {
            _selectedTag = null;
            if (_card != null) _card.SetActive(false);
        }

        /// <summary>Asks for 1 Hz vitals of the selected wristband (not more than every 20 s unless asked again).</summary>
        private void RequestLive(bool force)
        {
            var net = ShiroNetworkManager.Instance;
            if (_selectedTag == null || net == null) return;
            if (!net.IsConnected) { _liveText = "⚠ Not connected to the edge server: 1 Hz cannot be requested."; return; }
            if (!force && _lastActiveRequest.TryGetValue(_selectedTag, out var last) && Time.time - last < ActiveModeRepeatSeconds)
            {
                return; // requested a moment ago: its answer is shown
            }
            var subject = FindSubject(ViewingActiveWard ? net.LastLoadedSubjects : _viewData?.tracked_subjects, _selectedTag);
            if (net.RequestActiveMode(subject != null && !string.IsNullOrEmpty(subject.device_id) ? subject.device_id : _selectedTag, subject?.mac_address))
            {
                _lastActiveRequest[_selectedTag] = Time.time;
                _liveText = "⏳ Requesting 1 Hz vitals from the edge server…";
                _liveUntil = 0f;
            }
        }

        private void RefreshCard()
        {
            if (_card == null || !_card.activeSelf || _selectedTag == null) return;
            var net = ShiroNetworkManager.Instance;
            var subjects = ViewingActiveWard ? net?.LastLoadedSubjects : _viewData?.tracked_subjects;
            var s = FindSubject(subjects, _selectedTag);
            _tags.TryGetValue(_selectedTag, out var mark);

            _cardTitle.text = s != null ? $"👤 {s.full_name}" : $"📟 {_selectedTag}";
            var lines = new List<string>();
            if (s != null)
            {
                lines.Add($"Patient {s.patient_id} · {(string.IsNullOrEmpty(s.assigned_bed_id) ? "no bed assigned" : s.assigned_bed_id)}");
                if (s.HasHeight || s.weight_kg > 0f)
                    lines.Add($"{(s.HasHeight ? $"{s.height_cm} cm" : "height not recorded")} · {(s.weight_kg > 0f ? $"{s.weight_kg:0.#} kg" : "weight not recorded")}");
                lines.Add($"Wristband {s.device_id}{(string.IsNullOrEmpty(s.mac_address) ? "" : $" ({s.mac_address})")}");
            }
            else
            {
                lines.Add("No patient is bound to this wristband in this ward.");
            }

            if (_vitals.TryGetValue(_selectedTag, out var v) || (s != null && !string.IsNullOrEmpty(s.device_id) && _vitals.TryGetValue(s.device_id.ToUpper(), out v)))
            {
                float age = Time.time - v.at;
                lines.Add($"❤ {(v.bpm > 0 ? $"{v.bpm} BPM" : "-- BPM")}   🫁 {(v.spo2 > 0 ? $"~{v.spo2} %" : "-- %")}   🔋 {(v.battery >= 0 ? $"{v.battery} %" : "-- %")}");
                lines.Add($"Motion: {(string.IsNullOrEmpty(v.motion) ? "not reported" : v.motion.ToLower().Replace('_', ' '))} · vitals {age:F0} s ago");
            }
            else
            {
                lines.Add("No vitals received from this wristband yet.");
            }
            if (mark != null) lines.Add($"Position ({mark.x:F1} m, {mark.y:F1} m), {Time.time - mark.lastSeen:F0} s ago");
            _cardBody.text = string.Join("\n", lines);

            string live = _liveText;
            if (_liveUntil > 0f)
            {
                float left = _liveUntil - Time.time;
                live = left > 0 ? $"{_liveText}\n{left:F0} s left" : "1 Hz period ended: back to the normal rate. Tap \"Request 1 Hz again\" to continue.";
            }
            _cardLive.text = live;
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
            go.GetComponent<Image>().raycastTarget = false;
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
            txt.raycastTarget = false;
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
