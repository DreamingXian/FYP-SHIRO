// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Ward Physical Alignment Tool: Interactive 2-Point Bed & Landmark Calibrator
// =============================================================================
using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.UI;

namespace ShiroMR
{
    public enum AlignmentStep
    {
        Idle,
        AimingHeadboard,
        AimingFootboard,
        AimingAnchorA,
        AimingAnchorB,
        AimingCornerA,
        AimingCornerB,
        AimingDoorLeft,
        AimingDoorRight,
        Completed
    }

    public class WardAlignmentTool : MonoBehaviour
    {
        public static WardAlignmentTool Instance { get; private set; }

        [Header("References")]
        public WardSpatialManager spatialManager;
        public WardVisualizer wardVisualizer;

        [Header("State")]
        public AlignmentStep currentStep = AlignmentStep.Idle;
        public WardBed selectedBed = null;
        public WardAnchor selectedAnchorA = null;
        public WardAnchor selectedAnchorB = null;
        public Vector3 recordedHeadboardPoint;
        public Vector3 recordedFootboardPoint;
        public Vector3 recordedAnchorAPoint;
        public Vector3 recordedAnchorBPoint;
        public Vector3 recordedCornerAPoint;
        public Vector3 recordedCornerBPoint;
        public Vector3 recordedDoorLeftPoint;
        public Vector3 recordedDoorRightPoint;
        public float lastMeasuredLength = 0f;
        public float lastCalculatedYaw = 0f;
        public bool isAligned = false;

        [Header("Door Alignment Perspective")]
        [Tooltip("True if the user is standing inside the ward looking at the door; False if in hallway entering the room.")]
        public bool isInsideRoomLookingAtDoor = true;

        private WardConfig _cachedWardConfig = null;
        public WardConfig CachedWardConfig => _cachedWardConfig;

        // UI GameObjects
        private GameObject _uiPanelRoot;
        private Text _statusBadgeText;
        private Text _instructionText;
        private Text _metricsText;
        private Transform _bedButtonsContainer;
        private GameObject _point1Marker;
        private GameObject _point2Marker;
        private LineRenderer _alignmentLine;

        private Camera _mainCam;
        private float _mattressElevation = 0.50f;

