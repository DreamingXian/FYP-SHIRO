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
//              patient opens them too).
//   Settings - the ward, found automatically (ShiroWardAutoDetect) where this
//              headset has aligned it, chosen by hand only for a ward not
//              aligned yet; the connection; the version 1 menu for room setup,
//              server address, pairing and the test tools (until stage 4).
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

        // Map
        private ShiroWardMapView _map;

        // Settings: the main view, or the list of wards to choose by hand
        private GameObject _settingsMain, _settingsList;
        private TextMeshProUGUI _wardName, _wardAuto, _connection, _listHeading;
        private ShiroButton _autoBtn, _linkBtn;
        private readonly List<ShiroButton> _wardBtns = new List<ShiroButton>();
        private string _wardBtnsKey = "";

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
        public void OpenPatient(string tagId)
        {
            if (string.IsNullOrEmpty(tagId)) return;
            if (!_open) Open();
            _mainRoot.SetActive(false);
            _patientView.Show(tagId);
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

        /// <summary>Shown while open, except while the alert card is shown (it comes first).</summary>
        private void UpdateVisible()
        {
            bool cardUp = ShiroAlertCard.Instance != null && ShiroAlertCard.Instance.IsCardShown;
            bool show = _open && !cardUp;
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
            UpdateVisible();
            if (!_visible) return;
            if (_head == null && Camera.main != null) _head = Camera.main.transform;
            if (_head != null) Place();

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
            string status = StatusWords(net, out Color dot);
            if (WardFoundAutomatically()) status += " · ward found automatically";
            _status.text = status;
            _statusDot.color = dot;
            int n = CountWithWristband(net);
            _tabs[0].SetText(n > 0 ? $"Patients ({n})" : "Patients");
        }

        private static string WardTitle(ShiroNetworkManager net)
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
            if (page == Page.Settings) ShowSettingsList(false);
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
            WardConfig ward = net != null && net.IsWardLoaded ? net.LastLoadedWardConfig : null;
            _map.Refresh(ward, net != null ? net.LastLoadedSubjects : null, net != null && net.IsConnected);
        }

        // ----- Settings -----

        private void RefreshSettings()
        {
            var net = ShiroNetworkManager.Instance;
            if (_settingsList.activeSelf)
            {
                var wards = new List<WardSummary>();
                if (net != null) foreach (var w in net.AvailableWards) if (w != null && !string.IsNullOrEmpty(w.ward_id)) wards.Add(w);
                ShowWards(wards, net != null ? net.targetWardId : "");
                return;
            }

            _wardName.text = WardTitle(net);
            var det = ShiroWardAutoDetect.Instance;
            _wardAuto.text = AutoWords(det);
            _wardAuto.color = WardFoundAutomatically() ? ShiroTheme.GoodText : ShiroTheme.TextDim;
            _autoBtn.SetText(det != null && det.IsEnabled ? "Automatic: on" : "Automatic: off");
            _autoBtn.SetInteractable(det != null);

            if (net == null) { _connection.text = "Starting…"; return; }
            string where = $"{net.serverIp}:{net.serverPort}";
            string device = net.Identity != null ? net.Identity.DeviceId : "this headset";
            _connection.text = (net.IsConnected ? $"Connected to the edge server at {where}." : $"Not connected to the edge server at {where}.")
                + "\n" + (net.IsPaired ? $"{device} is paired." : $"{device} is not paired yet: Server and pairing.");
            _connection.color = net.IsConnected && net.IsPaired ? ShiroTheme.Text : ShiroTheme.WarnText;
        }

        /// <summary>What the automatic ward detection is doing, in words.</summary>
        internal static string AutoWords(ShiroWardAutoDetect det)
        {
            if (det == null) return "Automatic ward detection is not available.";
            if (!det.IsEnabled) return "Automatic ward detection is off: the ward stays as chosen.";
            string s = det.StatusText ?? "";
            if (s.StartsWith("in ", StringComparison.Ordinal)) return "Found automatically: you are inside this ward.";
            if (s.StartsWith("entered ", StringComparison.Ordinal)) return $"Found automatically when you entered {s.Substring(8)}.";
            if (s.StartsWith("entering ", StringComparison.Ordinal)) return $"Entering {s.Substring(9).TrimEnd('…')}…";
            if (s == "not in a calibrated ward") return "Not inside an aligned ward: the last ward stays shown.";
            if (s == "no calibrated ward here") return "No aligned ward found here. A new ward needs its room set up once (Room setup and tools).";
            return $"Automatic ward detection: {s}.";
        }

        private void ShowSettingsList(bool list)
        {
            if (_settingsMain == null) return;
            _settingsMain.SetActive(!list);
            _settingsList.SetActive(list);
            _wardBtnsKey = "";
            _refreshIn = 0f;
        }

        /// <summary>The wards to choose by hand (up to 9), the one shown highlighted. Also used by the preview tool.</summary>
        internal void ShowWards(List<WardSummary> wards, string active)
        {
            string key = active + "|";
            foreach (var w in wards) key += w.ward_id + ";";
            if (key == _wardBtnsKey) return;
            _wardBtnsKey = key;
            foreach (var b in _wardBtns) if (b != null) Destroy(b.gameObject);
            _wardBtns.Clear();

            Transform page = _settingsList.transform;
            float bw = (W - 2 * Pad - 2 * ShiroTheme.Gap) / 3f;
            int n = Mathf.Min(wards.Count, 9);
            for (int i = 0; i < n; i++)
            {
                var w = wards[i];
                string id = w.ward_id;
                bool shown = string.Equals(id, active, StringComparison.OrdinalIgnoreCase);
                string label = !string.IsNullOrEmpty(w.room_title) ? w.room_title : id;
                var b = ShiroUIKit.Button(page, $"Ward_{id}", label, shown ? ButtonKind.Primary : ButtonKind.Secondary, () => ChooseWard(id), 13f);
                if (b.Label != null) b.Label.fontSizeMin = 9f;   // long ward names shrink further
                ShiroUIKit.Place(b, Pad + (i % 3) * (bw + ShiroTheme.Gap), 54f + (i / 3) * 40f, bw, 32f);
                _wardBtns.Add(b);
            }
            _listHeading.text = wards.Count == 0 ? "The list of wards comes from the edge server (not connected?)."
                : wards.Count > 9 ? $"Choose the ward by hand (first 9 of {wards.Count})." : "Choose the ward by hand.";
        }

        private void ChooseWard(string id)
        {
            var net = ShiroNetworkManager.Instance;
            if (net != null) net.SwitchWard(id);
            ShowSettingsList(false);
        }

        private void ToggleAuto()
        {
            var det = ShiroWardAutoDetect.Instance;
            if (det != null) det.SetEnabled(!det.IsEnabled);
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
            _map.Build(_pages[1].transform, Pad, W - 2 * Pad, PageH, (tag, bed, name) => OpenPatient(tag));
            BuildSettings(_pages[2].transform);
            SelectPage(Page.Patients);

            // One patient (stage 3): in place of the list, in the same frame
            _patientView.Build(_canvas.transform, this);
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

        private void BuildSettings(Transform page)
        {
            float w = W - 2 * Pad;
            float bw = (w - ShiroTheme.Gap) / 2f;

            // Main view: the ward (found automatically), the connection, the version 1 menu
            _settingsMain = new GameObject("Main", typeof(RectTransform));
            _settingsMain.transform.SetParent(page, false);
            ShiroUIKit.Fill(_settingsMain.transform as RectTransform);
            Transform m = _settingsMain.transform;

            var wardHeading = ShiroUIKit.Label(m, "WardHeading", "Ward", 12f, ShiroTheme.TextDim);
            ShiroUIKit.Place(wardHeading, Pad, 0, w, 16);
            _wardName = ShiroUIKit.Label(m, "WardName", "", 16f, ShiroTheme.Text, FontStyles.Bold).Fit(11f);
            ShiroUIKit.Place(_wardName, Pad, 17, w, 22);
            _wardAuto = ShiroUIKit.Label(m, "WardAuto", "", 12f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.TopLeft, true).Fit(9f);
            ShiroUIKit.Place(_wardAuto, Pad, 40, w, 30);
            var byHand = ShiroUIKit.Button(m, "ChooseByHand", "Choose by hand", ButtonKind.Secondary, () => ShowSettingsList(true), 13f);
            ShiroUIKit.Place(byHand, Pad, 74, bw, 28);
            _autoBtn = ShiroUIKit.Button(m, "Automatic", "Automatic: on", ButtonKind.Secondary, ToggleAuto, 13f);
            ShiroUIKit.Place(_autoBtn, Pad + bw + ShiroTheme.Gap, 74, bw, 28);

            var connHeading = ShiroUIKit.Label(m, "ConnHeading", "Connection", 12f, ShiroTheme.TextDim);
            ShiroUIKit.Place(connHeading, Pad, 112, w, 16);
            _connection = ShiroUIKit.Label(m, "Connection", "", 13f, ShiroTheme.Text, FontStyles.Normal, TextAlignmentOptions.TopLeft, true).Fit(10f);
            ShiroUIKit.Place(_connection, Pad, 129, w, 31);
            var reconnect = ShiroUIKit.Button(m, "Reconnect", "Reconnect", ButtonKind.Secondary, () =>
            {
                var net = ShiroNetworkManager.Instance;
                if (net != null) net.Connect();
            }, 13f);
            ShiroUIKit.Place(reconnect, Pad, 163, bw, 28);
            // Over Quest Link the edge server runs on the same computer (editor only)
            _linkBtn = ShiroUIKit.Button(m, "QuestLink", "Server on this PC (Link)", ButtonKind.Secondary, () =>
            {
                var net = ShiroNetworkManager.Instance;
                if (net != null) net.SetServerIp("127.0.0.1");
            }, 13f);
            ShiroUIKit.Place(_linkBtn, Pad + bw + ShiroTheme.Gap, 163, bw, 28);
            _linkBtn.gameObject.SetActive(Application.isEditor);
            var server = ShiroUIKit.Button(m, "ServerPairing", "Server and pairing", ButtonKind.Secondary, () => OpenOldMenu(3), 13f);
            ShiroUIKit.Place(server, Pad, 200, bw, 28);
            var setup = ShiroUIKit.Button(m, "RoomSetup", "Room setup and tools", ButtonKind.Secondary, () => OpenOldMenu(0), 13f);
            ShiroUIKit.Place(setup, Pad + bw + ShiroTheme.Gap, 200, bw, 28);

            // The list of wards, to choose by hand (a ward not aligned on this headset yet)
            _settingsList = new GameObject("WardList", typeof(RectTransform));
            _settingsList.transform.SetParent(page, false);
            ShiroUIKit.Fill(_settingsList.transform as RectTransform);
            Transform l = _settingsList.transform;
            _listHeading = ShiroUIKit.Label(l, "ListHeading", "Choose the ward by hand.", 14f, ShiroTheme.Text, FontStyles.Bold).Fit(10f);
            ShiroUIKit.Place(_listHeading, Pad, 0, w, 20);
            var listNote = ShiroUIKit.Label(l, "ListNote",
                "Only for a ward this headset has not aligned yet: aligned wards are found automatically when you walk in.",
                12f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.TopLeft, true).Fit(9f);
            ShiroUIKit.Place(listNote, Pad, 21, w, 30);
            var back = ShiroUIKit.Button(l, "Back", "Back", ButtonKind.Secondary, () => ShowSettingsList(false), 13f);
            ShiroUIKit.Place(back, Pad, 200, bw, 28);
            var setup2 = ShiroUIKit.Button(l, "RoomSetup", "Room setup and tools", ButtonKind.Secondary, () => OpenOldMenu(0), 13f);
            ShiroUIKit.Place(setup2, Pad + bw + ShiroTheme.Gap, 200, bw, 28);
            _settingsList.SetActive(false);
        }
    }
}
