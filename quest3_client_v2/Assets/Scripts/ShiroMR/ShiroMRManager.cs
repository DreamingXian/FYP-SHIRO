// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Master Orchestrator: Coordinates Network, Spatial Alignment, & Patient HUDs
// =============================================================================
using System;
using System.Collections.Generic;
using UnityEngine;

namespace ShiroMR
{
    public class ShiroMRManager : MonoBehaviour
    {
        public static ShiroMRManager Instance { get; private set; }

        [Header("Subsystem References (Auto-Created if Empty)")]
        public ShiroNetworkManager networkManager;
        public WardSpatialManager spatialManager;
        public WardVisualizer wardVisualizer;
        public WardAlignmentTool alignmentTool;
        public ShiroVRPointer vrPointer;
        public ShiroHandSlate handSlate;
        public ShiroHandVisualizer handVisualizer;

        [Header("Edge Server Configuration")]
        [Tooltip("IP address of the Edge Server (use 127.0.0.1 for PC Link testing, or 192.168.1.229 for wireless headset)")]
        public string serverIp = "192.168.1.229";
        public int serverPort = 3000;
        [Tooltip("Ward ID to monitor. Empty = not configured: the clinician chooses it on the hand slate (remembered between sessions).")]
        public string targetWardId = "";

        [Header("Patient Hologram Settings")]
        [Tooltip("Optional custom prefab for Patient Hologram. If null, automatically generated programmatically.")]
        public GameObject patientHologramPrefab;

        private readonly Dictionary<string, PatientHologram> _activeHolograms = new Dictionary<string, PatientHologram>();
        private readonly Dictionary<string, TrackedSubject> _patientRegistry = new Dictionary<string, TrackedSubject>();
        private WardConfig _cachedWardConfig = null;

        public WardConfig CachedWardConfig => _cachedWardConfig;
        public IReadOnlyDictionary<string, PatientHologram> ActiveHolograms => _activeHolograms;

        public PatientHologram GetHologram(string tagId)
        {
            if (string.IsNullOrEmpty(tagId)) return null;
            _activeHolograms.TryGetValue(tagId.ToUpper().Trim(), out var holo);
            return holo;
        }

        public void ClearAllHolograms()
        {
            foreach (var kvp in _activeHolograms)
            {
                if (kvp.Value != null)
                {
                    Destroy(kvp.Value.gameObject);
                }
            }
            _activeHolograms.Clear();
            _patientRegistry.Clear();
            Debug.Log("[SHIRO MR] Cleared all patient holograms for ward switch.");
        }

        private void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Destroy(gameObject);
                return;
            }
            Instance = this;

            // Hide the boundary so the clinician can walk the whole clinic, not only the boundary
            // area (Meta's Boundary API, "contextual boundaryless"). The headset allows it only
            // while passthrough is shown (always, in this app) and only when the app has the
            // boundary visibility permission: Quest Features → Boundary Visibility Support, set
            // by SHIRO → Apply APK build settings. Over Quest Link the app's Android manifest,
            // and with it the permission, does not apply.
            try
            {
                if (OVRManager.instance != null)
                {
                    OVRManager.instance.shouldBoundaryVisibilityBeSuppressed = true;
                }
                OVRManager.BoundaryVisibilityChanged += LogBoundaryVisibility;
            }
            catch (Exception swallowed) { ShiroLog.Caught("ShiroMRManager.Awake", swallowed); }

