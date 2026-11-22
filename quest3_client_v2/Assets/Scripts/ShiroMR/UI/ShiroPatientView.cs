// =============================================================================
// Project SHIRO - headset app version 2: one patient (stage 3: UC-05, FR-MR-03)
//
// Shown in the ward panel in place of the list (same frame, same place), from a
// row of the patient list, a dot on the map, or "Profile and history" on the
// patient's tag. "Back" returns to the list. Four tabs:
//   Now      - the heart rate in the same words as their tag, SpO2, the
//              wristband's battery, where they are and how that is known; an
//              alert waiting for them at the top with "I'm responding"; Show me
//              (their tag pulses blue, an arrow points to it); live vitals (one
//              reading a second for 2 minutes).
//   24 hours - heart rate and SpO2 over the last 1, 6 or 24 hours (one median
//              per window from the edge server's time-series database), low,
//              average and high, the normal range shaded, a heart rate under 50
//              or over 120 marked; a gap where no reading came. SpO2 is a rough
//              guide only (not calibrated), so it is not marked.
//   Alerts   - this patient's alerts of the last 7 days, newest first, and who
//              answered them how fast; four per page with the web's pager.
//   Profile  - ID, age and sex, ward and bed, admitted, height and weight,
//              wristband, medical history. No ID card number, no phone number.
// The data is read from the edge server with this headset's pairing
// (/api/patients/get, /api/patients/vitals-history, /api/alerts/history); the
// ward's patient list fills the profile at once until the answer arrives.
// =============================================================================
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;
using TMPro;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.UI;

namespace ShiroMR.UI
{
    public class ShiroPatientView
    {
        private const float W = ShiroWardPanel.W, Pad = ShiroWardPanel.Pad;
        private const float CW = W - 2 * Pad;              // content width
        private const float PageTop = 108f;
        private const float PageH = ShiroWardPanel.PageH;
        private const float ButtonsY = PageH - 30f;
        private const int AlertsPerPage = 4;
        private const float AlertRowH = 40f, AlertRowGap = 5f;
        private const float ChartH = 64f;
        private const string AlertRange = "7d";
        private const int AlertLimit = 40;

        private static readonly string[] TabNames = { "Now", "24 hours", "Alerts", "Profile" };
        private static readonly string[] Ranges = { "-1h", "-6h", "-24h" };
        private static readonly string[] RangeLabels = { "1 h", "6 h", "24 h" };
        private static readonly Color HeartColour = new Color32(248, 113, 113, 255);
        private static readonly Color NormalBand = new Color(0.53f, 0.94f, 0.67f, 0.10f);
        private const string Unit = "<size=12><color=#A5ACB8>";
        private const string UnitEnd = "</color></size>";

        /// <summary>What the "Now" tab shows (built from the patient's tag; the preview tool fills one by hand).</summary>
        public struct NowState
        {
            public bool HasTag, Heard;
            public string HeartValue, HeartWords;
            public bool HeartWarn, HeartDim;
            public int Spo2, Battery;
            public bool Charging, BatteryLow;
            public string Where, How;
            public Color HowColour, Colour;
        }

        private class ChartView
        {
            public TextMeshProUGUI Title, Stats, Top, Bottom, Empty;
            public ShiroLineChart Chart;
        }

        private class AlertRowView
        {
            public Image Root, Stripe;
            public TextMeshProUGUI Title, Tag, Line;
        }

        private ShiroWardPanel _panel;
        private GameObject _root;
        private TextMeshProUGUI _name, _sub;
        private Image _dot;
        private readonly ShiroButton[] _tabs = new ShiroButton[4];
        private readonly GameObject[] _pages = new GameObject[4];
        private int _tab;
        private int _seq;                       // answers for an earlier patient are dropped

        // Who
        private string _tag, _patientId, _bedId, _fullName;
        private TrackedSubject _subject;
        private PatientProfile _profile;

        // Now
        private Image _alertBox;
        private TextMeshProUGUI _alertTitle, _alertLine;
        private ShiroButton _respond;
        private RectTransform _nowBody;
        private TextMeshProUGUI _hrValue, _hrWords, _spo2Value, _spo2Words, _batValue, _batWords;
        private TextMeshProUGUI _where, _how, _nowNote;
        private ShiroButton _showMe, _live;
        private bool _alertShown;
        private string _noteText;
        private float _noteUntil;
        private bool _awaitingAck;
        private bool _liveSubscribed;
        private float _liveAskedAt = -100f, _liveUntil;
        private string _liveText;

        // 24 hours
        private readonly ShiroButton[] _rangeBtns = new ShiroButton[3];
        private string _range = "-24h";
        private TextMeshProUGUI _windowText, _tStart, _tMid, _tEnd;
        private ChartView _hr, _spo;
        private List<VitalsPoint> _points;
        private string _window;
        private DateTime _pointsNowUtc;
        private string _historyError;
        private bool _historyLoading;
        private float _historyAt = -100f;

        // Alerts
        private TextMeshProUGUI _alertSummary, _alertsEmpty;
        private readonly List<AlertRowView> _alertRows = new List<AlertRowView>();
        private readonly ShiroPager _alertPager = new ShiroPager();
        private List<IncidentHistoryRow> _incidents;
        private IncidentHistorySummary _summary;
        private string _incidentsError;
        private bool _incidentsLoading;
        private float _incidentsAt = -100f;
        private int _alertPage;

        // Profile
        private readonly TextMeshProUGUI[] _profileValues = new TextMeshProUGUI[6];
        private TextMeshProUGUI _historyText, _profileStatus;
        private string _profileError;
        private bool _profileLoading;
        private float _profileAt = -100f;

        public bool IsShown => _root != null && _root.activeSelf;

        // ----- Show, hide, refresh -----

        /// <summary>Shows the patient wearing this wristband and asks the edge server for their data.</summary>
        internal void Show(string tagId)
        {
            Begin(tagId, FindSubject(tagId));
            FetchProfile();
            FetchHistory();
            FetchIncidents();
            Refresh();
        }

        /// <summary>The preview tool: a patient with sample data, without asking the edge server.</summary>
        internal void PreviewOpen(TrackedSubject s)
        {
            Begin(s != null ? s.device_id : "TAG-001", s);
        }

