// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Dynamic In-Situ Patient Hologram & Floating Billboard Vitals Card
// Phase A: Bed Headboard Center Poster + In-Transit Glowing Human Silhouette
// =============================================================================
using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

namespace ShiroMR
{
    public enum PatientDockMode
    {
        Headboard,
        Bedside
    }

    public enum PatientTrackingState
    {
        BedDocked,
        InTransit,
        ManualAim
    }

    public class PatientHologram : MonoBehaviour
    {
        [Header("Identity & Association")]
        public string tagId = "TAG-001";
        public string patientId = "--";
        public string fullName = "Unassigned Patient";
        public string assignedBed = "--";

        [Header("Current Telemetry State")]
        public int heartRateBpm = 0;
        public int spo2Percent = 0;
        public int batteryPercent = 100;
        public string motionState = "STATIONARY";
        public bool isOnline = true;

        [Header("Clinical Docking & Tracking Modes")]
        public PatientDockMode dockMode = PatientDockMode.Headboard;
        public PatientTrackingState trackingState = PatientTrackingState.BedDocked;
        public bool isPersonDetected = false;
        public Vector3 detectedPersonPosition;
        public Vector3 lockedManualPosition;

        [Header("Spatial HUD Offsets")]
        [Tooltip("Horizontal offset from patient center/shoulder to float beside them (~1.25m elevation in transit)")]
        public Vector3 hudOffset = new Vector3(0.40f, 1.25f, 0f);

        [Header("Kinematic Movement Tuning")]
        public float smoothTime = 0.35f;
        public float maxSpeed = 1.30f; // Max realistic walking speed in ward (m/s)

        // Internal Kinematics & Tracking
        private Vector3 _targetPosition;
        private Vector3 _currentVelocity;
        private Transform _cameraTransform;
        private WardConfig _cachedWardConfig;
        private WardBed _assignedWardBed;
        private Vector3 _rawIpsWorldPos;
        private Vector3 _lastStationaryWorldPos;
        private bool _hasStationaryLock = false;
        private float _bedSettleTimer = 0f;
        private float _pulseTimer = 0f;
        private float _ringPulseTimer = 0f;
        private float _bannerStatusTimer = 0f;

        // Visual Components
        private GameObject _hudContainer;
        private Canvas _hudCanvas;
        private Image _cardBackground;
        private Text _nameText;
        private Text _subText;
        private Text _trackingBadgeText;
        private Text _bpmText;
        private Text _spo2Text;
        private Text _batteryText;
        private Text _motionBadgeText;
        private Text _statusBannerText;

        // Interactive HUD Buttons
        private Button _reattachBtn;
        private Text _reattachBtnText;
        private Button _dockToggleBtn;
        private Text _dockToggleBtnText;
        private Button _cancelAimBtn;
        private Text _cancelAimBtnText;

        // Floor Uncertainty Footprint Circle
        private GameObject _floorRingObj;
        private Renderer _floorRingRenderer;
        private Material _floorRingMaterial;

        // Manual Move / Adjust Handle (Top-Left of Card)
        private Button _moveHandleBtn;
        private Text _moveHandleBtnText;
        private bool _isPanelDragging = false;
        private float _dragDistance = 2.0f;
        private Vector3 _customBedOffset = Vector3.zero;
        private bool _isManuallyLocked = false;

        private void Start()
        {
            if (Camera.main != null)
            {
                _cameraTransform = Camera.main.transform;
            }

            BuildHologramVisuals();

            // Try to resolve bed from active ward config if available
            if (WardSpatialManager.Instance != null && _cachedWardConfig == null)
            {
                _cachedWardConfig = WardSpatialManager.Instance.GetCachedWardConfig();
                ResolveAssignedBed();
            }

            if (trackingState == PatientTrackingState.BedDocked && _hudContainer != null)
            {
                _hudContainer.transform.localPosition = Vector3.zero;
            }
        }