            EnsureSubsystems();
        }

        private void Start()
        {
            if (networkManager != null)
            {
                networkManager.OnWardInitialized += HandleWardInitialized;
                networkManager.OnPositionUpdated += HandlePositionUpdated;
                networkManager.OnTelemetryUpdated += HandleTelemetryUpdated;
                networkManager.OnTagPurged += HandleTagPurged;
                networkManager.OnActiveWardChanged += HandleActiveWardChanged;
            }
        }

        private void HandleActiveWardChanged(string newWardId)
        {
            targetWardId = newWardId;
            ClearAllHolograms();
        }

        private void Update()
        {
            // Unity 6 New Input System Keyboard Shortcuts (PC Link / Editor Testing)
#if ENABLE_INPUT_SYSTEM
            if (UnityEngine.InputSystem.Keyboard.current != null)
            {
                // Press 'Space' to toggle 3D ward digital twin overlay
                if (UnityEngine.InputSystem.Keyboard.current.spaceKey.wasPressedThisFrame)
                {
                    if (wardVisualizer != null)
                    {
                        wardVisualizer.ToggleOverlay(!wardVisualizer.showDigitalTwinOverlay);
                    }
                }

                // Press 'C' to toggle Ward Alignment UI
                if (UnityEngine.InputSystem.Keyboard.current.cKey.wasPressedThisFrame)
                {
                    if (alignmentTool != null)
                    {
                        alignmentTool.ToggleCalibrationUI();
                    }
                }

                // Press 'R' to instantly Re-Sync room coordinate alignment
                if (UnityEngine.InputSystem.Keyboard.current.rKey.wasPressedThisFrame)
                {
                    if (alignmentTool != null)
                    {
                        alignmentTool.QuickReSync();
                    }
                    else if (spatialManager != null)
                    {
                        spatialManager.ReSyncAlignment();
                    }
                }

                // Press 'Backspace' or 'Delete' to reset room coordinate alignment to default (0,0,0)
                if (UnityEngine.InputSystem.Keyboard.current.backspaceKey.wasPressedThisFrame ||
                    UnityEngine.InputSystem.Keyboard.current.deleteKey.wasPressedThisFrame)
                {
                    if (spatialManager != null)
                    {
                        spatialManager.ResetAlignment();
                    }
                }
            }
#elif ENABLE_LEGACY_INPUT_MANAGER
            if (Input.GetKeyDown(KeyCode.Space))
            {
                if (wardVisualizer != null)
                    wardVisualizer.ToggleOverlay(!wardVisualizer.showDigitalTwinOverlay);
            }
            if (Input.GetKeyDown(KeyCode.R))
            {
                if (alignmentTool != null)
                    alignmentTool.QuickReSync();
                else if (spatialManager != null)
                    spatialManager.ReSyncAlignment();
            }
            if (Input.GetKeyDown(KeyCode.Backspace))
            {
                if (spatialManager != null)
                    spatialManager.ResetAlignment();
            }
#endif
        }

        private static void LogBoundaryVisibility(OVRPlugin.BoundaryVisibility visibility)
        {
            Debug.Log(visibility == OVRPlugin.BoundaryVisibility.Suppressed
                ? "[SHIRO MR] Boundary hidden: the app works beyond the boundary area."
                : $"[SHIRO MR] Boundary shown ({visibility}): the app stops at the edge of the boundary area.");
        }

        private void OnDestroy()
        {
            OVRManager.BoundaryVisibilityChanged -= LogBoundaryVisibility;
            if (networkManager != null)
            {
                networkManager.OnWardInitialized -= HandleWardInitialized;
                networkManager.OnPositionUpdated -= HandlePositionUpdated;
                networkManager.OnTelemetryUpdated -= HandleTelemetryUpdated;
                networkManager.OnTagPurged -= HandleTagPurged;
                networkManager.OnActiveWardChanged -= HandleActiveWardChanged;
            }
        }

        private void EnsureSubsystems()
        {
            if (networkManager == null)
            {
                networkManager = FindObjectOfType<ShiroNetworkManager>();
                if (networkManager == null)
                {
                    networkManager = gameObject.AddComponent<ShiroNetworkManager>();
                }
            }

            // Sync configured Inspector settings down to Network Manager
            if (networkManager != null)
            {
                networkManager.serverIp = serverIp;
                networkManager.serverPort = serverPort;
                if (!string.IsNullOrEmpty(networkManager.targetWardId))
                {
                    targetWardId = networkManager.targetWardId;
                }
                else
                {
                    networkManager.targetWardId = targetWardId;
                }
            }

            if (spatialManager == null)
            {
                spatialManager = FindObjectOfType<WardSpatialManager>();
                if (spatialManager == null)
                {
                    spatialManager = gameObject.AddComponent<WardSpatialManager>();
                }
            }

            if (wardVisualizer == null)
            {
                wardVisualizer = FindObjectOfType<WardVisualizer>();
                if (wardVisualizer == null)
                {
                    wardVisualizer = gameObject.AddComponent<WardVisualizer>();
                }
            }

            if (alignmentTool == null)
            {
                alignmentTool = FindObjectOfType<WardAlignmentTool>();
                if (alignmentTool == null)
                {
                    alignmentTool = gameObject.AddComponent<WardAlignmentTool>();
                }
            }

            if (vrPointer == null)
            {
                vrPointer = FindObjectOfType<ShiroVRPointer>();
                if (vrPointer == null)
                {
                    vrPointer = gameObject.AddComponent<ShiroVRPointer>();
                }
            }

            if (handSlate == null)
            {
                handSlate = FindObjectOfType<ShiroHandSlate>();
                if (handSlate == null)
                {
                    handSlate = gameObject.AddComponent<ShiroHandSlate>();
                }
            }

            if (handVisualizer == null)
            {
                handVisualizer = FindObjectOfType<ShiroHandVisualizer>();
                if (handVisualizer == null)
                {
                    handVisualizer = gameObject.AddComponent<ShiroHandVisualizer>();
                }
            }
        }

        private void HandleWardInitialized(WardConfig ward, List<TrackedSubject> subjects)
        {
            _cachedWardConfig = ward;
            _patientRegistry.Clear();
            if (subjects != null)
            {
                foreach (var s in subjects)
                {
                    if (!string.IsNullOrEmpty(s.device_id))
                    {
                        _patientRegistry[s.device_id.ToUpper()] = s;
                    }
                    if (!string.IsNullOrEmpty(s.mac_address))
                    {
                        _patientRegistry[s.mac_address.ToUpper()] = s;
                    }
                }
            }

            // Populate alignment tool bed buttons
            if (alignmentTool != null && ward != null)
            {
                alignmentTool.PopulateBedsFromWard(ward);
            }

            // Update any existing holograms with newly bound patient info & ward layout
            foreach (var kvp in _activeHolograms)
            {
                string tagId = kvp.Key.ToUpper();
                if (ward != null)
                {
                    kvp.Value.SetWardConfig(ward);
                }
                if (_patientRegistry.TryGetValue(tagId, out var subject))
                {
                    kvp.Value.SetPatientInfo(subject.patient_id, subject.full_name, subject.assigned_bed_id);
                }
            }
        }

        // KEY LOGIC: a position update from the edge server moves the patient's tag. The
        // server sends several sources; TryGetBest picks the most accurate one:
        // another headset's depth sensor (cm) > the LiDAR (about 0.1 m) > Bluetooth (about 1 m).
        private void HandlePositionUpdated(IpsPositionUpdate pos)
        {
            if (pos == null || string.IsNullOrEmpty(pos.tag_id)) return;

            // Version 2: the panel follows the best position the edge server has (another
            // headset's depth sensor, else the LiDAR, else Bluetooth), as the maps do; version 1
            // always used Bluetooth, so the panel shook with it even where the LiDAR saw the
            // patient. This headset's own depth position is not taken back: fed back here, a
            // wristband would always seem to be right at the linked person, and a wrong link
            // could never end (the panel follows its linked person itself).
            string own = networkManager != null && networkManager.Identity != null ? networkManager.Identity.DeviceId : null;
            if (!pos.TryGetBest(own, out float px, out float py, out string from)) return;
            string cleanTag = pos.tag_id.ToUpper().Trim();
            PatientHologram hologram = GetOrCreateHologram(cleanTag);
            hologram.UpdatePosition(px, py, pos.motion_state, from, pos.lidar_held);
            // Version 2: the tag says "Wristband not heard" when the edge server says so
            hologram.NoteSignal(pos.status != "OFFLINE");
        }

        private void HandleTelemetryUpdated(TelemetryUpdate tel)
        {
            if (tel == null) return;
            string cleanTag = tel.EffectiveTagId;
            if (string.IsNullOrEmpty(cleanTag)) return;

            cleanTag = cleanTag.ToUpper().Trim();
            if (_activeHolograms.TryGetValue(cleanTag, out var hologram))
            {
                hologram.UpdateTelemetryState(tel.data);
                hologram.UpdateTelemetry(tel.EffectiveBpm, tel.EffectiveSpo2, tel.EffectiveBattery);
            }
        }

        private void HandleTagPurged(string tagId)
        {
            if (string.IsNullOrEmpty(tagId)) return;

            string cleanTag = tagId.ToUpper().Trim();
            if (_activeHolograms.TryGetValue(cleanTag, out var hologram))
            {
                Destroy(hologram.gameObject);
                _activeHolograms.Remove(cleanTag);
                Debug.Log($"[SHIRO MR] Purged patient hologram for tag {cleanTag}.");
            }
        }

        /// <summary>The patient panels shown, by tag id.</summary>
        public IReadOnlyDictionary<string, PatientHologram> Holograms => _activeHolograms;

        /// <summary>The bound patient of a wristband (tag id or MAC), or null.</summary>
        public TrackedSubject FindSubject(string tagId)
        {
            if (string.IsNullOrEmpty(tagId)) return null;
            return _patientRegistry.TryGetValue(tagId.ToUpper().Trim(), out var s) ? s : null;
        }

        /// <summary>A panel for testing (fake wristband): not a real wristband, no bed.</summary>
        public PatientHologram SpawnTestHologram(string tagId, string patientId, string label)
        {
            PatientHologram holo = GetOrCreateHologram(tagId);
            holo.SetPatientInfo(patientId, label, "--");
            return holo;
        }

        public void RemoveHologram(string tagId) => HandleTagPurged(tagId);

        private PatientHologram GetOrCreateHologram(string tagId)
        {
            if (_activeHolograms.TryGetValue(tagId, out var existing))
            {
                return existing;
            }

            GameObject holoObj;
            if (patientHologramPrefab != null)
            {
                holoObj = Instantiate(patientHologramPrefab);
            }
            else
            {
                holoObj = new GameObject($"PatientHologram_{tagId}");
            }

            PatientHologram holo = holoObj.GetComponent<PatientHologram>();
            if (holo == null)
            {
                holo = holoObj.AddComponent<PatientHologram>();
            }

            holo.tagId = tagId;
            if (_cachedWardConfig != null)
            {
                holo.SetWardConfig(_cachedWardConfig);
            }

            // Bind demographic info if patient is enrolled in registry
            if (_patientRegistry.TryGetValue(tagId, out var subject))
            {
                holo.SetPatientInfo(subject.patient_id, subject.full_name, subject.assigned_bed_id);
            }
            else
            {
                holo.SetPatientInfo("--", $"Subject ({tagId})", "--");
            }

            _activeHolograms[tagId] = holo;
            Debug.Log($"[SHIRO MR] Spawned new dynamic patient hologram for {tagId}.");
            return holo;
        }
    }
}