        private void Begin(string tagId, TrackedSubject subject)
        {
            _seq++;
            _tag = tagId;
            _subject = subject;
            var holo = Holo();
            _patientId = subject != null ? subject.patient_id : null;
            _fullName = subject != null && !string.IsNullOrEmpty(subject.full_name) ? subject.full_name
                : holo != null ? holo.fullName : tagId;
            _bedId = subject != null ? subject.assigned_bed_id : holo != null ? holo.assignedBed : null;
            _profile = null;
            _points = null; _window = null; _historyError = null; _historyLoading = false; _historyAt = -100f;
            _incidents = null; _summary = null; _incidentsError = null; _incidentsLoading = false; _incidentsAt = -100f; _alertPage = 0;
            _profileError = null; _profileLoading = false; _profileAt = -100f;
            _noteText = null; _liveText = null; _liveUntil = 0f; _liveAskedAt = -100f; _awaitingAck = false;
            _root.SetActive(true);
            SelectTab(0, false);
            FillProfile();
            ShowHistory();
            ShowIncidents();
        }

        internal void Hide()
        {
            _seq++;
            if (_root != null) _root.SetActive(false);
        }

        /// <summary>Every half second while shown: the tag's live state, an alert, older data loaded again.</summary>
        internal void Refresh()
        {
            if (!IsShown) return;
            var net = ShiroNetworkManager.Instance;
            if (!_liveSubscribed && net != null) { net.OnActiveModeResult += HandleLive; _liveSubscribed = true; }

            var now = BuildNow(Holo());
            SetNow(now);
            var alert = PendingAlert();
            SetAlert(alert);
            _dot.color = alert != null ? ShiroTheme.Alert : now.Colour;

            if (_awaitingAck && alert == null)
            {
                _awaitingAck = false;
                var am = ShiroAlertManager.Instance;
                Note(am != null && !string.IsNullOrEmpty(am.LastOwnAcknowledgement) ? am.LastOwnAcknowledgement : "Your response was sent.");
                _incidentsAt = -100f;   // the alert list changed
            }
            if (_tab == 1 && !_historyLoading && Time.time - _historyAt > 120f) FetchHistory();
            if (_tab == 2 && !_incidentsLoading && Time.time - _incidentsAt > 60f) FetchIncidents();
        }

        internal void SelectTab(int tab, bool fetch = true)
        {
            _tab = tab;
            for (int i = 0; i < _pages.Length; i++)
            {
                _pages[i].SetActive(i == tab);
                _tabs[i].SetKind(i == tab ? ButtonKind.Primary : ButtonKind.Secondary);
            }
            if (!fetch) return;
            if (tab == 1 && !_historyLoading && Time.time - _historyAt > 60f) FetchHistory();
            if (tab == 2 && !_incidentsLoading && Time.time - _incidentsAt > 15f) FetchIncidents();
            if (tab == 3 && !_profileLoading && Time.time - _profileAt > 60f) FetchProfile();
        }

        private PatientHologram Holo()
        {
            var mr = ShiroMRManager.Instance;
            return mr != null && !string.IsNullOrEmpty(_tag) ? mr.GetHologram(_tag) : null;
        }

        private static TrackedSubject FindSubject(string tagId)
        {
            var net = ShiroNetworkManager.Instance;
            if (net == null || net.LastLoadedSubjects == null || string.IsNullOrEmpty(tagId)) return null;
            foreach (var s in net.LastLoadedSubjects)
                if (s != null && string.Equals(s.device_id, tagId, StringComparison.OrdinalIgnoreCase)) return s;
            return null;
        }

        private ShiroAlertManager.HeadsetAlert PendingAlert()
        {
            var subject = _subject ?? new TrackedSubject { device_id = _tag, patient_id = _patientId };
            return ShiroWardPanel.PendingAlertFor(ShiroAlertManager.Instance, subject);
        }

        // ----- Now -----

        private NowState BuildNow(PatientHologram holo)
        {
            var s = new NowState { Battery = -1, HowColour = ShiroTheme.TextDim, Colour = ShiroTheme.Off };
            if (holo == null)
            {
                s.HeartValue = "--";
                s.HeartWords = "Waiting for the wristband";
                s.HeartDim = true;
                s.Where = "No position in this room yet";
                s.How = "";
                return s;
            }
            var st = holo.GetListState();
            s.HasTag = true;
            s.Heard = st.Heard;
            s.HeartValue = st.Value;
            s.HeartWords = FirstLine(st.HeartText);
            s.HeartWarn = st.Warn;
            s.HeartDim = st.Dim || st.Value == "--";
            s.Spo2 = st.Spo2;
            s.Battery = st.Battery;
            s.Charging = st.Charging;
            s.BatteryLow = st.BatteryLow;
            string where = SentenceStart(st.Where);
            if (st.Where == "at their bed" && st.Bed != "No bed") where += $" ({st.Bed})";
            if (st.Where != "walking" && st.Motion != "Still" && !string.IsNullOrEmpty(st.Motion)) where += $" · {st.Motion}";
            s.Where = where;
            s.How = st.Position;
            s.HowColour = st.PositionColour;
            s.Colour = st.Colour;
            return s;
        }