        private void Update()
        {
            // 0. Top-Left Handle Dragging: Pinch/Hold to Move Panel
            if (_isPanelDragging)
            {
                if (ShiroVRPointer.Instance != null && ShiroVRPointer.Instance.isTriggerDown)
                {
                    // Distance is adjusted by left-hand extension or thumbstick
                    _dragDistance = ShiroVRPointer.Instance.manualLaserDistance;
                    Vector3 newPos = ShiroVRPointer.Instance.PointerOrigin + ShiroVRPointer.Instance.PointerForward * _dragDistance;

                    if (trackingState == PatientTrackingState.BedDocked)
                    {
                        if (WardSpatialManager.Instance != null && _assignedWardBed != null)
                        {
                            Vector3 bedBase = (dockMode == PatientDockMode.Headboard)
                                ? WardSpatialManager.Instance.GetBedHeadboardWorldPosition(_assignedWardBed)
                                : WardSpatialManager.Instance.GetBedSideWorldPosition(_assignedWardBed);
                            _customBedOffset = newPos - bedBase;
                        }
                        _targetPosition = newPos;
                        transform.position = newPos;
                    }
                    else
                    {
                        _targetPosition = newPos;
                        transform.position = newPos;
                        hudOffset = newPos - detectedPersonPosition;
                    }

                    // Face user smoothly while dragging
                    if (_cameraTransform != null)
                    {
                        Vector3 toCam = _cameraTransform.position - _hudContainer.transform.position;
                        toCam.y = 0;
                        if (toCam.sqrMagnitude > 0.01f)
                        {
                            _hudContainer.transform.rotation = Quaternion.LookRotation(toCam) * Quaternion.Euler(0, 180f, 0);
                        }
                    }
                }
                else
                {
                    // Drag released!
                    _isPanelDragging = false;
                    SetStatusBanner("✅ PANEL POSITION ADJUSTED", 3.0f, new Color(0.2f, 0.95f, 0.5f));
                }
            }
            else
            {
                // Check if user just pinched the Move Handle
                if (ShiroVRPointer.Instance != null && ShiroVRPointer.Instance.wasTriggerPressedThisFrame &&
                    ShiroVRPointer.Instance.currentHoveredButton == _moveHandleBtn)
                {
                    StartPanelDrag();
                }

                // 1. Smooth Kinematic Position Interpolation towards target
                if (trackingState == PatientTrackingState.BedDocked)
                {
                    if (WardSpatialManager.Instance != null && _assignedWardBed != null)
                    {
                        Vector3 bedBase = (dockMode == PatientDockMode.Headboard)
                            ? WardSpatialManager.Instance.GetBedHeadboardWorldPosition(_assignedWardBed)
                            : WardSpatialManager.Instance.GetBedSideWorldPosition(_assignedWardBed);
                        _targetPosition = bedBase + _customBedOffset;
                    }
                    transform.position = _targetPosition;
                }
                else
                {
                    if (motionState == "STATIONARY" || motionState == "SETTLING")
                    {
                        transform.position = Vector3.MoveTowards(transform.position, _targetPosition, 0.50f * Time.deltaTime);
                    }
                    else
                    {
                        transform.position = Vector3.SmoothDamp(transform.position, _targetPosition, ref _currentVelocity, smoothTime, maxSpeed);
                    }
                }
            }

            // 2. Pulse Heart Rate
            if (heartRateBpm > 0)
            {
                float beatsPerSecond = Mathf.Max(0.5f, heartRateBpm / 60.0f);
                _pulseTimer += Time.deltaTime * beatsPerSecond * Mathf.PI * 2f;
            }

            // 3. Pulse Floor Uncertainty Ring
            _ringPulseTimer += Time.deltaTime * 2.5f;
            float glowAlpha = 0.45f + 0.20f * Mathf.Sin(_ringPulseTimer);

            if (_floorRingObj != null && _floorRingObj.activeInHierarchy && _floorRingRenderer != null)
            {
                Color baseCol = isPersonDetected
                    ? new Color(0.10f, 0.95f, 0.45f, glowAlpha)  // Emerald Green: Physical Human Locked
                    : new Color(0.06f, 0.71f, 0.83f, 0.35f);    // Translucent Cyan: Searching/BLE Area

                _floorRingRenderer.material.color = baseCol;
            }

            // 4. Banner Status Timeout
            if (_bannerStatusTimer > 0f)
            {
                _bannerStatusTimer -= Time.deltaTime;
                if (_bannerStatusTimer <= 0f && _statusBannerText != null)
                {
                    RefreshStatusBanner();
                }
            }

            // 5. Refresh UI Badges & Text
            RefreshUiText();
        }

        private void LateUpdate()
        {
            if (_hudContainer == null || _isPanelDragging) return;

            // =========================================================================
            // User Clinical Rule:
            // When in Bed-Docked mode, DO NOT billboard/rotate when headset moves!
            // It sticks statically on the head of the bed like a wall-mounted poster.
            // When in In-Transit mode, it smoothly faces the doctor so it can be read.
            // =========================================================================
            if (trackingState == PatientTrackingState.BedDocked)
            {
                if (WardSpatialManager.Instance != null && _assignedWardBed != null)
                {
                    _hudContainer.transform.rotation = WardSpatialManager.Instance.GetBedHeadboardRotation(_assignedWardBed);
                }
            }
            else
            {
                // In-Transit or ManualAim: Smoothly billboard towards doctor's headset
                if (_cameraTransform != null)
                {
                    Vector3 toCam = _cameraTransform.position - _hudContainer.transform.position;
                    toCam.y = 0; // Maintain vertical horizon
                    if (toCam.sqrMagnitude > 0.01f)
                    {
                        _hudContainer.transform.rotation = Quaternion.LookRotation(toCam) * Quaternion.Euler(0, 180f, 0);
                    }
                }
            }
        }

        /// <summary>
        /// Supplies active Ward Configuration to resolve bed positions
        /// </summary>
        public void SetWardConfig(WardConfig ward)
        {
            _cachedWardConfig = ward;
            ResolveAssignedBed();
        }

        /// <summary>
        /// Resolves the specific WardBed instance matching the assigned bed string
        /// </summary>
        private void ResolveAssignedBed()
        {
            if (_cachedWardConfig == null || _cachedWardConfig.beds == null || _cachedWardConfig.beds.Count == 0)
            {
                _assignedWardBed = null;
                return;
            }

            string cleanAssigned = assignedBed?.Trim() ?? "";

            // 1. Direct match by bed_id
            foreach (var b in _cachedWardConfig.beds)
            {
                if (b != null && !string.IsNullOrEmpty(b.bed_id) && b.bed_id.Equals(cleanAssigned, StringComparison.OrdinalIgnoreCase))
                {
                    _assignedWardBed = b;
                    return;
                }
            }

            // 2. Match by bed_code (e.g. "Bed 1")
            foreach (var b in _cachedWardConfig.beds)
            {
                if (b != null && !string.IsNullOrEmpty(b.bed_code) && b.bed_code.Equals(cleanAssigned, StringComparison.OrdinalIgnoreCase))
                {
                    _assignedWardBed = b;
                    return;
                }
            }

            // 3. Substring match (e.g. "1" in "BED-001" or "Bed 1")
            foreach (var b in _cachedWardConfig.beds)
            {
                if (b != null)
                {
                    if (cleanAssigned.Contains("1") && (b.bed_code.Contains("1") || b.bed_id.Contains("1")))
                    {
                        _assignedWardBed = b;
                        return;
                    }
                }
            }

            // 4. Default to first bed in ward if available
            _assignedWardBed = _cachedWardConfig.beds[0];
        }

