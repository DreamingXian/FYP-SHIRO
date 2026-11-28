// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Automatic ward detection from this headset's saved spatial anchors.
//
// Every ward this headset was calibrated in has a spatial anchor saved on the
// headset (its reference is kept on the edge server per headset). The anchor
// sits at the ward's origin corner, so once the headset finds it in the room it
// also knows where that ward's rectangle is. This component keeps those anchors
// loaded and checks once a second which ward rectangle the headset stands in:
//
// - Inside the active ward: nothing to do.
// - Inside another calibrated ward for 2 s: that ward becomes the active ward,
//   and its saved anchor aligns it (no manual calibration).
// - Inside no calibrated ward (corridor, a ward never calibrated on this
//   headset): nothing changes; the status says so.
//
// No camera image is used or stored: the headset's own tracking finds the
// anchors. A ward never calibrated on this headset still needs one manual
// calibration (Ward tab) before it can be found.
// Creates itself when the scene loads: nothing has to be added to the scene.
// =============================================================================
using System;
using System.Collections.Generic;
using UnityEngine;

namespace ShiroMR
{
    public class ShiroWardAutoDetect : MonoBehaviour
    {
        public static ShiroWardAutoDetect Instance { get; private set; }

        private const string PrefKey = "Shiro_AutoWardDetect";
        private const float CheckInterval = 1f;       // s between position checks
        private const float SwitchAfter = 2f;         // s inside another ward before switching
        private const float EnterMargin = 0.2f;       // m: must be this far inside another ward
        private const float StayMargin = 0.4f;        // m: the active ward counts a bit beyond its walls
        private const float ReloadInterval = 15f;     // s between attempts to find anchors not found yet

        /// <summary>On by default; the System tab can switch it off.</summary>
        public bool IsEnabled { get; private set; } = true;
        /// <summary>Short status for the hand slate.</summary>
        public string StatusText { get; private set; } = "waiting for the ward list";
        public event Action<string> OnStatusChanged;
        /// <summary>Raised when this component switched the active ward (ward id).</summary>
        public event Action<string> OnWardDetected;

        private class WardAnchorHost
        {
            public string wardId;
            public string uuid;
            public GameObject host;
            public OVRSpatialAnchor anchor;
        }

        private readonly Dictionary<string, WardAnchorHost> _hosts = new Dictionary<string, WardAnchorHost>(StringComparer.OrdinalIgnoreCase);
        private bool _subscribed;
        private bool _loading;
        private float _nextCheck;
        private float _nextLoad;
        private string _candidate;
        private float _candidateSince;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Bootstrap()
        {
            if (Instance == null && FindAnyObjectByType<ShiroWardAutoDetect>() == null)
            {
                new GameObject("ShiroWardAutoDetect").AddComponent<ShiroWardAutoDetect>();
            }
        }

        private void Awake()
        {
            if (Instance != null && Instance != this) { Destroy(gameObject); return; }
            Instance = this;
            DontDestroyOnLoad(gameObject);
            IsEnabled = PlayerPrefs.GetInt(PrefKey, 1) == 1;
        }

        private void OnDestroy()
        {
            var net = ShiroNetworkManager.Instance;
            if (_subscribed && net != null)
            {
                net.OnWardListLoaded -= HandleWardList;
                net.OnActiveWardChanged -= HandleActiveWardChanged;
            }
            ReleaseAll();
        }

        public void SetEnabled(bool on)
        {
            IsEnabled = on;
            PlayerPrefs.SetInt(PrefKey, on ? 1 : 0);
            PlayerPrefs.Save();
            _candidate = null;
            SetStatus(on ? "on" : "off");
            if (on) _nextLoad = 0f;
        }

        private void Update()
        {
            var net = ShiroNetworkManager.Instance;
            if (net == null) return;
            if (!_subscribed)
            {
                net.OnWardListLoaded += HandleWardList;
                net.OnActiveWardChanged += HandleActiveWardChanged;
                _subscribed = true;
                if (net.AvailableWards.Count > 0) _nextLoad = 0f;
            }
            if (!IsEnabled || IsCalibrating()) return;

            if (!_loading && Time.realtimeSinceStartup >= _nextLoad && net.AvailableWards.Count > 0)
            {
                _nextLoad = Time.realtimeSinceStartup + ReloadInterval;
                LoadMissingAnchors();
            }

            if (Time.realtimeSinceStartup < _nextCheck) return;
            _nextCheck = Time.realtimeSinceStartup + CheckInterval;
            CheckPosition(net);
        }