        /// <summary>Fills the "Now" tab (also used by the preview tool).</summary>
        internal void SetNow(NowState s)
        {
            _hrValue.text = s.HeartValue == "--" ? "--" : $"{s.HeartValue}{Unit} bpm{UnitEnd}";
            _hrValue.color = s.HeartDim ? ShiroTheme.TextDim : ShiroTheme.Text;
            _hrWords.text = s.HeartWords ?? "";
            _hrWords.color = s.HeartWarn ? ShiroTheme.WarnText : ShiroTheme.TextDim;
            _spo2Value.text = s.Spo2 > 0 ? $"{s.Spo2}{Unit} %{UnitEnd}" : "--";
            _spo2Value.color = s.Spo2 > 0 && s.Heard ? ShiroTheme.Text : ShiroTheme.TextDim;
            _spo2Words.text = "rough guide";
            _batValue.text = s.Battery >= 0 ? $"{s.Battery}{Unit} %{UnitEnd}" : "--";
            _batValue.color = s.Battery >= 0 ? ShiroTheme.Text : ShiroTheme.TextDim;
            _batWords.text = s.Charging ? "charging" : s.BatteryLow ? "low: charge it" : s.HasTag && !s.Heard ? "not heard" : "battery";
            _batWords.color = s.BatteryLow ? ShiroTheme.WarnText : ShiroTheme.TextDim;
            _where.text = s.Where ?? "";
            _how.text = s.How ?? "";
            _how.color = s.HowColour;

            // Live vitals: the button and a line about it
            var net = ShiroNetworkManager.Instance;
            float now = Time.time;
            bool live = _liveUntil > now;
            bool asking = !live && now - _liveAskedAt < 10f;
            string liveLine = live ? $"Live vitals: one reading a second, {Mathf.CeilToInt(_liveUntil - now)} s left." : _liveText;
            if (asking) liveLine = "Asking the wristband for live vitals…";
            _live.SetText(live ? $"Live: {Mathf.CeilToInt(_liveUntil - now)} s left" : asking ? "Asking…" : "Live vitals, 2 min");
            _live.SetInteractable(!live && !asking && (net == null || net.IsConnected) && !string.IsNullOrEmpty(_tag));

            string note = now < _noteUntil ? _noteText : null;
            string text = liveLine;
            if (!string.IsNullOrEmpty(note)) text = string.IsNullOrEmpty(text) ? note : $"{note}\n{text}";
            _nowNote.text = text ?? "";
        }

        /// <summary>An alert waiting for this patient, at the top of "Now" (null: none). Also used by the preview tool.</summary>
        internal void SetAlert(ShiroAlertManager.HeadsetAlert a)
        {
            bool show = a != null && a.incident != null;
            if (show != _alertShown)
            {
                _alertShown = show;
                _alertBox.gameObject.SetActive(show);
                LayoutNow();
            }
            if (!show) return;
            bool sending = a.status == ShiroAlertManager.AlertStatus.Sending;
            _alertTitle.text = ShiroAlertCard.WhatHappened(a.incident) + (a.incident.IsSimulated ? " (test)" : "");
            string when = When(a.incident.trigger_timestamp);
            // The alert card has the full reason when a response could not be sent
            _alertLine.text = a.note != null ? "Not sent: try again or respond in person."
                : sending ? "Sending your response…" : $"Waiting for a response{(when.Length > 0 ? " · " + when : "")}";
            _respond.SetText(sending ? "Sending…" : "I'm responding");
            _respond.SetInteractable(!sending);
        }

        /// <summary>With an alert at the top, the rest moves down and the note keeps one line.</summary>
        private void LayoutNow()
        {
            float top = _alertShown ? 56f : 0f;
            ShiroUIKit.Place(_nowBody, 0, top, W, PageH - top);
            ShiroUIKit.Place(_nowNote, Pad, 128, CW, _alertShown ? 16f : 34f);
        }

        private void Respond()
        {
            var am = ShiroAlertManager.Instance;
            var a = PendingAlert();
            if (am == null || a == null) return;
            _awaitingAck = true;
            am.Acknowledge(a);
            Refresh();
        }

        private void ShowMe()
        {
            Note(ShiroWardPanel.PointTo(_tag, _bedId, _fullName));
        }

        private void AskLive()
        {
            var net = ShiroNetworkManager.Instance;
            if (net == null || !net.IsConnected) { _liveText = "Live vitals: not connected to the edge server."; return; }
            if (!_liveSubscribed) { net.OnActiveModeResult += HandleLive; _liveSubscribed = true; }
            if (net.RequestActiveMode(_tag, _subject != null ? _subject.mac_address : null))
            {
                _liveAskedAt = Time.time;
                _liveText = null;
            }
            else _liveText = "Live vitals could not be asked for.";
        }

        private void HandleLive(string tag, bool ok, string text, int seconds)
        {
            if (!IsShown || !string.Equals(tag, _tag, StringComparison.OrdinalIgnoreCase)) return;
            _liveAskedAt = -100f;
            if (ok) { _liveUntil = Time.time + Mathf.Max(1, seconds); _liveText = null; }
            else { _liveUntil = 0f; _liveText = $"Live vitals not started: {text}"; }
        }

        private void Note(string text)
        {
            _noteText = text;
            _noteUntil = Time.time + 6f;
        }

        // ----- 24 hours -----

        private void ChooseRange(int i)
        {
            _range = Ranges[i];
            FetchHistory();
        }

        private void FetchHistory()
        {
            var net = ShiroNetworkManager.Instance;
            if (!CanFetch(net, out string why)) { _historyError = why; _historyLoading = false; _historyAt = Time.time; ShowHistory(); return; }
            int seq = _seq;
            string range = _range;
            _historyLoading = true;
            _historyError = null;
            ShowHistory();
            net.StartCoroutine(net.GetJsonRoutine<VitalsHistoryResponse>(
                $"/api/patients/vitals-history?id={UnityWebRequest.EscapeURL(_patientId)}&range={UnityWebRequest.EscapeURL(range)}",
                (resp, err) =>
                {
                    if (seq != _seq || range != _range) return;   // another patient or range meanwhile
                    _historyLoading = false;
                    _historyAt = Time.time;
                    if (resp == null || !resp.success) { _points = null; _historyError = err ?? resp?.error ?? "no answer"; }
                    else { _points = resp.vitals ?? new List<VitalsPoint>(); _window = resp.window; _pointsNowUtc = DateTime.UtcNow; _historyError = null; }
                    ShowHistory();
                }));
        }

        /// <summary>The preview tool: sample points (UTC times) as if the edge server had sent them.</summary>
        internal void SetHistory(List<VitalsPoint> points, string range, string window, DateTime nowUtc, string error)
        {
            _range = range ?? _range;
            _points = points;
            _window = window;
            _pointsNowUtc = nowUtc;
            _historyError = error;
            _historyLoading = false;
            ShowHistory();
        }