        /// <summary>
        /// Updates patient demographic metadata
        /// </summary>
        public void SetPatientInfo(string pId, string name, string bed)
        {
            patientId = pId;
            fullName = string.IsNullOrEmpty(name) ? "Unassigned Patient" : name;
            assignedBed = string.IsNullOrEmpty(bed) ? "--" : bed;
            ResolveAssignedBed();
            RefreshUiText();
        }

        /// <summary>
        /// Updates Vitals from Edge Server Telemetry
        /// </summary>
        public void UpdateTelemetry(int bpm, int spo2, int battery)
        {
            if (bpm > 0) heartRateBpm = bpm;
            if (spo2 > 0) spo2Percent = spo2;
            if (battery >= 0) batteryPercent = battery;
            isOnline = true;
            EvaluatePersonDetection();
            RefreshUiText();
        }

        /// <summary>
        /// Updates IPS Coordinates from Network Event and executes the Bed vs Transit State Machine
        /// with tight geometric margins and hysteresis.
        /// </summary>
        public void UpdatePosition(float wardX, float wardY, string motion)
        {
            motionState = motion ?? "STATIONARY";
            isOnline = true;

            // Calculate Nominal Ground World Position from Ward Coordinates
            if (WardSpatialManager.Instance != null)
            {
                _rawIpsWorldPos = WardSpatialManager.Instance.WardToWorldPosition(wardX, wardY, 0f);
            }
            else
            {
                _rawIpsWorldPos = new Vector3(wardX, 0f, wardY);
            }

            // Ensure bed is resolved if not already cached
            if (_assignedWardBed == null && WardSpatialManager.Instance != null)
            {
                if (_cachedWardConfig == null) _cachedWardConfig = WardSpatialManager.Instance.GetCachedWardConfig();
                ResolveAssignedBed();
            }

            // If manual aim is actively being targeted, keep target position as-is
            if (trackingState == PatientTrackingState.ManualAim)
            {
                return;
            }

            // Calculate distance to bed center (with tight margin)
            float distToBed = 999f;
            if (WardSpatialManager.Instance != null && _assignedWardBed != null)
            {
                distToBed = WardSpatialManager.Instance.GetDistanceToBedCenter(wardX, wardY, _assignedWardBed);
            }

            // =========================================================================
            // Bed-Docking State Machine with Hysteresis:
            // 1) If BedDocked: Detach IMMEDIATELY if distToBed > 1.15m OR motion is WALKING!
            // 2) If InTransit: Only re-dock if distToBed <= 0.85m AND stationary for >= 1.5s!
            // =========================================================================
            if (trackingState == PatientTrackingState.BedDocked)
            {
                if (distToBed > 1.15f || motionState == "WALKING")
                {
                    // Detach from bed immediately!
                    trackingState = PatientTrackingState.InTransit;
                    _bedSettleTimer = 0f;
                    _hasStationaryLock = false;
                    _isManuallyLocked = false;
                }
            }
            else if (trackingState == PatientTrackingState.InTransit)
            {
                if (distToBed <= 0.85f && motionState != "WALKING")
                {
                    _bedSettleTimer += 0.20f; // Settle accumulation
                    if (_bedSettleTimer >= 1.5f)
                    {
                        // Succeeded docking back to bed
                        trackingState = PatientTrackingState.BedDocked;
                        _isManuallyLocked = false;
                    }
                }
                else
                {
                    _bedSettleTimer = 0f;
                }
            }

            // Evaluate whether living human is detected via PPG optical pulse or clinician lock
            EvaluatePersonDetection();

            // Execute Mode Behaviors
            if (trackingState == PatientTrackingState.BedDocked)
            {
                Vector3 bedBase;
                if (WardSpatialManager.Instance != null && _assignedWardBed != null)
                {
                    bedBase = (dockMode == PatientDockMode.Headboard)
                        ? WardSpatialManager.Instance.GetBedHeadboardWorldPosition(_assignedWardBed)
                        : WardSpatialManager.Instance.GetBedSideWorldPosition(_assignedWardBed);
                }
                else
                {
                    bedBase = _rawIpsWorldPos + new Vector3(0, 1.28f, 0);
                }

                _targetPosition = bedBase + _customBedOffset;

                // Center alignment on headboard
                if (_hudContainer != null && !_isPanelDragging)
                {
                    _hudContainer.transform.localPosition = Vector3.zero;
                }

                // Hide Floor Uncertainty Ring when docked to bed
                if (_floorRingObj != null) _floorRingObj.SetActive(false);
                _hasStationaryLock = false;
            }
            else
            {
                // In-Transit Mode: Attach floating HUD next to the real human
                if (_hudContainer != null && !_isPanelDragging)
                {
                    _hudContainer.transform.localPosition = hudOffset;
                }

                if (_floorRingObj != null)
                {
                    _floorRingObj.SetActive(true);
                    _floorRingObj.transform.localPosition = new Vector3(0, 0.005f, 0);
                }

                if (motionState == "WALKING")
                {
                    _isManuallyLocked = false;
                    _hasStationaryLock = false;
                    detectedPersonPosition = new Vector3(_rawIpsWorldPos.x, 0, _rawIpsWorldPos.z);
                }
                else // STATIONARY, HAND_MOVEMENT, SETTLING
                {
                    if (!_hasStationaryLock)
                    {
                        _lastStationaryWorldPos = _rawIpsWorldPos;
                        _hasStationaryLock = true;
                    }
                    else if (Vector3.Distance(_rawIpsWorldPos, _lastStationaryWorldPos) > 0.85f && !_isManuallyLocked)
                    {
                        _lastStationaryWorldPos = _rawIpsWorldPos;
                    }

                    detectedPersonPosition = new Vector3(_lastStationaryWorldPos.x, 0, _lastStationaryWorldPos.z);
                }

                _targetPosition = detectedPersonPosition;
            }

            // Snap immediately on first initialization
            if (transform.position == Vector3.zero)
            {
                transform.position = _targetPosition;
            }
        }