        private static bool IsCalibrating()
        {
            var tool = WardAlignmentTool.Instance;
            return tool != null && tool.currentStep != AlignmentStep.Idle && tool.currentStep != AlignmentStep.Completed;
        }

        // ----- Which ward am I in? -----

        // KEY LOGIC: once a second: is the head inside the active ward's rectangle (aligned)? If
        // not, is it inside another ward whose saved spatial anchor was found? Staying there for
        // 2 s switches the active ward, and that ward's anchor aligns it. Uses the headset's own
        // tracking, not the BLE anchors (those only place the wristbands).
        private void CheckPosition(ShiroNetworkManager net)
        {
            Camera cam = Camera.main;
            if (cam == null) return;
            Vector3 head = cam.transform.position;
            string active = net.targetWardId;

            // Still in the active (aligned) ward: nothing to do
            var spatial = WardSpatialManager.Instance;
            var tool = WardAlignmentTool.Instance;
            WardSummary activeWard = FindWard(net, active);
            if (activeWard != null && spatial != null && spatial.wardOrigin != null && tool != null && tool.isAligned &&
                Inside(spatial.wardOrigin, activeWard, head, -StayMargin))
            {
                _candidate = null;
                SetStatus($"in {activeWard.ward_id}");
                return;
            }

            // Inside another ward whose anchor this headset found?
            string found = null;
            foreach (var h in _hosts.Values)
            {
                if (string.Equals(h.wardId, active, StringComparison.OrdinalIgnoreCase)) continue;
                if (h.anchor == null || !h.anchor.Localized || !h.anchor.IsTracked) continue;
                WardSummary w = FindWard(net, h.wardId);
                if (w != null && Inside(h.host.transform, w, head, EnterMargin)) { found = h.wardId; break; }
            }

            if (found == null)
            {
                _candidate = null;
                int ready = 0;
                foreach (var h in _hosts.Values) if (h.anchor != null && h.anchor.Localized) ready++;
                SetStatus(ready == 0 && (tool == null || !tool.isAligned)
                    ? "no calibrated ward here"
                    : "not in a calibrated ward");
                return;
            }

            if (!string.Equals(found, _candidate, StringComparison.OrdinalIgnoreCase))
            {
                _candidate = found;
                _candidateSince = Time.realtimeSinceStartup;
                SetStatus($"entering {found}…");
                return;
            }
            if (Time.realtimeSinceStartup - _candidateSince < SwitchAfter) return;

            _candidate = null;
            Debug.Log($"[SHIRO WARD DETECT] The headset is inside {found}: switching the active ward.");
            SetStatus($"entered {found}");
            net.SwitchWard(found); // the ward loads and its saved anchor aligns it (WardAlignmentTool)
            OnWardDetected?.Invoke(found);
        }

        /// <summary>
        /// True when the point is inside the ward rectangle placed at origin (ward x along the
        /// origin's right, ward y along its forward). margin > 0 requires being that far inside;
        /// margin &lt; 0 also accepts that far outside.
        /// </summary>
        private static bool Inside(Transform origin, WardSummary w, Vector3 point, float margin)
        {
            if (w.length_x <= 0f || w.width_y <= 0f) return false;
            Vector3 local = origin.InverseTransformPoint(point);
            return local.x >= margin && local.x <= w.length_x - margin &&
                   local.z >= margin && local.z <= w.width_y - margin;
        }

        private static WardSummary FindWard(ShiroNetworkManager net, string wardId)
        {
            if (string.IsNullOrEmpty(wardId)) return null;
            foreach (var w in net.AvailableWards)
                if (string.Equals(w.ward_id, wardId, StringComparison.OrdinalIgnoreCase)) return w;
            return null;
        }