        private void ShowHistory()
        {
            for (int i = 0; i < Ranges.Length; i++) _rangeBtns[i].SetKind(Ranges[i] == _range ? ButtonKind.Primary : ButtonKind.Secondary);
            string window = _window ?? DefaultWindow(_range);
            _windowText.text = $"Each point: median of {WindowWords(window)}";
            string span = SpanWords(_range);
            double spanS = SpanSeconds(_range);
            DateTime nowUtc = _points != null ? _pointsNowUtc : DateTime.UtcNow;
            DateTime startLocal = nowUtc.AddSeconds(-spanS).ToLocalTime();
            _tStart.text = ClockWords(startLocal);
            _tMid.text = ClockWords(nowUtc.AddSeconds(-spanS / 2).ToLocalTime());
            _tEnd.text = "now";

            if (_historyLoading || _historyError != null || _points == null || _points.Count == 0)
            {
                string msg = _historyLoading ? "Loading…"
                    : _historyError != null ? $"Could not load: {_historyError}"
                    : _points == null ? "" : $"No readings in {span}.";
                ClearChart(_hr, msg);
                ClearChart(_spo, msg);
                return;
            }

            DateTime start = nowUtc.AddSeconds(-spanS);
            double winS = WindowSeconds(window);
            var hr = new List<Vector2>();
            var hrFlags = new List<bool>();
            var sp = new List<Vector2>();
            DateTime? prev = null;
            foreach (var p in _points)
            {
                if (p == null || !TryUtc(p.time, out DateTime t)) continue;
                if (prev.HasValue && (t - prev.Value).TotalSeconds > 2.5 * winS)
                {
                    // No reading for a while: a gap, not a line across it
                    hr.Add(new Vector2(0f, float.NaN)); hrFlags.Add(false);
                    sp.Add(new Vector2(0f, float.NaN));
                }
                prev = t;
                float x = (float)(((t - start).TotalSeconds + winS / 2) / spanS);
                float h = p.heart_rate > 0 ? p.heart_rate : float.NaN;
                float s = p.spo2 > 0f ? p.spo2 : float.NaN;
                hr.Add(new Vector2(x, h));
                hrFlags.Add(!float.IsNaN(h) && (h > 120f || h < 50f));
                sp.Add(new Vector2(x, s));
            }
            FillChart(_hr, hr, hrFlags, true, $"No heart rate in {span}.");
            FillChart(_spo, sp, null, false, $"No SpO2 in {span}.");
        }

        private static void FillChart(ChartView v, List<Vector2> pts, List<bool> flags, bool heart, string emptyMsg)
        {
            float min = float.MaxValue, max = float.MinValue, sum = 0f;
            int n = 0;
            foreach (var p in pts)
            {
                if (float.IsNaN(p.y)) continue;
                min = Mathf.Min(min, p.y);
                max = Mathf.Max(max, p.y);
                sum += p.y;
                n++;
            }
            if (n == 0) { ClearChart(v, emptyMsg); return; }
            float lo, hi;
            if (heart)
            {
                lo = Mathf.Max(30f, Mathf.Min(50f, Mathf.Floor((min - 5f) / 10f) * 10f));
                hi = Mathf.Min(220f, Mathf.Max(110f, Mathf.Ceil((max + 5f) / 10f) * 10f));
            }
            else
            {
                lo = Mathf.Max(70f, Mathf.Min(90f, Mathf.Floor((min - 2f) / 2f) * 2f));
                hi = 100f;
            }
            v.Chart.YMin = lo;
            v.Chart.YMax = hi;
            v.Chart.SetPoints(pts, flags);
            v.Top.text = hi.ToString("0", CultureInfo.InvariantCulture);
            v.Bottom.text = lo.ToString("0", CultureInfo.InvariantCulture);
            v.Stats.text = $"low {Mathf.RoundToInt(min)} · average {Mathf.RoundToInt(sum / n)} · high {Mathf.RoundToInt(max)}";
            v.Empty.text = "";
        }

        private static void ClearChart(ChartView v, string msg)
        {
            v.Chart.SetPoints(null, null);
            v.Top.text = "";
            v.Bottom.text = "";
            v.Stats.text = "";
            v.Empty.text = msg ?? "";
        }

        // ----- Alerts -----

        private void FetchIncidents()
        {
            var net = ShiroNetworkManager.Instance;
            if (!CanFetch(net, out string why)) { _incidentsError = why; _incidentsLoading = false; _incidentsAt = Time.time; ShowIncidents(); return; }
            int seq = _seq;
            _incidentsLoading = true;   // "Loading…" only while nothing is shown yet; a reload keeps the list
            _incidentsError = null;
            ShowIncidents();
            net.StartCoroutine(net.GetJsonRoutine<IncidentHistoryResponse>(
                $"/api/alerts/history?patient_id={UnityWebRequest.EscapeURL(_patientId)}&range={AlertRange}&limit={AlertLimit}",
                (resp, err) =>
                {
                    if (seq != _seq) return;
                    _incidentsLoading = false;
                    _incidentsAt = Time.time;
                    if (resp == null || !resp.success) { _incidentsError = err ?? resp?.error ?? "no answer"; }
                    else { _incidents = resp.history ?? new List<IncidentHistoryRow>(); _summary = resp.summary; _incidentsError = null; }
                    ShowIncidents();
                }));
        }

        /// <summary>The preview tool: sample alerts as if the edge server had sent them.</summary>
        internal void SetIncidents(List<IncidentHistoryRow> rows, IncidentHistorySummary summary, string error)
        {
            _incidents = rows;
            _summary = summary;
            _incidentsError = error;
            _incidentsLoading = false;
            ShowIncidents();
        }

        private void GoToAlertPage(int page)
        {
            _alertPage = page - 1;
            ShowIncidents();
        }

        private void ShowIncidents()
        {
            int count = _incidents != null ? _incidents.Count : 0;
            int total = _summary != null && _summary.total > count ? _summary.total : count;
            _tabs[2].SetText(total > 0 ? $"Alerts ({total})" : "Alerts");

            string empty = null;
            if (_incidents == null)
                empty = _incidentsLoading ? "Loading…" : _incidentsError != null ? $"Could not load: {_incidentsError}" : "";
            else if (count == 0)
                empty = $"No alerts for {ShiroWardPanel.FirstName(_fullName)} in the last 7 days.";

            if (empty != null)
            {
                foreach (var r in _alertRows) r.Root.gameObject.SetActive(false);
                _alertsEmpty.gameObject.SetActive(true);
                _alertsEmpty.text = empty;
                _alertSummary.text = "Last 7 days";
                _alertPager.Layout(0, AlertsPerPage, 0);
                return;
            }
            _alertsEmpty.gameObject.SetActive(false);
            _alertSummary.text = SummaryWords(total, count) + (_incidentsError != null ? " · could not refresh" : "");

            int pages = ShiroPager.Pages(count, AlertsPerPage);
            _alertPage = Mathf.Clamp(_alertPage, 0, pages - 1);
            for (int i = 0; i < AlertsPerPage; i++)
            {
                int idx = _alertPage * AlertsPerPage + i;
                var row = _alertRows[i];
                bool has = idx < count && _incidents[idx] != null;
                row.Root.gameObject.SetActive(has);
                if (!has) continue;
                var inc = _incidents[idx];
                bool waiting = inc.resolution_status == "PENDING";
                row.Stripe.color = waiting ? ShiroTheme.Alert : inc.IsTest ? ShiroTheme.Off : ShiroTheme.Good;
                row.Title.text = AlertTitle(inc);
                row.Tag.text = inc.IsTest ? "Test" : "";
                row.Line.text = $"{DayWords(inc.trigger_timestamp)} · {AnswerWords(inc)}";
                row.Line.color = waiting ? ShiroTheme.AlertText : ShiroTheme.TextDim;
            }
            _alertPager.Layout(_alertPage, AlertsPerPage, count);
        }