        private void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Destroy(gameObject);
                return;
            }
            Instance = this;
        }

        private void Start()
        {
            _mainCam = Camera.main;
            if (spatialManager == null) spatialManager = WardSpatialManager.Instance;
            if (wardVisualizer == null) wardVisualizer = FindObjectOfType<WardVisualizer>();

            BuildAlignmentUI();
            CreateMarkers();
            RepositionInFrontOfUser();

            // Try loading saved alignment
            if (ShiroNetworkManager.Instance != null)
            {
                ShiroNetworkManager.Instance.OnWardInitialized += (ward, subjects) =>
                {
                    _cachedWardConfig = ward;
                };
                if (_cachedWardConfig == null && ShiroNetworkManager.Instance.LastLoadedWardConfig != null)
                {
                    _cachedWardConfig = ShiroNetworkManager.Instance.LastLoadedWardConfig;
                }
            }

            if (spatialManager != null && ShiroNetworkManager.Instance != null)
            {
                string targetWard = ShiroNetworkManager.Instance.targetWardId;
                if (spatialManager.LoadAlignmentFromPrefs(targetWard))
                {
                    isAligned = true;
                    UpdateStatusUi("ALIGNED (Saved Preference)", new Color(0.1f, 0.9f, 0.4f));
                }
            }
        }

        private void Update()
        {
            if (_mainCam == null) _mainCam = Camera.main;

            // Update Line Renderer if markers are active
            if (_alignmentLine != null)
            {
                if (currentStep == AlignmentStep.AimingFootboard && _point1Marker != null && _point1Marker.activeSelf)
                {
                    _alignmentLine.enabled = true;
                    _alignmentLine.SetPosition(0, recordedHeadboardPoint);
                    _alignmentLine.SetPosition(1, GetCurrentAimPoint());
                }
                else if (currentStep == AlignmentStep.AimingAnchorB && _point1Marker != null && _point1Marker.activeSelf)
                {
                    _alignmentLine.enabled = true;
                    _alignmentLine.SetPosition(0, recordedAnchorAPoint);
                    _alignmentLine.SetPosition(1, GetCurrentAimPoint());
                }
                else if (currentStep == AlignmentStep.AimingCornerB && _point1Marker != null && _point1Marker.activeSelf)
                {
                    _alignmentLine.enabled = true;
                    _alignmentLine.SetPosition(0, recordedCornerAPoint);
                    _alignmentLine.SetPosition(1, GetCurrentAimPoint());
                }
                else if (currentStep == AlignmentStep.AimingDoorRight && _point1Marker != null && _point1Marker.activeSelf)
                {
                    _alignmentLine.enabled = true;
                    _alignmentLine.SetPosition(0, recordedDoorLeftPoint);
                    _alignmentLine.SetPosition(1, GetCurrentAimPoint());
                }
                else if (currentStep == AlignmentStep.Completed && _point1Marker != null && _point2Marker != null)
                {
                    _alignmentLine.enabled = true;
                    _alignmentLine.SetPosition(0, _point1Marker.transform.position);
                    _alignmentLine.SetPosition(1, _point2Marker.transform.position);
                }
                else
                {
                    _alignmentLine.enabled = false;
                }
            }

            // Keyboard testing & Input Handling
            HandleInput();
        }

        private void HandleInput()
        {
            // Toggle UI on 'C' key or VR Controller (B button / Y button / Menu button)
            bool toggleRequested = false;
#if ENABLE_INPUT_SYSTEM
            if (UnityEngine.InputSystem.Keyboard.current != null && UnityEngine.InputSystem.Keyboard.current.cKey.wasPressedThisFrame)
            {
                toggleRequested = true;
            }
            if (UnityEngine.InputSystem.Keyboard.current != null && UnityEngine.InputSystem.Keyboard.current.rKey.wasPressedThisFrame)
            {
                QuickReSync();
            }
#endif
            try
            {
                if (OVRInput.GetDown(OVRInput.Button.Two, OVRInput.Controller.RTouch) ||
                    OVRInput.GetDown(OVRInput.Button.Four, OVRInput.Controller.LTouch) ||
                    OVRInput.GetDown(OVRInput.Button.Start, OVRInput.Controller.LTouch))
                {
                    toggleRequested = true;
                }

                // Quick Re-Sync via Right Thumbstick Click
                if (OVRInput.GetDown(OVRInput.Button.PrimaryThumbstick, OVRInput.Controller.RTouch))
                {
                    QuickReSync();
                }
            }
            catch { }

            if (toggleRequested)
            {
                ToggleCalibrationUI();
            }

            // Trigger / Click handling during alignment steps
            if (currentStep == AlignmentStep.AimingHeadboard || currentStep == AlignmentStep.AimingFootboard ||
                currentStep == AlignmentStep.AimingAnchorA || currentStep == AlignmentStep.AimingAnchorB ||
                currentStep == AlignmentStep.AimingCornerA || currentStep == AlignmentStep.AimingCornerB ||
                currentStep == AlignmentStep.AimingDoorLeft || currentStep == AlignmentStep.AimingDoorRight)
            {
                bool triggerPressed = false;

                // 1. Universal VR Pointer (Touch Controller Trigger, A button, Hand Pinch)
                if (ShiroVRPointer.Instance != null && ShiroVRPointer.Instance.wasTriggerPressedThisFrame)
                {
                    // Only drop marker if aiming in room space, NOT on a UI button
                    if (!ShiroVRPointer.Instance.isHittingUi)
                    {
                        triggerPressed = true;
                    }
                }

                // 2. Editor Fallbacks (Space, Enter, Mouse)
#if ENABLE_INPUT_SYSTEM
                if (UnityEngine.InputSystem.Mouse.current != null && UnityEngine.InputSystem.Mouse.current.leftButton.wasPressedThisFrame)
                {
                    if (ShiroVRPointer.Instance == null || !ShiroVRPointer.Instance.isHittingUi)
                    {
                        triggerPressed = true;
                    }
                }
                if (UnityEngine.InputSystem.Keyboard.current != null && (UnityEngine.InputSystem.Keyboard.current.spaceKey.wasPressedThisFrame || UnityEngine.InputSystem.Keyboard.current.enterKey.wasPressedThisFrame))
                {
                    triggerPressed = true;
                }
#endif

                if (triggerPressed)
                {
                    Vector3 hitPt = GetCurrentAimPoint();
                    OnPointRegistered(hitPt);
                }
            }
        }

        public Vector3 GetCurrentAimPoint()
        {
            // Point is locked directly to the real physical hit point where the laser reticle is aiming!
            if (ShiroVRPointer.Instance != null && ShiroVRPointer.Instance.currentHitPoint != Vector3.zero)
            {
                return ShiroVRPointer.Instance.currentHitPoint;
            }

            Ray ray;
            if (_mainCam != null)
            {
#if ENABLE_INPUT_SYSTEM
                if (UnityEngine.InputSystem.Mouse.current != null)
                {
                    Vector2 mousePos = UnityEngine.InputSystem.Mouse.current.position.ReadValue();
                    ray = _mainCam.ScreenPointToRay(mousePos);
                }
                else
                {
                    ray = new Ray(_mainCam.transform.position, _mainCam.transform.forward);
                }
#else
                ray = new Ray(_mainCam.transform.position, _mainCam.transform.forward);
#endif
            }
            else
            {
                ray = new Ray(Vector3.up * 1.5f, Vector3.forward);
            }

            float floorY = ShiroVRPointer.GetPhysicalFloorHeight();
            if (ray.direction.y < -0.02f && ray.origin.y > (floorY + 0.02f))
            {
                float t = (floorY - ray.origin.y) / ray.direction.y;
                return new Vector3(ray.origin.x + ray.direction.x * t, floorY, ray.origin.z + ray.direction.z * t);
            }

            return ray.origin + ray.direction * 2.0f;
        }

        private void OnPointRegistered(Vector3 point)
        {
            // The landmark is registered EXACTLY at the physical 3D point the user aimed at!
            if (currentStep == AlignmentStep.AimingHeadboard)
            {
                recordedHeadboardPoint = point;
                _point1Marker.transform.position = point;
                _point1Marker.SetActive(true);

                currentStep = AlignmentStep.AimingFootboard;
                if (_instructionText != null)
                {
                    _instructionText.text = "👉 Step 2/2: Touch or Aim at Bed FOOTBOARD and Click/Trigger.\n(Thumbstick ↕ tunes distance, or walk up & touch)";
                    _instructionText.color = new Color(0.2f, 0.85f, 1.0f);
                }
                Debug.Log($"[SHIRO ALIGN] Registered Headboard Point: {point}");
            }
            else if (currentStep == AlignmentStep.AimingFootboard)
            {
                recordedFootboardPoint = point;
                _point2Marker.transform.position = point;
                _point2Marker.SetActive(true);

                ExecuteBedAlignment();
            }
            else if (currentStep == AlignmentStep.AimingAnchorA)
            {
                recordedAnchorAPoint = point;
                _point1Marker.transform.position = point;
                _point1Marker.SetActive(true);

                currentStep = AlignmentStep.AimingAnchorB;
                string bName = selectedAnchorB != null ? selectedAnchorB.anchor_id : "Node B";
                string bWall = selectedAnchorB != null ? selectedAnchorB.wall_location : "";
                if (_instructionText != null)
                {
                    _instructionText.text = $"👉 Step 2/2: Touch or Aim at Wall {bName} ({bWall}) & Trigger.\n(Thumbstick ↕ tunes distance, or walk up & touch)";
                    _instructionText.color = new Color(0.2f, 0.85f, 1.0f);
                }
                Debug.Log($"[SHIRO ALIGN] Registered Wall Anchor A Point: {point}");
            }
            else if (currentStep == AlignmentStep.AimingAnchorB)
            {
                recordedAnchorBPoint = point;
                _point2Marker.transform.position = point;
                _point2Marker.SetActive(true);

                ExecuteWallAnchorsAlignment();
            }
            else if (currentStep == AlignmentStep.AimingCornerA)
            {
                recordedCornerAPoint = point;
                _point1Marker.transform.position = point;
                _point1Marker.SetActive(true);

                currentStep = AlignmentStep.AimingCornerB;
                if (_instructionText != null)
                {
                    _instructionText.text = "👉 Step 2/2: Touch or Aim at North-West Corner (Along Left Wall) & Trigger.\n(Thumbstick ↕ tunes distance, or walk up & touch floor corner)";
                    _instructionText.color = new Color(0.2f, 0.85f, 1.0f);
                }
                Debug.Log($"[SHIRO ALIGN] Registered Corner A (South-West) Point: {point}");
            }
            else if (currentStep == AlignmentStep.AimingCornerB)
            {
                recordedCornerBPoint = point;
                _point2Marker.transform.position = point;
                _point2Marker.SetActive(true);

                ExecuteCornersAlignment();
            }
            else if (currentStep == AlignmentStep.AimingDoorLeft)
            {
                recordedDoorLeftPoint = point;
                _point1Marker.transform.position = point;
                _point1Marker.SetActive(true);

                currentStep = AlignmentStep.AimingDoorRight;
                if (_instructionText != null)
                {
                    _instructionText.text = "👉 Step 2/2: Point at Door Frame BOTTOM-RIGHT corner (floor level) & Trigger / Pinch.";
                    _instructionText.color = new Color(0.2f, 0.85f, 1.0f);
                }
                Debug.Log($"[SHIRO ALIGN] Registered Door Frame Left Point: {point}");
            }
            else if (currentStep == AlignmentStep.AimingDoorRight)
            {
                recordedDoorRightPoint = point;
                _point2Marker.transform.position = point;
                _point2Marker.SetActive(true);

                ExecuteDoorAlignment();
            }
        }

        private void ExecuteBedAlignment()
        {
            if (selectedBed == null)
            {
                Debug.LogWarning("[SHIRO ALIGN] No bed selected for alignment.");
                if (wardVisualizer != null)
                {
                    wardVisualizer.ToggleOverlay(true);
                    wardVisualizer.SetCollidersEnabled(true);
                }
                return;
            }

            if (spatialManager != null)
            {
                bool success = spatialManager.AlignWardByBedTwoPoints(
                    selectedBed,
                    recordedHeadboardPoint,
                    recordedFootboardPoint,
                    out lastMeasuredLength,
                    out lastCalculatedYaw
                );

                if (wardVisualizer != null)
                {
                    wardVisualizer.ToggleOverlay(true);
                    wardVisualizer.SetCollidersEnabled(true);
                }

                if (success)
                {
                    currentStep = AlignmentStep.Completed;
                    isAligned = true;

                    float expectedLen = selectedBed.length > 0 ? selectedBed.length : 2.00f;
                    float lenDiff = Mathf.Abs(lastMeasuredLength - expectedLen);

                    if (_instructionText != null)
                    {
                        _instructionText.text = $"✅ Aligned to {selectedBed.bed_code}!\nDigital twin now overlays physical room.";
                        _instructionText.color = new Color(0.1f, 0.95f, 0.4f);
                    }

                    if (_metricsText != null)
                    {
                        _metricsText.text = $"Measured Length: {lastMeasuredLength:F2}m (Config: {expectedLen:F2}m | Δ: {lenDiff:F2}m)\nCalculated Yaw: {lastCalculatedYaw:F1}° | Origin: {spatialManager.wardOrigin.position.x:F2}, {spatialManager.wardOrigin.position.z:F2}";
                    }

                    UpdateStatusUi("ALIGNED (" + selectedBed.bed_code + ")", new Color(0.1f, 0.9f, 0.4f));

                    if (ShiroNetworkManager.Instance != null)
                    {
                        spatialManager.SaveAlignmentToPrefs(ShiroNetworkManager.Instance.targetWardId);
                    }
                }
                else
                {
                    if (_instructionText != null)
                    {
                        _instructionText.text = "⚠️ Points were too close. Please try again.";
                        _instructionText.color = new Color(0.95f, 0.3f, 0.2f);
                    }
                    currentStep = AlignmentStep.Idle;
                }
            }
        }

        public void StartWallAnchorsCalibration()
        {
            StartWallAnchorsCalibration(null, null);
        }

        public void StartWallAnchorsCalibration(WardAnchor a, WardAnchor b)
        {
            if (_cachedWardConfig == null || _cachedWardConfig.anchors == null || _cachedWardConfig.anchors.Count < 2)
            {
                if (_instructionText != null)
                {
                    _instructionText.text = "⚠️ Need at least 2 wall anchors configured on the server.";
                    _instructionText.color = new Color(0.95f, 0.35f, 0.2f);
                }
                return;
            }

            selectedAnchorA = a ?? _cachedWardConfig.anchors[0];
            selectedAnchorB = b ?? _cachedWardConfig.anchors[1];

            // Detach stale anchor so old coordinates never override calibration
            if (spatialManager != null) spatialManager.DetachCurrentAnchor();

            currentStep = AlignmentStep.AimingAnchorA;

            // Hide unaligned overlay and disable colliders so virtual objects NEVER block physical walls!
            if (wardVisualizer != null)
            {
                wardVisualizer.ToggleOverlay(false);
                wardVisualizer.SetCollidersEnabled(false);
            }

            if (_point1Marker != null) _point1Marker.SetActive(false);
            if (_point2Marker != null) _point2Marker.SetActive(false);
            if (_alignmentLine != null) _alignmentLine.enabled = false;

            string aWall = !string.IsNullOrEmpty(selectedAnchorA.wall_location) ? $" ({selectedAnchorA.wall_location})" : "";
            if (_instructionText != null)
            {
                _instructionText.text = $"👉 Step 1/2: Touch or Aim at Wall {selectedAnchorA.anchor_id}{aWall} & Trigger.\n(Use Thumbstick ↕ to adjust distance or walk up & touch)";
                _instructionText.color = new Color(0.95f, 0.85f, 0.2f);
            }

            if (_metricsText != null)
            {
                float dx = selectedAnchorB.x - selectedAnchorA.x;
                float dy = selectedAnchorB.y - selectedAnchorA.y;
                float expectedDist = Mathf.Sqrt(dx * dx + dy * dy);
                _metricsText.text = $"Baseline: Wall {selectedAnchorA.anchor_id} -> {selectedAnchorB.anchor_id} (Config Dist: {expectedDist:F2}m)";
            }

            UpdateStatusUi($"CALIBRATING ({selectedAnchorA.anchor_id}->{selectedAnchorB.anchor_id})...", new Color(0.95f, 0.8f, 0.1f));
        }

        private void ExecuteWallAnchorsAlignment()
        {
            if (spatialManager != null && selectedAnchorA != null && selectedAnchorB != null)
            {
                bool success = spatialManager.AlignWardByWallAnchors(
                    selectedAnchorA,
                    selectedAnchorB,
                    recordedAnchorAPoint,
                    recordedAnchorBPoint,
                    out lastMeasuredLength,
                    out lastCalculatedYaw
                );

                if (wardVisualizer != null)
                {
                    wardVisualizer.ToggleOverlay(true);
                    wardVisualizer.SetCollidersEnabled(true);
                }

                if (success)
                {
                    currentStep = AlignmentStep.Completed;
                    isAligned = true;

                    float dx = selectedAnchorB.x - selectedAnchorA.x;
                    float dy = selectedAnchorB.y - selectedAnchorA.y;
                    float expectedDist = Mathf.Sqrt(dx * dx + dy * dy);
                    float diff = Mathf.Abs(lastMeasuredLength - expectedDist);

                    if (_instructionText != null)
                    {
                        _instructionText.text = $"✅ Aligned to Wall Nodes {selectedAnchorA.anchor_id} & {selectedAnchorB.anchor_id}!\nDigital twin permanently locked to physical anchors.";
                        _instructionText.color = new Color(0.1f, 0.95f, 0.4f);
                    }

                    if (_metricsText != null)
                    {
                        _metricsText.text = $"Measured Dist: {lastMeasuredLength:F2}m (Expected: {expectedDist:F2}m | Δ: {diff:F2}m)\nYaw: {lastCalculatedYaw:F1}° | Origin: {spatialManager.wardOrigin.position.x:F2}, {spatialManager.wardOrigin.position.z:F2}";
                    }

                    UpdateStatusUi("ALIGNED (WALL NODES)", new Color(0.1f, 0.9f, 0.4f));

                    if (ShiroNetworkManager.Instance != null)
                    {
                        spatialManager.SaveAlignmentToPrefs(ShiroNetworkManager.Instance.targetWardId);
                    }
                }
                else
                {
                    if (_instructionText != null)
                    {
                        _instructionText.text = "⚠️ Wall anchor points were too close. Please try again.";
                        _instructionText.color = new Color(0.95f, 0.3f, 0.2f);
                    }
                    currentStep = AlignmentStep.Idle;
                }
            }
        }

        public void StartCornersCalibration()
        {
            if (spatialManager != null) spatialManager.DetachCurrentAnchor();

            currentStep = AlignmentStep.AimingCornerA;

            // Hide unaligned overlay so virtual objects NEVER block physical corners!
            if (wardVisualizer != null)
            {
                wardVisualizer.ToggleOverlay(false);
                wardVisualizer.SetCollidersEnabled(false);
            }

            if (_point1Marker != null) _point1Marker.SetActive(false);
            if (_point2Marker != null) _point2Marker.SetActive(false);
            if (_alignmentLine != null) _alignmentLine.enabled = false;

            if (_instructionText != null)
            {
                _instructionText.text = "👉 Step 1/2: Touch or Aim at South-West Corner (Origin: 0,0) & Trigger.\n(Thumbstick ↕ tunes distance, or walk up & touch floor corner)";
                _instructionText.color = new Color(0.95f, 0.85f, 0.2f);
            }

            float expectedLen = (_cachedWardConfig != null && _cachedWardConfig.width_y > 0) ? _cachedWardConfig.width_y : 5.0f;
            if (_metricsText != null)
            {
                _metricsText.text = $"Target Baseline: Corner SW -> Corner NW (Ward Length: {expectedLen:F2}m)";
            }

            UpdateStatusUi("CALIBRATING (ROOM CORNERS)...", new Color(0.95f, 0.8f, 0.1f));
        }

        private void ExecuteCornersAlignment()
        {
            float expectedLen = (_cachedWardConfig != null && _cachedWardConfig.width_y > 0) ? _cachedWardConfig.width_y : 5.0f;
            if (spatialManager != null)
            {
                bool success = spatialManager.AlignWardByTwoCorners(
                    recordedCornerAPoint,
                    recordedCornerBPoint,
                    expectedLen,
                    out lastMeasuredLength,
                    out lastCalculatedYaw
                );

                if (wardVisualizer != null)
                {
                    wardVisualizer.ToggleOverlay(true);
                    wardVisualizer.SetCollidersEnabled(true);
                }

                if (success)
                {
                    currentStep = AlignmentStep.Completed;
                    isAligned = true;

                    float diff = Mathf.Abs(lastMeasuredLength - expectedLen);
                    if (_instructionText != null)
                    {
                        _instructionText.text = "✅ Room Aligned by Room Corners (SW -> NW)!\nOrigin snaps directly to corner, zero drift.";
                        _instructionText.color = new Color(0.1f, 0.95f, 0.4f);
                    }
                    if (_metricsText != null)
                    {
                        _metricsText.text = $"Wall Length: {lastMeasuredLength:F2}m (Expected: {expectedLen:F2}m | Δ: {diff:F2}m)\nYaw: {lastCalculatedYaw:F1}° | Origin: {spatialManager.wardOrigin.position.x:F2}, {spatialManager.wardOrigin.position.z:F2}";
                    }
                    UpdateStatusUi("ALIGNED (CORNERS SW->NW)", new Color(0.1f, 0.9f, 0.4f));

                    if (ShiroNetworkManager.Instance != null)
                    {
                        spatialManager.SaveAlignmentToPrefs(ShiroNetworkManager.Instance.targetWardId);
                    }
                }
                else
                {
                    if (_instructionText != null)
                    {
                        _instructionText.text = "⚠️ Corner points were too close. Please try again.";
                        _instructionText.color = new Color(0.95f, 0.3f, 0.2f);
                    }
                    currentStep = AlignmentStep.Idle;
                }
            }
        }

        public void StartDoorCalibration()
        {
            if (_cachedWardConfig == null)
            {
                if (spatialManager != null && spatialManager.GetCachedWardConfig() != null)
                    _cachedWardConfig = spatialManager.GetCachedWardConfig();
                else if (ShiroNetworkManager.Instance != null && ShiroNetworkManager.Instance.LastLoadedWardConfig != null)
                    _cachedWardConfig = ShiroNetworkManager.Instance.LastLoadedWardConfig;
            }

            if (_cachedWardConfig == null || _cachedWardConfig.door == null)
            {
                if (_instructionText != null)
                {
                    _instructionText.text = "⚠️ No door configuration found for this ward.";
                    _instructionText.color = new Color(0.95f, 0.35f, 0.2f);
                }
                return;
            }

            // Detach stale anchor so old coordinates never override calibration
            if (spatialManager != null) spatialManager.DetachCurrentAnchor();

            currentStep = AlignmentStep.AimingDoorLeft;

            // Hide unaligned overlay and disable colliders so virtual objects NEVER block physical doorway!
            if (wardVisualizer != null)
            {
                wardVisualizer.ToggleOverlay(false);
                wardVisualizer.SetCollidersEnabled(false);
            }
            if (_point1Marker != null) _point1Marker.SetActive(false);
            if (_point2Marker != null) _point2Marker.SetActive(false);
            if (_alignmentLine != null) _alignmentLine.enabled = false;

            float dw = _cachedWardConfig.door.width > 0 ? _cachedWardConfig.door.width : 0.90f;
            string wall = !string.IsNullOrEmpty(_cachedWardConfig.door.wall) ? _cachedWardConfig.door.wall : "SOUTH";
            string viewStr = isInsideRoomLookingAtDoor ? "Inside Ward looking at door" : "In Hallway entering room";

            if (_instructionText != null)
            {
                _instructionText.text = $"👉 Step 1/2: Point at Door Frame BOTTOM-LEFT corner (floor level) & Trigger / Pinch.\n({viewStr} - {wall} Wall)";
                _instructionText.color = new Color(0.95f, 0.85f, 0.2f);
            }

            if (_metricsText != null)
            {
                _metricsText.text = $"Door: {wall} Wall ({dw:F2}m at Pos {_cachedWardConfig.door.x:F2}m) | View: {(isInsideRoomLookingAtDoor ? "Inside Ward" : "Hallway")}";
            }

            UpdateStatusUi("CALIBRATING (DOOR FRAME)...", new Color(0.95f, 0.8f, 0.1f));
        }

        private void ExecuteDoorAlignment()
        {
            if (spatialManager != null && _cachedWardConfig != null && _cachedWardConfig.door != null)
            {
                bool success = spatialManager.AlignWardByDoorFrame(
                    _cachedWardConfig,
                    recordedDoorLeftPoint,
                    recordedDoorRightPoint,
                    isInsideRoomLookingAtDoor,
                    out lastMeasuredLength,
                    out lastCalculatedYaw
                );

                if (wardVisualizer != null)
                {
                    wardVisualizer.ToggleOverlay(true);
                    wardVisualizer.SetCollidersEnabled(true);
                }

                if (success)
                {
                    currentStep = AlignmentStep.Completed;
                    isAligned = true;

                    float expectedW = _cachedWardConfig.door.width > 0 ? _cachedWardConfig.door.width : 0.90f;
                    float diff = Mathf.Abs(lastMeasuredLength - expectedW);

                    if (_instructionText != null)
                    {
                        _instructionText.text = "✅ Aligned to Door Frame in < 5 seconds!\nRoom origin & orientation locked directly from entrance.";
                        _instructionText.color = new Color(0.1f, 0.95f, 0.4f);
                    }

                    if (_metricsText != null)
                    {
                        _metricsText.text = $"Door Width: {lastMeasuredLength:F2}m (Expected: {expectedW:F2}m | Δ: {diff:F2}m)\nYaw: {lastCalculatedYaw:F1}° | Origin: {spatialManager.wardOrigin.position.x:F2}, {spatialManager.wardOrigin.position.z:F2}";
                    }

                    UpdateStatusUi("ALIGNED (DOOR FRAME)", new Color(0.1f, 0.9f, 0.4f));

                    if (ShiroNetworkManager.Instance != null)
                    {
                        spatialManager.SaveAlignmentToPrefs(ShiroNetworkManager.Instance.targetWardId);
                    }
                }
                else
                {
                    if (_instructionText != null)
                    {
                        _instructionText.text = "⚠️ Door frame points were too close. Please try again.";
                        _instructionText.color = new Color(0.95f, 0.3f, 0.2f);
                    }
                    currentStep = AlignmentStep.Idle;
                }
            }
        }

        public void StartBedCalibration(WardBed bed)
        {
            selectedBed = bed;

            // Detach stale anchor so old coordinates never override calibration
            if (spatialManager != null) spatialManager.DetachCurrentAnchor();

            currentStep = AlignmentStep.AimingHeadboard;

            // Hide unaligned overlay and disable colliders so virtual objects NEVER block physical bed!
            if (wardVisualizer != null)
            {
                wardVisualizer.ToggleOverlay(false);
                wardVisualizer.SetCollidersEnabled(false);
            }

            if (_point1Marker != null) _point1Marker.SetActive(false);
            if (_point2Marker != null) _point2Marker.SetActive(false);
            if (_alignmentLine != null) _alignmentLine.enabled = false;

            if (_instructionText != null)
            {
                _instructionText.text = $"👉 Step 1/2: Touch or Aim at {bed.bed_code} HEADBOARD center (pillow side) & Trigger.\n(Thumbstick ↕ tunes distance, or walk up & touch)";
                _instructionText.color = new Color(0.95f, 0.85f, 0.2f);
            }

            if (_metricsText != null)
            {
                _metricsText.text = $"Target: {bed.bed_code} ({bed.width:F2}m × {bed.length:F2}m, {bed.rotation_deg}°)";
            }

            UpdateStatusUi("CALIBRATING...", new Color(0.95f, 0.8f, 0.1f));
        }

        public void ResetAlignment()
        {
            PurgeAnchorAndResetAlignment();
        }

        /// <summary>
        /// Complete Purge & Reset: Cleans up local anchor, deletes PlayerPrefs, purges server anchor DB, and hides digital twin.
        /// </summary>
        public void PurgeAnchorAndResetAlignment()
        {
            if (spatialManager != null) spatialManager.ResetAlignment();
            if (wardVisualizer != null)
            {
                wardVisualizer.ToggleOverlay(false);
                wardVisualizer.SetCollidersEnabled(false);
            }
            currentStep = AlignmentStep.Idle;
            isAligned = false;

            if (_point1Marker != null) _point1Marker.SetActive(false);
            if (_point2Marker != null) _point2Marker.SetActive(false);
            if (_alignmentLine != null) _alignmentLine.enabled = false;

            string wardId = ShiroNetworkManager.Instance != null ? ShiroNetworkManager.Instance.targetWardId : "WARD-005";
            StartCoroutine(SendAnchorToServerRoutine(wardId, ""));

            UpdateStatusUi("UNALIGNED (Anchor Cleared)", new Color(0.95f, 0.45f, 0.2f));
            if (_instructionText != null)
            {
                _instructionText.text = "🗑️ Anchor & alignment purged! You can now calibrate fresh with the door frame.";
                _instructionText.color = new Color(0.95f, 0.85f, 0.2f);
            }
            if (_metricsText != null)
            {
                _metricsText.text = "Origin reset to (0,0,0). Digital twin disabled until re-calibrated.";
            }
            Debug.Log("[SHIRO ALIGN] Native anchor purged and room alignment reset.");
        }

        /// <summary>
        /// 1-Click Instant Re-Sync: Restores saved room calibration immediately.
        /// Useful when taking off the headset and putting it back on.
        /// </summary>
        public void QuickReSync()
        {
            if (spatialManager != null)
            {
                bool ok = spatialManager.ReSyncAlignment();
                if (ok)
                {
                    isAligned = true;
                    if (wardVisualizer != null)
                {
                    wardVisualizer.ToggleOverlay(true);
                    wardVisualizer.SetCollidersEnabled(true);
                }
                    UpdateStatusUi("RE-SYNCED (Saved Preference)", new Color(0.1f, 0.95f, 0.4f));
                    if (_instructionText != null)
                    {
                        _instructionText.text = "⚡ Ward digital twin re-locked to saved coordinates!\n(Tracking recenter compensated)";
                        _instructionText.color = new Color(0.1f, 0.95f, 0.4f);
                    }
                }
                else
                {
                    if (_instructionText != null)
                    {
                        _instructionText.text = "⚠️ No saved alignment found yet. Please calibrate first.";
                        _instructionText.color = new Color(0.95f, 0.5f, 0.2f);
                    }
                }
            }
        }

        public async void SavePersistentAnchor()
        {
            if (!isAligned || spatialManager == null) return;

            string wardId = ShiroNetworkManager.Instance != null ? ShiroNetworkManager.Instance.targetWardId : "WARD-005";
            if (_instructionText != null)
            {
                _instructionText.text = "⏳ Binding to Meta Quest SLAM Vision Map...";
                _instructionText.color = new Color(0.95f, 0.85f, 0.2f);
            }

            string realUuid = await spatialManager.SaveNativeSpatialAnchorAsync(wardId);
            string anchorUuid = !string.IsNullOrEmpty(realUuid) ? realUuid : $"ANCHOR-{wardId}-{DateTime.UtcNow.Ticks.ToString().Substring(10)}";

            StartCoroutine(SendAnchorToServerRoutine(wardId, anchorUuid));
        }

        private IEnumerator SendAnchorToServerRoutine(string wardId, string anchorUuid)
        {
            if (ShiroNetworkManager.Instance == null) yield break;
            string url = $"http://{ShiroNetworkManager.Instance.serverIp}:{ShiroNetworkManager.Instance.serverPort}/api/ward/save-anchor";

            string json = $"{{\"ward_id\":\"{wardId}\",\"spatial_anchor_uuid\":\"{anchorUuid}\"}}";
            byte[] bodyRaw = Encoding.UTF8.GetBytes(json);

            using (UnityWebRequest req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(bodyRaw);
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 5;

                yield return req.SendWebRequest();
                if (req.result == UnityWebRequest.Result.Success)
                {
                    Debug.Log($"[SHIRO ALIGN] Persistent Spatial Anchor synced to Edge Server: {anchorUuid}");
                    if (_instructionText != null)
                    {
                        _instructionText.text = "💾 Native Spatial Anchor synced to Hospital DB!\nAuto-restores on restart & headset re-mount.";
                        _instructionText.color = new Color(0.1f, 0.95f, 0.4f);
                    }
                }
                else
                {
                    Debug.LogWarning($"[SHIRO ALIGN] Could not sync anchor to server: {req.error}");
                }
            }
        }

        public void ToggleCalibrationUI()
        {
            if (ShiroHandSlate.Instance != null)
            {
                ShiroHandSlate.Instance.ToggleSlateVisibility();
                if (_uiPanelRoot != null) _uiPanelRoot.SetActive(false);
                return;
            }

            if (_uiPanelRoot != null)
            {
                bool active = !_uiPanelRoot.activeSelf;
                _uiPanelRoot.SetActive(active);

                if (active)
                {
                    RepositionInFrontOfUser();
                }
            }
        }

        public void RepositionInFrontOfUser()
        {
            if (_uiPanelRoot == null) return;
            if (_mainCam == null) _mainCam = Camera.main;
            if (_mainCam == null) return;

            Vector3 camPos = _mainCam.transform.position;
            Vector3 camFwd = _mainCam.transform.forward;
            camFwd.y = 0;
            if (camFwd.sqrMagnitude < 0.01f) camFwd = Vector3.forward;
            camFwd.Normalize();

            // Position 1.1m in front of user at comfortable eye level
            _uiPanelRoot.transform.position = camPos + camFwd * 1.1f + Vector3.up * 0.05f;
            _uiPanelRoot.transform.rotation = Quaternion.LookRotation(camFwd);
        }

        public void PopulateBedsFromWard(WardConfig ward)
        {
            if (_bedButtonsContainer == null || ward == null) return;
            _cachedWardConfig = ward;

            // Clear old buttons
            foreach (Transform child in _bedButtonsContainer)
            {
                Destroy(child.gameObject);
            }

            // 1. Prominent Entrance Alignment: Door Frame (Bottom Left -> Right, < 5 sec)
            if (ward.door != null)
            {
                CreateSelectionButton(_bedButtonsContainer, "🚪 Door Frame (L->R)", new Color(0.08f, 0.42f, 0.50f, 0.95f), StartDoorCalibration);
                CreateSelectionButton(_bedButtonsContainer, isInsideRoomLookingAtDoor ? "👀 View: Inside Ward" : "👀 View: In Hallway", new Color(0.12f, 0.35f, 0.45f, 0.95f), () =>
                {
                    isInsideRoomLookingAtDoor = !isInsideRoomLookingAtDoor;
                    PopulateBedsFromWard(_cachedWardConfig);
                });
            }

            // 2. Wall Anchors Button (Node A -> Node B: North Wall)
            if (ward.anchors != null && ward.anchors.Count >= 2)
            {
                var a0 = ward.anchors[0];
                var a1 = ward.anchors[1];
                CreateSelectionButton(_bedButtonsContainer, $"🔗 Wall {a0.anchor_id}->{a1.anchor_id}", new Color(0.22f, 0.14f, 0.38f, 0.95f), () =>
                {
                    StartWallAnchorsCalibration(a0, a1);
                });

                // If 3+ anchors, also provide Node A -> Node C (Side Wall)
                if (ward.anchors.Count >= 3)
                {
                    var a2 = ward.anchors[2];
                    CreateSelectionButton(_bedButtonsContainer, $"🔗 Wall {a0.anchor_id}->{a2.anchor_id}", new Color(0.18f, 0.18f, 0.42f, 0.95f), () =>
                    {
                        StartWallAnchorsCalibration(a0, a2);
                    });
                }
            }

            // 3. Room Corners Button (South-West to North-West)
            CreateSelectionButton(_bedButtonsContainer, "📐 Corners (SW->NW)", new Color(0.12f, 0.30f, 0.25f, 0.95f), StartCornersCalibration);

            // 4. Hospital Bed Buttons
            if (ward.beds != null)
            {
                foreach (var b in ward.beds)
                {
                    var bedCopy = b;
                    CreateSelectionButton(_bedButtonsContainer, $"🛏️ {b.bed_code} ({b.width:F1}×{b.length:F1}m)", new Color(0.12f, 0.18f, 0.28f, 0.95f), () =>
                    {
                        StartBedCalibration(bedCopy);
                    });
                }

                if (ward.beds.Count > 0)
                {
                    selectedBed = ward.beds[0];
                }
            }

            // 4. Auto-restore Native Spatial Anchor if UUID is present in ward
            if (!string.IsNullOrEmpty(ward.spatial_anchor_uuid) && spatialManager != null)
            {
                TryAutoRestoreNativeAnchor(ward.spatial_anchor_uuid);
            }
        }

        private void CreateSelectionButton(Transform parent, string label, Color bgCol, Action onClick)
        {
            GameObject btnObj = new GameObject($"Btn_{label}");
            btnObj.transform.SetParent(parent, false);

            var img = btnObj.AddComponent<Image>();
            img.color = bgCol;

            var btn = btnObj.AddComponent<Button>();
            btn.targetGraphic = img;

            ColorBlock colors = btn.colors;
            colors.highlightedColor = new Color(0.06f, 0.71f, 0.83f, 0.8f);
            colors.pressedColor = new Color(0.04f, 0.50f, 0.65f, 1.0f);
            btn.colors = colors;

            btn.onClick.AddListener(() => onClick?.Invoke());

            RectTransform rt = btnObj.GetComponent<RectTransform>();
            rt.sizeDelta = new Vector2(136, 32);

            BoxCollider box = btnObj.AddComponent<BoxCollider>();
            box.size = new Vector3(136f, 32f, 4f);
            box.center = Vector3.zero;

            GameObject textObj = new GameObject("Text");
            textObj.transform.SetParent(btnObj.transform, false);
            var t = textObj.AddComponent<Text>();
            t.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            t.fontSize = 10;
            t.fontStyle = FontStyle.Bold;
            t.alignment = TextAnchor.MiddleCenter;
            t.color = Color.white;
            t.text = label;

            RectTransform textRt = textObj.GetComponent<RectTransform>();
            textRt.anchorMin = Vector2.zero;
            textRt.anchorMax = Vector2.one;
            textRt.sizeDelta = Vector2.zero;
        }

        private async void TryAutoRestoreNativeAnchor(string uuid)
        {
            if (spatialManager == null) return;
            if (await spatialManager.LoadNativeSpatialAnchorAsync(uuid))
            {
                isAligned = true;
                UpdateStatusUi("AUTO-ALIGNED (Native Spatial Anchor)", new Color(0.1f, 0.95f, 0.4f));
                if (_instructionText != null)
                {
                    _instructionText.text = "🎯 Auto-localized to physical room via Meta Quest SLAM map!";
                    _instructionText.color = new Color(0.1f, 0.95f, 0.4f);
                }
            }
        }

        private void UpdateStatusUi(string status, Color col)
        {
            if (_statusBadgeText != null)
            {
                _statusBadgeText.text = status;
                _statusBadgeText.color = col;
            }
        }

        private void CreateMarkers()
        {
            // Point 1: Headboard (Emerald Green)
            _point1Marker = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            _point1Marker.name = "Point1_HeadboardMarker";
            _point1Marker.transform.localScale = new Vector3(0.10f, 0.10f, 0.10f);
            Destroy(_point1Marker.GetComponent<Collider>());
            var r1 = _point1Marker.GetComponent<Renderer>();
            if (r1 != null) r1.material.color = new Color(0.1f, 0.95f, 0.4f);
            _point1Marker.SetActive(false);

            // Point 2: Footboard (Cyan Blue)
            _point2Marker = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            _point2Marker.name = "Point2_FootboardMarker";
            _point2Marker.transform.localScale = new Vector3(0.10f, 0.10f, 0.10f);
            Destroy(_point2Marker.GetComponent<Collider>());
            var r2 = _point2Marker.GetComponent<Renderer>();
            if (r2 != null) r2.material.color = new Color(0.2f, 0.8f, 1.0f);
            _point2Marker.SetActive(false);

            // Alignment Axis Line
            GameObject lineObj = new GameObject("AlignmentLine");
            _alignmentLine = lineObj.AddComponent<LineRenderer>();
            _alignmentLine.startWidth = 0.015f;
            _alignmentLine.endWidth = 0.015f;
            _alignmentLine.positionCount = 2;
            _alignmentLine.material = new Material(Shader.Find("Sprites/Default"));
            _alignmentLine.startColor = new Color(0.1f, 0.9f, 0.5f, 0.8f);
            _alignmentLine.endColor = new Color(0.2f, 0.8f, 1.0f, 0.8f);
            _alignmentLine.enabled = false;
        }

        private void EnsureEventSystem()
        {
            if (UnityEngine.EventSystems.EventSystem.current == null)
            {
                GameObject esObj = new GameObject("EventSystem");
                esObj.AddComponent<UnityEngine.EventSystems.EventSystem>();
#if ENABLE_INPUT_SYSTEM
                esObj.AddComponent<UnityEngine.InputSystem.UI.InputSystemUIInputModule>();
#elif ENABLE_LEGACY_INPUT_MANAGER
                esObj.AddComponent<UnityEngine.EventSystems.StandaloneInputModule>();
#endif
            }
        }

        private void BuildAlignmentUI()
        {
            EnsureEventSystem();
            _uiPanelRoot = new GameObject("WardAlignmentCanvas");
            Canvas canvas = _uiPanelRoot.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.WorldSpace;
            _uiPanelRoot.AddComponent<CanvasScaler>();
            _uiPanelRoot.AddComponent<GraphicRaycaster>();

            RectTransform rect = _uiPanelRoot.GetComponent<RectTransform>();
            rect.sizeDelta = new Vector2(460, 320);
            rect.localScale = new Vector3(0.002f, 0.002f, 0.002f); // ~92cm wide comfortable dialog

            // Card Background
            GameObject bgObj = new GameObject("PanelBg");
            bgObj.transform.SetParent(_uiPanelRoot.transform, false);
            var bgImg = bgObj.AddComponent<Image>();
            bgImg.color = new Color(0.06f, 0.09f, 0.16f, 0.92f); // Dark clinical slate
            RectTransform bgRect = bgObj.GetComponent<RectTransform>();
            bgRect.anchorMin = Vector2.zero;
            bgRect.anchorMax = Vector2.one;
            bgRect.sizeDelta = Vector2.zero;

            Font defaultFont = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");

            // Title
            GameObject titleObj = new GameObject("Title");
            titleObj.transform.SetParent(bgObj.transform, false);
            var title = titleObj.AddComponent<Text>();
            title.font = defaultFont;
            title.fontSize = 17;
            title.fontStyle = FontStyle.Bold;
            title.color = Color.white;
            title.text = "🎯 Ward Physical Room Alignment";
            RectTransform tRt = titleObj.GetComponent<RectTransform>();
            tRt.anchoredPosition = new Vector2(0, 130);
            tRt.sizeDelta = new Vector2(430, 28);

            // Status Badge
            GameObject statusObj = new GameObject("StatusBadge");
            statusObj.transform.SetParent(bgObj.transform, false);
            _statusBadgeText = statusObj.AddComponent<Text>();
            _statusBadgeText.font = defaultFont;
            _statusBadgeText.fontSize = 12;
            _statusBadgeText.fontStyle = FontStyle.Bold;
            _statusBadgeText.text = "NOT ALIGNED (Default Origin)";
            _statusBadgeText.color = new Color(0.95f, 0.6f, 0.1f);
            RectTransform sRt = statusObj.GetComponent<RectTransform>();
            sRt.anchoredPosition = new Vector2(0, 105);
            sRt.sizeDelta = new Vector2(430, 20);

            // Horizontal Selection Container
            GameObject bedContainerObj = new GameObject("BedButtonsContainer");
            bedContainerObj.transform.SetParent(bgObj.transform, false);
            var hl = bedContainerObj.AddComponent<HorizontalLayoutGroup>();
            hl.spacing = 6;
            hl.childAlignment = TextAnchor.MiddleCenter;
            hl.childControlWidth = false;
            hl.childControlHeight = false;
            _bedButtonsContainer = bedContainerObj.transform;
            RectTransform bcRt = bedContainerObj.GetComponent<RectTransform>();
            bcRt.anchoredPosition = new Vector2(0, 70);
            bcRt.sizeDelta = new Vector2(440, 36);

            // Instructions Box
            GameObject instObj = new GameObject("InstructionBox");
            instObj.transform.SetParent(bgObj.transform, false);
            _instructionText = instObj.AddComponent<Text>();
            _instructionText.font = defaultFont;
            _instructionText.fontSize = 12;
            _instructionText.alignment = TextAnchor.MiddleCenter;
            _instructionText.color = new Color(0.85f, 0.9f, 0.95f);
            _instructionText.text = "Select an alignment method above (Door Frame, Wall Nodes, Corners, or Bed).\nFloor auto-snaps! Pure Hand: Left Hand reaches forward/back to tune ray depth.";
            RectTransform iRt = instObj.GetComponent<RectTransform>();
            iRt.anchoredPosition = new Vector2(0, 15);
            iRt.sizeDelta = new Vector2(430, 48);

            // Metrics Box
            GameObject mObj = new GameObject("MetricsBox");
            mObj.transform.SetParent(bgObj.transform, false);
            _metricsText = mObj.AddComponent<Text>();
            _metricsText.font = defaultFont;
            _metricsText.fontSize = 11;
            _metricsText.alignment = TextAnchor.MiddleCenter;
            _metricsText.color = new Color(0.6f, 0.75f, 0.9f);
            _metricsText.text = "";
            RectTransform mRt = mObj.GetComponent<RectTransform>();
            mRt.anchoredPosition = new Vector2(0, -32);
            mRt.sizeDelta = new Vector2(430, 36);

            // Bottom Action Buttons Row
            GameObject actionsRow = new GameObject("ActionsRow");
            actionsRow.transform.SetParent(bgObj.transform, false);
            var aHl = actionsRow.AddComponent<HorizontalLayoutGroup>();
            aHl.spacing = 8;
            aHl.childAlignment = TextAnchor.MiddleCenter;
            aHl.childControlWidth = false;
            aHl.childControlHeight = false;
            RectTransform aRt = actionsRow.GetComponent<RectTransform>();
            aRt.anchoredPosition = new Vector2(0, -100);
            aRt.sizeDelta = new Vector2(440, 38);

            CreateActionButton(actionsRow.transform, "Start Calibration", new Color(0.06f, 0.71f, 0.83f), () =>
            {
                if (_cachedWardConfig != null && _cachedWardConfig.door != null) StartDoorCalibration();
                else if (selectedBed != null) StartBedCalibration(selectedBed);
                else StartCornersCalibration();
            });

            CreateActionButton(actionsRow.transform, "📌 Re-Sync", new Color(0.18f, 0.45f, 0.85f), QuickReSync);
            CreateActionButton(actionsRow.transform, "Save Anchor", new Color(0.1f, 0.7f, 0.4f), SavePersistentAnchor);
            CreateActionButton(actionsRow.transform, "Reset Origin", new Color(0.8f, 0.3f, 0.2f), ResetAlignment);
            CreateActionButton(actionsRow.transform, "Close", new Color(0.3f, 0.35f, 0.45f), ToggleCalibrationUI);

            // Initial position: 1.2m forward, default inactive so Hand Slate is primary UI
            _uiPanelRoot.transform.position = new Vector3(0, 1.4f, 1.2f);
            _uiPanelRoot.SetActive(false);
        }

        private void CreateActionButton(Transform parent, string label, Color bgCol, Action onClick)
        {
            GameObject btnObj = new GameObject($"Btn_{label}");
            btnObj.transform.SetParent(parent, false);

            var img = btnObj.AddComponent<Image>();
            img.color = bgCol;

            var btn = btnObj.AddComponent<Button>();
            btn.targetGraphic = img;
            btn.onClick.AddListener(() => onClick?.Invoke());

            RectTransform rt = btnObj.GetComponent<RectTransform>();
            rt.sizeDelta = new Vector2(76, 32);

            // Add 3D BoxCollider for direct VR laser raycasting
            BoxCollider box = btnObj.AddComponent<BoxCollider>();
            box.size = new Vector3(76f, 32f, 4f);
            box.center = Vector3.zero;

            GameObject textObj = new GameObject("Text");
            textObj.transform.SetParent(btnObj.transform, false);
            var t = textObj.AddComponent<Text>();
            t.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            t.fontSize = 10;
            t.fontStyle = FontStyle.Bold;
            t.alignment = TextAnchor.MiddleCenter;
            t.color = Color.white;
            t.text = label;

            RectTransform textRt = textObj.GetComponent<RectTransform>();
            textRt.anchorMin = Vector2.zero;
            textRt.anchorMax = Vector2.one;
            textRt.sizeDelta = Vector2.zero;
        }
    }
}
