// =============================================================================
// Project SHIRO - headset app version 2: the ward panel (the main menu)
//
// Opens with Meta's menu gesture (left palm toward you, pinch), Y or B, or the
// wrist chip. It appears in front of the clinician, within reach, and glides
// back in front when they turn away ("Pin here" leaves it where it is). It
// replaces the hand slate of version 1 for everyday use:
//   Patients - every patient of the ward: name, bed, heart rate in the same
//              words as their tag, alerts first. A tap shows where they are
//              (their tag pulses blue and an arrow points to it, or to their
//              bed); a patient with an alert opens the alert card.
//   Map      - the ward from above: beds, door, patients, you.
//   Settings - the ward shown, the connection, and the version 1 menu for room
//              setup, server address, pairing and the test tools (until stage 4).
// Creates itself when the scene loads.
// =============================================================================
using System;
using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace ShiroMR.UI
{
    public class ShiroWardPanel : MonoBehaviour
    {
        public static ShiroWardPanel Instance { get; private set; }

        // Size (mm) and place: within reach, a little below the eyes
        internal const float W = 400f, H = 354f, Pad = 20f;
        private const float Distance = 0.62f;
        private const float Below = 0.14f;
        private const float FollowAngle = 50f;         // degrees off the view before it glides back
        private const float PageTop = 108f;
        internal const float PageH = H - PageTop - 14f;
        private const int RowsPerPage = 4;
        private const float RowH = 44f, RowGap = 6f;

        private enum Page { Patients = 0, Map = 1, Settings = 2 }
        private Page _page = Page.Patients;

        private bool _open;
        private bool _pinned;
        private bool _placed;
        private bool _following;
        private bool _built;
        private Transform _head;
        private float _refreshIn;

        private Canvas _canvas;
        private TextMeshProUGUI _title, _status;
        private Image _statusDot;
        private ShiroButton _pinBtn;
        private readonly ShiroButton[] _tabs = new ShiroButton[3];
        private readonly GameObject[] _pages = new GameObject[3];

        // Patients
        private readonly List<RowView> _rows = new List<RowView>();
        private readonly List<PatientRow> _data = new List<PatientRow>();
        private int _pageIndex;
        private ShiroButton _prevBtn, _nextBtn;
        private TextMeshProUGUI _note;      // a hint, "Page 1 of 2", or what "Show me" did
        private string _noteText;
        private float _noteUntil;

        // Map
        private ShiroWardMapView _map;

        // Settings
        private TextMeshProUGUI _wardHeading, _connection;
        private readonly List<ShiroButton> _wardBtns = new List<ShiroButton>();
        private string _wardBtnsKey = "";
        private ShiroButton _linkBtn;

        /// <summary>One patient of the list (the preview tool fills these with sample data).</summary>
        public class PatientRow
        {
            public string Name, Line, Value;
            public Color Stripe, LineColour;
            public bool ValueDim, Alert;
            public int Order;                 // 0 alert, 1 needs a look, 2 fine, 3 not heard, 4 no position
            public string SortKey;
            public string TagId, BedId;
        }

        private class RowView
        {
            public ShiroButton Button;
            public Image Stripe;
            public TextMeshProUGUI Name, Line, Value, Unit;
            public PatientRow Data;
        }

        public bool IsOpen => _open;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Bootstrap()
        {
            if (Instance == null && FindAnyObjectByType<ShiroWardPanel>() == null)
                new GameObject("ShiroWardPanel").AddComponent<ShiroWardPanel>();
        }

        private void Awake()
        {
            if (Instance != null && Instance != this) { Destroy(gameObject); return; }
            Instance = this;
            Build();
            Open();   // shown at start: the connection and the ward at a glance
        }

        private void OnDestroy()
        {
            var net = ShiroNetworkManager.Instance;
            if (_subscribed && net != null) net.OnAnyPositionUpdated -= HandlePosition;
        }

        // ----- Open, close, place -----

        public void Open()
        {
            _open = true;
            _placed = false;
            if (_canvas != null) _canvas.gameObject.SetActive(true);
            _refreshIn = 0f;
        }

        public void Close()
        {
            _open = false;
            if (_canvas != null) _canvas.gameObject.SetActive(false);
        }

        public void Toggle() { if (_open) Close(); else Open(); }

        private void TogglePin()
        {
            _pinned = !_pinned;
            _following = false;
            _pinBtn.SetText(_pinned ? "Follow me" : "Pin here");
        }

        private bool _subscribed;

        private void Update()
        {
            if (!_subscribed && ShiroNetworkManager.Instance != null)
            {
                ShiroNetworkManager.Instance.OnAnyPositionUpdated += HandlePosition;
                _subscribed = true;
            }
            if (!_open) return;
            if (_head == null && Camera.main != null) _head = Camera.main.transform;
            if (_head != null) Place();

            _refreshIn -= Time.deltaTime;
            if (_refreshIn <= 0f)
            {
                _refreshIn = _page == Page.Map ? 0.25f : 1f;
                RefreshHeader();
                if (_page == Page.Patients) RefreshPatients();
                else if (_page == Page.Map) RefreshMap();
                else RefreshSettings();
            }
        }

        /// <summary>In front when opened; then it stays while the clinician looks around a little.</summary>
        private void Place()
        {
            Vector3 flat = _head.forward;
            flat.y = 0f;
            if (flat.sqrMagnitude < 0.001f) flat = Vector3.forward;
            flat.Normalize();
            Vector3 target = _head.position + flat * Distance + Vector3.down * Below;
            Quaternion rot = Quaternion.LookRotation(target - _head.position, Vector3.up);
            Transform t = _canvas.transform;
            if (!_placed)
            {
                t.SetPositionAndRotation(target, rot);
                _placed = true;
                return;
            }
            if (_pinned) return;
            Vector3 to = t.position - _head.position;
            float off = Vector3.Angle(flat, Vector3.ProjectOnPlane(to, Vector3.up));
            float want = Mathf.Sqrt(Distance * Distance + Below * Below);
            if (off > FollowAngle || Mathf.Abs(to.magnitude - want) > 0.45f) _following = true;
            if (_following)
            {
                float k = 1f - Mathf.Exp(-5f * Time.deltaTime);
                t.SetPositionAndRotation(Vector3.Lerp(t.position, target, k), Quaternion.Slerp(t.rotation, rot, k));
                if ((t.position - target).sqrMagnitude < 0.0004f) _following = false;
            }
        }

        // ----- Header -----

        private void RefreshHeader()
        {
            var net = ShiroNetworkManager.Instance;
            string ward = "No ward chosen";
            if (net != null && net.HasWard)
            {
                var loaded = net.LastLoadedWardConfig;
                ward = loaded != null && string.Equals(loaded.ward_id, net.targetWardId, StringComparison.OrdinalIgnoreCase) && !string.IsNullOrEmpty(loaded.room_title)
                    ? loaded.room_title : net.targetWardId;
            }
            _title.text = ward;
            _status.text = StatusWords(net, out Color dot);
            _statusDot.color = dot;
            int n = net != null && net.LastLoadedSubjects != null ? net.LastLoadedSubjects.Count : 0;
            _tabs[0].SetText(n > 0 ? $"Patients ({n})" : "Patients");
        }

        internal static string StatusWords(ShiroNetworkManager net, out Color dot)
        {
            if (net == null) { dot = ShiroTheme.Off; return "Starting…"; }
            if (!net.IsPaired) { dot = ShiroTheme.Warn; return "Not paired: see Settings"; }
            if (!net.IsConnected) { dot = ShiroTheme.Off; return "Not connected to the edge server"; }
            if (!net.HasWard) { dot = ShiroTheme.Warn; return "Connected · choose a ward in Settings"; }
            dot = ShiroTheme.Good;
            var who = net.AssignedClinician;
            return who != null && who.IsSet ? $"Connected · used by {who.name}" : "Connected · no clinician assigned";
        }

        private void SelectPage(Page page)
        {
            _page = page;
            for (int i = 0; i < 3; i++)
            {
                _pages[i].SetActive(i == (int)page);
                _tabs[i].SetKind(i == (int)page ? ButtonKind.Primary : ButtonKind.Secondary);
            }
            _refreshIn = 0f;
        }

        // ----- Patients -----

        private void RefreshPatients()
        {
            _data.Clear();
            CollectRows(_data);
            ShowRows(_data);
        }

        /// <summary>The ward's patients with their tag's state, alerts first.</summary>
        private static void CollectRows(List<PatientRow> rows)
        {
            var net = ShiroNetworkManager.Instance;
            var mr = ShiroMRManager.Instance;
            var am = ShiroAlertManager.Instance;
            var subjects = net != null ? net.LastLoadedSubjects : null;
            if (subjects == null) return;
            var ward = net.LastLoadedWardConfig;
            foreach (var s in subjects)
            {
                if (s == null) continue;
                var row = new PatientRow
                {
                    Name = !string.IsNullOrEmpty(s.full_name) ? s.full_name : (s.patient_id ?? "Unknown patient"),
                    TagId = s.device_id,
                    BedId = s.assigned_bed_id
                };
                string bed = BedCode(ward, s.assigned_bed_id);
                var holo = mr != null && !string.IsNullOrEmpty(s.device_id) ? mr.GetHologram(s.device_id) : null;
                if (holo != null)
                {
                    var st = holo.GetListState();
                    row.Value = st.Value;
                    row.ValueDim = st.Dim || st.Value == "--";
                    row.Line = $"{st.Bed} · {st.Words}";
                    row.Stripe = st.Colour;
                    row.LineColour = st.Warn ? ShiroTheme.WarnText : ShiroTheme.TextDim;
                    if (st.BatteryLow) { row.Line += $" · battery {st.Battery} %"; row.LineColour = ShiroTheme.WarnText; }
                    row.Order = !st.Heard ? 3 : (st.Warn || st.BatteryLow) ? 1 : 2;
                    bed = st.Bed;
                }
                else
                {
                    row.Value = "--";
                    row.ValueDim = true;
                    row.Line = string.IsNullOrEmpty(s.device_id) ? $"{bed} · no wristband" : $"{bed} · no position yet";
                    row.Stripe = ShiroTheme.Off;
                    row.LineColour = ShiroTheme.TextDim;
                    row.Order = 4;
                }
                var alert = PendingAlertFor(am, s);
                if (alert != null)
                {
                    row.Alert = true;
                    row.Order = 0;
                    row.Line = $"{ShiroAlertCard.WhatHappened(alert.incident)}: waiting for a response";
                    row.LineColour = ShiroTheme.AlertText;
                    row.Stripe = ShiroTheme.Alert;
                }
                row.SortKey = $"{bed}|{row.Name}";
                rows.Add(row);
            }
            rows.Sort((a, b) => a.Order != b.Order ? a.Order.CompareTo(b.Order) : string.CompareOrdinal(a.SortKey, b.SortKey));
        }

        private static ShiroAlertManager.HeadsetAlert PendingAlertFor(ShiroAlertManager am, TrackedSubject s)
        {
            if (am == null) return null;
            foreach (var a in am.Alerts)
            {
                if (a == null || a.incident == null || a.status == ShiroAlertManager.AlertStatus.AcknowledgedElsewhere) continue;
                bool samePatient = !string.IsNullOrEmpty(s.patient_id) && string.Equals(a.incident.patient_id, s.patient_id, StringComparison.OrdinalIgnoreCase);
                bool sameBand = !string.IsNullOrEmpty(s.device_id) && string.Equals(a.incident.device_id, s.device_id, StringComparison.OrdinalIgnoreCase);
                if (samePatient || sameBand) return a;
            }
            return null;
        }

        internal static string BedCode(WardConfig ward, string bedId)
        {
            if (string.IsNullOrEmpty(bedId) || bedId == "--") return "No bed";
            if (ward != null && ward.beds != null)
                foreach (var b in ward.beds)
                    if (b != null && b.bed_id == bedId && !string.IsNullOrEmpty(b.bed_code)) return b.bed_code;
            return bedId;
        }

        /// <summary>Shows rows on the list (pages of four). Also used by the preview tool.</summary>
        internal void ShowRows(List<PatientRow> data)
        {
            int pages = Mathf.Max(1, Mathf.CeilToInt(data.Count / (float)RowsPerPage));
            _pageIndex = Mathf.Clamp(_pageIndex, 0, pages - 1);
            for (int i = 0; i < RowsPerPage; i++)
            {
                int idx = _pageIndex * RowsPerPage + i;
                var view = _rows[i];
                bool has = idx < data.Count;
                view.Button.gameObject.SetActive(has);
                if (!has) { view.Data = null; continue; }
                var r = data[idx];
                view.Data = r;
                view.Name.text = r.Name;
                view.Line.text = r.Line;
                view.Line.color = r.LineColour;
                view.Value.text = r.Value;
                view.Value.color = r.ValueDim ? ShiroTheme.TextDim : ShiroTheme.Text;
                view.Stripe.color = r.Stripe;
            }
            bool paged = pages > 1;
            _prevBtn.gameObject.SetActive(paged);
            _nextBtn.gameObject.SetActive(paged);
            _prevBtn.SetInteractable(_pageIndex > 0);
            _nextBtn.SetInteractable(_pageIndex < pages - 1);
            PlaceNote(paged);

            bool noting = Time.time < _noteUntil;
            string empty = EmptyWords(data.Count);
            if (noting) _note.text = _noteText;
            else if (empty != null) _note.text = empty;
            else _note.text = paged ? $"Page {_pageIndex + 1} of {pages}" : "Tap a patient to see where they are.";
            _note.color = noting ? ShiroTheme.OkText : ShiroTheme.TextDim;
        }

        private static string EmptyWords(int count)
        {
            if (count > 0) return null;
            var net = ShiroNetworkManager.Instance;
            if (net == null || !net.IsConnected) return "Not connected: the patient list comes from the edge server.";
            if (!net.HasWard) return "No ward chosen: choose one in Settings.";
            if (!net.IsWardLoaded) return "Loading the ward…";
            return "No patients in this ward.";
        }

        private void TapRow(int i)
        {
            var r = _rows[i].Data;
            if (r == null) return;
            if (r.Alert && ShiroAlertCard.Instance != null) { ShiroAlertCard.Instance.Open(); return; }
            ShowPatient(r.TagId, r.BedId, r.Name);
        }

        /// <summary>
        /// "Show me": the patient's tag pulses blue and an arrow points to it; without a tag,
        /// the arrow points to their bed (the ward aligned to the room).
        /// </summary>
        public void ShowPatient(string tagId, string bedId, string name)
        {
            var mr = ShiroMRManager.Instance;
            var holo = mr != null && !string.IsNullOrEmpty(tagId) ? mr.GetHologram(tagId) : null;
            if (holo != null)
            {
                holo.Highlight(6f);
                ShiroGuideArrow.Show(() => holo != null ? holo.GuidePoint : (Vector3?)null, 8f);
                Note($"{FirstName(name)}: their tag is pulsing blue.");
                return;
            }
            var net = ShiroNetworkManager.Instance;
            var ward = net != null ? net.LastLoadedWardConfig : null;
            WardBed bed = null;
            if (ward != null && ward.beds != null && !string.IsNullOrEmpty(bedId))
                foreach (var b in ward.beds) if (b != null && b.bed_id == bedId) bed = b;
            var space = WardSpatialManager.Instance;
            if (bed != null && space != null && space.IsAligned)
            {
                Vector3 p = space.GetBedHeadboardWorldPosition(bed);
                ShiroGuideArrow.Show(() => p, 8f);
                Note($"{FirstName(name)}: no position yet; the arrow shows their bed.");
                return;
            }
            Note($"{FirstName(name)}: no position in this room yet.");
        }

        private static string FirstName(string full)
        {
            if (string.IsNullOrEmpty(full)) return "Patient";
            string t = full.Trim();
            int sp = t.IndexOf(' ');
            return sp > 0 ? t.Substring(0, sp) : t;
        }

        private void Note(string text)
        {
            _noteText = text;
            _noteUntil = Time.time + 5f;
            _refreshIn = 0f;
        }

        private void TurnPage(int delta)
        {
            _pageIndex += delta;
            _refreshIn = 0f;
        }

        // ----- Map -----

        private void HandlePosition(IpsPositionUpdate pos) { _map?.OnPosition(pos); }

        private void RefreshMap()
        {
            var net = ShiroNetworkManager.Instance;
            WardConfig ward = net != null && net.IsWardLoaded ? net.LastLoadedWardConfig : null;
            _map.Refresh(ward, net != null ? net.LastLoadedSubjects : null, net != null && net.IsConnected);
        }

        // ----- Settings -----

        private void RefreshSettings()
        {
            var net = ShiroNetworkManager.Instance;
            var wards = new List<WardSummary>();
            if (net != null) foreach (var w in net.AvailableWards) if (w != null && !string.IsNullOrEmpty(w.ward_id)) wards.Add(w);
            ShowWards(wards, net != null ? net.targetWardId : "");

            if (net == null) { _connection.text = "Starting…"; return; }
            string where = $"{net.serverIp}:{net.serverPort}";
            string device = net.Identity != null ? net.Identity.DeviceId : "this headset";
            _connection.text = (net.IsConnected ? $"Connected to the edge server at {where}." : $"Not connected to the edge server at {where}.")
                + "\n" + (net.IsPaired ? $"{device} is paired." : $"{device} is not paired yet: Server and pairing.");
            _connection.color = net.IsConnected && net.IsPaired ? ShiroTheme.Text : ShiroTheme.WarnText;
        }

        /// <summary>The wards as buttons (up to 6), the one shown highlighted. Also used by the preview tool.</summary>
        internal void ShowWards(List<WardSummary> wards, string active)
        {
            string key = active + "|";
            foreach (var w in wards) key += w.ward_id + ";";
            if (key == _wardBtnsKey) return;
            _wardBtnsKey = key;
            foreach (var b in _wardBtns) if (b != null) Destroy(b.gameObject);
            _wardBtns.Clear();

            Transform page = _pages[(int)Page.Settings].transform;
            float bw = (W - 2 * Pad - 2 * ShiroTheme.Gap) / 3f;
            int n = Mathf.Min(wards.Count, 6);
            for (int i = 0; i < n; i++)
            {
                var w = wards[i];
                string id = w.ward_id;
                bool shown = string.Equals(id, active, StringComparison.OrdinalIgnoreCase);
                string label = !string.IsNullOrEmpty(w.room_title) ? w.room_title : id;
                var b = ShiroUIKit.Button(page, $"Ward_{id}", label, shown ? ButtonKind.Primary : ButtonKind.Secondary, () => ChooseWard(id), 13f);
                if (b.Label != null) b.Label.fontSizeMin = 9f;   // long ward names shrink further
                ShiroUIKit.Place(b, Pad + (i % 3) * (bw + ShiroTheme.Gap), 22f + (i / 3) * 40f, bw, 34f);
                _wardBtns.Add(b);
            }
            _wardHeading.text = wards.Count == 0 ? "Ward: the list comes from the edge server (not connected?)"
                : wards.Count > 6 ? $"Ward shown on this headset (first 6 of {wards.Count})" : "Ward shown on this headset";
        }

        private void ChooseWard(string id)
        {
            var net = ShiroNetworkManager.Instance;
            if (net != null) net.SwitchWard(id);
            _wardBtnsKey = "";
            _refreshIn = 0f;
        }

        private void OpenOldMenu(int tab)
        {
            var slate = ShiroHandSlate.Instance;
            if (slate == null) return;
            Close();
            slate.OpenOldMenu(tab);
        }

        // ----- Building -----

        private void Build()
        {
            if (_built) return;
            _built = true;
            _canvas = ShiroUIKit.WorldCanvas("WardPanel", transform, new Vector2(W, H));
            Transform root = _canvas.transform;
            ShiroUIKit.Fill(ShiroUIKit.Panel(root, "Background", ShiroTheme.Glass, 18f));

            // Header: the ward, the connection; pin and close
            _title = ShiroUIKit.Label(root, "Title", "", 18f, ShiroTheme.Text, FontStyles.Bold).Fit(13f);
            ShiroUIKit.Place(_title, Pad, 10, W - 2 * Pad - 190, 26);
            var close = ShiroUIKit.Button(root, "Close", "Close", ButtonKind.Secondary, Close, 13f);
            ShiroUIKit.Place(close, W - Pad - 74, 8, 74, 30);
            _pinBtn = ShiroUIKit.Button(root, "Pin", "Pin here", ButtonKind.Secondary, TogglePin, 13f);
            ShiroUIKit.Place(_pinBtn, W - Pad - 74 - ShiroTheme.Gap - 92, 8, 92, 30);
            _statusDot = ShiroUIKit.Dot(root, "StatusDot", ShiroTheme.Off);
            ShiroUIKit.Place(_statusDot, Pad, 45, 9, 9);
            _status = ShiroUIKit.Label(root, "Status", "", 12f, ShiroTheme.TextDim).Fit(9f);
            ShiroUIKit.Place(_status, Pad + 14, 41, W - 2 * Pad - 14, 17);

            // Tabs
            string[] names = { "Patients", "Map", "Settings" };
            float tw = (W - 2 * Pad - 2 * ShiroTheme.Gap) / 3f;
            for (int i = 0; i < 3; i++)
            {
                int index = i;
                _tabs[i] = ShiroUIKit.Button(root, $"Tab_{names[i]}", names[i], ButtonKind.Secondary, () => SelectPage((Page)index), 14f);
                ShiroUIKit.Place(_tabs[i], Pad + i * (tw + ShiroTheme.Gap), 64, tw, 36);
                _pages[i] = new GameObject($"Page_{names[i]}", typeof(RectTransform));
                _pages[i].transform.SetParent(root, false);
                ShiroUIKit.Place(_pages[i].transform as RectTransform, 0, PageTop, W, PageH);
            }

            BuildPatients(_pages[0].transform);
            _map = new ShiroWardMapView();
            _map.Build(_pages[1].transform, Pad, W - 2 * Pad, PageH, (tag, bed, name) => ShowPatient(tag, bed, name));
            BuildSettings(_pages[2].transform);
            SelectPage(Page.Patients);
            _canvas.gameObject.SetActive(false);
        }

        private void BuildPatients(Transform page)
        {
            float w = W - 2 * Pad;
            for (int i = 0; i < RowsPerPage; i++)
            {
                int index = i;
                var v = new RowView();
                v.Button = ShiroUIKit.Button(page, $"Row_{i}", null, ButtonKind.Surface, () => TapRow(index));
                ShiroUIKit.Place(v.Button, Pad, i * (RowH + RowGap), w, RowH);
                Transform row = v.Button.transform;
                v.Stripe = ShiroUIKit.Panel(row, "Status", ShiroTheme.Off, 3f);
                ShiroUIKit.Place(v.Stripe, 6, 6, 6, RowH - 12);
                v.Name = ShiroUIKit.Label(row, "Name", "", 15f, ShiroTheme.Text, FontStyles.Bold).Fit(11f);
                ShiroUIKit.Place(v.Name, 20, 4, 244, 20);
                v.Line = ShiroUIKit.Label(row, "Line", "", 12f, ShiroTheme.TextDim).Fit(9f);
                ShiroUIKit.Place(v.Line, 20, 24, 252, 16);
                v.Value = ShiroUIKit.Label(row, "Heart", "", 22f, ShiroTheme.Text, FontStyles.Bold, TextAlignmentOptions.Right);
                ShiroUIKit.Place(v.Value, w - 92, 1, 80, 26);
                v.Unit = ShiroUIKit.Label(row, "HeartUnit", "<color=#F87171>♥</color> bpm", 11f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.Right);
                v.Unit.richText = true;
                ShiroUIKit.Place(v.Unit, w - 92, 27, 80, 14);
                v.Button.gameObject.SetActive(false);
                _rows.Add(v);
            }
            float footY = RowsPerPage * (RowH + RowGap) + 2f;
            _prevBtn = ShiroUIKit.Button(page, "Previous", "Previous", ButtonKind.Secondary, () => TurnPage(-1), 12f);
            ShiroUIKit.Place(_prevBtn, Pad, footY, PagerW, 30);
            _nextBtn = ShiroUIKit.Button(page, "Next", "Next", ButtonKind.Secondary, () => TurnPage(1), 12f);
            ShiroUIKit.Place(_nextBtn, W - Pad - PagerW, footY, PagerW, 30);
            _note = ShiroUIKit.Label(page, "Note", "", 12f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.Center, true).Fit(8f);
            _footY = footY;
            PlaceNote(false);
        }

        private float _footY;
        private const float PagerW = 70f;

        /// <summary>The note (one or two lines): between Previous and Next with pages, else the whole width.</summary>
        private void PlaceNote(bool paged)
        {
            if (paged) ShiroUIKit.Place(_note, Pad + PagerW + 8f, _footY, W - 2 * Pad - 2 * PagerW - 16f, 30);
            else ShiroUIKit.Place(_note, Pad, _footY, W - 2 * Pad, 30);
        }

        private void BuildSettings(Transform page)
        {
            float w = W - 2 * Pad;
            _wardHeading = ShiroUIKit.Label(page, "WardHeading", "Ward shown on this headset", 12f, ShiroTheme.TextDim).Fit(9f);
            ShiroUIKit.Place(_wardHeading, Pad, 0, w, 18);

            var connHeading = ShiroUIKit.Label(page, "ConnHeading", "Connection", 12f, ShiroTheme.TextDim);
            ShiroUIKit.Place(connHeading, Pad, 106, w, 18);
            _connection = ShiroUIKit.Label(page, "Connection", "", 13f, ShiroTheme.Text, FontStyles.Normal, TextAlignmentOptions.TopLeft, true).Fit(10f);
            ShiroUIKit.Place(_connection, Pad, 124, w, 34);

            float bw = (w - ShiroTheme.Gap) / 2f;
            var reconnect = ShiroUIKit.Button(page, "Reconnect", "Reconnect", ButtonKind.Secondary, () =>
            {
                var net = ShiroNetworkManager.Instance;
                if (net != null) net.Connect();
            }, 13f);
            ShiroUIKit.Place(reconnect, Pad, 162, bw, 30);
            // Over Quest Link the edge server runs on the same computer (editor only)
            _linkBtn = ShiroUIKit.Button(page, "QuestLink", "Server on this PC (Link)", ButtonKind.Secondary, () =>
            {
                var net = ShiroNetworkManager.Instance;
                if (net != null) net.SetServerIp("127.0.0.1");
            }, 13f);
            ShiroUIKit.Place(_linkBtn, Pad + bw + ShiroTheme.Gap, 162, bw, 30);
            _linkBtn.gameObject.SetActive(Application.isEditor);

            var server = ShiroUIKit.Button(page, "ServerPairing", "Server and pairing", ButtonKind.Secondary, () => OpenOldMenu(3), 13f);
            ShiroUIKit.Place(server, Pad, 200, bw, 30);
            var setup = ShiroUIKit.Button(page, "RoomSetup", "Room setup and tools", ButtonKind.Secondary, () => OpenOldMenu(0), 13f);
            ShiroUIKit.Place(setup, Pad + bw + ShiroTheme.Gap, 200, bw, 30);
        }
    }
}
