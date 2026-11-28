// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Emergency alerts on the headset: falls, critical vitals, geofence.
//
// - A new incident from the edge server makes the patient's panel and floor
//   ring flash red, plays an alarm tone and opens the alert on the hand slate.
// - The clinician acknowledges it from the hand slate; the edge server records
//   the headset ("QUEST3-… (paired by …)") and tells every screen.
// - Acknowledged elsewhere (dashboard, another headset): the alarm stops and the
//   hand slate says by whom, until the clinician closes it with "OK".
// - On every (re)connection the pending incidents are fetched, so alerts raised
//   while the headset was offline are shown too.
// Creates itself when the scene loads: nothing has to be added to the scene.
// =============================================================================
using System;
using System.Collections.Generic;
using UnityEngine;

namespace ShiroMR
{
    public class ShiroAlertManager : MonoBehaviour
    {
        public static ShiroAlertManager Instance { get; private set; }

        public enum AlertStatus { Pending, Sending, AcknowledgedElsewhere }

        public class HeadsetAlert
        {
            public IncidentAlert incident;
            public AlertStatus status = AlertStatus.Pending;
            public string acknowledgedBy;   // AcknowledgedElsewhere: who responded
            public string acknowledgedAt;   // local time text, or null when not known
            public string note;             // last problem (acknowledge failed, ...)
        }

        /// <summary>Raised on the main thread whenever an alert is added, changed or removed.</summary>
        public event Action OnAlertsChanged;
        /// <summary>Raised when a new alert arrives (the hand slate opens for it).</summary>
        public event Action<HeadsetAlert> OnAlertRaised;

        /// <summary>Text about the last check with the server, for the hand slate.</summary>
        public string ServerCheckText { get; private set; } = "waiting for the edge server";
        /// <summary>Confirmation after this headset acknowledged an alert (shown briefly).</summary>
        public string LastOwnAcknowledgement { get; private set; }

        private readonly List<HeadsetAlert> _alerts = new List<HeadsetAlert>();
        private readonly HashSet<string> _handledIds = new HashSet<string>();
        private bool _subscribed;
        private float _hologramSyncTimer;

        private AudioSource _alarmSource;
        private AudioClip _alarmClip;
        public bool IsMuted { get; private set; }

        public IReadOnlyList<HeadsetAlert> Alerts => _alerts;
        public int PendingCount
        {
            get { int n = 0; foreach (var a in _alerts) if (a.status != AlertStatus.AcknowledgedElsewhere) n++; return n; }
        }

