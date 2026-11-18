// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// High-Performance Zero-Dependency WebSocket & REST Networking Client
// =============================================================================
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;

namespace ShiroMR
{
    public class ShiroNetworkManager : MonoBehaviour
    {
        public static ShiroNetworkManager Instance { get; private set; }

        [Header("Edge Server Configuration")]
        [Tooltip("IP address of the Edge Server (use 127.0.0.1 for PC Link testing, or 192.168.1.229 for wireless headset)")]
        public string serverIp = "192.168.1.229";
        public int serverPort = 3000;
        [Tooltip("Ward shown in the headset. Empty = not configured: choose one on the hand slate. The last choice is remembered.")]
        public string targetWardId = "";
        public bool autoConnectOnStart = true;

        /// <summary>True when a ward has been chosen. No ward is assumed.</summary>
        public bool HasWard => !string.IsNullOrEmpty(targetWardId);

        /// <summary>This headset's own device ID and artificial MAC address (see HeadsetIdentity).</summary>
        public HeadsetIdentity Identity { get; private set; }

        [Header("Connection Status")]
        [SerializeField] private bool isWsConnected = false;
        public bool IsConnected => isWsConnected;

        // Pairing: the edge server accepts this headset only with the token it
        // received once for a 6-digit code created by an admin on the dashboard.
        private const string TokenPrefKey = "Shiro_HeadsetToken";
        private string _headsetToken = "";
        /// <summary>True when this headset holds a pairing token.</summary>
        public bool IsPaired => !string.IsNullOrEmpty(_headsetToken);
        /// <summary>The last pairing state as text for the hand slate.</summary>
        public string PairingMessage { get; private set; } = "";
        /// <summary>Raised on the main thread when the pairing changes (paired, message).</summary>
        public event Action<bool, string> OnPairingStatusChanged;

        private const string NotPairedMessage = "Not paired. On the dashboard: ADMIN → Headset Pairing → Create pairing code, then enter it here.";

        // Events for other MR components
        public event Action<WardConfig, List<TrackedSubject>> OnWardInitialized;
        public event Action<IpsPositionUpdate> OnPositionUpdated;
        public event Action<TelemetryUpdate> OnTelemetryUpdated;
        public event Action<string> OnTagPurged;
        public event Action<bool> OnConnectionStatusChanged;
        public event Action<List<WardSummary>> OnWardListLoaded;
        public event Action<string> OnActiveWardChanged;
        /// <summary>A new incident (fall, critical vitals, geofence) from the edge server.</summary>
        public event Action<IncidentAlert> OnEmergencyAlert;
        /// <summary>An incident was acknowledged (incident ID, by whom, ISO time).</summary>
        public event Action<string, string, string> OnEmergencyAcknowledged;
        /// <summary>Every wristband position, of every ward (the Live Map can show another ward).</summary>
        public event Action<IpsPositionUpdate> OnAnyPositionUpdated;
        /// <summary>Answer to a 1 Hz request: (tag ID, started, text for the clinician, seconds).</summary>
        public event Action<string, bool, string, int> OnActiveModeResult;
        /// <summary>The clinician this headset is assigned to changed (null = nobody).</summary>
        public event Action<ClinicianRef> OnAssignmentChanged;

        /// <summary>The clinician an admin assigned this headset to; null = nobody (or not known yet).</summary>
        public ClinicianRef AssignedClinician { get; private set; }
        /// <summary>False until the server has said who this headset is assigned to.</summary>
        public bool AssignmentKnown { get; private set; }

        // Hospital Ward Directory
        private readonly List<WardSummary> _availableWards = new List<WardSummary>();
        public IReadOnlyList<WardSummary> AvailableWards => _availableWards;
        public WardConfig LastLoadedWardConfig { get; private set; }

        private ClientWebSocket _webSocket;
        private CancellationTokenSource _masterCts;
        private Task _receiveLoopTask;
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);
        private readonly ConcurrentQueue<Action> _mainThreadQueue = new ConcurrentQueue<Action>();
        private bool _isDisposed = false;
        private volatile int _cachedBatteryLevel = -1; // -1 = unknown, sent as null
        private float _batteryPollTimer = 0f;

