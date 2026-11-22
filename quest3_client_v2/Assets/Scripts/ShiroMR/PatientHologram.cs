// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Dynamic In-Situ Patient Hologram & Floating Billboard Vitals Card
// Phase A: Bed Headboard Center Poster + In-Transit Glowing Human Silhouette
//
// Version 2 (Phase 12): the card is the patient's tag in the room, in the new
// interface's look (ShiroMR.UI): name, bed and where they are, the heart rate
// with its state in words (as on the web dashboard), a coloured stripe for the
// status (red needs help, amber check, blue OK, grey not heard). It keeps the
// same size to the eye at any distance. A tap (ray or fingertip) opens the
// details: SpO2, battery, movement, how the position is found, and the controls
// (move, choose the person, headboard or bedside, automatic). The positioning
// logic is version 1's.
// =============================================================================
using System;
using System.Collections.Generic;
using ShiroMR.UI;
using TMPro;
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
        public int batteryPercent = -1; // -1: not reported yet
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

        // Visual Components (version 2: the tag, ShiroMR.UI)
        private GameObject _hudContainer;
        private Canvas _hudCanvas;
        private RectTransform _hudRect;
        private Image _cardBackground;
        private ShiroButton _cardButton;      // the whole tag: a tap opens or closes the details
        private Image _statusStripe;
        private TMP_Text _nameText;
        private TMP_Text _subText;
        private TMP_Text _trackingBadgeText;
        private TMP_Text _bpmText;            // the heart rate value
        private TMP_Text _bpmUnitText;
        private TMP_Text _heartStateText;     // the heart rate in words, or the alert
        private TMP_Text _spo2Text;
        private TMP_Text _batteryText;
        private TMP_Text _motionBadgeText;
        private TMP_Text _statusBannerText;
        private GameObject _detailsRoot;
        private bool _detailsOpen;

        // Interactive HUD Buttons
        private Button _reattachBtn;
        private TMP_Text _reattachBtnText;
        private Button _dockToggleBtn;
        private TMP_Text _dockToggleBtnText;
        private Button _cancelAimBtn;
        private TMP_Text _cancelAimBtnText;
        private Button _autoBtn;            // ends a choice made by hand (pinned spot or chosen person)

        // The wristband's state for the heart rate in words (version 2; as the web dashboard)
        private float _lastHeardAt = -1f;     // Time.time of the last telemetry or position (online)
        private bool _heardOffline;           // the edge server says the wristband is not heard
        private bool _touch;                  // skin contact (measuring)
        private bool _liveMode;               // 1 Hz live vitals
        private bool _charging;
        private float _touchSince = -1f;
        private float _burstEndAt = -1f;
        private int _lastBpm;
        private float _lastBpmAt = -1f;
        private const float NoSignalAfter = 6f;   // s without a message: "No signal"
        private const float FirstReadingS = 15f;  // the first heart rate takes about 13 s
        private const float PassiveCycleS = 180f; // between automatic readings

        // Floor Uncertainty Footprint Circle
        private GameObject _floorRingObj;
        private Renderer _floorRingRenderer;
        private Material _floorRingMaterial;

        // Manual Move / Adjust Handle (Top-Left of Card)
        private Button _moveHandleBtn;
        private TMP_Text _moveHandleBtnText;
        private bool _isPanelDragging = false;
        private float _dragDistance = 2.0f;
        private Vector3 _customBedOffset = Vector3.zero;
        private bool _isManuallyLocked = false;

        // Person linking (8D): the panel follows a person seen by the depth sensor
        private bool _linkingActive;
        private bool _depthLinked;
        private Vector3 _depthLinkPos;
        private float _depthLinkHeight;
        private bool _sideLayout;           // the card is beside the person (restored when the link ends)
        private TextMesh _nameTag;          // the patient's name above the linked person's head
        public ShiroMR.Linking.LinkState depthLinkState { get; private set; } = ShiroMR.Linking.LinkState.BleOnly;
        public string depthLinkReason { get; private set; } = "";
        /// <summary>A Bluetooth position has arrived for this panel.</summary>
        public bool HasIpsPosition { get; private set; }
        /// <summary>The Bluetooth position on the floor (world).</summary>
        public Vector3 IpsWorldPosition => _rawIpsWorldPos;
        public bool IsManuallyLocked => _isManuallyLocked;

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
                    SetStatusBanner("Tag moved", 3.0f, ShiroTheme.GoodText);
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
                    if (_depthLinked && trackingState == PatientTrackingState.InTransit)
                    {
                        _targetPosition = _depthLinkPos;
                        transform.position = Vector3.SmoothDamp(transform.position, _targetPosition, ref _currentVelocity, smoothTime, maxSpeed);
                    }
                    else if (motionState == "STATIONARY" || motionState == "SETTLING")
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

            // 6. Emergency alarm: flashing red card and floor ring until it is handled
            if (isAlarmActive) UpdateAlarmVisuals();
        }

        // ----- Emergency alarm (set by ShiroAlertManager) -----
        public bool isAlarmActive { get; private set; }
        private string _alarmLabel = "";
        private float _alarmTimer;

        /// <summary>The tag's background: a colour (alarm flash) or null for the normal look.</summary>
        private void SetCardColor(Color? color)
        {
            if (_cardButton != null) _cardButton.SetColorOverride(color);
            else if (_cardBackground != null) _cardBackground.color = color ?? ShiroTheme.Glass;
        }

        /// <summary>
        /// Shows or clears the emergency state of this patient's panel: the card and
        /// the floor ring flash red and the status line names the alert.
        /// </summary>
        public void SetAlarm(bool active, string label = "")
        {
            isAlarmActive = active;
            _alarmLabel = label ?? "";
            _alarmTimer = 0f;
            if (active)
            {
                if (_floorRingObj != null) _floorRingObj.SetActive(true);
                return;
            }
            // Back to the normal look of the current tracking state
            SetCardColor(null);
            if (_floorRingObj != null)
            {
                _floorRingObj.transform.localScale = new Vector3(0.65f, 0.005f, 0.65f);
                _floorRingObj.transform.localPosition = new Vector3(0, 0.005f, 0);
                _floorRingObj.SetActive(trackingState != PatientTrackingState.BedDocked);
            }
            RefreshStatusBanner();
        }

        private void UpdateAlarmVisuals()
        {
            _alarmTimer += Time.deltaTime;
            bool on = Mathf.Repeat(_alarmTimer, 0.6f) < 0.3f; // ~1.7 flashes per second
            SetCardColor(on ? new Color(0.62f, 0.06f, 0.09f, 0.96f) : ShiroTheme.AlertDark);
            if (_statusStripe != null) _statusStripe.color = ShiroTheme.Alert;
            if (_floorRingObj != null)
            {
                if (!_floorRingObj.activeSelf) _floorRingObj.SetActive(true);
                // On the floor below the panel (a bed-docked panel hangs at the headboard)
                float floorY = (WardSpatialManager.Instance != null && WardSpatialManager.Instance.wardOrigin != null)
                    ? WardSpatialManager.Instance.wardOrigin.position.y : 0f;
                _floorRingObj.transform.position = new Vector3(transform.position.x, floorY + 0.005f, transform.position.z);
                float s = 0.9f + 0.35f * Mathf.Abs(Mathf.Sin(_alarmTimer * 3.5f));
                _floorRingObj.transform.localScale = new Vector3(s, 0.005f, s);
                if (_floorRingRenderer != null) _floorRingRenderer.material.color = new Color(0.95f, 0.08f, 0.10f, on ? 0.85f : 0.45f);
            }
            // The tag's main line names the alert (after RefreshUiText, which runs first each frame)
            if (_heartStateText != null)
            {
                _heartStateText.text = $"{SentenceCase(_alarmLabel)}: waiting for a response";
                _heartStateText.color = on ? Color.white : ShiroTheme.AlertText;
            }
        }

        /// <summary>"AT THE DOOR" → "At the door".</summary>
        private static string SentenceCase(string s)
        {
            if (string.IsNullOrEmpty(s)) return "Alert";
            string lower = s.ToLowerInvariant();
            return char.ToUpperInvariant(lower[0]) + lower.Substring(1);
        }

        private void LateUpdate()
        {
            UpdateLinkedLayout();
            KeepTagSizeToTheEye();
            FitHeartLine();   // after Update wrote the heart line (or the alert over it)
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

        // ----- Layout while linked to a detected person (8D) -----
        // The name floats above the person's head; the card stands beside the person
        // (on the right as the clinician sees it), so it never covers the person.
        private const float SideDistance = 0.65f;   // m from the person's centre
        private const float CardHeight = 1.15f;     // m above the floor

        private void UpdateLinkedLayout()
        {
            bool linkedLayout = _depthLinked && trackingState == PatientTrackingState.InTransit && _cameraTransform != null;
            if (linkedLayout)
            {
                Vector3 toCam = _cameraTransform.position - transform.position;
                toCam.y = 0f;
                if (toCam.sqrMagnitude < 0.01f) toCam = Vector3.forward;
                Vector3 right = Vector3.Cross(toCam.normalized, Vector3.up); // the clinician's right

                if (_hudContainer != null && !_isPanelDragging)
                {
                    Vector3 cardPos = transform.position + right * SideDistance + Vector3.up * CardHeight;
                    _hudContainer.transform.position = _sideLayout
                        ? Vector3.Lerp(_hudContainer.transform.position, cardPos, 8f * Time.deltaTime)
                        : cardPos;
                }
                _sideLayout = true;

                EnsureNameTag();
                _nameTag.gameObject.SetActive(true);
                _nameTag.text = fullName;
                float top = _depthLinkHeight > 0.3f ? _depthLinkHeight : 1.7f;
                _nameTag.transform.position = transform.position + Vector3.up * (top + 0.15f);
                _nameTag.transform.rotation = Quaternion.LookRotation(-toCam.normalized);
                _nameTag.color = isAlarmActive ? new Color(1f, 0.3f, 0.3f) : Color.white;
            }
            else
            {
                if (_nameTag != null) _nameTag.gameObject.SetActive(false);
                if (_sideLayout && _hudContainer != null && !_isPanelDragging && trackingState == PatientTrackingState.InTransit)
                {
                    _hudContainer.transform.localPosition = hudOffset;
                }
                _sideLayout = false;
            }
        }

        private void EnsureNameTag()
        {
            if (_nameTag != null) return;
            var obj = new GameObject("LinkedNameTag");
            obj.transform.SetParent(transform, false);
            _nameTag = obj.AddComponent<TextMesh>();
            _nameTag.fontSize = 60;
            _nameTag.characterSize = 0.005f;
            _nameTag.fontStyle = FontStyle.Bold;
            _nameTag.anchor = TextAnchor.LowerCenter;
            _nameTag.alignment = TextAlignment.Center;
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

            // No bed of this ward matches: the patient has no bed here. Guessing one
            // (first bed, or any bed with a "1" in it) would dock the panel at
            // another patient's bed.
            _assignedWardBed = null;
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
            // 0 from the server means "no valid reading now": show "--" instead of
            // keeping the previous value on screen as if it were current.
            heartRateBpm = bpm > 0 ? bpm : 0;
            spo2Percent = spo2 > 0 ? spo2 : 0;
            if (battery >= 0) batteryPercent = battery;
            isOnline = true;
            _lastHeardAt = Time.time;
            _heardOffline = false;
            if (bpm > 0) { _lastBpm = bpm; _lastBpmAt = Time.time; }
            EvaluatePersonDetection();
            RefreshUiText();
        }

        /// <summary>
        /// Version 2: the wristband's state with each telemetry message (skin contact, live
        /// mode, charging), for the heart rate in words: measuring, no skin contact, resting.
        /// </summary>
        public void UpdateTelemetryState(TelemetryData d)
        {
            if (d == null) return;
            bool touch = d.touch == 1;
            if (touch && !_touch) _touchSince = Time.time;
            if (!touch && _touch) _burstEndAt = Time.time;
            _touch = touch;
            _liveMode = d.active;
            _charging = d.charging;
        }

        /// <summary>A position message: heard (online) or the edge server says it is not heard (offline).</summary>
        public void NoteSignal(bool heard)
        {
            if (heard) { _lastHeardAt = Time.time; _heardOffline = false; }
            else _heardOffline = true;
        }

        /// <summary>
        /// Updates IPS Coordinates from Network Event and executes the Bed vs Transit State Machine
        /// with tight geometric margins and hysteresis.
        /// </summary>
        public void UpdatePosition(float wardX, float wardY, string motion)
        {
            motionState = motion ?? "STATIONARY";
            isOnline = true;
            HasIpsPosition = true;

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
                // A person chosen by hand is kept (the clinician sees the patient elsewhere)
                // until that person is lost from view; then the bed rule applies again.
                bool chosenByHand = depthLinkState == ShiroMR.Linking.LinkState.LinkedManual;
                if (distToBed <= 0.85f && motionState != "WALKING" && !chosenByHand)
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
                // (while linked to a detected person, UpdateLinkedLayout places it beside them)
                if (_hudContainer != null && !_isPanelDragging && !_sideLayout)
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

                if (_depthLinked) detectedPersonPosition = _depthLinkPos;
                _targetPosition = detectedPersonPosition;
            }

            // Snap immediately on first initialization
            if (transform.position == Vector3.zero)
            {
                transform.position = _targetPosition;
            }
        }

        /// <summary>
        /// "Person detected" means only: a valid pulse is being read right now (40 to 220 BPM),
        /// or the clinician locked the hologram onto the patient by hand. No reading (0) does not
        /// prove the wristband is off: at the wrist the pulse is often not measurable for a while.
        /// </summary>
        public void EvaluatePersonDetection()
        {
            bool hasLivingPulse = (heartRateBpm >= 40 && heartRateBpm <= 220);
            isPersonDetected = (hasLivingPulse || _isManuallyLocked || _depthLinked);
        }

        /// <summary>
        /// Person linking result (8D). Linked / LinkedManual: the panel follows that person
        /// (floor position, world). Otherwise it uses the Bluetooth position as before.
        /// </summary>
        public void SetDepthLink(ShiroMR.Linking.LinkState state, Vector3 personFloorPos, string reason, float personHeight = 0f)
        {
            _depthLinkHeight = personHeight;
            _linkingActive = true;
            depthLinkState = state;
            depthLinkReason = reason ?? "";
            _depthLinked = state == ShiroMR.Linking.LinkState.Linked || state == ShiroMR.Linking.LinkState.LinkedManual;
            if (_depthLinked)
            {
                _depthLinkPos = new Vector3(personFloorPos.x, 0f, personFloorPos.z);
                if (trackingState == PatientTrackingState.InTransit && !_isPanelDragging)
                {
                    detectedPersonPosition = _depthLinkPos;
                    _targetPosition = _depthLinkPos;
                }
            }
            else if (trackingState == PatientTrackingState.InTransit && HasIpsPosition && !_isManuallyLocked)
            {
                // Back to the Bluetooth position
                detectedPersonPosition = new Vector3(_rawIpsWorldPos.x, 0f, _rawIpsWorldPos.z);
                _targetPosition = detectedPersonPosition;
            }
            EvaluatePersonDetection();
        }

        /// <summary>Person linking switched off: the panel uses the Bluetooth position as before.</summary>
        public void ClearDepthLink()
        {
            if (!_linkingActive) return;
            SetDepthLink(ShiroMR.Linking.LinkState.BleOnly, Vector3.zero, "");
            _linkingActive = false;
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

            SetStatusBanner(LinkingOn
                ? "Point at the patient and pinch: the tag follows the person seen there"
                : "Point at the patient and pinch: the tag stays there", 15.0f, ShiroTheme.WarnText);
            RefreshUiText();
        }

        private static bool LinkingOn => ShiroPatientLinking.Instance != null && ShiroPatientLinking.Instance.LinkingEnabled;

        /// <summary>
        /// Choosing a person by hand (8D-5): the clinician aimed at a detected person and pinched.
        /// The panel follows that person until the person is lost from view (or "Auto").
        /// </summary>
        public void ChoosePerson(Vector3 personFloorPos, float personHeight, string reason)
        {
            trackingState = PatientTrackingState.InTransit;
            _isManuallyLocked = false;
            _bedSettleTimer = 0f;
            if (ShiroVRPointer.Instance != null) ShiroVRPointer.Instance.SetReattachTargeting(false);
            if (_floorRingObj != null)
            {
                _floorRingObj.SetActive(true);
                _floorRingObj.transform.localPosition = new Vector3(0, 0.005f, 0);
            }
            SetDepthLink(ShiroMR.Linking.LinkState.LinkedManual, personFloorPos, reason, personHeight);
            SetStatusBanner("Following the person you chose (Automatic to undo)", 4.0f, ShiroTheme.GoodText);
            RefreshUiText();
        }

        /// <summary>"🔄 Auto": ends a pinned spot or a person chosen by hand; automatic linking resumes.</summary>
        public void ReturnToAuto()
        {
            _isManuallyLocked = false;
            _hasStationaryLock = false;
            ShiroPatientLinking.Instance?.ReleaseChoice(tagId);
            if (depthLinkState == ShiroMR.Linking.LinkState.LinkedManual)
                SetDepthLink(ShiroMR.Linking.LinkState.BleOnly, Vector3.zero, "back to automatic: waiting for the next update");
            else if (trackingState == PatientTrackingState.InTransit && HasIpsPosition)
            {
                detectedPersonPosition = new Vector3(_rawIpsWorldPos.x, 0f, _rawIpsWorldPos.z);
                _targetPosition = detectedPersonPosition;
            }
            EvaluatePersonDetection();
            SetStatusBanner("Automatic again", 2.5f, ShiroTheme.Text);
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

            SetStatusBanner("The tag stays where you pointed (Automatic to undo)", 4.0f, ShiroTheme.GoodText);
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
            SetStatusBanner("Automatic again", 2.0f, ShiroTheme.Text);
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

            SetStatusBanner(dockMode == PatientDockMode.Headboard ? "Tag at the head of the bed" : "Tag beside the bed", 2.5f, ShiroTheme.OkText);
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

        /// <summary>The line about the tag's position, shown in the details.</summary>
        private void RefreshStatusBanner()
        {
            if (_statusBannerText == null) return;

            if (trackingState == PatientTrackingState.BedDocked)
            {
                string place = dockMode == PatientDockMode.Headboard ? "at the head of the bed" : "beside the bed";
                _statusBannerText.text = $"Tag {place}{(_customBedOffset != Vector3.zero ? " (moved by you)" : "")}";
                _statusBannerText.color = ShiroTheme.TextDim;
            }
            else if (_isPanelDragging)
            {
                _statusBannerText.text = "Moving the tag: point where it should go and let go of the pinch";
                _statusBannerText.color = ShiroTheme.OkText;
            }
            else if (trackingState == PatientTrackingState.ManualAim)
            {
                _statusBannerText.text = LinkingOn
                    ? "Point at the patient and pinch (nobody seen there: the tag stays at that spot)"
                    : "Point at the patient and pinch: the tag stays there";
                _statusBannerText.color = ShiroTheme.WarnText;
            }
            else if (_isManuallyLocked)
            {
                _statusBannerText.text = "Placed here by you (Automatic to undo)";
                _statusBannerText.color = ShiroTheme.WarnText;
            }
            else if (_linkingActive && !string.IsNullOrEmpty(depthLinkReason))
            {
                // The person linking's own reason, e.g. "linked: person 1.62 m, 0.3 m from the wristband"
                _statusBannerText.text = depthLinkReason;
                _statusBannerText.color = _depthLinked ? ShiroTheme.GoodText
                    : depthLinkState == ShiroMR.Linking.LinkState.Unclear ? ShiroTheme.WarnText : ShiroTheme.TextDim;
            }
            else
            {
                _statusBannerText.text = "Position from the wristband's Bluetooth signal (about ±1 m)";
                _statusBannerText.color = ShiroTheme.TextDim;
            }
        }

        // ----- The tag's words (version 2; the same states as the web dashboard) -----

        private struct HeartLine
        {
            public string Value;      // the number shown, or "--"
            public string Text;       // the heart rate in words
            public bool Warn;         // amber: needs a look
            public bool Dim;          // an older value (resting between readings)
            public bool Measuring;
        }

        private static string Ago(float s)
        {
            if (s < 60f) return $"{Mathf.RoundToInt(s)} s";
            if (s < 3600f) return $"{Mathf.RoundToInt(s / 60f)} min";
            return $"{Mathf.RoundToInt(s / 3600f)} h";
        }

        private bool IsHeard => _lastHeardAt >= 0f && !_heardOffline && Time.time - _lastHeardAt <= NoSignalAfter;

        /// <summary>
        /// The heart rate as a nurse should read it: a live value, measuring (and how long
        /// it usually takes), no skin contact, no signal, or the last value while the
        /// wristband rests between its automatic readings.
        /// </summary>
        private HeartLine Heart()
        {
            float now = Time.time;
            var h = new HeartLine { Value = "--", Text = "" };
            // Short lines for the headset (a line is read at a glance); a second line
            // only when needed, and the tag grows to fit it (FitHeartLine)
            if (_lastHeardAt < 0f) { h.Text = "Waiting for the wristband"; return h; }
            if (!IsHeard)
            {
                h.Text = $"No signal for {Ago(now - _lastHeardAt)}" +
                         (_lastBpmAt >= 0f ? $"\nLast {_lastBpm} bpm, {Ago(now - _lastBpmAt)} ago" : "");
                h.Warn = true;
                return h;
            }
            if (heartRateBpm > 0)
            {
                h.Value = heartRateBpm.ToString();
                h.Text = _liveMode ? "Live, every second" : "Just measured";
                return h;
            }
            if (_touch)
            {
                float s = _touchSince >= 0f ? now - _touchSince : 0f;
                h.Measuring = true;
                if (s > 30f) { h.Text = "Still measuring\nKeep the arm still, strap snug"; return h; }
                int left = Mathf.Max(1, Mathf.RoundToInt(FirstReadingS - s));
                h.Text = s < FirstReadingS ? $"Measuring… about {left} s" : "Measuring… almost ready";
                return h;
            }
            if (_liveMode) { h.Text = "No skin contact\nMake the strap snug"; h.Warn = true; return h; }
            // Resting between the automatic readings
            float next = _burstEndAt >= 0f ? Mathf.Max(0f, PassiveCycleS - (now - _burstEndAt)) : -1f;
            string nextText = next > 30f ? $"Next reading in about {Mathf.CeilToInt(next / 60f)} min" : "Next reading within 3 min";
            if (_lastBpmAt >= 0f)
            {
                h.Value = _lastBpm.ToString();
                h.Dim = true;
                h.Text = $"Measured {Ago(now - _lastBpmAt)} ago\n{nextText}";
            }
            else h.Text = nextText;
            return h;
        }

        private bool BatteryLow => batteryPercent >= 0 && batteryPercent <= 20 && !_charging;

        /// <summary>The stripe: grey not heard, amber check, blue OK (red while an alert waits).</summary>
        private Color StatusColour(HeartLine h)
        {
            if (!IsHeard) return ShiroTheme.Off;
            if (h.Warn || BatteryLow) return ShiroTheme.Warn;
            return ShiroTheme.Ok;
        }

        private string BedWords()
        {
            if (string.IsNullOrEmpty(assignedBed) || assignedBed == "--") return "No bed";
            if (_assignedWardBed != null && !string.IsNullOrEmpty(_assignedWardBed.bed_code)) return _assignedWardBed.bed_code;
            return assignedBed;
        }

        private string WhereWords()
        {
            switch (trackingState)
            {
                case PatientTrackingState.BedDocked: return "at their bed";
                case PatientTrackingState.ManualAim: return "being placed";
            }
            if (_isManuallyLocked) return "placed by you";
            if (_depthLinked) return "seen by headset";
            string m = motionState?.ToUpperInvariant() ?? "";
            return m == "WALKING" ? "walking" : "in the room";
        }

        private string MotionWords()
        {
            switch (motionState?.ToUpperInvariant() ?? "")
            {
                case "WALKING": return "Moving: walking";
                case "HAND_MOVEMENT": return "Moving: arm only";
                case "SETTLING": return "Settling";
                default: return "Still";
            }
        }

        private string PositionWords(out Color colour)
        {
            colour = ShiroTheme.OkText;
            if (trackingState == PatientTrackingState.BedDocked) return "At their bed";
            if (trackingState == PatientTrackingState.ManualAim) { colour = ShiroTheme.WarnText; return "Choosing the place by hand"; }
            if (_linkingActive && depthLinkState == ShiroMR.Linking.LinkState.Linked) { colour = ShiroTheme.GoodText; return "Seen by this headset"; }
            if (_linkingActive && depthLinkState == ShiroMR.Linking.LinkState.LinkedManual) { colour = ShiroTheme.GoodText; return "Following chosen person"; }
            if (_linkingActive && depthLinkState == ShiroMR.Linking.LinkState.Unclear) { colour = ShiroTheme.WarnText; return "Unclear: choose the person"; }
            return "Bluetooth, about ±1 m";
        }

        private void RefreshUiText()
        {
            if (_nameText != null) _nameText.text = fullName;
            if (_subText != null) _subText.text = $"{BedWords()} · {WhereWords()}";

            var h = Heart();
            if (_bpmText != null)
            {
                if (_bpmText.text != h.Value)
                {
                    _bpmText.text = h.Value;
                    // "♥ bpm" right after the number, however wide it is
                    float numberW = _bpmText.GetPreferredValues(h.Value).x;
                    if (_bpmUnitText != null) ShiroUIKit.Place(_bpmUnitText, 20 + numberW + 8, HeartRowY + 17, 80, 20);
                }
                _bpmText.color = h.Dim || h.Value == "--" ? ShiroTheme.TextDim : ShiroTheme.Text;
            }
            if (_bpmUnitText != null) _bpmUnitText.text = "<color=#F87171>♥</color> bpm";
            if (_heartStateText != null)
            {
                _heartStateText.text = h.Text;
                _heartStateText.color = h.Warn ? ShiroTheme.WarnText : ShiroTheme.TextDim;
            }
            // A second line only when something needs a look (the tag grows by one line)
            string flag = BatteryLow && IsHeard ? $"Battery low ({batteryPercent} %)" : "";
            if (_flagText != null && _flagText.text != flag) _flagText.text = flag;
            if ((flag.Length > 0) != _flagShown)
            {
                _flagShown = flag.Length > 0;
                if (_flagText != null) _flagText.gameObject.SetActive(_flagShown);
                LayoutTag();
            }
            if (_statusStripe != null && !isAlarmActive) _statusStripe.color = StatusColour(h);

            // Details
            if (_trackingBadgeText != null)
            {
                _trackingBadgeText.text = PositionWords(out Color c);
                _trackingBadgeText.color = c;
            }
            if (_spo2Text != null)
                _spo2Text.text = spo2Percent > 0 ? $"SpO2 ~{spo2Percent} %, for information" : "SpO2 --";
            if (_batteryText != null)
                _batteryText.text = batteryPercent >= 0 ? $"Battery {batteryPercent} %{(_charging ? ", charging" : "")}" : "Battery --";
            if (_motionBadgeText != null) _motionBadgeText.text = MotionWords();

            // Controls (the same rules as version 1)
            if (_cancelAimBtn != null) _cancelAimBtn.gameObject.SetActive(trackingState == PatientTrackingState.ManualAim);
            if (_autoBtn != null)
            {
                bool chosenByHand = _isManuallyLocked || depthLinkState == ShiroMR.Linking.LinkState.LinkedManual;
                _autoBtn.gameObject.SetActive(trackingState == PatientTrackingState.InTransit && chosenByHand);
            }
            if (_dockToggleBtn != null)
            {
                _dockToggleBtn.gameObject.SetActive(trackingState == PatientTrackingState.BedDocked);
                if (_dockToggleBtnText != null)
                    _dockToggleBtnText.text = dockMode == PatientDockMode.Headboard ? "Beside bed" : "Head of bed";
            }
            if (_reattachBtnText != null) _reattachBtnText.text = LinkingOn ? "Choose person" : "Pin to a spot";

            if (_bannerStatusTimer <= 0f)
            {
                RefreshStatusBanner();
            }
        }

        /// <summary>A tap on the tag: the details (SpO2, battery, position, controls) open or close.</summary>
        private void ToggleDetails()
        {
            _detailsOpen = !_detailsOpen;
            if (_detailsRoot != null) _detailsRoot.SetActive(_detailsOpen);
            LayoutTag();
            RefreshUiText();
        }

        private TMP_Text _flagText;          // "Battery low": a second line when something needs a look
        private bool _flagShown;
        private string _heartLaidOutFor;     // the heart line's text the tag was last sized for
        private float _heartLineH = 18f;

        /// <summary>
        /// The tag, top to bottom: name, bed and where, heart rate, its state (one or two
        /// lines, or the alert), a flag line when one is shown; the details below when open.
        /// Every line is as tall as its text: nothing is cut.
        /// </summary>
        private void LayoutTag()
        {
            if (_hudRect == null) return;
            float y = HeartRowY + 42f;
            if (_heartStateText != null) ShiroUIKit.Place(_heartStateText, 20, y, TagW - 34, _heartLineH);
            y += _heartLineH + 2f;
            if (_flagShown && _flagText != null) { ShiroUIKit.Place(_flagText, 20, y, TagW - 34, 20); y += 20f; }
            float compact = y + 8f;
            _hudRect.sizeDelta = new Vector2(TagW, _detailsOpen ? compact + DetailsH : compact);
            if (_detailsRoot != null) ShiroUIKit.Place(_detailsRoot.transform as RectTransform, 0, compact, TagW, DetailsH);
        }

        /// <summary>Resizes the tag when the heart line's text needs more or fewer lines.</summary>
        private void FitHeartLine()
        {
            if (_heartStateText == null) return;
            string text = _heartStateText.text;
            if (text == _heartLaidOutFor) return;
            _heartLaidOutFor = text;
            float h = string.IsNullOrEmpty(text) ? 18f
                : Mathf.Max(18f, Mathf.Ceil(_heartStateText.GetPreferredValues(text, TagW - 34, 0f).y) + 2f);
            if (Mathf.Abs(h - _heartLineH) < 0.5f) return;
            _heartLineH = h;
            LayoutTag();
        }

        /// <summary>
        /// The tag keeps the same size to the eye at any distance (Meta's guidance for panels
        /// that move in depth): its scale grows with the distance to the headset.
        /// </summary>
        private void KeepTagSizeToTheEye()
        {
            if (_hudContainer == null) return;
            if (_cameraTransform == null && Camera.main != null) _cameraTransform = Camera.main.transform;
            if (_cameraTransform == null) return;
            float d = Vector3.Distance(_cameraTransform.position, _hudContainer.transform.position);
            float s = Mathf.Clamp(d, 0.6f, 4f) * 0.001f;
            _hudContainer.transform.localScale = new Vector3(s, s, s);
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
            SetStatusBanner("Moving the tag: point where it should go and let go of the pinch", 10.0f, ShiroTheme.OkText);
            RefreshUiText();
        }

        // The tag, in mm as seen from 1 m (it scales with the distance, see KeepTagSizeToTheEye);
        // its height follows its lines (LayoutTag), TagH is the usual one
        private const float TagW = 260f;
        private const float TagH = 132f;
        private const float HeartRowY = 62f;
        private const float DetailsH = 208f;

        /// <summary>
        /// Builds the floor ring and the patient's tag (version 2, ShiroMR.UI).
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

            // 2. The tag: its bottom edge at the anchor point, so the details open upward
            //    (never into the bed or the person)
            _hudCanvas = ShiroUIKit.WorldCanvas("PatientTag", transform, new Vector2(TagW, TagH), new Vector2(0.5f, 0f));
            _hudContainer = _hudCanvas.gameObject;
            _hudContainer.transform.localPosition = hudOffset;
            _hudRect = (RectTransform)_hudContainer.transform;

            // The whole tag can be tapped (ray or fingertip): details open or close
            _cardButton = ShiroUIKit.Button(_hudContainer.transform, "Tag", null, ButtonKind.Surface, ToggleDetails);
            ShiroUIKit.Fill(_cardButton);
            _cardBackground = _cardButton.Background;
            Transform card = _cardButton.transform;

            // Status stripe on the left edge (red needs help, amber check, blue OK, grey not heard)
            _statusStripe = ShiroUIKit.Panel(card, "Status", ShiroTheme.Ok, 3.5f);
            var stripe = (RectTransform)_statusStripe.transform;
            stripe.anchorMin = new Vector2(0f, 0f);
            stripe.anchorMax = new Vector2(0f, 1f);
            stripe.pivot = new Vector2(0f, 0.5f);
            stripe.offsetMin = new Vector2(4f, 6f);
            stripe.offsetMax = new Vector2(11f, -6f);

            // Always shown, top to bottom: name (the whole width), bed and where, the heart
            // rate, its state in words (one or two lines), a flag line when one is shown
            _nameText = ShiroUIKit.Label(card, "Name", fullName, 22f, ShiroTheme.Text, FontStyles.Bold).Fit(14f);
            ShiroUIKit.Place(_nameText, 20, 10, TagW - 34, 28);
            _subText = ShiroUIKit.Label(card, "BedWhere", "", 14f, ShiroTheme.TextDim).Fit(11f);
            ShiroUIKit.Place(_subText, 20, 40, TagW - 34, 20);
            _bpmText = ShiroUIKit.Label(card, "Heart", "", 34f, ShiroTheme.Text, FontStyles.Bold);
            ShiroUIKit.Place(_bpmText, 20, HeartRowY, 110, 42);
            _bpmUnitText = ShiroUIKit.Label(card, "HeartUnit", "bpm", 14f, ShiroTheme.TextDim);
            _bpmUnitText.richText = true;
            ShiroUIKit.Place(_bpmUnitText, 20 + 40 + 8, HeartRowY + 17, 80, 20);
            _heartStateText = ShiroUIKit.Label(card, "HeartState", "", 14f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.TopLeft, true);
            _flagText = ShiroUIKit.Label(card, "Flag", "", 14f, ShiroTheme.WarnText, FontStyles.Bold);
            _flagText.gameObject.SetActive(false);

            // Details (after a tap)
            var details = new GameObject("Details", typeof(RectTransform));
            details.transform.SetParent(card, false);
            ShiroUIKit.Place(details.transform as RectTransform, 0, TagH, TagW, DetailsH);
            _detailsRoot = details;
            Transform d = details.transform;
            float w = TagW - 34f;
            ShiroUIKit.Place(ShiroUIKit.Panel(d, "Divider", ShiroTheme.Divider, 0f), 20, 0, w, 1.5f);
            _spo2Text = ShiroUIKit.Label(d, "Spo2", "", 14f, ShiroTheme.Text).Fit(11f);
            ShiroUIKit.Place(_spo2Text, 20, 8, w, 20);
            _batteryText = ShiroUIKit.Label(d, "Battery", "", 14f, ShiroTheme.Text).Fit(11f);
            ShiroUIKit.Place(_batteryText, 20, 30, w, 20);
            _motionBadgeText = ShiroUIKit.Label(d, "Motion", "", 14f, ShiroTheme.Text).Fit(11f);
            ShiroUIKit.Place(_motionBadgeText, 20, 52, w, 20);
            _trackingBadgeText = ShiroUIKit.Label(d, "Position", "", 14f, ShiroTheme.OkText).Fit(11f);
            ShiroUIKit.Place(_trackingBadgeText, 20, 74, w, 20);
            _statusBannerText = ShiroUIKit.Label(d, "PositionNote", "", 12f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.TopLeft, true).Fit(9f);
            ShiroUIKit.Place(_statusBannerText, 20, 96, w, 30);

            float bw = (w - 8f) / 2f;
            var move = ShiroUIKit.Button(d, "Move", "Move tag", ButtonKind.Secondary, StartPanelDrag, 12f);
            ShiroUIKit.Place(move, 20, 130, bw, 30);
            _moveHandleBtn = move.UiButton;
            _moveHandleBtnText = move.Label;

            var reattach = ShiroUIKit.Button(d, "Reattach", "Choose person", ButtonKind.Secondary, BeginManualAim, 12f);
            ShiroUIKit.Place(reattach, 28 + bw, 130, bw, 30);
            _reattachBtn = reattach.UiButton;
            _reattachBtnText = reattach.Label;

            // Second row, left: one of three, by state (head of bed / beside it, automatic, cancel)
            var dock = ShiroUIKit.Button(d, "Dock", "Beside bed", ButtonKind.Secondary, ToggleDockMode, 12f);
            ShiroUIKit.Place(dock, 20, 166, bw, 30);
            _dockToggleBtn = dock.UiButton;
            _dockToggleBtnText = dock.Label;

            var auto = ShiroUIKit.Button(d, "Auto", "Automatic", ButtonKind.Primary, ReturnToAuto, 12f);
            ShiroUIKit.Place(auto, 20, 166, bw, 30);
            _autoBtn = auto.UiButton;
            auto.gameObject.SetActive(false);

            var cancel = ShiroUIKit.Button(d, "CancelAim", "Cancel", ButtonKind.Danger, CancelManualAim, 12f);
            ShiroUIKit.Place(cancel, 20, 166, bw, 30);
            _cancelAimBtn = cancel.UiButton;
            _cancelAimBtnText = cancel.Label;
            cancel.gameObject.SetActive(false);

            var close = ShiroUIKit.Button(d, "Close", "Close", ButtonKind.Quiet, ToggleDetails, 12f);
            ShiroUIKit.Place(close, 28 + bw, 166, bw, 30);

            details.SetActive(false);
            RefreshUiText();
            FitHeartLine();
            LayoutTag();
        }
    }
}