        /// <summary>
        /// Evaluates whether an actual physical human is wearing the wristband using multi-modal bio-sensing:
        /// 1. MAX30102 Optical PPG capillary pulse: Valid pulse wave (40 <= heartRateBpm <= 220) proves human skin contact.
        /// 2. If the wristband is sitting on a table/bed/floor with no human, heartRateBpm is 0.
        /// 3. Manual Clinician Aim Lock: Clinician explicitly locked the hologram onto the patient in the room.
        /// </summary>
        public void EvaluatePersonDetection()
        {
            bool hasLivingPulse = (heartRateBpm >= 40 && heartRateBpm <= 220);
            isPersonDetected = (hasLivingPulse || _isManuallyLocked);
        }

        /// <summary>
        /// Begins manual aim mode: Clinician can point at the physical patient across the room to re-attach
        /// </summary>
        public void BeginManualAim()
        {
            trackingState = PatientTrackingState.ManualAim;
            if (ShiroVRPointer.Instance != null)
            {
                ShiroVRPointer.Instance.SetReattachTargeting(true);
            }

            SetStatusBanner("🎯 AIM AT PATIENT & PINCH / CLICK TO LOCK POSITION", 15.0f, new Color(1.0f, 0.85f, 0.2f));
            RefreshUiText();
        }

        /// <summary>
        /// Snaps the patient hologram directly to a clinician-selected world space position
        /// </summary>
        public void LockManualPosition(Vector3 worldPoint)
        {
            lockedManualPosition = worldPoint;
            detectedPersonPosition = new Vector3(worldPoint.x, 0, worldPoint.z);
            _targetPosition = detectedPersonPosition;
            _lastStationaryWorldPos = detectedPersonPosition;
            _hasStationaryLock = true;
            _isManuallyLocked = true;
            isPersonDetected = true;

            transform.position = _targetPosition;

            if (_hudContainer != null)
            {
                _hudContainer.transform.localPosition = hudOffset;
            }

            if (_floorRingObj != null)
            {
                _floorRingObj.SetActive(true);
                _floorRingObj.transform.localPosition = new Vector3(0, 0.005f, 0);
            }

            trackingState = PatientTrackingState.InTransit;

            if (ShiroVRPointer.Instance != null)
            {
                ShiroVRPointer.Instance.SetReattachTargeting(false);
            }

            SetStatusBanner("✅ POSITION RE-ATTACHED & LOCKED TO PATIENT", 4.0f, new Color(0.2f, 0.95f, 0.5f));
            RefreshUiText();
        }

        /// <summary>
        /// Cancels manual aim mode and returns to automatic tracking
        /// </summary>
        public void CancelManualAim()
        {
            trackingState = PatientTrackingState.InTransit;
            _isManuallyLocked = false;
            if (ShiroVRPointer.Instance != null)
            {
                ShiroVRPointer.Instance.SetReattachTargeting(false);
            }
            SetStatusBanner("Auto-Tracking Resumed", 2.0f, Color.white);
            RefreshUiText();
        }

        /// <summary>
        /// Toggles between Headboard and Bedside mounting in Bed-Docked mode
        /// </summary>
        public void ToggleDockMode()
        {
            dockMode = (dockMode == PatientDockMode.Headboard) ? PatientDockMode.Bedside : PatientDockMode.Headboard;

            if (trackingState == PatientTrackingState.BedDocked && WardSpatialManager.Instance != null && _assignedWardBed != null)
            {
                _targetPosition = (dockMode == PatientDockMode.Headboard)
                    ? WardSpatialManager.Instance.GetBedHeadboardWorldPosition(_assignedWardBed)
                    : WardSpatialManager.Instance.GetBedSideWorldPosition(_assignedWardBed);
            }

            SetStatusBanner($"Dock Location: {dockMode}", 2.5f, new Color(0.2f, 0.85f, 1.0f));
            RefreshUiText();
        }