        private void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Destroy(gameObject);
                return;
            }
            Instance = this;
            DontDestroyOnLoad(gameObject);

            Identity = HeadsetIdentity.Create();
            Debug.Log($"[SHIRO NET] This headset is {Identity.DeviceId} ({Identity.MacAddress}).");

            // Restore last active ward selected by clinician if available
            targetWardId = PlayerPrefs.GetString("Shiro_ActiveWardId", targetWardId);

            // Restore last configured server IP if available (persists between sessions)
            serverIp = PlayerPrefs.GetString("Shiro_ServerIp", serverIp);

            _headsetToken = PlayerPrefs.GetString(TokenPrefKey, "");
            PairingMessage = IsPaired ? "Paired with the edge server." : NotPairedMessage;
        }

        /// <summary>Adds this headset's token to a request to the edge server.</summary>
        public void Authorize(UnityWebRequest req)
        {
            if (req != null && IsPaired) req.SetRequestHeader("Authorization", $"Bearer {_headsetToken}");
        }

        /// <summary>
        /// The server no longer accepts the token (revoked on the dashboard, or a new
        /// database): forget it and stop connecting until the headset is paired again.
        /// Main thread only.
        /// </summary>
        private void ForgetPairing(string reason)
        {
            _headsetToken = "";
            PlayerPrefs.DeleteKey(TokenPrefKey);
            PlayerPrefs.Save();
            PairingMessage = reason;
            Debug.LogWarning($"[SHIRO NET] {reason}");
            Disconnect();
            OnPairingStatusChanged?.Invoke(false, reason);
        }

        /// <summary>Exchanges a 6-digit pairing code for this headset's token.</summary>
        public void Pair(string code)
        {
            StartCoroutine(PairRoutine(code));
        }

        /// <summary>Answer of POST /api/headset/pair (filled by JsonUtility).</summary>
        [Serializable]
        public class PairResponse
        {
            public bool success;
            public string token;
            public string device_id;
            public string paired_by;
            public string error;
        }

        private IEnumerator PairRoutine(string code)
        {
            code = (code ?? "").Trim();
            if (code.Length != 6)
            {
                PairingMessage = "The pairing code has 6 digits.";
                OnPairingStatusChanged?.Invoke(IsPaired, PairingMessage);
                yield break;
            }

            string url = $"http://{serverIp}:{serverPort}/api/headset/pair";
            string json = $"{{\"device_id\":\"{Identity.DeviceId}\",\"mac_address\":\"{Identity.MacAddress}\",\"code\":\"{code}\",\"model\":\"Meta Quest 3 (MR)\"}}";
            PairingMessage = $"Pairing with {serverIp}...";
            OnPairingStatusChanged?.Invoke(IsPaired, PairingMessage);

            using (UnityWebRequest req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(json));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 6;
                yield return req.SendWebRequest();

                PairResponse resp = null;
                try
                {
                    if (!string.IsNullOrEmpty(req.downloadHandler.text)) resp = JsonUtility.FromJson<PairResponse>(req.downloadHandler.text);
                }
                catch (Exception ex)
                {
                    Debug.LogWarning($"[SHIRO NET] Pairing answer not readable: {ex.Message}");
                }

                if (req.result == UnityWebRequest.Result.Success && resp != null && resp.success && !string.IsNullOrEmpty(resp.token))
                {
                    _headsetToken = resp.token;
                    PlayerPrefs.SetString(TokenPrefKey, _headsetToken);
                    PlayerPrefs.Save();
                    PairingMessage = $"Paired as {resp.device_id} (code created by {resp.paired_by}).";
                    Debug.Log($"[SHIRO NET] {PairingMessage}");
                    OnPairingStatusChanged?.Invoke(true, PairingMessage);
                    Disconnect();
                    Connect();
                }
                else
                {
                    PairingMessage = resp != null && !string.IsNullOrEmpty(resp.error)
                        ? $"Pairing refused: {resp.error}"
                        : $"Edge server at {serverIp} not reachable ({req.error}). Choose the right server address below.";
                    Debug.LogWarning($"[SHIRO NET] {PairingMessage}");
                    OnPairingStatusChanged?.Invoke(IsPaired, PairingMessage);
                }
            }
        }

        private void Start()
        {
            // Cache battery level on the Unity Main Thread safely (-1 when the platform does not report it)
            float lvl = SystemInfo.batteryLevel;
            _cachedBatteryLevel = lvl >= 0f ? Mathf.RoundToInt(lvl * 100f) : -1;

            if (autoConnectOnStart)
            {
                Connect();
            }
        }

        private void Update()
        {
            // Periodically refresh battery level on Unity Main Thread
            _batteryPollTimer += Time.deltaTime;
            if (_batteryPollTimer >= 5f)
            {
                _batteryPollTimer = 0f;
                float lvl = SystemInfo.batteryLevel;
                _cachedBatteryLevel = lvl >= 0f ? Mathf.RoundToInt(lvl * 100f) : -1;
            }

            // Dispatch queued WebSocket events on Unity's main thread
            while (_mainThreadQueue.TryDequeue(out var action))
            {
                action?.Invoke();
            }
        }

        private void OnDestroy()
        {
            _isDisposed = true;
            Disconnect();
        }

        public void Connect()
        {
            if (isWsConnected)
            {
                Debug.Log("[SHIRO NET] Already connected to Edge Server.");
                return;
            }

            Disconnect(); // Ensure previous background loops are terminated cleanly
            StartCoroutine(FetchHospitalWardsAndInitRoutine());
        }

        public void SetServerIp(string newIp)
        {
            if (string.IsNullOrEmpty(newIp)) return;
            serverIp = newIp.Trim();
            PlayerPrefs.SetString("Shiro_ServerIp", serverIp);
            PlayerPrefs.Save();
            if (ShiroMRManager.Instance != null) ShiroMRManager.Instance.serverIp = serverIp;
            Debug.Log($"[SHIRO NET] Server IP switched to: {serverIp}. Reconnecting...");
            Disconnect();
            Connect();
        }

        /// <summary>
        /// Records this headset's saved anchor of a ward ("" when removed) in the ward data
        /// already loaded, so ward detection and Re-Sync use it without reloading the list.
        /// </summary>
        public void RememberOwnAnchor(string wardId, string anchorUuid)
        {
            if (string.IsNullOrEmpty(wardId)) return;
            foreach (var w in _availableWards)
                if (string.Equals(w.ward_id, wardId, StringComparison.OrdinalIgnoreCase)) w.spatial_anchor_uuid = anchorUuid ?? "";
            if (LastLoadedWardConfig != null && string.Equals(LastLoadedWardConfig.ward_id, wardId, StringComparison.OrdinalIgnoreCase))
                LastLoadedWardConfig.spatial_anchor_uuid = anchorUuid ?? "";
            OnWardListLoaded?.Invoke(_availableWards);
        }

        public void SwitchWard(string newWardId)
        {
            if (string.IsNullOrEmpty(newWardId)) return;
            newWardId = newWardId.Trim().ToUpper();
            if (targetWardId == newWardId) return;

            targetWardId = newWardId;
            PlayerPrefs.SetString("Shiro_ActiveWardId", targetWardId);
            PlayerPrefs.Save();
            Debug.Log($"[SHIRO NET] Active Ward switched to: {targetWardId}");

            if (ShiroMRManager.Instance != null)
            {
                ShiroMRManager.Instance.targetWardId = targetWardId;
                ShiroMRManager.Instance.ClearAllHolograms();
            }

            OnActiveWardChanged?.Invoke(targetWardId);

            // Re-fetch geometry and patient bindings for the new ward
            StartCoroutine(FetchWardConfigRoutine(null));

            // Notify Edge Server that headset has entered this ward
            _ = SendSafeAsync(BuildHandshakeJson(), CancellationToken.None);
        }

        public void Disconnect()
        {
            try
            {
                _masterCts?.Cancel();
            }
            catch (Exception swallowed) { ShiroLog.Caught("ShiroNetworkManager.Disconnect", swallowed); }

            if (_webSocket != null)
            {
                try
                {
                    if (_webSocket.State == WebSocketState.Open)
                    {
                        _webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Client shutting down", CancellationToken.None);
                    }
                    _webSocket.Dispose();
                }
                catch (Exception ex)
                {
                    Debug.LogWarning($"[SHIRO NET] WebSocket cleanup: {ex.Message}");
                }
                _webSocket = null;
            }

            if (isWsConnected)
            {
                isWsConnected = false;
                OnConnectionStatusChanged?.Invoke(false);
            }
        }

        /// <summary>
        /// Auto-discovers the active Edge Server across Wi-Fi and Hotspot network interfaces,
        /// loads available hospital wards, then initializes the active ward geometry.
        /// </summary>
        private IEnumerator FetchHospitalWardsAndInitRoutine()
        {
            string[] candidateIps = new string[] { serverIp, "192.168.137.1", "192.168.1.229", "127.0.0.1" };
            var testedIps = new HashSet<string>();
            bool serverDiscovered = false;

            // 1. Find the edge server: /api/auth/status answers without sign-in
            foreach (var ip in candidateIps)
            {
                if (string.IsNullOrEmpty(ip) || testedIps.Contains(ip)) continue;
                testedIps.Add(ip);

                using (UnityWebRequest probe = UnityWebRequest.Get($"http://{ip}:{serverPort}/api/auth/status"))
                {
                    probe.timeout = 2; // Fast 2s probe per network interface
                    yield return probe.SendWebRequest();
                    if (probe.result != UnityWebRequest.Result.Success) continue;
                }

                if (serverIp != ip)
                {
                    Debug.Log($"[SHIRO NET] Auto-discovered active Edge Server at {ip} (was {serverIp}). Saving to PlayerPrefs...");
                    serverIp = ip;
                    PlayerPrefs.SetString("Shiro_ServerIp", serverIp);
                    PlayerPrefs.Save();
                    if (ShiroMRManager.Instance != null) ShiroMRManager.Instance.serverIp = serverIp;
                }
                serverDiscovered = true;
                break;
            }

            if (!serverDiscovered)
            {
                Debug.LogWarning($"[SHIRO NET] Could not auto-discover Edge Server on standard subnets. Attempting connection to configured IP: {serverIp}...");
            }

            // 2. Without a pairing the server accepts nothing else: wait for a code
            if (!IsPaired)
            {
                PairingMessage = NotPairedMessage;
                Debug.LogWarning($"[SHIRO NET] {NotPairedMessage}");
                OnPairingStatusChanged?.Invoke(false, PairingMessage);
                yield break;
            }

            // 3. The hospital ward list
            yield return StartCoroutine(FetchWardListRoutine());
            if (!IsPaired) yield break; // the server refused the token

            // Next, load active ward geometry and open WebSocket
            yield return StartCoroutine(FetchWardConfigRoutine(() =>
            {
                StartWebSocketConnection();
            }));
        }

        /// <summary>The hospital's ward list (for the Ward tab buttons).</summary>
        private IEnumerator FetchWardListRoutine()
        {
            using (UnityWebRequest listReq = UnityWebRequest.Get($"http://{serverIp}:{serverPort}/api/ward/list"))
            {
                Authorize(listReq);
                listReq.timeout = 4;
                yield return listReq.SendWebRequest();

                if (listReq.responseCode == 401)
                {
                    ForgetPairing("The edge server no longer accepts this headset (pairing revoked or a new database). Pair it again.");
                    yield break;
                }
                if (listReq.result == UnityWebRequest.Result.Success)
                {
                    try
                    {
                        WardListResponse listResp = JsonUtility.FromJson<WardListResponse>(listReq.downloadHandler.text);
                        if (listResp != null && listResp.success && listResp.wards != null)
                        {
                            _availableWards.Clear();
                            _availableWards.AddRange(listResp.wards);
                            Debug.Log($"[SHIRO NET] Hospital Directory: Discovered {_availableWards.Count} wards on Edge Server at {serverIp}.");
                            OnWardListLoaded?.Invoke(_availableWards);
                        }
                    }
                    catch (Exception ex)
                    {
                        Debug.LogWarning($"[SHIRO NET] Ward directory parse warning on {serverIp}: {ex.Message}");
                    }
                }
                else
                {
                    Debug.LogWarning($"[SHIRO NET] Ward list not loaded ({listReq.error}). It is loaded again when the live connection comes up.");
                }
            }
        }

        /// <summary>
        /// Incidents still waiting for a response (GET /api/alerts/active), for alerts
        /// raised while this headset was not connected. onDone(alerts, error): alerts is
        /// null when the request failed.
        /// </summary>
        public IEnumerator FetchActiveAlertsRoutine(Action<List<IncidentAlert>, string> onDone)
        {
            if (!IsPaired) { onDone?.Invoke(null, "not paired"); yield break; }
            using (UnityWebRequest req = UnityWebRequest.Get($"http://{serverIp}:{serverPort}/api/alerts/active"))
            {
                Authorize(req);
                req.timeout = 5;
                yield return req.SendWebRequest();
                if (req.responseCode == 401)
                {
                    ForgetPairing("The edge server no longer accepts this headset (pairing revoked or a new database). Pair it again.");
                    onDone?.Invoke(null, "not paired");
                    yield break;
                }
                if (req.result != UnityWebRequest.Result.Success)
                {
                    onDone?.Invoke(null, req.error);
                    yield break;
                }
                ActiveAlertsResponse resp = null;
                try { resp = JsonUtility.FromJson<ActiveAlertsResponse>(req.downloadHandler.text); }
                catch (Exception ex) { onDone?.Invoke(null, $"unreadable answer ({ex.Message})"); yield break; }
                if (resp == null || !resp.success) onDone?.Invoke(null, resp?.error ?? "unreadable answer");
                else onDone?.Invoke(resp.alerts ?? new List<IncidentAlert>(), null);
            }
        }

        /// <summary>
        /// Acknowledges an incident as this headset (POST /api/alerts/acknowledge).
        /// The server records "QUEST3-… (paired by …)". onDone(HTTP status, answer):
        /// 200 acknowledged, 409 someone else was first (answer.error names them),
        /// 404 unknown incident, 0 no answer.
        /// </summary>
        public IEnumerator AcknowledgeIncidentRoutine(string incidentId, Action<long, AcknowledgeResponse> onDone)
        {
            // Incident IDs are letters, digits, '-' and '_' (server rule); anything else is dropped
            string safeId = System.Text.RegularExpressions.Regex.Replace(incidentId ?? "", "[^A-Za-z0-9_-]", "");
            string body = "{\"incident_id\":\"" + safeId + "\",\"notes\":\"Acknowledged on the Meta Quest 3 headset.\"}";
            using (UnityWebRequest req = new UnityWebRequest($"http://{serverIp}:{serverPort}/api/alerts/acknowledge", "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                Authorize(req);
                req.timeout = 6;
                yield return req.SendWebRequest();

                if (req.responseCode == 401)
                {
                    ForgetPairing("The edge server no longer accepts this headset (pairing revoked or a new database). Pair it again.");
                }
                AcknowledgeResponse resp = null;
                try
                {
                    if (!string.IsNullOrEmpty(req.downloadHandler?.text))
                        resp = JsonUtility.FromJson<AcknowledgeResponse>(req.downloadHandler.text);
                }
                catch (Exception swallowed) { ShiroLog.Caught("ShiroNetworkManager.AcknowledgeIncidentRoutine", swallowed); }
                if (resp == null) resp = new AcknowledgeResponse { success = false, error = req.error ?? "no answer from the edge server" };
                onDone?.Invoke(req.responseCode, resp);
            }
        }

        // ----- Assignment: the clinician using this headset -----

        private void SetAssignment(ClinicianRef who)
        {
            AssignedClinician = who != null && who.IsSet ? who : null;
            AssignmentKnown = true;
            OnAssignmentChanged?.Invoke(AssignedClinician);
        }

        private IEnumerator FetchAssignmentRoutine()
        {
            if (!IsPaired) yield break;
            using (UnityWebRequest req = UnityWebRequest.Get($"http://{serverIp}:{serverPort}/api/auth/me"))
            {
                Authorize(req);
                req.timeout = 5;
                yield return req.SendWebRequest();
                if (req.result != UnityWebRequest.Result.Success) yield break; // stays "not known"
                try
                {
                    var me = JsonUtility.FromJson<AuthMeResponse>(req.downloadHandler.text);
                    if (me != null && me.success && me.user != null) SetAssignment(me.user.assigned_clinician);
                }
                catch (Exception ex) { Debug.LogWarning($"[SHIRO NET] Could not read the headset assignment: {ex.Message}"); }
            }
        }

        // ----- 1 Hz vitals on demand (FR: tap a patient on the Live Map) -----

        private volatile string _lastActiveModeTag;

        /// <summary>
        /// Asks the edge server to put a wristband into 1 Hz mode through its strongest
        /// anchor (SET_ACTIVE_MODE, 60 s). The answer arrives as OnActiveModeResult.
        /// </summary>
        public bool RequestActiveMode(string tagId, string macAddress)
        {
            if (string.IsNullOrEmpty(tagId) || !isWsConnected) return false;
            string safeTag = System.Text.RegularExpressions.Regex.Replace(tagId, "[^A-Za-z0-9_:-]", "");
            string safeMac = System.Text.RegularExpressions.Regex.Replace(macAddress ?? "", "[^A-Fa-f0-9:]", "");
            _lastActiveModeTag = safeTag;
            string json = "{\"action\":\"SET_ACTIVE_MODE\",\"tag_id\":\"" + safeTag + "\"" +
                          (safeMac.Length == 17 ? ",\"target_mac\":\"" + safeMac + "\"" : "") +
                          ",\"duration\":60}";
            _ = SendSafeAsync(json, CancellationToken.None);
            return true;
        }

        /// <summary>
        /// Tells the edge server where this headset sees the patient of a wristband (a person
        /// its depth sensor sees, linked to the wristband), in ward coordinates: the maps then
        /// show the patient there instead of at the Bluetooth position. seen: false when it no
        /// longer does (the link ended). Sent a few times a second while linked.
        /// </summary>
        public bool SendPatientSeen(string tagId, bool seen, float wardX, float wardY, float heightM, bool manual)
        {
            if (string.IsNullOrEmpty(tagId) || !isWsConnected || !HasWard) return false;
            string safeTag = System.Text.RegularExpressions.Regex.Replace(tagId, "[^A-Za-z0-9_:-]", "");
            string safeWard = System.Text.RegularExpressions.Regex.Replace(targetWardId, "[^A-Za-z0-9_-]", "");
            var inv = System.Globalization.CultureInfo.InvariantCulture;
            string json = "{\"action\":\"PATIENT_SEEN\",\"tag_id\":\"" + safeTag + "\",\"ward_id\":\"" + safeWard + "\"" +
                          (seen
                              ? ",\"seen\":true,\"x\":" + wardX.ToString("0.000", inv) + ",\"y\":" + wardY.ToString("0.000", inv) +
                                (heightM >= 0.5f && heightM <= 2.5f ? ",\"height_m\":" + heightM.ToString("0.00", inv) : "") +
                                ",\"manual\":" + (manual ? "true" : "false")
                              : ",\"seen\":false") +
                          "}";
            _ = SendSafeAsync(json, CancellationToken.None);
            return true;
        }

        // ----- Another ward, only for viewing on the Live Map -----

        /// <summary>
        /// Loads a ward's layout and patients for the Live Map without making it the
        /// active ward (no holograms, no alignment change). onDone(response, error).
        /// </summary>
        public IEnumerator FetchWardForViewRoutine(string wardId, Action<WardInitResponse, string> onDone)
        {
            if (string.IsNullOrEmpty(wardId) || !IsPaired) { onDone?.Invoke(null, "no ward or not paired"); yield break; }
            using (UnityWebRequest req = UnityWebRequest.Get($"http://{serverIp}:{serverPort}/api/ward/ips-init?ward_id={UnityWebRequest.EscapeURL(wardId)}"))
            {
                Authorize(req);
                req.timeout = 5;
                yield return req.SendWebRequest();
                if (req.result != UnityWebRequest.Result.Success) { onDone?.Invoke(null, req.error); yield break; }
                WardInitResponse resp = null;
                try { resp = JsonUtility.FromJson<WardInitResponse>(req.downloadHandler.text); }
                catch (Exception ex) { onDone?.Invoke(null, ex.Message); yield break; }
                if (resp == null || !resp.success || resp.ward == null) onDone?.Invoke(null, resp?.error ?? "unreadable answer");
                else onDone?.Invoke(resp, null);
            }
        }

        /// <summary>The patients of the active ward, from the last ward load.</summary>
        public List<TrackedSubject> LastLoadedSubjects { get; private set; } = new List<TrackedSubject>();

        /// <summary>True when the chosen ward's layout (and its spatial anchor ID) has been loaded.</summary>
        public bool IsWardLoaded =>
            HasWard && LastLoadedWardConfig != null &&
            string.Equals(LastLoadedWardConfig.ward_id, targetWardId, StringComparison.OrdinalIgnoreCase);

        private bool _reloadInProgress;

        /// <summary>
        /// Loads what is still missing: the ward list and the chosen ward's layout.
        /// Called when the live connection comes up, so a headset started before the
        /// edge server gets its ward (and restores its spatial anchor) once the server
        /// answers; also from Re-Sync. Does nothing when everything is loaded.
        /// </summary>
        public void ReloadMissingWardData()
        {
            if (_reloadInProgress || !IsPaired) return;
            if (_availableWards.Count > 0 && (!HasWard || IsWardLoaded)) return;
            StartCoroutine(ReloadMissingWardDataRoutine());
        }

        private IEnumerator ReloadMissingWardDataRoutine()
        {
            _reloadInProgress = true;
            try
            {
                if (_availableWards.Count == 0) yield return StartCoroutine(FetchWardListRoutine());
                if (IsPaired && HasWard && !IsWardLoaded)
                {
                    Debug.Log($"[SHIRO NET] Loading ward {targetWardId}, which was not loaded before (edge server was not reachable).");
                    yield return StartCoroutine(FetchWardConfigRoutine(null));
                }
            }
            finally
            {
                _reloadInProgress = false;
            }
        }

        /// <summary>
        /// Fetch Initial Ward Geometry & Patient Bindings via REST API
        /// </summary>
        public IEnumerator FetchWardConfigRoutine(Action onComplete = null)
        {
            if (!HasWard)
            {
                // Nothing is assumed: the clinician chooses the ward on the hand slate.
                // The live connection still starts, so the ward list and alerts work.
                Debug.LogWarning("[SHIRO NET] No ward configured. Choose one on the hand slate (Ward tab).");
                onComplete?.Invoke();
                yield break;
            }

            string url = $"http://{serverIp}:{serverPort}/api/ward/ips-init?ward_id={UnityWebRequest.EscapeURL(targetWardId)}";
            Debug.Log($"[SHIRO NET] Fetching Ward Architecture from {url}...");

            using (UnityWebRequest req = UnityWebRequest.Get(url))
            {
                Authorize(req);
                req.timeout = 5;
                yield return req.SendWebRequest();

                if (req.responseCode == 401)
                {
                    ForgetPairing("The edge server no longer accepts this headset (pairing revoked or a new database). Pair it again.");
                    yield break;
                }

                if (req.result == UnityWebRequest.Result.Success)
                {
                    try
                    {
                        string json = req.downloadHandler.text;
                        WardInitResponse response = JsonUtility.FromJson<WardInitResponse>(json);
                        if (response != null && response.success && response.ward != null)
                        {
                            Debug.Log($"[SHIRO NET] Ward {response.ward.ward_id} loaded successfully. Found {response.ward.beds?.Count ?? 0} beds, {response.tracked_subjects?.Count ?? 0} tracked subjects.");
                            LastLoadedWardConfig = response.ward;
                            LastLoadedSubjects = response.tracked_subjects ?? new List<TrackedSubject>();
                            OnWardInitialized?.Invoke(response.ward, response.tracked_subjects ?? new List<TrackedSubject>());
                            onComplete?.Invoke();
                        }
                        else
                        {
                            Debug.LogError($"[SHIRO NET] Ward {targetWardId} could not be loaded: {response?.error ?? "Unknown error"}");
                            onComplete?.Invoke(); // the live connection is still needed
                        }
                    }
                    catch (Exception ex)
                    {
                        Debug.LogError($"[SHIRO NET] JSON parsing error on ward init: {ex.Message}");
                        onComplete?.Invoke();
                    }
                }
                else
                {
                    Debug.LogWarning($"[SHIRO NET] Could not connect to Edge Server via REST ({req.error}). Starting WebSocket anyway...");
                    onComplete?.Invoke();
                }
            }
        }

        /// <summary>
        /// Start High-Speed Real-Time WebSocket Streaming Client (Single Thread-Safe Background Task)
        /// </summary>
        private void StartWebSocketConnection()
        {
            if (!IsPaired) return; // the server refuses a headset without its token
            string token = _headsetToken;
            if (_receiveLoopTask != null && !_receiveLoopTask.IsCompleted)
            {
                try { _masterCts?.Cancel(); } catch (Exception swallowed) { ShiroLog.Caught("ShiroNetworkManager.StartWebSocketConnection", swallowed); }
            }

            _masterCts = new CancellationTokenSource();
            _receiveLoopTask = Task.Run(() => WebSocketReceiveLoopAsync(token, _masterCts.Token));
        }

        // Close code the server uses when it ends a headset's access (pairing revoked)
        private const int AccessEndedCloseCode = 4001;

        private async Task WebSocketReceiveLoopAsync(string token, CancellationToken ct)
        {
            string wsUri = $"ws://{serverIp}:{serverPort}";
            byte[] buffer = new byte[8192];

            while (!ct.IsCancellationRequested && !_isDisposed)
            {
                CancellationTokenSource sessionCts = null;
                try
                {
                    sessionCts = CancellationTokenSource.CreateLinkedTokenSource(ct);

                    if (_webSocket != null)
                    {
                        try { _webSocket.Dispose(); } catch (Exception swallowed) { ShiroLog.Caught("ShiroNetworkManager.WebSocketReceiveLoopAsync", swallowed); }
                        _webSocket = null;
                    }

                    _webSocket = new ClientWebSocket();
                    _webSocket.Options.SetRequestHeader("Authorization", $"Bearer {token}");
                    Debug.Log($"[SHIRO NET] Connecting WebSocket to {wsUri}...");
                    try
                    {
                        await _webSocket.ConnectAsync(new Uri(wsUri), sessionCts.Token);
                    }
                    catch (WebSocketException wex) when (wex.Message.Contains("401"))
                    {
                        // Refused: the pairing is no longer valid
                        _mainThreadQueue.Enqueue(() => ForgetPairing("The edge server no longer accepts this headset (pairing revoked or a new database). Pair it again."));
                        break;
                    }

                    _mainThreadQueue.Enqueue(() =>
                    {
                        isWsConnected = true;
                        Debug.Log($"[SHIRO NET] WebSocket Connected to SHIRO Edge Server!");
                        OnConnectionStatusChanged?.Invoke(true);
                        // Started before the server? Load the ward list and ward now.
                        ReloadMissingWardData();
                        // Who wears this headset (assigned on the dashboard)
                        StartCoroutine(FetchAssignmentRoutine());
                    });

                    // Send Headset Identification Handshake to Edge Server
                    await SendDeviceHandshakeAsync(sessionCts.Token);

                    // Launch background heartbeat task linked strictly to this connection's lifetime
                    _ = SendHeartbeatLoopAsync(sessionCts.Token);

                    using (var ms = new MemoryStream())
                    {
                        while (_webSocket.State == WebSocketState.Open && !sessionCts.IsCancellationRequested)
                        {
                            ms.SetLength(0);
                            WebSocketReceiveResult result;
                            do
                            {
                                result = await _webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), sessionCts.Token);
                                if (result.MessageType == WebSocketMessageType.Close) break;
                                ms.Write(buffer, 0, result.Count);
                            } while (!result.EndOfMessage);

                            if (result.MessageType == WebSocketMessageType.Close)
                            {
                                bool accessEnded = result.CloseStatus.HasValue && (int)result.CloseStatus.Value == AccessEndedCloseCode;
                                await _webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", sessionCts.Token);
                                if (accessEnded)
                                {
                                    _mainThreadQueue.Enqueue(() => ForgetPairing("This headset's pairing was revoked on the dashboard. Pair it again."));
                                    return;
                                }
                                break;
                            }

                            if (result.MessageType == WebSocketMessageType.Text && ms.Length > 0)
                            {
                                string jsonMessage = Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
                                ProcessIncomingJson(jsonMessage);
                            }
                        }
                    }
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    if (!ct.IsCancellationRequested && !_isDisposed)
                    {
                        Debug.LogWarning($"[SHIRO NET] WebSocket disconnected ({ex.Message}). Retrying in 3.0s...");
                    }
                }
                finally
                {
                    if (sessionCts != null)
                    {
                        try { sessionCts.Cancel(); sessionCts.Dispose(); } catch (Exception swallowed) { ShiroLog.Caught("ShiroNetworkManager.WebSocketReceiveLoopAsync", swallowed); }
                    }

                    if (_webSocket != null)
                    {
                        try { _webSocket.Dispose(); } catch (Exception swallowed) { ShiroLog.Caught("ShiroNetworkManager.WebSocketReceiveLoopAsync", swallowed); }
                        _webSocket = null;
                    }

                    _mainThreadQueue.Enqueue(() =>
                    {
                        if (isWsConnected)
                        {
                            isWsConnected = false;
                            OnConnectionStatusChanged?.Invoke(false);
                        }
                    });
                }

                if (!ct.IsCancellationRequested && !_isDisposed)
                {
                    try
                    {
                        await Task.Delay(3000, ct); // Backoff before reconnect
                    }
                    catch (OperationCanceledException)
                    {
                        break;
                    }
                }
            }
        }

        /// <summary>
        /// Parse and Route WebSocket Messages to Unity Event Listeners
        /// </summary>
        private void ProcessIncomingJson(string json)
        {
            try
            {
                WsMessageBase baseMsg = JsonUtility.FromJson<WsMessageBase>(json);
                if (baseMsg == null || string.IsNullOrEmpty(baseMsg.type)) return;

                switch (baseMsg.type)
                {
                    case "IPS_POSITION_UPDATE":
                        var posMsg = JsonUtility.FromJson<IpsPositionUpdate>(json);
                        if (posMsg != null)
                        {
                            _mainThreadQueue.Enqueue(() => OnAnyPositionUpdated?.Invoke(posMsg));
                            // Route if for current active ward, or if ward unassigned
                            if (string.IsNullOrEmpty(posMsg.ward_id) || posMsg.ward_id.Equals(targetWardId, StringComparison.OrdinalIgnoreCase))
                            {
                                _mainThreadQueue.Enqueue(() => OnPositionUpdated?.Invoke(posMsg));
                            }
                        }
                        break;

                    case "TELEMETRY":
                        var telMsg = JsonUtility.FromJson<TelemetryUpdate>(json);
                        if (telMsg != null && !string.IsNullOrEmpty(telMsg.EffectiveTagId))
                        {
                            _mainThreadQueue.Enqueue(() => OnTelemetryUpdated?.Invoke(telMsg));
                        }
                        break;

                    case "IPS_TAG_PURGE":
                        var purgeMsg = JsonUtility.FromJson<TagPurgeUpdate>(json);
                        string tagToPurge = purgeMsg?.tag_id ?? purgeMsg?.canonical_id ?? purgeMsg?.mac;
                        if (!string.IsNullOrEmpty(tagToPurge))
                        {
                            _mainThreadQueue.Enqueue(() => OnTagPurged?.Invoke(tagToPurge));
                        }
                        break;

                    case "EMERGENCY_ALERT":
                        var alertMsg = JsonUtility.FromJson<EmergencyAlertMessage>(json);
                        if (alertMsg?.incident != null && !string.IsNullOrEmpty(alertMsg.incident.incident_id))
                        {
                            _mainThreadQueue.Enqueue(() => OnEmergencyAlert?.Invoke(alertMsg.incident));
                        }
                        break;

                    case "EMERGENCY_ACKNOWLEDGED":
                        var ackMsg = JsonUtility.FromJson<EmergencyAcknowledgedMessage>(json);
                        if (ackMsg != null && !string.IsNullOrEmpty(ackMsg.incident_id))
                        {
                            _mainThreadQueue.Enqueue(() => OnEmergencyAcknowledged?.Invoke(ackMsg.incident_id, ackMsg.attending_clinician, ackMsg.timestamp));
                        }
                        break;

                    case "ACTIVE_MODE_ENGAGED":
                        var engaged = JsonUtility.FromJson<ActiveModeEngagedMessage>(json);
                        if (engaged != null && !string.IsNullOrEmpty(engaged.tag_id))
                        {
                            string via = !string.IsNullOrEmpty(engaged.via_anchor) ? engaged.via_anchor : engaged.anchor_mac;
                            _mainThreadQueue.Enqueue(() => OnActiveModeResult?.Invoke(engaged.tag_id, true,
                                $"1 Hz vitals requested through anchor {via} for {engaged.duration} s.", engaged.duration));
                        }
                        break;

                    case "ERROR":
                        var cmdErr = JsonUtility.FromJson<CommandErrorMessage>(json);
                        if (cmdErr != null && cmdErr.action == "SET_ACTIVE_MODE")
                        {
                            string tag = _lastActiveModeTag;
                            _mainThreadQueue.Enqueue(() => OnActiveModeResult?.Invoke(tag, false, cmdErr.error ?? "refused by the edge server", 0));
                        }
                        break;

                    case "HEADSET_ASSIGNMENT":
                        var assign = JsonUtility.FromJson<HeadsetAssignmentMessage>(json);
                        if (assign != null)
                        {
                            _mainThreadQueue.Enqueue(() => SetAssignment(assign.assigned_clinician));
                        }
                        break;

                    case "WARD_CONFIG_UPDATED":
                        _mainThreadQueue.Enqueue(() =>
                        {
                            Debug.Log("[SHIRO NET] Ward configuration was updated on the server. Refreshing layout...");
                            StartCoroutine(FetchHospitalWardsAndInitRoutine());
                        });
                        break;
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[SHIRO NET] Error processing WebSocket packet: {ex.Message}");
            }
        }

        // Battery as JSON: a number, or null when the platform does not report it
        private string BatteryJson()
        {
            int bat = _cachedBatteryLevel;
            return bat >= 0 ? bat.ToString() : "null";
        }

        private string BuildHandshakeJson()
        {
            string ward = HasWard ? $"\"{targetWardId}\"" : "null";
            return $"{{\"action\":\"DEVICE_HANDSHAKE\",\"device_id\":\"{Identity.DeviceId}\",\"mac_address\":\"{Identity.MacAddress}\",\"device_type\":\"HEADSET\",\"model\":\"Meta Quest 3 (MR)\",\"assigned_ward_id\":{ward},\"battery_level\":{BatteryJson()}}}";
        }

        private async Task SendDeviceHandshakeAsync(CancellationToken ct)
        {
            await SendSafeAsync(BuildHandshakeJson(), ct);
            Debug.Log($"[SHIRO NET] Headset Handshake sent to Edge Server ({Identity.DeviceId} in {(HasWard ? targetWardId : "no ward")}).");
        }

        private async Task SendHeartbeatLoopAsync(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    await Task.Delay(3000, ct);
                    if (ct.IsCancellationRequested) break;

                    string json = $"{{\"action\":\"DEVICE_HEARTBEAT\",\"device_id\":\"{Identity.DeviceId}\",\"mac_address\":\"{Identity.MacAddress}\",\"device_type\":\"HEADSET\",\"battery_level\":{BatteryJson()}}}";
                    await SendSafeAsync(json, ct);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception swallowed) { ShiroLog.Caught("ShiroNetworkManager.SendHeartbeatLoopAsync", swallowed); }
            }
        }

        /// <summary>
        /// Thread-Safe Serialized WebSocket Send. Guarantees no two SendAsync operations can ever collide.
        /// </summary>
        private async Task SendSafeAsync(string json, CancellationToken ct)
        {
            if (string.IsNullOrEmpty(json) || _webSocket == null || _webSocket.State != WebSocketState.Open) return;
            try
            {
                await _sendLock.WaitAsync(ct);
                try
                {
                    if (_webSocket != null && _webSocket.State == WebSocketState.Open)
                    {
                        byte[] bytes = Encoding.UTF8.GetBytes(json);
                        await _webSocket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, ct);
                    }
                }
                finally
                {
                    _sendLock.Release();
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                Debug.LogWarning($"[SHIRO NET] WebSocket Send Error: {ex.Message}");
            }
        }
    }
}