        private string SummaryWords(int total, int count)
        {
            string text = $"Last 7 days: {total} alert{(total == 1 ? "" : "s")}";
            int tests = _summary != null ? _summary.simulated : 0;
            int waiting = _summary != null ? _summary.pending : 0;
            if (tests > 0) text += tests == total ? (total == 1 ? ", a test" : ", all tests") : $", {tests} of them test{(tests == 1 ? "" : "s")}";
            if (waiting > 0) text += $" · {waiting} waiting";
            if (total > count) text += $" · newest {count} here";
            return text;
        }

        private static string AlertTitle(IncidentAlert inc)
        {
            string what = ShiroAlertCard.WhatHappened(inc);
            if (inc.incident_category == "CRITICAL_VITALS" && inc.heart_rate > 0) what += $": {inc.heart_rate} bpm";
            return what;
        }

        private static string AnswerWords(IncidentHistoryRow inc)
        {
            if (inc.resolution_status == "PENDING") return "waiting for a response";
            string who = WhoAnswered(inc.attending_clinician);
            string after = inc.response_latency_seconds > 0f ? $" after {Duration(inc.response_latency_seconds)}" : "";
            return who != null ? $"answered by {who}{after}" : $"answered{after}";
        }

        /// <summary>
        /// The server writes "Dr Lim (CLN-002)" for a dashboard and "QUEST3-1A2B3C (Dr Lim, CLN-002)"
        /// for a headset: both are "Dr Lim" here (the line has no room for more).
        /// </summary>
        internal static string WhoAnswered(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return null;
            var m = Regex.Match(raw.Trim(), @"^(.*?) \((.*)\)$");
            if (!m.Success) return raw.Trim();
            string inner = m.Groups[2].Value;
            int comma = inner.IndexOf(',');
            if (comma > 0) return inner.Substring(0, comma).Trim();
            if (inner.StartsWith("no clinician", StringComparison.OrdinalIgnoreCase)) return "a headset";
            return m.Groups[1].Value.Trim();
        }

        private static string Duration(float s)
        {
            if (s < 60f) return $"{Mathf.RoundToInt(s)} s";
            if (s < 3600f) return $"{Mathf.RoundToInt(s / 60f)} min";
            int h = (int)(s / 3600f);
            int min = Mathf.RoundToInt((s - h * 3600f) / 60f);
            return min > 0 ? $"{h} h {min} min" : $"{h} h";
        }

        // ----- Profile -----

        private void FetchProfile()
        {
            var net = ShiroNetworkManager.Instance;
            if (!CanFetch(net, out string why)) { _profileError = why; _profileLoading = false; _profileAt = Time.time; FillProfile(); return; }
            int seq = _seq;
            _profileLoading = true;
            _profileError = null;
            FillProfile();
            net.StartCoroutine(net.GetJsonRoutine<PatientGetResponse>(
                $"/api/patients/get?id={UnityWebRequest.EscapeURL(_patientId)}",
                (resp, err) =>
                {
                    if (seq != _seq) return;
                    _profileLoading = false;
                    _profileAt = Time.time;
                    if (resp == null || !resp.success || resp.patient == null) _profileError = err ?? resp?.error ?? "no answer";
                    else { _profile = resp.patient; _profileError = null; if (!string.IsNullOrEmpty(_profile.full_name)) _fullName = _profile.full_name; }
                    FillProfile();
                }));
        }

        /// <summary>The preview tool: a profile as if the edge server had sent it.</summary>
        internal void SetProfile(PatientProfile p)
        {
            _profile = p;
            _profileError = null;
            _profileLoading = false;
            _profileAt = Time.time;
            if (p != null && !string.IsNullOrEmpty(p.full_name)) _fullName = p.full_name;
            FillProfile();
        }

        /// <summary>The header and the Profile tab: the edge server's answer, else the ward list's copy.</summary>
        private void FillProfile()
        {
            var p = _profile;
            var s = _subject;
            var net = ShiroNetworkManager.Instance;
            var ward = net != null ? net.LastLoadedWardConfig : null;

            string id = p?.patient_id ?? s?.patient_id ?? "--";
            string dob = p?.dob ?? s?.dob;
            int age = p != null && p.age > 0 ? p.age : AgeFrom(dob);
            string sex = SexWords(p?.gender ?? s?.gender);
            string bedId = p?.assigned_bed_id ?? _bedId;
            string bed = !string.IsNullOrEmpty(p?.bed_code) ? p.bed_code : ShiroWardPanel.BedCode(ward, bedId);
            string wardName = !string.IsNullOrEmpty(p?.ward_title) ? p.ward_title
                : ward != null && !string.IsNullOrEmpty(ward.room_title) ? ward.room_title : (p?.assigned_ward_id ?? s?.assigned_ward_id ?? "--");
            int height = p != null && p.height_cm > 0 ? p.height_cm : s != null ? s.height_cm : 0;
            float weight = p != null && p.weight_kg > 0f ? p.weight_kg : s != null ? s.weight_kg : 0f;
            string history = p != null ? p.medical_history : s?.medical_history;

            _name.text = _fullName ?? "Patient";
            string ageSex = (age > 0 ? $"{age} years" : "") + (sex.Length > 0 ? (age > 0 ? " · " : "") + sex : "");
            _sub.text = $"{bed}{(ageSex.Length > 0 ? " · " + ageSex : "")} · {id}";

            _profileValues[0].text = id;
            _profileValues[1].text = ageSex.Length > 0 ? ageSex + (!string.IsNullOrEmpty(dob) ? $" (born {dob})" : "") : "--";
            _profileValues[2].text = $"{wardName} · {bed}";
            _profileValues[3].text = !string.IsNullOrEmpty(p?.admission_date) ? p.admission_date : "--";
            string body = (height > 0 ? $"{height} cm" : "") + (weight > 0f ? (height > 0 ? " · " : "") + $"{weight:0.#} kg" : "");
            _profileValues[4].text = body.Length > 0 ? body : "--";
            _profileValues[5].text = _tag ?? "--";
            _historyText.text = string.IsNullOrWhiteSpace(history) ? "None recorded." : history.Trim();
            _historyText.color = string.IsNullOrWhiteSpace(history) ? ShiroTheme.TextDim : ShiroTheme.Text;

            _profileStatus.text = _profileLoading ? "Loading…"
                : _profileError != null ? "Could not load the latest: from the ward list"
                : p != null ? "From the edge server" : "";
            _profileStatus.color = _profileError != null ? ShiroTheme.WarnText : ShiroTheme.TextDim;
        }