        // ----- Keeping the anchors of the other wards loaded -----

        private void HandleWardList(List<WardSummary> wards)
        {
            // Anchors of wards that are gone, or whose saved anchor changed, are released
            var keep = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var w in wards)
            {
                string uuid = SavedAnchor(w);
                if (!string.IsNullOrEmpty(uuid)) keep.Add($"{w.ward_id}|{uuid}");
            }
            foreach (var h in new List<WardAnchorHost>(_hosts.Values))
                if (!keep.Contains($"{h.wardId}|{h.uuid}")) Release(h.wardId);
            _nextLoad = 0f;
        }

        private void HandleActiveWardChanged(string wardId)
        {
            // The active ward's anchor is bound by WardSpatialManager; an anchor can only be
            // bound once, so this component lets go of it. The previous ward's anchor is
            // loaded here again shortly after (WardSpatialManager releases it).
            Release(wardId);
            _candidate = null;
            _nextLoad = Time.realtimeSinceStartup + 3f;
        }

        /// <summary>This headset's anchor of a ward: from the edge server, or the one kept on the headset.</summary>
        private static string SavedAnchor(WardSummary w)
        {
            if (!string.IsNullOrEmpty(w.spatial_anchor_uuid)) return w.spatial_anchor_uuid;
            string local = PlayerPrefs.GetString($"WARD_ANCHOR_UUID_{w.ward_id}", "");
            return string.IsNullOrEmpty(local) ? null : local;
        }

        private async void LoadMissingAnchors()
        {
            var net = ShiroNetworkManager.Instance;
            if (net == null || _loading) return;

            var wanted = new Dictionary<Guid, string>();
            foreach (var w in net.AvailableWards)
            {
                if (string.Equals(w.ward_id, net.targetWardId, StringComparison.OrdinalIgnoreCase)) continue;
                if (_hosts.TryGetValue(w.ward_id, out var have) && have.anchor != null && have.anchor.Localized) continue;
                string uuid = SavedAnchor(w);
                if (uuid != null && Guid.TryParse(uuid, out Guid g)) wanted[g] = w.ward_id;
            }
            if (wanted.Count == 0) return;

            _loading = true;
            try
            {
                var unbound = new List<OVRSpatialAnchor.UnboundAnchor>();
                var result = await OVRSpatialAnchor.LoadUnboundAnchorsAsync(wanted.Keys, unbound);
                if (!result.Success) return;

                foreach (var u in unbound)
                {
                    if (!wanted.TryGetValue(u.Uuid, out string wardId)) continue;
                    // Skip it if the active ward changed to this ward meanwhile
                    if (string.Equals(wardId, net.targetWardId, StringComparison.OrdinalIgnoreCase)) continue;
                    if (!u.Localized && !await u.LocalizeAsync(5.0)) continue; // not in this part of the building

                    Release(wardId);
                    var host = new GameObject($"WardDetectAnchor_{wardId}");
                    host.transform.SetParent(transform, false);
                    var anchor = host.AddComponent<OVRSpatialAnchor>();
                    u.BindTo(anchor);
                    _hosts[wardId] = new WardAnchorHost { wardId = wardId, uuid = u.Uuid.ToString(), host = host, anchor = anchor };
                    Debug.Log($"[SHIRO WARD DETECT] Found the saved anchor of {wardId}.");
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[SHIRO WARD DETECT] Loading saved ward anchors failed: {ex.Message}");
            }
            finally
            {
                _loading = false;
            }
        }

        private void Release(string wardId)
        {
            if (string.IsNullOrEmpty(wardId) || !_hosts.TryGetValue(wardId, out var h)) return;
            // Destroying the component only lets go of the anchor; it stays saved on the headset
            if (h.host != null) Destroy(h.host);
            _hosts.Remove(wardId);
        }

        private void ReleaseAll()
        {
            foreach (var h in _hosts.Values) if (h.host != null) Destroy(h.host);
            _hosts.Clear();
        }

        private void SetStatus(string text)
        {
            if (StatusText == text) return;
            StatusText = text;
            OnStatusChanged?.Invoke(text);
        }

    }
}
