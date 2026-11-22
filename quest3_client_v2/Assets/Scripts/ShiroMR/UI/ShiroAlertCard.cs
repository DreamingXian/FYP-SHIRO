// =============================================================================
// Project SHIRO - headset app version 2: the alert card
//
// A new alert (fall, critical vitals, at the door, left the ward) appears in
// front of the clinician, within reach, and follows the view lazily until it is
// answered: what happened, to whom, where and when, in words.
//   - "I'm responding" acknowledges it as this headset (every screen sees it).
//   - "Show me" folds the card into a small bar low in the view and shows a red
//     arrow toward the patient, whose tag in the room flashes red, or toward their
//     bed when they have no tag in the room (no position yet); "Open" brings the
//     card back. Not available when the patient is in another ward.
//   - "Mute" silences the alarm tone of this headset ("Unmute" turns it back on).
// The card grows to fit its text; nothing is cut.
// Answered elsewhere (dashboard, another headset): the card turns green, says who
// answered, and closes with "OK".
// The logic of the alerts stays in ShiroAlertManager (version 1); this replaces
// the alert screen of the hand slate. Creates itself when the scene loads.
// =============================================================================
using System;
using System.Globalization;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace ShiroMR.UI
{
    public class ShiroAlertCard : MonoBehaviour
    {
        public static ShiroAlertCard Instance { get; private set; }

        // Card: within reach (touch) and comfortable for the ray; a little below the eyes.
        // Its height follows its text (LayoutCard); H is the usual one.
        private const float W = 380f, H = 272f;          // mm
        private const float Pad = 20f, TagsW = 120f;
        // Within easy reach of a fingertip (version 2 test: 0.55 m was too far); a little
        // smaller than drawn (scale), so it keeps the same size to the eye
        private const float CardDistance = 0.42f;        // m ahead
        private const float CardBelow = 0.15f;           // m below eye height
        private const float CardScale = 0.8f;
        private const float PillW = 300f, PillH = 56f;
        private const float PillDistance = 0.45f;
        private const float PillBelow = 0.24f;
        private const float PillScale = 0.85f;
        private const float FollowAngle = 28f;           // degrees off the view before it moves
        private const float LookedAtAngle = 15f;         // the patient is in view: no arrow

        private enum Mode { Hidden, Card, Bar }
        private Mode _mode = Mode.Hidden;
        private string _barForId;        // "Show me" was chosen for this incident
        private bool _subscribed;
        private bool _placed;
        private bool _following;
        private float _blink;
        private Transform _head;

        // Card
        private Canvas _card;
        private Image _band, _bandSquare;
        private TextMeshProUGUI _title, _tags, _patient, _place, _details, _state;
        private ShiroButton _respond, _ok, _showMe, _mute;
        // Bar ("Show me")
        private Canvas _bar;
        private Image _barDot;
        private TextMeshProUGUI _barText;
        // Arrow toward the patient
        private Canvas _arrow;
        private Image _arrowImage;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Bootstrap()
        {
            if (Instance == null && FindAnyObjectByType<ShiroAlertCard>() == null)
                new GameObject("ShiroAlertCard").AddComponent<ShiroAlertCard>();
        }

        private void Awake()
        {
            if (Instance != null && Instance != this) { Destroy(gameObject); return; }
            Instance = this;
            Build();
            SetMode(Mode.Hidden);
        }

        private void OnDestroy()
        {
            var am = ShiroAlertManager.Instance;
            if (_subscribed && am != null)
            {
                am.OnAlertsChanged -= Refresh;
                am.OnAlertRaised -= HandleRaised;
            }
        }

        /// <summary>Shows the card of the current alert (from the wrist chip or the menu).</summary>
        public void Open()
        {
            var am = ShiroAlertManager.Instance;
            if (am == null || am.Current == null) return;
            _barForId = null;
            _placed = false;
            SetMode(Mode.Card);
            Refresh();
        }

        /// <summary>True while an alert card or its bar is shown.</summary>
        public bool IsShowing => _mode != Mode.Hidden;

        /// <summary>True while the full card is shown (the ward panel steps aside meanwhile).</summary>
        public bool IsCardShown => _mode == Mode.Card;

        private void Update()
        {
            if (!_subscribed) TrySubscribe();
            if (_head == null && Camera.main != null) _head = Camera.main.transform;
            if (_mode == Mode.Hidden || _head == null) return;

            Follow(_mode == Mode.Card ? _card.transform : _bar.transform,
                _mode == Mode.Card ? CardDistance : PillDistance,
                _mode == Mode.Card ? CardBelow : PillBelow);
            if (_mode == Mode.Bar)
            {
                bool panelUp = ShiroWardPanel.Instance != null && ShiroWardPanel.Instance.IsVisible;
                if (_bar.gameObject.activeSelf == panelUp) _bar.gameObject.SetActive(!panelUp);
            }

            // Waiting for a response: the band (or the bar's dot) blinks
            var am = ShiroAlertManager.Instance;
            var cur = am != null ? am.Current : null;
            bool pending = cur != null && cur.status != ShiroAlertManager.AlertStatus.AcknowledgedElsewhere;
            _blink += Time.deltaTime;
            bool on = Mathf.Repeat(_blink, 0.8f) < 0.4f;
            Color band = pending ? (on ? ShiroTheme.Alert : ShiroTheme.AlertDark) : ShiroTheme.Good;
            if (_band.color != band) { _band.color = band; _bandSquare.color = band; }
            if (_barDot != null) _barDot.color = pending ? (on ? ShiroTheme.Alert : ShiroTheme.AlertDark) : ShiroTheme.Good;

            UpdateArrow(cur);

            // Once a second: "… s ago", and whether there is a tag or bed to show yet
            _refreshIn -= Time.deltaTime;
            if (_refreshIn <= 0f) { _refreshIn = 1f; Refresh(); }
        }

        private float _refreshIn = 1f;

        private void TrySubscribe()
        {
            var am = ShiroAlertManager.Instance;
            if (am == null) return;
            am.OnAlertsChanged += Refresh;
            am.OnAlertRaised += HandleRaised;
            _subscribed = true;
            Refresh();
        }

        private void HandleRaised(ShiroAlertManager.HeadsetAlert alert)
        {
            // A new alert always comes to the front, in front of the clinician
            _barForId = null;
            _placed = false;
            SetMode(Mode.Card);
            try { OVRInput.SetControllerVibration(0.6f, 0.6f, OVRInput.Controller.LTouch); }
            catch (Exception swallowed) { ShiroLog.Caught("ShiroAlertCard.HandleRaised", swallowed); }
            Refresh();
        }

        private void Refresh()
        {
            var am = ShiroAlertManager.Instance;
            var cur = am != null ? am.Current : null;
            if (cur == null)
            {
                _barForId = null;
                SetMode(Mode.Hidden);
                return;
            }
            string id = cur.incident != null ? cur.incident.incident_id : "";
            if (_barForId != null && _barForId != id) _barForId = null;   // a different alert: the full card
            Mode want = _barForId != null ? Mode.Bar : Mode.Card;
            if (_mode != want) { _placed = false; SetMode(want); }
            Fill(cur, am.Alerts.Count);
        }

        // ----- Content -----

        /// <summary>What happened, in words ("Fall detected"): the card's title, the ward panel's list.</summary>
        public static string WhatHappened(IncidentAlert inc) => Words(inc);

        /// <summary>What happened, as the card's title.</summary>
        private static string Words(IncidentAlert inc)
        {
            switch (inc.incident_category)
            {
                case "FALL_ACCIDENT": return "Fall detected";
                case "CRITICAL_VITALS": return "Critical vitals";
                case "GEOFENCE_BREACH": return inc.geofence_kind == "AT_DOOR" ? "At the door" : "Left the ward";
                default: return "Alert";
            }
        }

        /// <summary>The ward this headset shows, when the alert is for it.</summary>
        private static WardConfig ShownWard(IncidentAlert inc)
        {
            var ward = ShiroMRManager.Instance != null ? ShiroMRManager.Instance.CachedWardConfig : null;
            return ward != null && !string.IsNullOrEmpty(inc.ward_id) && ward.ward_id == inc.ward_id ? ward : null;
        }

        private static WardBed FindBed(IncidentAlert inc)
        {
            var ward = ShownWard(inc);
            if (ward == null || ward.beds == null || string.IsNullOrEmpty(inc.bed_id)) return null;
            foreach (var b in ward.beds) if (b != null && b.bed_id == inc.bed_id) return b;
            return null;
        }

        /// <summary>
        /// Where "Show me" points: the patient's tag in the room, else their bed (the
        /// ward is aligned to the room and the bed is in it). False: nowhere to point.
        /// </summary>
        private static bool TryFindTarget(IncidentAlert inc, out Vector3 pos, out bool isBed)
        {
            pos = Vector3.zero;
            isBed = false;
            if (inc == null) return false;
            var am = ShiroAlertManager.Instance;
            var holo = am != null ? am.FindHologram(inc) : null;
            if (holo != null) { pos = holo.transform.position + Vector3.up * 1.2f; return true; }
            var bed = FindBed(inc);
            var space = WardSpatialManager.Instance;
            if (bed == null || space == null || !space.IsAligned) return false;
            pos = space.GetBedHeadboardWorldPosition(bed);
            isBed = pos != Vector3.zero;
            return isBed;
        }

        private static string When(string timestamp)
        {
            if (string.IsNullOrEmpty(timestamp) ||
                !DateTime.TryParse(timestamp, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out DateTime utc))
                return "";
            DateTime local = utc.ToLocalTime();
            double s = Math.Max(0, (DateTime.Now - local).TotalSeconds);
            string ago = s < 10 ? "just now" : s < 60 ? $"{(int)s} s ago" : s < 3600 ? $"{(int)(s / 60)} min ago" : $"{(int)(s / 3600)} h ago";
            return $"{local:HH:mm} ({ago})";
        }

        /// <summary>The bed's name in the ward this headset shows ("Bed 2"), else its ID.</summary>
        private static string BedName(IncidentAlert inc)
        {
            var b = FindBed(inc);
            return b != null && !string.IsNullOrEmpty(b.bed_code) ? b.bed_code : inc.bed_id;
        }

        private void Fill(ShiroAlertManager.HeadsetAlert alert, int total)
        {
            var inc = alert.incident;
            if (inc == null) return;
            bool elsewhere = alert.status == ShiroAlertManager.AlertStatus.AcknowledgedElsewhere;
            bool sending = alert.status == ShiroAlertManager.AlertStatus.Sending;
            var am = ShiroAlertManager.Instance;
            bool canShow = TryFindTarget(inc, out _, out bool toBed);
            bool tagHere = canShow && !toBed;

            // Title: what happened; the band's right side: test, answered, how many
            string what = Words(inc);
            _title.text = what;
            string tags = inc.IsSimulated ? "Test" : "";
            if (elsewhere) tags += (tags.Length > 0 ? " · " : "") + "Answered";
            if (total > 1) tags += (tags.Length > 0 ? " · " : "") + $"1 of {total}";
            _tags.text = tags;
            _patient.text = string.IsNullOrEmpty(inc.patient_name) ? "Unknown patient" : inc.patient_name;

            var shown = ShownWard(inc);
            string ward = shown != null && !string.IsNullOrEmpty(shown.room_title) ? shown.room_title
                : string.IsNullOrEmpty(inc.ward_id) ? "Ward not known" : inc.ward_id;
            string bed = string.IsNullOrEmpty(inc.bed_id) ? "" : $" · {BedName(inc)}";
            string when = When(inc.trigger_timestamp);
            _place.text = $"{ward}{bed}{(when.Length > 0 ? " · " + when : "")}";

            string vitals = "";
            if (inc.incident_category == "CRITICAL_VITALS")
            {
                if (inc.heart_rate > 0) vitals = $"Heart rate {inc.heart_rate} bpm";
                if (inc.spo2 > 0) vitals += (vitals.Length > 0 ? " · " : "") + $"SpO2 about {Mathf.RoundToInt(inc.spo2)} %";
                if (vitals.Length > 0) vitals += "\n";
            }
            string where;
            if (tagHere) where = "Their tag in the room is flashing red.";
            else if (toBed) where = "No live position: Show me points to their bed.";
            else if (shown == null && !string.IsNullOrEmpty(inc.ward_id)) where = "In another ward than the one this headset shows.";
            else where = "No position in this room yet.";
            _details.text = vitals + where;

            if (elsewhere)
            {
                _state.text = alert.acknowledgedBy != null
                    ? $"{alert.acknowledgedBy} responded{(alert.acknowledgedAt != null ? " at " + alert.acknowledgedAt : "")}. Nothing to do on this headset."
                    : "Handled while this headset was offline (see the dashboard's incident log).";
                _state.color = ShiroTheme.GoodText;
            }
            else if (sending)
            {
                _state.text = "Sending your response…";
                _state.color = ShiroTheme.WarnText;
            }
            else
            {
                _state.text = alert.note ?? "Waiting for someone to respond.";
                _state.color = alert.note != null ? ShiroTheme.AlertText : ShiroTheme.WarnText;
            }

            _respond.gameObject.SetActive(!elsewhere);
            _ok.gameObject.SetActive(elsewhere);
            _respond.SetText(sending ? "Sending…" : "I'm responding");
            _respond.SetInteractable(!sending);
            _showMe.SetInteractable(canShow);
            _mute.SetText(am != null && am.IsMuted ? "Unmute" : "Mute");

            _barText.text = $"<b>{what}</b>\n{_patient.text}";
            Color band = elsewhere ? ShiroTheme.Good : ShiroTheme.Alert;
            _band.color = band;
            _bandSquare.color = band;
            LayoutCard();
        }

        /// <summary>
        /// Stacks the card's lines from the top, each as tall as its text needs, and the
        /// buttons below them: the card grows rather than cutting a line.
        /// </summary>
        private void LayoutCard()
        {
            float w = W - 2 * Pad;
            float y = 62f;
            ShiroUIKit.Place(_patient, Pad, y, w, 38); y += 40f;
            ShiroUIKit.Place(_place, Pad, y, w, 22); y += 26f;
            y = Stack(_details, y, w) + 4f;
            y = Stack(_state, y, w) + 10f;
            ShiroUIKit.Place(_respond, Pad, y, 150, 44);
            ShiroUIKit.Place(_ok, Pad, y, 150, 44);
            ShiroUIKit.Place(_showMe, Pad + 162, y, 90, 44);
            ShiroUIKit.Place(_mute, Pad + 264, y, 76, 44);
            float h = y + 44f + 18f;
            var rt = (RectTransform)_card.transform;
            if (!Mathf.Approximately(rt.sizeDelta.y, h)) rt.sizeDelta = new Vector2(W, h);
        }

        /// <summary>Places a wrapping label at y, as tall as its text; returns the y below it.</summary>
        private static float Stack(TextMeshProUGUI label, float y, float w)
        {
            if (string.IsNullOrEmpty(label.text)) { ShiroUIKit.Place(label, Pad, y, w, 0); return y - 4f; }
            float h = Mathf.Ceil(label.GetPreferredValues(label.text, w, 0f).y) + 2f;
            ShiroUIKit.Place(label, Pad, y, w, h);
            return y + h;
        }

        // ----- Actions -----

        private void Respond()
        {
            var am = ShiroAlertManager.Instance;
            if (am != null) am.Acknowledge(am.Current);
        }

        private void CloseAnswered()
        {
            var am = ShiroAlertManager.Instance;
            if (am != null) am.Dismiss(am.Current);
        }

        private void ShowMe()
        {
            var am = ShiroAlertManager.Instance;
            var cur = am != null ? am.Current : null;
            if (cur == null || cur.incident == null) return;
            _barForId = cur.incident.incident_id;
            _placed = false;
            SetMode(Mode.Bar);
        }

        private void ToggleMute()
        {
            var am = ShiroAlertManager.Instance;
            if (am != null) am.ToggleMute();
        }

        // ----- Placement -----

        private void SetMode(Mode mode)
        {
            _mode = mode;
            if (_card != null) _card.gameObject.SetActive(mode == Mode.Card);
            if (_bar != null) _bar.gameObject.SetActive(mode == Mode.Bar);
            if (_arrow != null && mode != Mode.Bar) _arrow.gameObject.SetActive(false);
            _following = false;
        }

        /// <summary>
        /// Keeps a panel ahead of the clinician: placed at once when shown, then it stays
        /// put while they look around a little and glides back when they turn away.
        /// </summary>
        private void Follow(Transform t, float distance, float below)
        {
            Vector3 flat = _head.forward;
            flat.y = 0f;
            if (flat.sqrMagnitude < 0.001f) flat = Vector3.forward;
            flat.Normalize();
            Vector3 target = _head.position + flat * distance + Vector3.down * below;
            Quaternion rot = Quaternion.LookRotation(target - _head.position, Vector3.up);

            if (!_placed)
            {
                t.SetPositionAndRotation(target, rot);
                _placed = true;
                return;
            }
            Vector3 to = t.position - _head.position;
            Vector3 toFlat = Vector3.ProjectOnPlane(to, Vector3.up);
            float off = Vector3.Angle(flat, toFlat);
            float want = Mathf.Sqrt(distance * distance + below * below);
            if (off > FollowAngle || Mathf.Abs(to.magnitude - want) > 0.25f) _following = true;
            if (_following)
            {
                float k = 1f - Mathf.Exp(-6f * Time.deltaTime);
                t.SetPositionAndRotation(Vector3.Lerp(t.position, target, k), Quaternion.Slerp(t.rotation, rot, k));
                if ((t.position - target).sqrMagnitude < 0.0004f) _following = false;
            }
        }

        /// <summary>"Show me": a red arrow at the edge of the view, toward the patient's tag (or bed).</summary>
        private void UpdateArrow(ShiroAlertManager.HeadsetAlert cur)
        {
            if (_arrow == null) return;
            Vector3 target = Vector3.zero;
            bool found = _mode == Mode.Bar && cur != null && TryFindTarget(cur.incident, out target, out _);
            if (!found) { _arrow.gameObject.SetActive(false); return; }

            Vector3 toTarget = target - _head.position;
            if (Vector3.Angle(_head.forward, toTarget) < LookedAtAngle) { _arrow.gameObject.SetActive(false); return; }

            Vector3 local = _head.InverseTransformDirection(toTarget);
            Vector2 dir = new Vector2(local.x, local.y);
            if (local.z < 0f && dir.sqrMagnitude < 0.01f) dir = Vector2.right;   // right behind: turn right
            dir.Normalize();
            Vector3 worldDir = _head.right * dir.x + _head.up * dir.y;
            // 0.35 m ahead: in front of the ward panel and the card, the same size to the eye
            Vector3 pos = _head.position + _head.forward * 0.35f + worldDir * 0.075f;
            _arrow.gameObject.SetActive(true);
            _arrow.transform.SetPositionAndRotation(pos, Quaternion.LookRotation(_head.forward, worldDir));
            float pulse = 0.85f + 0.15f * Mathf.Sin(Time.time * 6f);
            _arrow.transform.localScale = Vector3.one * 0.001f * 0.6f * pulse;
        }

        // ----- Building -----

        private void Build()
        {
            // The card
            _card = ShiroUIKit.WorldCanvas("AlertCard", transform, new Vector2(W, H));
            _card.transform.localScale = Vector3.one * 0.001f * CardScale;
            var root = _card.transform;
            ShiroUIKit.Fill(ShiroUIKit.Panel(root, "Background", ShiroTheme.Glass, 18f));
            _band = ShiroUIKit.Panel(root, "Band", ShiroTheme.Alert, 18f);
            ShiroUIKit.Place(_band, 0, 0, W, 52);
            _bandSquare = ShiroUIKit.Panel(root, "BandLower", ShiroTheme.Alert, 0f);
            ShiroUIKit.Place(_bandSquare, 0, 30, W, 22);

            // Band: what happened (left); test, answered, how many (right)
            _title = ShiroUIKit.Label(root, "Title", "", 22f, ShiroTheme.TextOnColour, FontStyles.Bold).Fit(16f);
            ShiroUIKit.Place(_title, Pad, 10, W - 2 * Pad - TagsW - 8, 32);
            _tags = ShiroUIKit.Label(root, "Tags", "", 14f, ShiroTheme.TextOnColour, FontStyles.Normal, TextAlignmentOptions.Right).Fit(10f);
            ShiroUIKit.Place(_tags, W - Pad - TagsW, 14, TagsW, 24);

            // Who, where and when, details, state: placed by LayoutCard
            _patient = ShiroUIKit.Label(root, "Patient", "", 28f, ShiroTheme.Text, FontStyles.Bold).Fit(18f);
            _place = ShiroUIKit.Label(root, "Place", "", 15f, ShiroTheme.TextDim).Fit(11f);
            _details = ShiroUIKit.Label(root, "Details", "", 14f, ShiroTheme.Text, FontStyles.Normal, TextAlignmentOptions.TopLeft, true);
            _state = ShiroUIKit.Label(root, "State", "", 14f, ShiroTheme.WarnText, FontStyles.Bold, TextAlignmentOptions.TopLeft, true);

            _respond = ShiroUIKit.Button(root, "Respond", "I'm responding", ButtonKind.Danger, Respond, 16f);
            _ok = ShiroUIKit.Button(root, "Ok", "OK, close", ButtonKind.Primary, CloseAnswered, 16f);
            _showMe = ShiroUIKit.Button(root, "ShowMe", "Show me", ButtonKind.Secondary, ShowMe, 15f);
            _mute = ShiroUIKit.Button(root, "Mute", "Mute", ButtonKind.Quiet, ToggleMute, 14f);
            LayoutCard();

            // The bar shown after "Show me"
            _bar = ShiroUIKit.WorldCanvas("AlertBar", transform, new Vector2(PillW, PillH));
            _bar.transform.localScale = Vector3.one * 0.001f * PillScale;
            var bar = _bar.transform;
            ShiroUIKit.Fill(ShiroUIKit.Panel(bar, "Background", ShiroTheme.Glass, PillH / 2f));
            _barDot = ShiroUIKit.Dot(bar, "Dot", ShiroTheme.Alert);
            ShiroUIKit.Place(_barDot, 18, 20, 16, 16);
            // Two lines: what happened, who
            _barText = ShiroUIKit.Label(bar, "Text", "", 14f, ShiroTheme.Text).Fit(11f);
            _barText.richText = true;
            _barText.lineSpacing = -8f;
            ShiroUIKit.Place(_barText, 42, 7, PillW - 42 - 82, 42);
            var open = ShiroUIKit.Button(bar, "Open", "Open", ButtonKind.Primary, Open, 15f);
            ShiroUIKit.Place(open, PillW - 74, 8, 62, 40);

            // The arrow toward the patient
            _arrow = ShiroUIKit.WorldCanvas("AlertArrow", transform, new Vector2(36f, 36f));
            _arrowImage = ShiroUIKit.Panel(_arrow.transform, "Arrow", ShiroTheme.Alert, 0f);
            _arrowImage.sprite = ShiroUIKit.TriangleSprite;
            _arrowImage.type = Image.Type.Simple;
            ShiroUIKit.Fill(_arrowImage);
            _arrow.gameObject.SetActive(false);
        }
    }
}