        private static int AgeFrom(string dob)
        {
            if (string.IsNullOrEmpty(dob) || !DateTime.TryParseExact(dob.Length >= 10 ? dob.Substring(0, 10) : dob, "yyyy-MM-dd",
                    CultureInfo.InvariantCulture, DateTimeStyles.None, out DateTime born)) return 0;
            DateTime today = DateTime.Today;
            int age = today.Year - born.Year;
            if (born.Date > today.AddYears(-age)) age--;
            return Mathf.Max(0, age);
        }

        private static string SexWords(string g)
        {
            switch ((g ?? "").Trim().ToUpperInvariant())
            {
                case "MALE": case "M": return "Male";
                case "FEMALE": case "F": return "Female";
                case "OTHER": return "Other";
                case "": return "";
                default: return SentenceStart(g.Trim().ToLowerInvariant());
            }
        }

        // ----- Shared -----

        private bool CanFetch(ShiroNetworkManager net, out string why)
        {
            why = null;
            if (string.IsNullOrEmpty(_patientId)) why = "no patient is bound to this wristband in this ward";
            else if (net == null) why = "the edge server cannot be reached";
            else if (!net.IsPaired) why = "this headset is not paired (Settings)";
            return why == null;
        }

        private static string FirstLine(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            int nl = s.IndexOf('\n');
            return nl >= 0 ? s.Substring(0, nl) : s;
        }

        private static string SentenceStart(string s) =>
            string.IsNullOrEmpty(s) ? "" : char.ToUpperInvariant(s[0]) + s.Substring(1);

        private static bool TryUtc(string ts, out DateTime utc)
        {
            utc = default;
            return !string.IsNullOrEmpty(ts) &&
                   DateTime.TryParse(ts, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out utc);
        }

        /// <summary>"14:05 (2 min ago)".</summary>
        private static string When(string ts)
        {
            if (!TryUtc(ts, out DateTime utc)) return "";
            DateTime local = utc.ToLocalTime();
            double s = Math.Max(0, (DateTime.Now - local).TotalSeconds);
            string ago = s < 10 ? "just now" : s < 60 ? $"{(int)s} s ago" : s < 3600 ? $"{(int)(s / 60)} min ago" : $"{(int)(s / 3600)} h ago";
            return $"{local:HH:mm} ({ago})";
        }

        /// <summary>"Today 14:05", "Yesterday 14:05", "Thu 20 Nov 14:05".</summary>
        private static string DayWords(string ts)
        {
            if (!TryUtc(ts, out DateTime utc)) return "Time not known";
            DateTime local = utc.ToLocalTime();
            if (local.Date == DateTime.Today) return $"Today {local:HH:mm}";
            if (local.Date == DateTime.Today.AddDays(-1)) return $"Yesterday {local:HH:mm}";
            return local.ToString("ddd d MMM HH:mm", CultureInfo.InvariantCulture);
        }

        /// <summary>A time on the chart's axis: "14:05", or "yesterday 14:05".</summary>
        private static string ClockWords(DateTime local) =>
            local.Date == DateTime.Today ? local.ToString("HH:mm", CultureInfo.InvariantCulture)
                                         : "yesterday " + local.ToString("HH:mm", CultureInfo.InvariantCulture);

        private static string DefaultWindow(string range) => range == "-1h" ? "10s" : range == "-6h" ? "1m" : "5m";

        private static string WindowWords(string window)
        {
            switch (window)
            {
                case "10s": return "10 s";
                case "1m": return "1 min";
                case "5m": return "5 min";
                case "30m": return "30 min";
                case "2h": return "2 h";
                default: return window;
            }
        }

        private static double WindowSeconds(string window)
        {
            switch (window)
            {
                case "10s": return 10;
                case "1m": return 60;
                case "30m": return 1800;
                case "2h": return 7200;
                default: return 300;
            }
        }

        private static string SpanWords(string range) => range == "-1h" ? "the last hour" : range == "-6h" ? "the last 6 hours" : "the last 24 hours";

        private static double SpanSeconds(string range) => range == "-1h" ? 3600 : range == "-6h" ? 6 * 3600 : 24 * 3600;

        // ----- Building -----