        private void SetStatusBanner(string message, float duration, Color color)
        {
            if (_statusBannerText != null)
            {
                _statusBannerText.text = message;
                _statusBannerText.color = color;
                _bannerStatusTimer = duration;
            }
        }

        private void RefreshStatusBanner()
        {
            if (_statusBannerText == null) return;

            if (trackingState == PatientTrackingState.BedDocked)
            {
                string offsetNotice = (_customBedOffset != Vector3.zero) ? " [Adjusted]" : "";
                _statusBannerText.text = $"🛏️ Bed Headboard Poster ({dockMode}){offsetNotice} • Pinch [✥ Move] to Adjust";
                _statusBannerText.color = new Color(0.3f, 0.85f, 1.0f);
            }
            else if (_isPanelDragging)
            {
                _statusBannerText.text = "✋ DRAGGING PANEL • MOVE RAY (USE LEFT HAND FOR DISTANCE)";
                _statusBannerText.color = new Color(0.2f, 0.95f, 0.5f);
            }
            else if (trackingState == PatientTrackingState.ManualAim)
            {
                _statusBannerText.text = "🎯 Aim at patient & pinch/click to lock position";
                _statusBannerText.color = new Color(1.0f, 0.85f, 0.2f);
            }
            else
            {
                if (isPersonDetected)
                {
                    _statusBannerText.text = "🟢 Patient Confirmed • Following Movement";
                    _statusBannerText.color = new Color(0.2f, 0.95f, 0.5f);
                }
                else
                {
                    _statusBannerText.text = "🟡 Searching Patient • Floor Ring Active (0 BPM)";
                    _statusBannerText.color = new Color(0.95f, 0.85f, 0.35f);
                }
            }
        }

        private void RefreshUiText()
        {
            if (_nameText != null) _nameText.text = fullName;
            if (_subText != null) _subText.text = $"{tagId} • Bed: {assignedBed}";

            // Tracking Mode Badge
            if (_trackingBadgeText != null)
            {
                if (trackingState == PatientTrackingState.BedDocked)
                {
                    string offsetNotice = (_customBedOffset != Vector3.zero) ? " (ADJUSTED)" : "";
                    _trackingBadgeText.text = $"🛏️ BED POSTER ({dockMode.ToString().ToUpper()}){offsetNotice}";
                    _trackingBadgeText.color = new Color(0.2f, 0.85f, 1.0f); // Cyan
                }
                else if (trackingState == PatientTrackingState.ManualAim)
                {
                    _trackingBadgeText.text = "🎯 MANUAL AIM TARGETING";
                    _trackingBadgeText.color = new Color(1.0f, 0.85f, 0.2f); // Amber
                }
                else
                {
                    _trackingBadgeText.text = isPersonDetected ? "🚶 IN-TRANSIT (PATIENT CONFIRMED)" : "🚶 IN-TRANSIT (WRISTBAND UNATTACHED)";
                    _trackingBadgeText.color = isPersonDetected ? new Color(0.2f, 0.95f, 0.5f) : new Color(0.95f, 0.85f, 0.35f);
                }
            }

            // Vitals BPM
            if (_bpmText != null)
            {
                if (heartRateBpm > 0)
                {
                    _bpmText.text = $"❤️ {heartRateBpm} BPM";
                    if (heartRateBpm < 50 || heartRateBpm > 120)
                        _bpmText.color = new Color(0.95f, 0.2f, 0.2f); // Red Alert
                    else if (heartRateBpm > 100)
                        _bpmText.color = new Color(0.95f, 0.75f, 0.1f); // Yellow Warning
                    else
                        _bpmText.color = new Color(0.1f, 0.95f, 0.45f); // Normal Green
                }
                else
                {
                    _bpmText.text = "❤️ -- BPM";
                    _bpmText.color = Color.gray;
                }
            }

            // SpO2
            if (_spo2Text != null)
            {
                if (spo2Percent > 0)
                {
                    _spo2Text.text = $"🫁 {spo2Percent}%";
                    _spo2Text.color = spo2Percent < 95 ? new Color(0.95f, 0.2f, 0.2f) : new Color(0.2f, 0.85f, 1.0f);
                }
                else
                {
                    _spo2Text.text = "🫁 --%";
                    _spo2Text.color = Color.gray;
                }
            }

            // Battery
            if (_batteryText != null)
            {
                _batteryText.text = $"🔋 {batteryPercent}%";
            }

            // Motion State
            if (_motionBadgeText != null)
            {
                string m = motionState?.ToUpper() ?? "STATIONARY";
                if (m == "WALKING")
                {
                    _motionBadgeText.text = "🚶 WALKING";
                    _motionBadgeText.color = new Color(0.2f, 0.95f, 0.5f);
                }
                else if (m == "HAND_MOVEMENT")
                {
                    _motionBadgeText.text = "✋ HAND MOVEMENT";
                    _motionBadgeText.color = new Color(0.95f, 0.75f, 0.2f);
                }
                else if (m == "SETTLING")
                {
                    _motionBadgeText.text = "⏳ SETTLING";
                    _motionBadgeText.color = new Color(0.3f, 0.85f, 1.0f);
                }
                else
                {
                    _motionBadgeText.text = "🔒 STATIONARY";
                    _motionBadgeText.color = new Color(0.3f, 0.85f, 1.0f);
                }
            }

            // Buttons state
            if (_cancelAimBtn != null)
            {
                _cancelAimBtn.gameObject.SetActive(trackingState == PatientTrackingState.ManualAim);
            }
            if (_dockToggleBtn != null)
            {
                _dockToggleBtn.gameObject.SetActive(trackingState == PatientTrackingState.BedDocked);
                if (_dockToggleBtnText != null)
                {
                    _dockToggleBtnText.text = (dockMode == PatientDockMode.Headboard) ? "📍 Headboard" : "🛏️ Bedside";
                }
            }

            if (_bannerStatusTimer <= 0f)
            {
                RefreshStatusBanner();
            }
        }

