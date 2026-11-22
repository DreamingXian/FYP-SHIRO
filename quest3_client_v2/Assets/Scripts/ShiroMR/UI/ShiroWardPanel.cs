// =============================================================================
// Project SHIRO - headset app version 2: the ward panel (the main menu)
//
// Opens with Meta's menu gesture (left palm toward you, pinch), Y or B, or the
// wrist chip. It appears in front of the clinician within easy reach of a
// fingertip (0.45 m, drawn at 0.8 so it keeps its size to the eye) and glides
// back in front when they turn away ("Pin here" leaves it where it is). It
// steps aside while an alert card is shown. It replaces the hand slate of
// version 1 for everyday use:
//   Patients - the ward's patients with a wristband: name, bed, heart rate in
//              the same words as their tag, alerts first; four per page with
//              the web dashboard's pager. A tap opens the patient (stage 3,
//              ShiroPatientView): now (with "Show me": their tag pulses blue
//              and an arrow points to it, or to their bed), the last 24 hours,
//              alerts, profile.
//   Map      - the ward from above: beds, door, patients, you (a tap on a
//              patient opens them too); ‹ › shows the other wards (their plan
//              and patients from the edge server; the version 1 Live Map's).
//   Settings - (ShiroSettingsView, stage 4) the ward and how it was found, room
//              setup in numbered steps, the server address and pairing keypads,
//              the test tools under Advanced. The version 1 hand slate is no
//              longer opened.
// The header shows how the ward was found: a badge "Found automatically"
// (green), "Room not set up" (amber), "Outside this ward" or "Chosen by hand";
// when the headset switches ward by itself the badge blinks and a note says so.
// While the room alignment waits for a point at the door, the panel steps aside
// for a small bar above the view (the step, Cancel), so the ray reaches the floor.
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

        // Size (mm, as drawn) and place: within easy reach, below the eyes
        internal const float W = 400f, H = 354f, Pad = 20f;
        private const float Distance = 0.45f;          // m ahead
        private const float Below = 0.20f;             // m below the eyes
        private const float PanelScale = 0.8f;         // drawn size × 0.8 at 0.45 m: the same size to the eye
        private const float FollowAngle = 50f;         // degrees off the view before it glides back
        private const float PageTop = 108f;
        internal const float PageH = H - PageTop - 14f;
        private const int RowsPerPage = 4;
        private const float RowH = 42f, RowGap = 6f;
        private const float NoteY = RowsPerPage * (RowH + RowGap) - RowGap + 4f;   // under the rows
        private const float PagerY = PageH - 28f;
        private const float PagerH = 28f;

        private enum Page { Patients = 0, Map = 1, Settings = 2 }
        private Page _page = Page.Patients;

        private bool _open;
        private bool _visible;
        private bool _pinned;
        private bool _placed;
        private bool _following;
        private bool _built;
        private bool _subscribed;
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
        private TextMeshProUGUI _note, _empty;
        private readonly ShiroPager _pager = new ShiroPager();
        private string _noteText;
        private float _noteUntil;

        // The list, map and settings (with the header and tabs), or one patient (stage 3)
        private GameObject _mainRoot;
        private readonly ShiroPatientView _patientView = new ShiroPatientView();

        // Map; another ward can be shown (null: the ward this headset is in)
        private ShiroWardMapView _map;
        private string _mapWardId;
        private ShiroButton _mapPrev, _mapNext;
        private TextMeshProUGUI _mapWard;
        private readonly Dictionary<string, WardInitResponse> _otherWards = new Dictionary<string, WardInitResponse>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, float> _otherWardAt = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, string> _otherWardError = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        private string _fetchingWard;
        private const float OtherWardRefreshS = 30f;

        // Settings (stage 4)
        private readonly ShiroSettingsView _settings = new ShiroSettingsView();

        // How the ward was found (header badge); blinks after the headset switched ward by itself
        private Image _badge;
        private TextMeshProUGUI _badgeText;
        private float _badgeBlinkUntil = -1f;
        private bool _detectSubscribed;

        // Room alignment: a small bar above the view while pointing at the door
        private const float BarW = 340f, BarH = 64f;
        private Canvas _aimBar;
        private TextMeshProUGUI _aimText;
        private bool _aimPlaced;

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

        /// <summary>Open (it may be stepping aside for an alert card meanwhile).</summary>
        public bool IsOpen => _open;

        /// <summary>Open and shown now (not stepping aside for an alert card).</summary>
        public bool IsVisible => _visible;

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
            _refreshIn = 0f;
            UpdateVisible();
        }

        public void Close()
        {
            _open = false;
            if (_patientView.IsShown) ShowList();   // opens on the list next time
            UpdateVisible();
        }

        public void Toggle() { if (_open) Close(); else Open(); }

        /// <summary>
        /// Stage 3 (UC-05): one patient: now, the last 24 hours, alerts, profile. From a row of
        /// the list, a dot on the map, or "Profile and history" on the patient's tag.
        /// </summary>
        public void OpenPatient(string tagId, TrackedSubject subject = null)
        {
            if (string.IsNullOrEmpty(tagId)) return;
            if (!_open) Open();
            _mainRoot.SetActive(false);
            _patientView.Show(tagId, subject);
            _refreshIn = 0f;
        }

        /// <summary>Back from a patient to the list (or the page it was opened from).</summary>
        internal void ShowList()
        {
            _patientView.Hide();
            _mainRoot.SetActive(true);
            _refreshIn = 0f;
        }

        /// <summary>The preview tool: the patient view with sample data (nothing is asked from the edge server).</summary>
        internal ShiroPatientView PreviewPatient(TrackedSubject s)
        {
            _mainRoot.SetActive(false);
            _patientView.PreviewOpen(s);
            return _patientView;
        }

        /// <summary>The note of the last "Show me" while it is fresh, else null (the patient view shows it too).</summary>
        internal string FreshNote => Time.time < _noteUntil ? _noteText : null;

        /// <summary>
        /// Shown while open, except while the alert card is shown (it comes first) and while the
        /// room alignment waits for a point at the door (the aiming bar is shown instead).
        /// </summary>
        private void UpdateVisible()
        {
            bool cardUp = ShiroAlertCard.Instance != null && ShiroAlertCard.Instance.IsCardShown;
            bool show = _open && !cardUp && !ShiroSettingsView.IsAiming;
            _visible = show;
            if (_canvas != null && _canvas.gameObject.activeSelf != show) _canvas.gameObject.SetActive(show);
        }

        private void TogglePin()
        {
            _pinned = !_pinned;
            _following = false;
            _pinBtn.SetText(_pinned ? "Follow me" : "Pin here");
        }

        private void Update()
        {
            if (!_subscribed && ShiroNetworkManager.Instance != null)
            {
                ShiroNetworkManager.Instance.OnAnyPositionUpdated += HandlePosition;
                _subscribed = true;
            }
            if (!_detectSubscribed && ShiroWardAutoDetect.Instance != null)
            {
                ShiroWardAutoDetect.Instance.OnWardDetected += HandleWardDetected;
                _detectSubscribed = true;
            }
            if (_head == null && Camera.main != null) _head = Camera.main.transform;
            UpdateAimBar();
            UpdateVisible();
            // After pointing at the door the clinician faces elsewhere: the panel comes back in front
            if (!_visible) { if (ShiroSettingsView.IsAiming) _placed = false; return; }
            if (_head != null) Place();
            if (Time.time < _badgeBlinkUntil) BlinkBadge();

            _refreshIn -= Time.deltaTime;
            if (_patientView.IsShown)
            {
                if (_refreshIn <= 0f) { _refreshIn = 0.5f; _patientView.Refresh(); }
                return;
            }
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
            if (off > FollowAngle || Mathf.Abs(to.magnitude - want) > 0.35f) _following = true;
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
            _title.text = WardTitle(net);
            _status.text = StatusWords(net, out Color dot);
            _statusDot.color = dot;
            string badge = ShiroSettingsView.BadgeWords(ShiroSettingsView.ModeOf(net), out Color badgeColour);
            _badge.gameObject.SetActive(badge != null);
            if (badge != null)
            {
                _badgeText.text = badge;
                if (Time.time >= _badgeBlinkUntil) _badge.color = badgeColour;
            }
            int n = CountWithWristband(net);
            _tabs[0].SetText(n > 0 ? $"Patients ({n})" : "Patients");
        }

        internal static string WardTitle(ShiroNetworkManager net)
        {
            if (net == null || !net.HasWard) return "No ward yet";
            var loaded = net.LastLoadedWardConfig;
            return loaded != null && string.Equals(loaded.ward_id, net.targetWardId, StringComparison.OrdinalIgnoreCase) && !string.IsNullOrEmpty(loaded.room_title)
                ? loaded.room_title : net.targetWardId;
        }

        internal static string StatusWords(ShiroNetworkManager net, out Color dot)
        {
            if (net == null) { dot = ShiroTheme.Off; return "Starting…"; }
            if (!net.IsPaired) { dot = ShiroTheme.Warn; return "Not paired: see Settings"; }
            if (!net.IsConnected) { dot = ShiroTheme.Off; return "Not connected to the edge server"; }
            if (!net.HasWard) { dot = ShiroTheme.Warn; return "Connected · no ward yet: see Settings"; }
            dot = ShiroTheme.Good;
            var who = net.AssignedClinician;
            return who != null && who.IsSet ? $"Connected · used by {who.name}" : "Connected · no clinician assigned";
        }

        /// <summary>The ward shown was found by the headset itself (it stands in an aligned ward).</summary>
        internal static bool WardFoundAutomatically()
        {
            var det = ShiroWardAutoDetect.Instance;
            if (det == null || !det.IsEnabled || string.IsNullOrEmpty(det.StatusText)) return false;
            return det.StatusText.StartsWith("in ", StringComparison.Ordinal) || det.StatusText.StartsWith("entered ", StringComparison.Ordinal);
        }

        private void SelectPage(Page page)
        {
            _page = page;
            for (int i = 0; i < 3; i++)
            {
                _pages[i].SetActive(i == (int)page);
                _tabs[i].SetKind(i == (int)page ? ButtonKind.Primary : ButtonKind.Secondary);
            }
            if (page == Page.Settings) _settings.ShowView(ShiroSettingsView.View.Main);
            _refreshIn = 0f;
        }

        // ----- Patients -----

        private void RefreshPatients()
        {
            _data.Clear();
            CollectRows(_data);
            ShowRows(_data);
        }

        private static int CountWithWristband(ShiroNetworkManager net)
        {
            if (net == null || net.LastLoadedSubjects == null) return 0;
            int n = 0;
            foreach (var s in net.LastLoadedSubjects) if (s != null && !string.IsNullOrEmpty(s.device_id)) n++;
            return n;
        }

        /// <summary>The ward's patients with a wristband, with their tag's state, alerts first.</summary>
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
                if (s == null || string.IsNullOrEmpty(s.device_id)) continue;   // the headset follows wristbands
                var row = new PatientRow
                {
                    Name = !string.IsNullOrEmpty(s.full_name) ? s.full_name : (s.patient_id ?? "Unknown patient"),
                    TagId = s.device_id,
                    BedId = s.assigned_bed_id
                };
                string bed = BedCode(ward, s.assigned_bed_id);
                var holo = mr != null ? mr.GetHologram(s.device_id) : null;
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
                    row.Line = $"{bed} · no position yet";
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

        internal static ShiroAlertManager.HeadsetAlert PendingAlertFor(ShiroAlertManager am, TrackedSubject s)
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

        /// <summary>Shows a page of rows and the pager. Also used by the preview tool.</summary>
        internal void ShowRows(List<PatientRow> data)
        {
            int total = data.Count;
            int pages = ShiroPager.Pages(total, RowsPerPage);
            _pageIndex = Mathf.Clamp(_pageIndex, 0, pages - 1);
            for (int i = 0; i < RowsPerPage; i++)
            {
                int idx = _pageIndex * RowsPerPage + i;
                var view = _rows[i];
                bool has = idx < total;
                if (view.Button.gameObject.activeSelf != has) view.Button.gameObject.SetActive(has);
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

            string empty = EmptyWords(total, CountWithWristband(ShiroNetworkManager.Instance) == 0 && SubjectCount() > 0);
            _empty.gameObject.SetActive(empty != null);
            if (empty != null) _empty.text = empty;

            bool noting = Time.time < _noteUntil;
            _note.text = noting ? _noteText : total > 0 ? "Tap a patient for their details, history and alerts." : "";
            _note.color = noting ? ShiroTheme.OkText : ShiroTheme.TextDim;

            _pager.Layout(_pageIndex, RowsPerPage, total);
        }

        private static int SubjectCount()
        {
            var net = ShiroNetworkManager.Instance;
            return net != null && net.LastLoadedSubjects != null ? net.LastLoadedSubjects.Count : 0;
        }

        private static string EmptyWords(int count, bool noneWithWristband)
        {
            if (count > 0) return null;
            var net = ShiroNetworkManager.Instance;
            if (net == null || !net.IsConnected) return "Not connected: the patient list comes from the edge server.";
            if (!net.HasWard) return "No ward yet: walk into a ward this headset has aligned, or see Settings.";
            if (!net.IsWardLoaded) return "Loading the ward…";
            return noneWithWristband ? "No patient in this ward has a wristband." : "No patients in this ward.";
        }

        /// <summary>A row: the patient (an alert waiting shows at the top there, with "I'm responding").</summary>
        private void TapRow(int i)
        {
            var r = _rows[i].Data;
            if (r == null) return;
            OpenPatient(r.TagId);
        }

        private void GoToPage(int page)
        {
            _pageIndex = page - 1;
            _refreshIn = 0f;
        }

        /// <summary>
        /// "Show me": the patient's tag pulses blue and an arrow points to it; without a tag,
        /// the arrow points to their bed (the ward aligned to the room).
        /// </summary>
        public void ShowPatient(string tagId, string bedId, string name)
        {
            Note(PointTo(tagId, bedId, name));
        }

        /// <summary>"Show me" and what it did, in words (for the note).</summary>
        internal static string PointTo(string tagId, string bedId, string name)
        {
            var mr = ShiroMRManager.Instance;
            var holo = mr != null && !string.IsNullOrEmpty(tagId) ? mr.GetHologram(tagId) : null;
            if (holo != null)
            {
                holo.Highlight(6f);
                ShiroGuideArrow.Show(() => holo != null ? holo.GuidePoint : (Vector3?)null, 8f);
                return $"{FirstName(name)}: their tag is pulsing blue.";
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
                return $"{FirstName(name)}: no position yet; the arrow shows their bed.";
            }
            return $"{FirstName(name)}: no position in this room yet.";
        }

        internal static string FirstName(string full)
        {
            if (string.IsNullOrEmpty(full)) return "Patient";
            string t = full.Trim();
            int sp = t.IndexOf(' ');
            return sp > 0 ? t.Substring(0, sp) : t;
        }

        internal void Note(string text)
        {
            _noteText = text;
            _noteUntil = Time.time + 5f;
            _refreshIn = 0f;
        }

        // ----- Map -----

        private void HandlePosition(IpsPositionUpdate pos) { _map?.OnPosition(pos); }

        private void RefreshMap()
        {
            var net = ShiroNetworkManager.Instance;
            bool connected = net != null && net.IsConnected;
            string own = net != null ? net.targetWardId : null;
            if (!string.IsNullOrEmpty(_mapWardId) && string.Equals(_mapWardId, own, StringComparison.OrdinalIgnoreCase)) _mapWardId = null;
            bool other = !string.IsNullOrEmpty(_mapWardId);
            int wards = net != null ? net.AvailableWards.Count : 0;
            _mapPrev.SetInteractable(wards > 1);
            _mapNext.SetInteractable(wards > 1);

            if (!other)
            {
                WardConfig ward = net != null && net.IsWardLoaded ? net.LastLoadedWardConfig : null;
                _mapWard.text = net != null && net.HasWard ? $"{WardTitle(net)} (this ward)" : "No ward yet";
                _map.Refresh(ward, net != null ? net.LastLoadedSubjects : null, connected, false, null);
                return;
            }
            // Another ward: its plan and patients from the edge server, again every 30 s
            _otherWards.TryGetValue(_mapWardId, out var data);
            _otherWardAt.TryGetValue(_mapWardId, out float at);
            if (net != null && _fetchingWard == null && (data == null || Time.time - at > OtherWardRefreshS)) FetchOtherWard(_mapWardId);
            _mapWard.text = OtherWardTitle(net, _mapWardId, data);
            _otherWardError.TryGetValue(_mapWardId, out string error);
            string note = data != null ? null : error != null ? $"Could not load this ward: {error}." : "Loading this ward from the edge server…";
            _map.Refresh(data != null ? data.ward : null, data != null ? data.tracked_subjects : null, connected, true, note);
        }

        private static string OtherWardTitle(ShiroNetworkManager net, string wardId, WardInitResponse data)
        {
            if (data != null && data.ward != null && !string.IsNullOrEmpty(data.ward.room_title)) return data.ward.room_title;
            if (net != null)
                foreach (var w in net.AvailableWards)
                    if (w != null && string.Equals(w.ward_id, wardId, StringComparison.OrdinalIgnoreCase) && !string.IsNullOrEmpty(w.room_title)) return w.room_title;
            return wardId;
        }

        private void FetchOtherWard(string wardId)
        {
            var net = ShiroNetworkManager.Instance;
            if (net == null) return;
            _fetchingWard = wardId;
            net.StartCoroutine(net.FetchWardForViewRoutine(wardId, (resp, error) =>
            {
                _fetchingWard = null;
                _otherWardAt[wardId] = Time.time;
                if (resp != null) { _otherWards[wardId] = resp; _otherWardError.Remove(wardId); }
                else _otherWardError[wardId] = error ?? "no answer";
                _refreshIn = 0f;
            }));
        }

        /// <summary>‹ ›: the ward before or after the one on show (the ward list from the edge server).</summary>
        private void StepMapWard(int step)
        {
            var net = ShiroNetworkManager.Instance;
            if (net == null || net.AvailableWards.Count == 0) return;
            var list = net.AvailableWards;
            string shown = !string.IsNullOrEmpty(_mapWardId) ? _mapWardId : net.targetWardId;
            int index = -1;
            for (int i = 0; i < list.Count; i++)
                if (list[i] != null && string.Equals(list[i].ward_id, shown, StringComparison.OrdinalIgnoreCase)) { index = i; break; }
            int next = ((index < 0 ? 0 : index + step) % list.Count + list.Count) % list.Count;
            string id = list[next] != null ? list[next].ward_id : null;
            _mapWardId = string.Equals(id, net.targetWardId, StringComparison.OrdinalIgnoreCase) ? null : id;
            _refreshIn = 0f;
        }

        // ----- Settings (stage 4: ShiroSettingsView) -----

        private void RefreshSettings() => _settings.Refresh();

        /// <summary>Settings, Room setup (also from the alignment tool's keyboard key in the editor).</summary>
        public void OpenRoomSetup()
        {
            if (!_open) Open();
            if (_patientView.IsShown) ShowList();
            SelectPage(Page.Settings);
            _settings.ShowView(ShiroSettingsView.View.RoomSetup);
        }

        /// <summary>The preview tool: the Settings view.</summary>
        internal ShiroSettingsView PreviewSettings()
        {
            SelectPage(Page.Settings);
            return _settings;
        }

        // ----- How the ward was found -----

        /// <summary>The headset switched ward by itself: the badge blinks and a note says so.</summary>
        private void HandleWardDetected(string wardId)
        {
            _badgeBlinkUntil = Time.time + 4f;
            Note($"Now in {WardTitle(ShiroNetworkManager.Instance)}: found automatically as you walked in.");
            _refreshIn = 0f;
        }

        private void BlinkBadge()
        {
            bool on = Mathf.Repeat(Time.time, 0.5f) < 0.25f;
            _badge.color = on ? ShiroTheme.GoodText : ShiroTheme.Good;
        }

        // ----- Room alignment: the aiming bar -----

        /// <summary>
        /// While the alignment waits for a point at the door: a bar above the view (the step and
        /// Cancel), out of the way of the ray toward the floor; it follows the view lazily.
        /// </summary>
        private void UpdateAimBar()
        {
            bool aiming = ShiroSettingsView.IsAiming;
            if (_aimBar.gameObject.activeSelf != aiming) { _aimBar.gameObject.SetActive(aiming); _aimPlaced = false; }
            if (!aiming || _head == null) return;
            string words = ShiroSettingsView.AimingWords();
            if (_aimText.text != words) _aimText.text = words;

            Vector3 flat = _head.forward;
            flat.y = 0f;
            if (flat.sqrMagnitude < 0.001f) flat = Vector3.forward;
            flat.Normalize();
            Vector3 target = _head.position + flat * 0.5f + Vector3.up * 0.10f;
            Quaternion rot = Quaternion.LookRotation(target - _head.position, Vector3.up);
            Transform b = _aimBar.transform;
            if (!_aimPlaced) { b.SetPositionAndRotation(target, rot); _aimPlaced = true; return; }
            float off = Vector3.Angle(flat, Vector3.ProjectOnPlane(b.position - _head.position, Vector3.up));
            if (off > 25f || (b.position - target).magnitude > 0.3f)
            {
                float k = 1f - Mathf.Exp(-4f * Time.deltaTime);
                b.SetPositionAndRotation(Vector3.Lerp(b.position, target, k), Quaternion.Slerp(b.rotation, rot, k));
            }
        }

        private void CancelAiming()
        {
            var tool = WardAlignmentTool.Instance;
            if (tool != null) tool.CancelCalibration();
        }

        // ----- Building -----

        private void Build()
        {
            if (_built) return;
            _built = true;
            _canvas = ShiroUIKit.WorldCanvas("WardPanel", transform, new Vector2(W, H));
            _canvas.transform.localScale = Vector3.one * 0.001f * PanelScale;
            ShiroUIKit.Fill(ShiroUIKit.Panel(_canvas.transform, "Background", ShiroTheme.Glass, 18f));
            _mainRoot = new GameObject("Main", typeof(RectTransform));
            _mainRoot.transform.SetParent(_canvas.transform, false);
            ShiroUIKit.Fill(_mainRoot.transform as RectTransform);
            Transform root = _mainRoot.transform;

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
            ShiroUIKit.Place(_status, Pad + 14, 41, W - 2 * Pad - 14 - BadgeW - 8, 17);
            // How the ward was found, as a badge at the right of the status line
            _badge = ShiroUIKit.Panel(root, "WardBadge", ShiroTheme.Good, 9.5f);
            ShiroUIKit.Place(_badge, W - Pad - BadgeW, 39, BadgeW, 20);
            _badgeText = ShiroUIKit.Label(_badge.transform, "Text", "", 11f, Color.white, FontStyles.Bold, TextAlignmentOptions.Center).Fit(8f);
            ShiroUIKit.Fill(_badgeText, 3f);
            _badge.gameObject.SetActive(false);

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
            // Map: the ward on show and ‹ › for the others, above it
            Transform mapPage = _pages[1].transform;
            _mapPrev = ShiroUIKit.Button(mapPage, "WardBefore", "‹", ButtonKind.Secondary, () => StepMapWard(-1), 16f);
            ShiroUIKit.Place(_mapPrev, Pad, 0, 40, 26);
            _mapNext = ShiroUIKit.Button(mapPage, "WardAfter", "›", ButtonKind.Secondary, () => StepMapWard(1), 16f);
            ShiroUIKit.Place(_mapNext, W - Pad - 40, 0, 40, 26);
            _mapWard = ShiroUIKit.Label(mapPage, "WardShown", "", 13f, ShiroTheme.Text, FontStyles.Bold, TextAlignmentOptions.Center).Fit(9f);
            ShiroUIKit.Place(_mapWard, Pad + 48, 0, W - 2 * Pad - 96, 26);
            _map = new ShiroWardMapView();
            _map.Build(mapPage, Pad, 30f, W - 2 * Pad, PageH, (tag, bed, name) => OpenPatient(tag, _map.ShownSubject(tag)));
            _settings.Build(_pages[2].transform, this);
            SelectPage(Page.Patients);

            // One patient (stage 3): in place of the list, in the same frame
            _patientView.Build(_canvas.transform, this);
            _canvas.gameObject.SetActive(false);

            // The aiming bar (room alignment)
            _aimBar = ShiroUIKit.WorldCanvas("AimBar", transform, new Vector2(BarW, BarH));
            _aimBar.transform.localScale = Vector3.one * 0.001f * 0.9f;
            Transform bar = _aimBar.transform;
            ShiroUIKit.Fill(ShiroUIKit.Panel(bar, "Background", ShiroTheme.Glass, 14f));
            var stripe = ShiroUIKit.Panel(bar, "Stripe", ShiroTheme.Primary, 3f);
            ShiroUIKit.Place(stripe, 8, 10, 6, BarH - 20);
            _aimText = ShiroUIKit.Label(bar, "Step", "", 13f, ShiroTheme.Text, FontStyles.Bold, TextAlignmentOptions.Left, true).Fit(9f);
            ShiroUIKit.Place(_aimText, 22, 6, BarW - 22 - 96, BarH - 12);
            var cancel = ShiroUIKit.Button(bar, "Cancel", "Cancel", ButtonKind.Secondary, CancelAiming, 13f);
            ShiroUIKit.Place(cancel, BarW - 12 - 76, (BarH - 32) / 2f, 76, 32);
            _aimBar.gameObject.SetActive(false);
        }

        private const float BadgeW = 128f;

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
                ShiroUIKit.Place(v.Name, 20, 3, 244, 20);
                v.Line = ShiroUIKit.Label(row, "Line", "", 12f, ShiroTheme.TextDim).Fit(9f);
                ShiroUIKit.Place(v.Line, 20, 23, 252, 16);
                v.Value = ShiroUIKit.Label(row, "Heart", "", 22f, ShiroTheme.Text, FontStyles.Bold, TextAlignmentOptions.Right);
                ShiroUIKit.Place(v.Value, w - 92, 1, 80, 25);
                v.Unit = ShiroUIKit.Label(row, "HeartUnit", "<color=#F87171>♥</color> bpm", 11f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.Right);
                v.Unit.richText = true;
                ShiroUIKit.Place(v.Unit, w - 92, 26, 80, 14);
                v.Button.gameObject.SetActive(false);
                _rows.Add(v);
            }

            // Nothing to list: why, in the list's place
            _empty = ShiroUIKit.Label(page, "Empty", "", 14f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.Center, true).Fit(10f);
            ShiroUIKit.Place(_empty, Pad, 50, w, 60);
            _empty.gameObject.SetActive(false);

            // A hint, or what "Show me" did
            _note = ShiroUIKit.Label(page, "Note", "", 11f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.Center).Fit(8f);
            ShiroUIKit.Place(_note, Pad, NoteY, w, 14);

            // Pager (as on the web dashboard)
            _pager.Build(page, Pad, W - Pad, PagerY, PagerH, "patient", GoToPage);
        }
    }
}