        internal void Build(Transform canvasRoot, ShiroWardPanel panel)
        {
            _panel = panel;
            _root = new GameObject("Patient", typeof(RectTransform));
            _root.transform.SetParent(canvasRoot, false);
            ShiroUIKit.Fill(_root.transform as RectTransform);
            Transform root = _root.transform;

            // Header: back, the patient, close; bed, age, sex, ID
            var back = ShiroUIKit.Button(root, "Back", "‹ Back", ButtonKind.Secondary, () => _panel.ShowList(), 13f);
            ShiroUIKit.Place(back, Pad, 8, 74, 30);
            var close = ShiroUIKit.Button(root, "Close", "Close", ButtonKind.Secondary, () => _panel.Close(), 13f);
            ShiroUIKit.Place(close, W - Pad - 74, 8, 74, 30);
            _name = ShiroUIKit.Label(root, "Name", "", 18f, ShiroTheme.Text, FontStyles.Bold, TextAlignmentOptions.Center).Fit(12f);
            ShiroUIKit.Place(_name, Pad + 74 + 10, 10, W - 2 * Pad - 2 * 74 - 20, 26);
            _dot = ShiroUIKit.Dot(root, "StatusDot", ShiroTheme.Off);
            ShiroUIKit.Place(_dot, Pad, 45, 9, 9);
            _sub = ShiroUIKit.Label(root, "Sub", "", 12f, ShiroTheme.TextDim).Fit(9f);
            ShiroUIKit.Place(_sub, Pad + 14, 41, W - 2 * Pad - 14, 17);

            float tw = (CW - 3 * ShiroTheme.Gap) / 4f;
            for (int i = 0; i < 4; i++)
            {
                int index = i;
                _tabs[i] = ShiroUIKit.Button(root, $"Tab_{TabNames[i]}", TabNames[i], ButtonKind.Secondary, () => SelectTab(index), 14f);
                ShiroUIKit.Place(_tabs[i], Pad + i * (tw + ShiroTheme.Gap), 64, tw, 36);
                _pages[i] = new GameObject($"Page_{TabNames[i]}", typeof(RectTransform));
                _pages[i].transform.SetParent(root, false);
                ShiroUIKit.Place(_pages[i].transform as RectTransform, 0, PageTop, W, PageH);
            }

            BuildNowTab(_pages[0].transform);
            BuildHistoryTab(_pages[1].transform);
            BuildAlertsTab(_pages[2].transform);
            BuildProfileTab(_pages[3].transform);
            SelectTab(0, false);
            _root.SetActive(false);
        }

        private void BuildNowTab(Transform page)
        {
            // An alert waiting for this patient (hidden when there is none)
            _alertBox = ShiroUIKit.Panel(page, "AlertBox", ShiroTheme.AlertDark, 10f);
            ShiroUIKit.Place(_alertBox, Pad, 0, CW, 48);
            Transform box = _alertBox.transform;
            float textW = CW - 12f - 136f - 8f;
            _alertTitle = ShiroUIKit.Label(box, "Title", "", 15f, ShiroTheme.AlertText, FontStyles.Bold).Fit(11f);
            ShiroUIKit.Place(_alertTitle, 12, 5, textW, 21);
            _alertLine = ShiroUIKit.Label(box, "Line", "", 12f, ShiroTheme.Text).Fit(9f);
            ShiroUIKit.Place(_alertLine, 12, 26, textW, 17);
            _respond = ShiroUIKit.Button(box, "Respond", "I'm responding", ButtonKind.Danger, Respond, 13f);
            ShiroUIKit.Place(_respond, CW - 10 - 136, 9, 136, 30);
            _alertBox.gameObject.SetActive(false);

            // The rest moves down while the alert is shown
            var body = new GameObject("Body", typeof(RectTransform));
            body.transform.SetParent(page, false);
            _nowBody = body.transform as RectTransform;
            Transform b = body.transform;
            const float hw = 160f;
            float sw = (CW - hw - 16f) / 2f;
            Tile(b, "HeartTile", Pad, hw, "Heart rate", out _hrValue, out _hrWords);
            Tile(b, "Spo2Tile", Pad + hw + 8f, sw, "SpO2", out _spo2Value, out _spo2Words);
            Tile(b, "WristbandTile", Pad + hw + 8f + sw + 8f, sw, "Wristband", out _batValue, out _batWords);
            _where = ShiroUIKit.Label(b, "Where", "", 14f, ShiroTheme.Text).Fit(10f);
            ShiroUIKit.Place(_where, Pad, 86, CW, 20);
            _how = ShiroUIKit.Label(b, "How", "", 12f, ShiroTheme.OkText).Fit(9f);
            ShiroUIKit.Place(_how, Pad, 106, CW, 16);
            _nowNote = ShiroUIKit.Label(b, "Note", "", 12f, ShiroTheme.OkText, FontStyles.Normal, TextAlignmentOptions.TopLeft, true).Fit(9f);

            float bw = (CW - ShiroTheme.Gap) / 2f;
            _showMe = ShiroUIKit.Button(page, "ShowMe", "Show me", ButtonKind.Primary, ShowMe, 13f);
            ShiroUIKit.Place(_showMe, Pad, ButtonsY, bw, 30);
            _live = ShiroUIKit.Button(page, "Live", "Live vitals, 2 min", ButtonKind.Secondary, AskLive, 13f);
            ShiroUIKit.Place(_live, Pad + bw + ShiroTheme.Gap, ButtonsY, bw, 30);
            LayoutNow();
        }

        private static void Tile(Transform parent, string name, float x, float w, string label, out TextMeshProUGUI value, out TextMeshProUGUI words)
        {
            var tile = ShiroUIKit.Panel(parent, name, ShiroTheme.GlassRaised, 10f);
            ShiroUIKit.Place(tile, x, 0, w, 78);
            var l = ShiroUIKit.Label(tile.transform, "Label", label, 12f, ShiroTheme.TextDim);
            ShiroUIKit.Place(l, 10, 6, w - 20, 16);
            value = ShiroUIKit.Label(tile.transform, "Value", "--", 28f, ShiroTheme.Text, FontStyles.Bold).Fit(18f);
            value.richText = true;
            ShiroUIKit.Place(value, 10, 22, w - 20, 32);
            words = ShiroUIKit.Label(tile.transform, "Words", "", 11f, ShiroTheme.TextDim).Fit(8f);
            ShiroUIKit.Place(words, 10, 56, w - 20, 16);
        }