        /// <summary>
        /// Begins manual panel repositioning triggered by pinching or clicking the top-left [✥ Move] button.
        /// Clinician moves laser pointer horizontally/vertically to position panel, and uses left hand to adjust distance.
        /// </summary>
        public void StartPanelDrag()
        {
            _isPanelDragging = true;
            if (ShiroVRPointer.Instance != null)
            {
                _dragDistance = ShiroVRPointer.Instance.manualLaserDistance;
            }
            SetStatusBanner("✋ DRAGGING PANEL • MOVE RAY (USE LEFT HAND FOR DISTANCE)", 10.0f, new Color(0.2f, 0.85f, 1.0f));
            RefreshUiText();
        }

        /// <summary>
        /// Programmatically builds the holographic billboard canvas and floor footprint circle
        /// </summary>
        private void BuildHologramVisuals()
        {
            // 1. Floor Uncertainty Footprint Ring (0.65m diameter, 0.005m height)
            _floorRingObj = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            _floorRingObj.name = "FloorFootprintRing";
            _floorRingObj.transform.SetParent(this.transform);
            _floorRingObj.transform.localPosition = new Vector3(0, 0.005f, 0);
            _floorRingObj.transform.localScale = new Vector3(0.65f, 0.005f, 0.65f);
            Destroy(_floorRingObj.GetComponent<Collider>()); // No physics blocking

            _floorRingRenderer = _floorRingObj.GetComponent<Renderer>();
            if (_floorRingRenderer != null)
            {
                Shader unlit = Shader.Find("Sprites/Default") ?? Shader.Find("Unlit/Color");
                _floorRingMaterial = new Material(unlit);
                _floorRingMaterial.color = new Color(0.06f, 0.71f, 0.83f, 0.35f);
                _floorRingRenderer.material = _floorRingMaterial;
            }

            // 2. Floating Billboard HUD Container
            _hudContainer = new GameObject("FloatingVitalsHUD");
            _hudContainer.transform.SetParent(this.transform);
            _hudContainer.transform.localPosition = hudOffset;

            // Canvas
            _hudCanvas = _hudContainer.AddComponent<Canvas>();
            _hudCanvas.renderMode = RenderMode.WorldSpace;
            _hudContainer.AddComponent<CanvasScaler>();

            RectTransform rect = _hudContainer.GetComponent<RectTransform>();
            rect.sizeDelta = new Vector2(320, 200);
            rect.localScale = new Vector3(0.0022f, 0.0022f, 0.0022f); // Physical eye size ~70cm wide

            // Card Background Panel
            GameObject bgObj = new GameObject("CardBackground");
            bgObj.transform.SetParent(_hudContainer.transform, false);
            _cardBackground = bgObj.AddComponent<Image>();
            _cardBackground.color = new Color(0.06f, 0.10f, 0.18f, 0.92f); // Deep clinical slate glass
            RectTransform bgRect = bgObj.GetComponent<RectTransform>();
            bgRect.anchorMin = Vector2.zero;
            bgRect.anchorMax = Vector2.one;
            bgRect.sizeDelta = Vector2.zero;

            Font defaultFont = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");

            // Top-Left Corner: [✥ Move] Manual Drag / Reposition Handle
            GameObject moveObj = new GameObject("Btn_MoveHandle");
            moveObj.transform.SetParent(bgObj.transform, false);
            Image moveImg = moveObj.AddComponent<Image>();
            moveImg.color = new Color(0.12f, 0.40f, 0.60f, 0.95f); // Sleek clinical steel blue
            _moveHandleBtn = moveObj.AddComponent<Button>();
            _moveHandleBtn.onClick.AddListener(StartPanelDrag);
            BoxCollider moveCol = moveObj.AddComponent<BoxCollider>();
            moveCol.size = new Vector3(56, 24, 35); // 35 units thick for laser & fingertip
            RectTransform moveRect = moveObj.GetComponent<RectTransform>();
            moveRect.anchoredPosition = new Vector2(-124, 70);
            moveRect.sizeDelta = new Vector2(54, 22);

            GameObject moveTxtObj = new GameObject("Txt");
            moveTxtObj.transform.SetParent(moveObj.transform, false);
            _moveHandleBtnText = moveTxtObj.AddComponent<Text>();
            _moveHandleBtnText.font = defaultFont;
            _moveHandleBtnText.fontSize = 11;
            _moveHandleBtnText.fontStyle = FontStyle.Bold;
            _moveHandleBtnText.alignment = TextAnchor.MiddleCenter;
            _moveHandleBtnText.color = Color.white;
            _moveHandleBtnText.text = "✥ Move";
            RectTransform mTxtRect = moveTxtObj.GetComponent<RectTransform>();
            mTxtRect.anchorMin = Vector2.zero;
            mTxtRect.anchorMax = Vector2.one;
            mTxtRect.sizeDelta = Vector2.zero;

            // Row 1: Patient Name (shifted slightly to accommodate [✥ Move])
            GameObject nameObj = new GameObject("NameText");
            nameObj.transform.SetParent(bgObj.transform, false);
            _nameText = nameObj.AddComponent<Text>();
            _nameText.font = defaultFont;
            _nameText.fontSize = 18;
            _nameText.fontStyle = FontStyle.Bold;
            _nameText.color = Color.white;
            _nameText.text = fullName;
            RectTransform nameRect = nameObj.GetComponent<RectTransform>();
            nameRect.anchoredPosition = new Vector2(25, 70);
            nameRect.sizeDelta = new Vector2(230, 24);

            // Row 2: Subtext (Tag & Bed)
            GameObject subObj = new GameObject("SubText");
            subObj.transform.SetParent(bgObj.transform, false);
            _subText = subObj.AddComponent<Text>();
            _subText.font = defaultFont;
            _subText.fontSize = 11;
            _subText.color = new Color(0.70f, 0.80f, 0.92f);
            _subText.text = $"{tagId} • Bed: {assignedBed}";
            RectTransform subRect = subObj.GetComponent<RectTransform>();
            subRect.anchoredPosition = new Vector2(12, 48);
            subRect.sizeDelta = new Vector2(295, 18);

            // Row 3: Tracking Mode Badge
            GameObject badgeObj = new GameObject("TrackingBadge");
            badgeObj.transform.SetParent(bgObj.transform, false);
            _trackingBadgeText = badgeObj.AddComponent<Text>();
            _trackingBadgeText.font = defaultFont;
            _trackingBadgeText.fontSize = 11;
            _trackingBadgeText.fontStyle = FontStyle.Bold;
            _trackingBadgeText.color = new Color(0.2f, 0.85f, 1.0f);
            _trackingBadgeText.text = "🛏️ BED HEADBOARD POSTER";
            RectTransform badgeRect = badgeObj.GetComponent<RectTransform>();
            badgeRect.anchoredPosition = new Vector2(12, 26);
            badgeRect.sizeDelta = new Vector2(295, 18);

            // Row 4: Heart Rate
            GameObject bpmObj = new GameObject("BpmText");
            bpmObj.transform.SetParent(bgObj.transform, false);
            _bpmText = bpmObj.AddComponent<Text>();
            _bpmText.font = defaultFont;
            _bpmText.fontSize = 20;
            _bpmText.fontStyle = FontStyle.Bold;
            _bpmText.color = new Color(0.1f, 0.95f, 0.45f);
            _bpmText.text = "❤️ -- BPM";
            RectTransform bpmRect = bpmObj.GetComponent<RectTransform>();
            bpmRect.anchoredPosition = new Vector2(12, -4);
            bpmRect.sizeDelta = new Vector2(145, 26);

            // Row 4: SpO2
            GameObject spo2Obj = new GameObject("SpO2Text");
            spo2Obj.transform.SetParent(bgObj.transform, false);
            _spo2Text = spo2Obj.AddComponent<Text>();
            _spo2Text.font = defaultFont;
            _spo2Text.fontSize = 18;
            _spo2Text.fontStyle = FontStyle.Bold;
            _spo2Text.color = new Color(0.2f, 0.85f, 1.0f);
            _spo2Text.text = "🫁 --%";
            RectTransform spo2Rect = spo2Obj.GetComponent<RectTransform>();
            spo2Rect.anchoredPosition = new Vector2(165, -4);
            spo2Rect.sizeDelta = new Vector2(145, 26);

            // Row 5: Motion State
            GameObject motionObj = new GameObject("MotionText");
            motionObj.transform.SetParent(bgObj.transform, false);
            _motionBadgeText = motionObj.AddComponent<Text>();
            _motionBadgeText.font = defaultFont;
            _motionBadgeText.fontSize = 11;
            _motionBadgeText.fontStyle = FontStyle.Bold;
            _motionBadgeText.color = new Color(0.3f, 0.85f, 1.0f);
            _motionBadgeText.text = "🔒 STATIONARY";
            RectTransform motionRect = motionObj.GetComponent<RectTransform>();
            motionRect.anchoredPosition = new Vector2(12, -32);
            motionRect.sizeDelta = new Vector2(145, 20);

            // Row 5: Battery
            GameObject batObj = new GameObject("BatteryText");
            batObj.transform.SetParent(bgObj.transform, false);
            _batteryText = batObj.AddComponent<Text>();
            _batteryText.font = defaultFont;
            _batteryText.fontSize = 11;
            _batteryText.color = new Color(0.80f, 0.88f, 0.95f);
            _batteryText.text = "🔋 100%";
            RectTransform batRect = batObj.GetComponent<RectTransform>();
            batRect.anchoredPosition = new Vector2(165, -32);
            batRect.sizeDelta = new Vector2(145, 20);

            // Row 6: Interactive Buttons Row (with Thick BoxColliders for distant laser clicks)
            // Button 1: [🎯 Re-Attach]
            GameObject reattachObj = new GameObject("Btn_Reattach");
            reattachObj.transform.SetParent(bgObj.transform, false);
            Image reattachImg = reattachObj.AddComponent<Image>();
            reattachImg.color = new Color(0.12f, 0.45f, 0.65f, 0.90f);
            _reattachBtn = reattachObj.AddComponent<Button>();
            _reattachBtn.onClick.AddListener(BeginManualAim);
            BoxCollider colA = reattachObj.AddComponent<BoxCollider>();
            colA.size = new Vector3(135, 32, 35); // 35 units thick so rays easily catch it
            RectTransform reattachRect = reattachObj.GetComponent<RectTransform>();
            reattachRect.anchoredPosition = new Vector2(-75, -64);
            reattachRect.sizeDelta = new Vector2(135, 30);

            GameObject reattachTxtObj = new GameObject("Txt");
            reattachTxtObj.transform.SetParent(reattachObj.transform, false);
            _reattachBtnText = reattachTxtObj.AddComponent<Text>();
            _reattachBtnText.font = defaultFont;
            _reattachBtnText.fontSize = 12;
            _reattachBtnText.fontStyle = FontStyle.Bold;
            _reattachBtnText.alignment = TextAnchor.MiddleCenter;
            _reattachBtnText.color = Color.white;
            _reattachBtnText.text = "🎯 Re-Attach";
            RectTransform rTxtRect = reattachTxtObj.GetComponent<RectTransform>();
            rTxtRect.anchorMin = Vector2.zero;
            rTxtRect.anchorMax = Vector2.one;
            rTxtRect.sizeDelta = Vector2.zero;

            // Button 2: [📍 Headboard / 🛏️ Bedside]
            GameObject dockObj = new GameObject("Btn_DockToggle");
            dockObj.transform.SetParent(bgObj.transform, false);
            Image dockImg = dockObj.AddComponent<Image>();
            dockImg.color = new Color(0.12f, 0.35f, 0.45f, 0.90f);
            _dockToggleBtn = dockObj.AddComponent<Button>();
            _dockToggleBtn.onClick.AddListener(ToggleDockMode);
            BoxCollider colB = dockObj.AddComponent<BoxCollider>();
            colB.size = new Vector3(135, 32, 35);
            RectTransform dockRect = dockObj.GetComponent<RectTransform>();
            dockRect.anchoredPosition = new Vector2(75, -64);
            dockRect.sizeDelta = new Vector2(135, 30);

            GameObject dockTxtObj = new GameObject("Txt");
            dockTxtObj.transform.SetParent(dockObj.transform, false);
            _dockToggleBtnText = dockTxtObj.AddComponent<Text>();
            _dockToggleBtnText.font = defaultFont;
            _dockToggleBtnText.fontSize = 12;
            _dockToggleBtnText.fontStyle = FontStyle.Bold;
            _dockToggleBtnText.alignment = TextAnchor.MiddleCenter;
            _dockToggleBtnText.color = Color.white;
            _dockToggleBtnText.text = "📍 Headboard";
            RectTransform dTxtRect = dockTxtObj.GetComponent<RectTransform>();
            dTxtRect.anchorMin = Vector2.zero;
            dTxtRect.anchorMax = Vector2.one;
            dTxtRect.sizeDelta = Vector2.zero;

            // Button 3: [✖ Cancel Aim]
            GameObject cancelObj = new GameObject("Btn_CancelAim");
            cancelObj.transform.SetParent(bgObj.transform, false);
            Image cancelImg = cancelObj.AddComponent<Image>();
            cancelImg.color = new Color(0.65f, 0.20f, 0.20f, 0.90f);
            _cancelAimBtn = cancelObj.AddComponent<Button>();
            _cancelAimBtn.onClick.AddListener(CancelManualAim);
            BoxCollider colC = cancelObj.AddComponent<BoxCollider>();
            colC.size = new Vector3(135, 32, 35);
            RectTransform cancelRect = cancelObj.GetComponent<RectTransform>();
            cancelRect.anchoredPosition = new Vector2(75, -64);
            cancelRect.sizeDelta = new Vector2(135, 30);
            cancelObj.SetActive(false); // Initially hidden

            GameObject cancelTxtObj = new GameObject("Txt");
            cancelTxtObj.transform.SetParent(cancelObj.transform, false);
            _cancelAimBtnText = cancelTxtObj.AddComponent<Text>();
            _cancelAimBtnText.font = defaultFont;
            _cancelAimBtnText.fontSize = 12;
            _cancelAimBtnText.fontStyle = FontStyle.Bold;
            _cancelAimBtnText.alignment = TextAnchor.MiddleCenter;
            _cancelAimBtnText.color = Color.white;
            _cancelAimBtnText.text = "✖ Cancel Aim";
            RectTransform cTxtRect = cancelTxtObj.GetComponent<RectTransform>();
            cTxtRect.anchorMin = Vector2.zero;
            cTxtRect.anchorMax = Vector2.one;
            cTxtRect.sizeDelta = Vector2.zero;

            // Row 7: Status Banner Text
            GameObject statusObj = new GameObject("StatusBanner");
            statusObj.transform.SetParent(bgObj.transform, false);
            _statusBannerText = statusObj.AddComponent<Text>();
            _statusBannerText.font = defaultFont;
            _statusBannerText.fontSize = 10;
            _statusBannerText.alignment = TextAnchor.MiddleCenter;
            _statusBannerText.color = new Color(0.3f, 0.85f, 1.0f);
            _statusBannerText.text = "🛏️ Bed Headboard Poster • Center Wall Mount (Zero Jitter)";
            RectTransform statusRect = statusObj.GetComponent<RectTransform>();
            statusRect.anchoredPosition = new Vector2(0, -88);
            statusRect.sizeDelta = new Vector2(300, 16);
        }
    }
}