        /// <summary>The alert the hand slate shows: a pending one first, then one acknowledged elsewhere.</summary>
        public HeadsetAlert Current
        {
            get
            {
                foreach (var a in _alerts) if (a.status != AlertStatus.AcknowledgedElsewhere) return a;
                return _alerts.Count > 0 ? _alerts[0] : null;
            }
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Bootstrap()
        {
            if (Instance == null && FindAnyObjectByType<ShiroAlertManager>() == null)
            {
                new GameObject("ShiroAlertManager").AddComponent<ShiroAlertManager>();
            }
        }

        private void Awake()
        {
            if (Instance != null && Instance != this) { Destroy(gameObject); return; }
            Instance = this;
            BuildAlarmTone();
        }

        private void Update()
        {
            if (!_subscribed) TrySubscribe();

            // Holograms may appear after the alert (patient comes into the ward later)
            _hologramSyncTimer += Time.deltaTime;
            if (_hologramSyncTimer >= 0.5f)
            {
                _hologramSyncTimer = 0f;
                foreach (var a in _alerts) ApplyHologramAlarm(a);
            }
        }

        private void TrySubscribe()
        {
            var net = ShiroNetworkManager.Instance;
            if (net == null) return;
            net.OnEmergencyAlert += HandleNewAlert;
            net.OnEmergencyAcknowledged += HandleAcknowledged;
            net.OnConnectionStatusChanged += HandleConnectionChanged;
            _subscribed = true;
            if (net.IsConnected) HandleConnectionChanged(true);
        }

        private void OnDestroy()
        {
            var net = ShiroNetworkManager.Instance;
            if (_subscribed && net != null)
            {
                net.OnEmergencyAlert -= HandleNewAlert;
                net.OnEmergencyAcknowledged -= HandleAcknowledged;
                net.OnConnectionStatusChanged -= HandleConnectionChanged;
            }
        }

        // ----- events from the edge server -----

        // KEY LOGIC: an incident from the edge server (fall, critical heart rate, left the ward)
        // becomes a headset alert: the patient's tag turns red and flashes, a two-tone alarm
        // plays, and the alert card opens in front of the clinician. "I'm responding" sends the
        // acknowledgement (REST); the first acknowledgement anywhere wins, and the others
        // show who responded.
        private void HandleNewAlert(IncidentAlert incident)
        {
            if (incident == null || string.IsNullOrEmpty(incident.incident_id)) return;
            if (_handledIds.Contains(incident.incident_id) || Find(incident.incident_id) != null) return;
            if (!string.IsNullOrEmpty(incident.resolution_status) && incident.resolution_status != "PENDING") return;

            var alert = new HeadsetAlert { incident = incident };
            _alerts.Add(alert);
            Debug.LogWarning($"[SHIRO ALERT] {incident.CategoryLabel} for {incident.patient_name ?? incident.patient_id ?? "unknown patient"} ({incident.incident_id}).");
            ApplyHologramAlarm(alert);
            UpdateAlarmTone();
            OnAlertRaised?.Invoke(alert);
            OnAlertsChanged?.Invoke();
        }

        private void HandleAcknowledged(string incidentId, string by, string at)
        {
            var alert = Find(incidentId);
            _handledIds.Add(incidentId);
            if (alert == null) return;
            // This headset's own request: its answer is handled in Acknowledge()
            if (alert.status == AlertStatus.Sending) return;
            MarkAcknowledgedElsewhere(alert, by, FormatTime(at));
        }

        private void HandleConnectionChanged(bool connected)
        {
            if (!connected)
            {
                ServerCheckText = "not connected to the edge server: alerts cannot arrive";
                OnAlertsChanged?.Invoke();
                return;
            }
            var net = ShiroNetworkManager.Instance;
            if (net == null) return;
            net.StartCoroutine(net.FetchActiveAlertsRoutine((list, error) =>
            {
                if (list == null)
                {
                    ServerCheckText = $"pending alerts could not be checked ({error})";
                    OnAlertsChanged?.Invoke();
                    return;
                }
                ServerCheckText = $"connected • checked {DateTime.Now:HH:mm:ss}";
                var pendingIds = new HashSet<string>();
                foreach (var inc in list)
                {
                    if (inc == null || string.IsNullOrEmpty(inc.incident_id)) continue;
                    pendingIds.Add(inc.incident_id);
                    HandleNewAlert(inc);
                }
                // Pending here but no longer on the server: handled while this headset was offline
                foreach (var a in _alerts.ToArray())
                {
                    if (a.status == AlertStatus.Pending && !pendingIds.Contains(a.incident.incident_id))
                    {
                        _handledIds.Add(a.incident.incident_id);
                        MarkAcknowledgedElsewhere(a, null, null);
                    }
                }
                OnAlertsChanged?.Invoke();
            }));
        }

        // ----- actions from the hand slate -----

        /// <summary>Acknowledges the alert as this headset.</summary>
        public void Acknowledge(HeadsetAlert alert)
        {
            var net = ShiroNetworkManager.Instance;
            if (alert == null || alert.status != AlertStatus.Pending || net == null) return;
            if (!net.IsConnected)
            {
                alert.note = "Not acknowledged: the edge server cannot be reached. Respond in person and acknowledge on the dashboard.";
                OnAlertsChanged?.Invoke();
                return;
            }
            alert.status = AlertStatus.Sending;
            alert.note = null;
            OnAlertsChanged?.Invoke();

            string id = alert.incident.incident_id;
            net.StartCoroutine(net.AcknowledgeIncidentRoutine(id, (status, resp) =>
            {
                if (status == 200 && resp.success)
                {
                    _handledIds.Add(id);
                    LastOwnAcknowledgement = $"You responded to the {alert.incident.CategoryLabel.ToLowerInvariant()} of {alert.incident.patient_name ?? "unknown patient"} at {DateTime.Now:HH:mm}.";
                    Remove(alert);
                }
                else if (status == 409)
                {
                    // Someone else was first: their acknowledgement is the record
                    _handledIds.Add(id);
                    string by = null;
                    var m = System.Text.RegularExpressions.Regex.Match(resp.error ?? "", @"by (.*)\.$");
                    if (m.Success) by = m.Groups[1].Value;
                    MarkAcknowledgedElsewhere(alert, by, null);
                }
                else if (status == 404)
                {
                    _handledIds.Add(id);
                    LastOwnAcknowledgement = $"Incident {id} is not known to the edge server (database reset?). Removed from the headset.";
                    Remove(alert);
                }
                else
                {
                    alert.status = AlertStatus.Pending;
                    alert.note = $"Not acknowledged: {resp.error ?? "no answer from the edge server"}. Try again.";
                    OnAlertsChanged?.Invoke();
                }
            }));
        }

        /// <summary>Closes an alert someone else acknowledged ("OK").</summary>
        public void Dismiss(HeadsetAlert alert)
        {
            if (alert == null || alert.status != AlertStatus.AcknowledgedElsewhere) return;
            Remove(alert);
        }

        public void ToggleMute()
        {
            IsMuted = !IsMuted;
            UpdateAlarmTone();
            OnAlertsChanged?.Invoke();
        }

        /// <summary>The hologram of the alert's patient, if it is in this ward.</summary>
        public PatientHologram FindHologram(IncidentAlert incident)
        {
            var mr = ShiroMRManager.Instance;
            if (mr == null || incident == null) return null;
            var holo = mr.GetHologram(incident.device_id);
            if (holo != null) return holo;
            if (!string.IsNullOrEmpty(incident.patient_id))
            {
                foreach (var kvp in mr.ActiveHolograms)
                {
                    if (kvp.Value != null && string.Equals(kvp.Value.patientId, incident.patient_id, StringComparison.OrdinalIgnoreCase))
                        return kvp.Value;
                }
            }
            return null;
        }

        // ----- internals -----

        private HeadsetAlert Find(string incidentId)
        {
            foreach (var a in _alerts) if (a.incident.incident_id == incidentId) return a;
            return null;
        }

        private void MarkAcknowledgedElsewhere(HeadsetAlert alert, string by, string at)
        {
            alert.status = AlertStatus.AcknowledgedElsewhere;
            alert.acknowledgedBy = by;
            alert.acknowledgedAt = at;
            alert.note = null;
            ApplyHologramAlarm(alert);
            UpdateAlarmTone();
            OnAlertsChanged?.Invoke();
        }

        private void Remove(HeadsetAlert alert)
        {
            _alerts.Remove(alert);
            var holo = FindHologram(alert.incident);
            if (holo != null && !HasPendingFor(holo)) holo.SetAlarm(false);
            UpdateAlarmTone();
            OnAlertsChanged?.Invoke();
        }

        private bool HasPendingFor(PatientHologram holo)
        {
            foreach (var a in _alerts)
                if (a.status != AlertStatus.AcknowledgedElsewhere && FindHologram(a.incident) == holo) return true;
            return false;
        }

        private void ApplyHologramAlarm(HeadsetAlert alert)
        {
            var holo = FindHologram(alert.incident);
            if (holo == null) return;
            bool shouldFlash = alert.status != AlertStatus.AcknowledgedElsewhere;
            if (shouldFlash && !holo.isAlarmActive) holo.SetAlarm(true, alert.incident.CategoryLabel);
            else if (!shouldFlash && holo.isAlarmActive && !HasPendingFor(holo)) holo.SetAlarm(false);
        }

        private void UpdateAlarmTone()
        {
            if (_alarmSource == null) return;
            bool shouldPlay = PendingCount > 0 && !IsMuted;
            if (shouldPlay && !_alarmSource.isPlaying) _alarmSource.Play();
            else if (!shouldPlay && _alarmSource.isPlaying) _alarmSource.Stop();
        }

        /// <summary>Two-tone alarm (880 Hz, 659 Hz) every 1.6 s, as on the dashboard.</summary>
        private void BuildAlarmTone()
        {
            _alarmSource = gameObject.AddComponent<AudioSource>();
            _alarmSource.playOnAwake = false;
            _alarmSource.loop = true;
            _alarmSource.spatialBlend = 0f;
            _alarmSource.volume = 0.7f;

            const int rate = 44100;
            const float cycle = 1.6f;
            int n = Mathf.RoundToInt(rate * cycle);
            float[] samples = new float[n];
            for (int i = 0; i < n; i++)
            {
                float t = (float)i / rate;
                float v = 0f;
                if (t < 0.15f) v = Mathf.Sin(2f * Mathf.PI * 880f * t) * Mathf.Exp(-t * 18f);
                else if (t >= 0.18f && t < 0.35f) v = Mathf.Sin(2f * Mathf.PI * 659f * t) * Mathf.Exp(-(t - 0.18f) * 18f);
                samples[i] = v * 0.5f;
            }
            _alarmClip = AudioClip.Create("ShiroAlarm", n, 1, rate, false);
            _alarmClip.SetData(samples, 0);
            _alarmSource.clip = _alarmClip;
        }

        private static string FormatTime(string iso)
        {
            if (string.IsNullOrEmpty(iso)) return null;
            if (DateTime.TryParse(iso, null, System.Globalization.DateTimeStyles.RoundtripKind, out var t))
                return t.ToLocalTime().ToString("HH:mm:ss");
            return iso;
        }
    }
}