        private void BuildHistoryTab(Transform page)
        {
            _windowText = ShiroUIKit.Label(page, "Window", "", 11f, ShiroTheme.TextDim).Fit(8f);
            ShiroUIKit.Place(_windowText, Pad, 0, 184, 26);
            for (int i = 0; i < Ranges.Length; i++)
            {
                int index = i;
                _rangeBtns[i] = ShiroUIKit.Button(page, $"Range_{RangeLabels[i]}", RangeLabels[i], ButtonKind.Secondary, () => ChooseRange(index), 12f);
                ShiroUIKit.Place(_rangeBtns[i], Pad + CW - (3 - i) * 52f - (2 - i) * 6f, 0, 52, 26);
            }
            _hr = BuildChart(page, "Heart", 32f, "Heart rate, bpm", HeartColour, 55f, 100f);
            _spo = BuildChart(page, "Spo2", 120f, "SpO2, % (rough guide)", ShiroTheme.OkText, 94f, 100f);

            const float axisX = Pad + 30f;
            float chartW = CW - 36f;
            _tStart = ShiroUIKit.Label(page, "TimeStart", "", 10f, ShiroTheme.TextDim);
            ShiroUIKit.Place(_tStart, axisX, 206, 100, 14);
            _tMid = ShiroUIKit.Label(page, "TimeMiddle", "", 10f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.Center);
            ShiroUIKit.Place(_tMid, axisX + chartW / 2f - 50f, 206, 100, 14);
            _tEnd = ShiroUIKit.Label(page, "TimeEnd", "", 10f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.Right);
            ShiroUIKit.Place(_tEnd, axisX + chartW - 100f, 206, 100, 14);
        }

        private static ChartView BuildChart(Transform page, string name, float y, string title, Color line, float bandLow, float bandHigh)
        {
            var v = new ChartView();
            v.Title = ShiroUIKit.Label(page, name + "Title", title, 12f, ShiroTheme.Text, FontStyles.Bold).Fit(9f);
            ShiroUIKit.Place(v.Title, Pad, y, 150, 16);
            v.Stats = ShiroUIKit.Label(page, name + "Stats", "", 12f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.Right).Fit(9f);
            ShiroUIKit.Place(v.Stats, Pad + 150, y, CW - 150, 16);
            var box = ShiroUIKit.Panel(page, name + "Box", ShiroTheme.GlassRaised, 8f);
            ShiroUIKit.Place(box, Pad, y + 18, CW, ChartH);
            v.Top = ShiroUIKit.Label(box.transform, "Top", "", 10f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.TopLeft);
            ShiroUIKit.Place(v.Top, 5, 3, 24, 12);
            v.Bottom = ShiroUIKit.Label(box.transform, "Bottom", "", 10f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.BottomLeft);
            ShiroUIKit.Place(v.Bottom, 5, ChartH - 15, 24, 12);
            var go = new GameObject("Chart", typeof(RectTransform));
            go.transform.SetParent(box.transform, false);
            v.Chart = go.AddComponent<ShiroLineChart>();
            v.Chart.raycastTarget = false;
            v.Chart.LineColour = line;
            v.Chart.BandLow = bandLow;
            v.Chart.BandHigh = bandHigh;
            v.Chart.BandColour = NormalBand;
            ShiroUIKit.Place(v.Chart, 30, 6, CW - 36, ChartH - 12);
            v.Empty = ShiroUIKit.Label(box.transform, "Empty", "", 12f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.Center, true).Fit(9f);
            ShiroUIKit.Place(v.Empty, 30, 0, CW - 36, ChartH);
            return v;
        }

        private void BuildAlertsTab(Transform page)
        {
            _alertSummary = ShiroUIKit.Label(page, "Summary", "", 12f, ShiroTheme.TextDim).Fit(9f);
            ShiroUIKit.Place(_alertSummary, Pad, 0, CW, 18);
            for (int i = 0; i < AlertsPerPage; i++)
            {
                var r = new AlertRowView();
                r.Root = ShiroUIKit.Panel(page, $"Alert_{i}", ShiroTheme.GlassRaised, 10f);
                ShiroUIKit.Place(r.Root, Pad, 24 + i * (AlertRowH + AlertRowGap), CW, AlertRowH);
                Transform row = r.Root.transform;
                r.Stripe = ShiroUIKit.Panel(row, "Status", ShiroTheme.Off, 2.5f);
                ShiroUIKit.Place(r.Stripe, 6, 6, 5, AlertRowH - 12);
                r.Title = ShiroUIKit.Label(row, "Title", "", 14f, ShiroTheme.Text, FontStyles.Bold).Fit(10f);
                ShiroUIKit.Place(r.Title, 18, 3, CW - 18 - 64, 19);
                r.Tag = ShiroUIKit.Label(row, "Tag", "", 12f, ShiroTheme.TextDim, FontStyles.Bold, TextAlignmentOptions.Right);
                ShiroUIKit.Place(r.Tag, CW - 60, 3, 50, 19);
                r.Line = ShiroUIKit.Label(row, "Line", "", 12f, ShiroTheme.TextDim).Fit(9f);
                ShiroUIKit.Place(r.Line, 18, 21, CW - 28, 16);
                r.Root.gameObject.SetActive(false);
                _alertRows.Add(r);
            }
            _alertsEmpty = ShiroUIKit.Label(page, "Empty", "", 13f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.Center, true).Fit(9f);
            ShiroUIKit.Place(_alertsEmpty, Pad, 60, CW, 60);
            _alertPager.Build(page, Pad, W - Pad, PageH - 28f, 28f, "alert", GoToAlertPage);
        }

        private void BuildProfileTab(Transform page)
        {
            string[] keys = { "Patient ID", "Age and sex", "Ward and bed", "Admitted", "Height, weight", "Wristband" };
            for (int i = 0; i < keys.Length; i++)
            {
                var k = ShiroUIKit.Label(page, $"Key_{i}", keys[i], 12f, ShiroTheme.TextDim);
                ShiroUIKit.Place(k, Pad, i * 22f, 108, 20);
                _profileValues[i] = ShiroUIKit.Label(page, $"Value_{i}", "", 14f, ShiroTheme.Text).Fit(10f);
                ShiroUIKit.Place(_profileValues[i], Pad + 112, i * 22f, CW - 112, 20);
            }
            var heading = ShiroUIKit.Label(page, "HistoryHeading", "Medical history", 12f, ShiroTheme.TextDim);
            ShiroUIKit.Place(heading, Pad, 136, 120, 16);
            _profileStatus = ShiroUIKit.Label(page, "Status", "", 11f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.Right).Fit(8f);
            ShiroUIKit.Place(_profileStatus, Pad + 120, 136, CW - 120, 16);
            _historyText = ShiroUIKit.Label(page, "History", "", 13f, ShiroTheme.Text, FontStyles.Normal, TextAlignmentOptions.TopLeft, true).Fit(9f);
            ShiroUIKit.Place(_historyText, Pad, 154, CW, 74);
        }
    }
}
