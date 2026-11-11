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
        public string targetWardId = "WARD-005";
        public bool autoConnectOnStart = true;

        [Header("Connection Status")]
        [SerializeField] private bool isWsConnected = false;
        public bool IsConnected => isWsConnected;

        // Events for other MR components
        public event Action<WardConfig, List<TrackedSubject>> OnWardInitialized;
        public event Action<IpsPositionUpdate> OnPositionUpdated;
        public event Action<TelemetryUpdate> OnTelemetryUpdated;
        public event Action<string> OnTagPurged;
        public event Action<bool> OnConnectionStatusChanged;
        public event Action<List<WardSummary>> OnWardListLoaded;
        public event Action<string> OnActiveWardChanged;

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
        private volatile int _cachedBatteryLevel = 95;
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

            // Restore last active ward selected by clinician if available
            targetWardId = PlayerPrefs.GetString("Shiro_ActiveWardId", targetWardId);

            // Restore last configured server IP if available (persists between sessions)
            serverIp = PlayerPrefs.GetString("Shiro_ServerIp", serverIp);
        }

        private void Start()
        {
            // Cache battery level on the Unity Main Thread safely
            float lvl = SystemInfo.batteryLevel;
            _cachedBatteryLevel = Mathf.RoundToInt(lvl >= 0f ? lvl * 100f : 95f);

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
                _cachedBatteryLevel = Mathf.RoundToInt(lvl >= 0f ? lvl * 100f : 95f);
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
            catch { }

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

            foreach (var ip in candidateIps)
            {
                if (string.IsNullOrEmpty(ip) || testedIps.Contains(ip)) continue;
                testedIps.Add(ip);

                string listUrl = $"http://{ip}:{serverPort}/api/ward/list";
                using (UnityWebRequest listReq = UnityWebRequest.Get(listUrl))
                {
                    listReq.timeout = 2; // Fast 2s probe per network interface
                    yield return listReq.SendWebRequest();

                    if (listReq.result == UnityWebRequest.Result.Success)
                    {
                        try
                        {
                            string json = listReq.downloadHandler.text;
                            WardListResponse listResp = JsonUtility.FromJson<WardListResponse>(json);
                            if (listResp != null && listResp.success && listResp.wards != null)
                            {
                                if (serverIp != ip)
                                {
                                    Debug.Log($"[SHIRO NET] Auto-discovered active Edge Server at {ip} (was {serverIp}). Saving to PlayerPrefs...");
                                    serverIp = ip;
                                    PlayerPrefs.SetString("Shiro_ServerIp", serverIp);
                                    PlayerPrefs.Save();
                                    if (ShiroMRManager.Instance != null) ShiroMRManager.Instance.serverIp = serverIp;
                                }

                                _availableWards.Clear();
                                _availableWards.AddRange(listResp.wards);
                                Debug.Log($"[SHIRO NET] Hospital Directory: Discovered {_availableWards.Count} wards on Edge Server at {serverIp}.");
                                OnWardListLoaded?.Invoke(_availableWards);
                                serverDiscovered = true;
                                break;
                            }
                        }
                        catch (Exception ex)
                        {
                            Debug.LogWarning($"[SHIRO NET] Ward directory parse warning on {ip}: {ex.Message}");
                        }
                    }
                }
            }

            if (!serverDiscovered)
            {
                Debug.LogWarning($"[SHIRO NET] Could not auto-discover Edge Server on standard subnets. Attempting connection to configured IP: {serverIp}...");
            }

            // Next, load active ward geometry and open WebSocket
            yield return StartCoroutine(FetchWardConfigRoutine(() =>
            {
                StartWebSocketConnection();
            }));
        }

        /// <summary>
        /// Fetch Initial Ward Geometry & Patient Bindings via REST API
        /// </summary>
        public IEnumerator FetchWardConfigRoutine(Action onComplete = null)
        {
            string url = $"http://{serverIp}:{serverPort}/api/ward/ips-init?ward_id={UnityWebRequest.EscapeURL(targetWardId)}";
            Debug.Log($"[SHIRO NET] Fetching Ward Architecture from {url}...");

            using (UnityWebRequest req = UnityWebRequest.Get(url))
            {
                req.timeout = 5;
                yield return req.SendWebRequest();

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
                            OnWardInitialized?.Invoke(response.ward, response.tracked_subjects ?? new List<TrackedSubject>());
                            onComplete?.Invoke();
                        }
                        else
                        {
                            Debug.LogError($"[SHIRO NET] Failed to parse ward configuration: {response?.error ?? "Unknown error"}");
                        }
                    }
                    catch (Exception ex)
                    {
                        Debug.LogError($"[SHIRO NET] JSON parsing error on ward init: {ex.Message}");
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
            if (_receiveLoopTask != null && !_receiveLoopTask.IsCompleted)
            {
                try { _masterCts?.Cancel(); } catch { }
            }

            _masterCts = new CancellationTokenSource();
            _receiveLoopTask = Task.Run(() => WebSocketReceiveLoopAsync(_masterCts.Token));
        }

        private async Task WebSocketReceiveLoopAsync(CancellationToken ct)
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
                        try { _webSocket.Dispose(); } catch { }
                        _webSocket = null;
                    }

                    _webSocket = new ClientWebSocket();
                    Debug.Log($"[SHIRO NET] Connecting WebSocket to {wsUri}...");
                    await _webSocket.ConnectAsync(new Uri(wsUri), sessionCts.Token);

                    _mainThreadQueue.Enqueue(() =>
                    {
                        isWsConnected = true;
                        Debug.Log($"[SHIRO NET] WebSocket Connected to SHIRO Edge Server!");
                        OnConnectionStatusChanged?.Invoke(true);
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
                                await _webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", sessionCts.Token);
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
                        try { sessionCts.Cancel(); sessionCts.Dispose(); } catch { }
                    }

                    if (_webSocket != null)
                    {
                        try { _webSocket.Dispose(); } catch { }
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

        private string BuildHandshakeJson()
        {
            int bat = _cachedBatteryLevel;
            string mac = "02:00:00:51:55:01";
            return $"{{\"action\":\"DEVICE_HANDSHAKE\",\"device_id\":\"QUEST3-001\",\"mac_address\":\"{mac}\",\"device_type\":\"HEADSET\",\"model\":\"Meta Quest 3 (MR)\",\"assigned_ward_id\":\"{targetWardId}\",\"battery_level\":{bat}}}";
        }

        private async Task SendDeviceHandshakeAsync(CancellationToken ct)
        {
            await SendSafeAsync(BuildHandshakeJson(), ct);
            Debug.Log($"[SHIRO NET] Headset Handshake sent to Edge Server (QUEST3-001 in {targetWardId}).");
        }

        private async Task SendHeartbeatLoopAsync(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    await Task.Delay(3000, ct);
                    if (ct.IsCancellationRequested) break;

                    int bat = _cachedBatteryLevel;
                    string mac = "02:00:00:51:55:01";
                    string json = $"{{\"action\":\"DEVICE_HEARTBEAT\",\"device_id\":\"QUEST3-001\",\"mac_address\":\"{mac}\",\"device_type\":\"HEADSET\",\"battery_level\":{bat}}}";
                    await SendSafeAsync(json, ct);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch { }
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
