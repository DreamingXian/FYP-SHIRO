// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Hand-Mounted Holographic Control Slate & Direct Touch ("Poke") Interactor
// =============================================================================
using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using UnityEngine;
using UnityEngine.UI;

namespace ShiroMR
{
    public class ShiroHandSlate : MonoBehaviour
    {
        public static ShiroHandSlate Instance { get; private set; }

        [Header("Hand Attachment Configuration")]
        [Tooltip("If true, the slate stays locked at its world position. If false, it follows the left wrist/palm.")]
        public bool isPinnedToWorld = false;

        [Tooltip("Whether the slate is currently expanded and visible.")]
        public bool isSlateVisible = true;

        [Tooltip("Offset relative to left wrist/palm (X = Right, Y = Up, Z = Forward).")]
        // Shifted X from -0.06 to -0.012 to perfectly balance and center the slate directly over the hand!
        public Vector3 wristOffset = new Vector3(-0.012f, 0.08f, 0.06f);

        public Vector3 SlateWorldPosition => _slateRoot != null ? _slateRoot.transform.position : transform.position;
        public GameObject SlateRoot => _slateRoot;

        [Header("Direct Touchscreen Interaction")]
        [Tooltip("Distance threshold (meters) from fingertip to button to trigger direct touch click.")]
        public float touchClickDistance = 0.024f; // 2.4 cm (effortless touch penetration)

        [Tooltip("Distance threshold (meters) from fingertip to button to show hover glow.")]
        public float touchHoverDistance = 0.048f; // 4.8 cm

        // Active Tab Index: 0 = Ward Setup, 1 = IPS Location, 2 = Patient Vitals, 3 = System, 4 = Live Map
        private int _currentTabIndex = 1; // Default to IPS Location tab

        // Tracking References
        private Transform _trackingSpace;
        private Transform _leftHandAnchor;
        private Transform _leftControllerAnchor;
        private Transform _rightHandAnchor;
        private Transform _rightControllerAnchor;
        private Camera _mainCam;
        private OVRSkeleton _rightSkeleton;

        // Visual UI Components
        private GameObject _slateRoot;
        private Canvas _slateCanvas;
        private RectTransform _slateCanvasRect;
        private GameObject _touchBead;
        private Renderer _touchBeadRenderer;

        // Mini Wrist Badge (shown when slate is collapsed so user can tap to re-open!)
        private GameObject _wristBadgeObj;
        private Button _wristBadgeBtn;

        // UI Panels & Dynamic Text
        private const int TabCount = 5;
        private GameObject[] _tabPanels = new GameObject[TabCount];
        private Image[] _tabHeaderButtons = new Image[TabCount];
        private Text[] _tabHeaderTexts = new Text[TabCount];
        private GameObject _tabBarObj;

        // Tab 0 (Ward Setup) UI References
        private Text _wardInfoText;
        private Text _wardStatusText;
        private Text _perspectiveBtnText;
        private Text _overlayBtnText;
        private Text _autoWardBtnText;
        private Text _depthBtnText;
        private Text _moveReqBtnText;
        private float _autoWardLabelTimer;

        // Tab 1 (IPS Location) UI References
        private Text _ipsStatusBadge;
        private Text _ipsResultSummary;
        private Text _ipsCoordinatesText;
        private Text _ipsDistancesText;
        private Text _ipsNearestAnchorText;
        private Text _ipsNearestBedText;
        private Text _ipsConfidenceText;
        private bool _isAutoRefreshIps = false;
        private float _ipsAutoRefreshTimer = 0f;

        // Tab 2 (Patient Vitals) UI References
        private Text _vitalsPatientName;
        private Text _vitalsTrackingModeText;
        private Text _vitalsBpmText;
        private Text _vitalsSpo2Text;
        private Text _vitalsMotionText;
        private Text _vitalsBatteryText;
        private Text _vitalsEmergencyStatus;
        private TrackedSubject _activePatient = null;
        private List<TrackedSubject> _cachedSubjects = new List<TrackedSubject>();

        // Tab 3 (System) UI References
        private Text _sysServerStatus;
        private Text _sysBatteryStatus;
        private Text _sysAnchorUuid;

        // Ward Selection UI
        private GameObject _wardButtonContainer;
        private readonly List<Button> _wardButtons = new List<Button>();

        // Pin Button Reference
        private Text _pinButtonText;

        // Touch Interaction State
        private readonly List<Button> _registeredButtons = new List<Button>();
        private Button _currentlyHoveredButton = null;
        private Color _cachedOriginalButtonColor = Color.white;
        private Image _cachedButtonImage = null;
        private float _touchDebounceTimer = 0f;
        private Vector3 _lastRightFingerPos = Vector3.zero;
        private bool _isRightFingerValid = false;
        private Vector3 _lastLeftFingerPos = Vector3.zero;
        private bool _isLeftFingerValid = false;

        // Rock-Solid Anchor Stabilization
        private Vector3 _stableTargetPos = Vector3.zero;
        private Quaternion _stableTargetRot = Quaternion.identity;
        private bool _isAnchorInitialized = false;

        // Gesture state
        private bool _wasLeftPinching = false;

        // Audio Click Generator
        private AudioSource _audioSource;
        private AudioClip _clickToneClip;

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
            EnsureTrackingReferences();
            GenerateClickAudio();
            BuildHandSlateUI();

            // Connect to Network Manager events for real-time telemetry updates
            if (ShiroNetworkManager.Instance != null)
            {
                ShiroNetworkManager.Instance.OnWardInitialized += OnWardLoaded;
                ShiroNetworkManager.Instance.OnTelemetryUpdated += OnTelemetryUpdated;
                ShiroNetworkManager.Instance.OnPositionUpdated += OnPositionUpdated;
                ShiroNetworkManager.Instance.OnConnectionStatusChanged += OnConnectionStatusChanged;
                ShiroNetworkManager.Instance.OnWardListLoaded += OnWardListLoaded;
                ShiroNetworkManager.Instance.OnActiveWardChanged += OnActiveWardChanged;
                ShiroNetworkManager.Instance.OnAssignmentChanged += OnAssignmentChanged;
            }

            // Default to IPS Location tab
            SelectTab(1);
        }

        private void OnDestroy()
        {
            if (ShiroNetworkManager.Instance != null)
            {
                ShiroNetworkManager.Instance.OnWardInitialized -= OnWardLoaded;
                ShiroNetworkManager.Instance.OnTelemetryUpdated -= OnTelemetryUpdated;
                ShiroNetworkManager.Instance.OnPositionUpdated -= OnPositionUpdated;
                ShiroNetworkManager.Instance.OnConnectionStatusChanged -= OnConnectionStatusChanged;
                ShiroNetworkManager.Instance.OnWardListLoaded -= OnWardListLoaded;
                ShiroNetworkManager.Instance.OnActiveWardChanged -= OnActiveWardChanged;
                ShiroNetworkManager.Instance.OnAssignmentChanged -= OnAssignmentChanged;
                ShiroNetworkManager.Instance.OnPairingStatusChanged -= OnPairingStatusChanged;
            }
            if (_alignSubscribed && WardAlignmentTool.Instance != null) WardAlignmentTool.Instance.OnAlignmentMessage -= ShowWardStatus;
            if (_alignSubscribed && WardSpatialManager.Instance != null) WardSpatialManager.Instance.OnRelocalized -= HandleRelocalized;
            if (_alertSubscribed && ShiroAlertManager.Instance != null)
            {
                ShiroAlertManager.Instance.OnAlertsChanged -= RefreshAlertUi;
                ShiroAlertManager.Instance.OnAlertRaised -= HandleAlertRaised;
            }
        }

        private void Update()
        {
            EnsureTrackingReferences();
            HandleReopenInputs();
            UpdateSlateTransform();
            UpdateRightFingertipPosition();
            UpdateDirectTouchInteraction();
            UpdateAlertBlink();

            _autoWardLabelTimer += Time.deltaTime;
            if (_autoWardLabelTimer >= 0.5f) { _autoWardLabelTimer = 0f; RefreshAutoWardLabel(); }

            // Auto-refresh IPS location if active
            if (_isAutoRefreshIps && _currentTabIndex == 1 && isSlateVisible)
            {
                _ipsAutoRefreshTimer += Time.deltaTime;
                if (_ipsAutoRefreshTimer >= 0.25f) // 4 Hz live update
                {
                    _ipsAutoRefreshTimer = 0f;
                    ExecuteIpsLocationFind(silent: true);
                }
            }

            // Live update Tab 2 Tracking Status if Tab 2 is active
            if (_currentTabIndex == 2 && isSlateVisible && ShiroMRManager.Instance != null)
            {
                foreach (var kvp in ShiroMRManager.Instance.ActiveHolograms)
                {
                    if (kvp.Value != null)
                    {
                        UpdateTrackingStatusUi(kvp.Value);
                        break;
                    }
                }
            }
        }

        private void EnsureTrackingReferences()
        {
            if (_mainCam == null) _mainCam = Camera.main;

            if (_trackingSpace == null)
            {
                GameObject tsObj = GameObject.Find("TrackingSpace");
                if (tsObj != null) _trackingSpace = tsObj.transform;
            }
            if (_leftHandAnchor == null)
            {
                GameObject lha = GameObject.Find("LeftHandAnchor");
                if (lha != null) _leftHandAnchor = lha.transform;
            }
            if (_leftControllerAnchor == null)
            {
                GameObject lca = GameObject.Find("LeftControllerAnchor");
                if (lca != null) _leftControllerAnchor = lca.transform;
            }
            if (_rightHandAnchor == null)
            {
                GameObject rha = GameObject.Find("RightHandAnchor");
                if (rha != null) _rightHandAnchor = rha.transform;
            }
            if (_rightControllerAnchor == null)
            {
                GameObject rca = GameObject.Find("RightControllerAnchor");
                if (rca != null) _rightControllerAnchor = rca.transform;
            }
            if (_rightSkeleton == null)
            {
                var skeletons = FindObjectsOfType<OVRSkeleton>();
                foreach (var s in skeletons)
                {
                    if (s.GetSkeletonType() == OVRSkeleton.SkeletonType.HandRight)
                    {
                        _rightSkeleton = s;
                        break;
                    }
                }
            }
        }

        /// <summary>
        /// Handles reopening the Slate via Quest Menu Button, Y Button, B Button, or Left Hand Pinch!
        /// </summary>
        private void HandleReopenInputs()
        {
            bool toggleRequested = false;

            // 1. Controller Menu / Face Buttons
            try
            {
                if (OVRInput.GetDown(OVRInput.Button.Start, OVRInput.Controller.LTouch) ||  // Left Menu Button (Quest System Menu)
                    OVRInput.GetDown(OVRInput.Button.Four, OVRInput.Controller.LTouch) ||   // Y Button (Left Controller)
                    OVRInput.GetDown(OVRInput.Button.Two, OVRInput.Controller.RTouch))     // B Button (Right Controller)
                {
                    toggleRequested = true;
                }
            }
            catch (Exception swallowed) { ShiroLog.Caught("ShiroHandSlate.HandleReopenInputs", swallowed); }

            // 2. Pure Hand Tracking: Left Hand Index Pinch Gesture
            try
            {
                OVRPlugin.HandState leftState = default;
                if (OVRPlugin.GetHandState(OVRPlugin.Step.Render, OVRPlugin.Hand.HandLeft, ref leftState))
                {
                    if ((leftState.Status & OVRPlugin.HandStatus.HandTracked) != 0)
                    {
                        bool isPinching = (leftState.Pinches & OVRPlugin.HandFingerPinch.Index) != 0;
                        if (isPinching && !_wasLeftPinching)
                        {
                            toggleRequested = true;
                        }
                        _wasLeftPinching = isPinching;
                    }
                }
            }
            catch (Exception swallowed) { ShiroLog.Caught("ShiroHandSlate.HandleReopenInputs", swallowed); }

            // 3. Unity Editor Keyboard Shortcuts ('M', 'C', 'H')
#if ENABLE_INPUT_SYSTEM
            if (UnityEngine.InputSystem.Keyboard.current != null)
            {
                if (UnityEngine.InputSystem.Keyboard.current.mKey.wasPressedThisFrame ||
                    UnityEngine.InputSystem.Keyboard.current.cKey.wasPressedThisFrame ||
                    UnityEngine.InputSystem.Keyboard.current.hKey.wasPressedThisFrame)
                {
                    toggleRequested = true;
                }
            }
#endif

            if (toggleRequested)
            {
                ToggleSlateVisibility();
            }
        }

        /// <summary>
        /// Updates the 3D position and rotation of the Slate and Mini Wrist Badge.
        /// When docked: Perfectly centered over the left hand / palm.
        /// When pinned: Stays frozen in world space.
        /// </summary>
        private void UpdateSlateTransform()
        {
            if (_slateRoot == null) return;

            Vector3 leftWristPos = Vector3.zero;
            Quaternion leftWristRot = Quaternion.identity;
            bool foundLeftWrist = false;

            // 1. Check Meta Quest Pure Hand Tracking
            try
            {
                OVRPlugin.HandState leftState = default;
                if (OVRPlugin.GetHandState(OVRPlugin.Step.Render, OVRPlugin.Hand.HandLeft, ref leftState))
                {
                    if ((leftState.Status & OVRPlugin.HandStatus.HandTracked) != 0)
                    {
                        OVRPose pose = leftState.RootPose.ToOVRPose();
                        if (_trackingSpace != null)
                        {
                            leftWristPos = _trackingSpace.TransformPoint(pose.position);
                            leftWristRot = _trackingSpace.rotation * pose.orientation;
                        }
                        else
                        {
                            leftWristPos = pose.position;
                            leftWristRot = pose.orientation;
                        }
                        foundLeftWrist = true;
                    }
                }
            }
            catch (Exception swallowed) { ShiroLog.Caught("ShiroHandSlate.UpdateSlateTransform", swallowed); }

            // 2. Controller Fallback
            if (!foundLeftWrist)
            {
                if (_leftControllerAnchor != null && _leftControllerAnchor.gameObject.activeInHierarchy)
                {
                    leftWristPos = _leftControllerAnchor.position;
                    leftWristRot = _leftControllerAnchor.rotation;
                    foundLeftWrist = true;
                }
                else if (_leftHandAnchor != null && _leftHandAnchor.gameObject.activeInHierarchy)
                {
                    leftWristPos = _leftHandAnchor.position;
                    leftWristRot = _leftHandAnchor.rotation;
                    foundLeftWrist = true;
                }
            }

            // 3. Desktop / Editor Fallback
            if (!foundLeftWrist && _mainCam != null)
            {
                leftWristPos = _mainCam.transform.position +
                               _mainCam.transform.forward * 0.45f -
                               _mainCam.transform.right * 0.16f -
                               _mainCam.transform.up * 0.12f;
                leftWristRot = _mainCam.transform.rotation;
                foundLeftWrist = true;
            }

            // Update Mini Wrist Badge Position (Always sits right at the wrist so user can tap to re-open!)
            if (_wristBadgeObj != null)
            {
                if (foundLeftWrist && !isSlateVisible)
                {
                    _wristBadgeObj.SetActive(true);
                    _wristBadgeObj.transform.position = leftWristPos + leftWristRot * new Vector3(0, 0.04f, 0.02f);
                    if (_mainCam != null)
                    {
                        Vector3 lookDir = (_wristBadgeObj.transform.position - _mainCam.transform.position).normalized;
                        _wristBadgeObj.transform.rotation = Quaternion.LookRotation(lookDir, Vector3.up);
                    }
                }
                else
                {
                    _wristBadgeObj.SetActive(false);
                }
            }

            // If Slate is pinned, maintain world position
            if (isPinnedToWorld)
            {
                return;
            }

            // Slate Docked Position (Placed in front of the palm/wrist facing the user)
            if (foundLeftWrist && isSlateVisible)
            {
                Vector3 toCamera = (_mainCam != null) ? (_mainCam.transform.position - leftWristPos).normalized : Vector3.up;
                Vector3 handForward = leftWristRot * Vector3.forward;

                // Place slate 5.5cm in front of hand along the direct line of sight to the camera, shifted 3.5cm along palm
                Vector3 rawTargetPos = leftWristPos + toCamera * 0.055f + handForward * 0.035f;

                // Canvas faces directly toward the user's eyes
                Vector3 lookDir = (rawTargetPos - _mainCam.transform.position).normalized;
                Quaternion rawTargetRot = Quaternion.LookRotation(lookDir, _mainCam.transform.up);

                if (!_isAnchorInitialized || _stableTargetPos == Vector3.zero)
                {
                    _stableTargetPos = rawTargetPos;
                    _stableTargetRot = rawTargetRot;
                    _isAnchorInitialized = true;
                }

                // Check distance of interacting pointer finger (right hand) to the slate:
                float pointerDist = _isRightFingerValid ? Vector3.Distance(_lastRightFingerPos, _slateRoot.transform.position) : 999f;
                bool isPointerNear = (pointerDist < 0.32f);

                float moveDist = Vector3.Distance(rawTargetPos, _stableTargetPos);
                float rotAngle = Quaternion.Angle(rawTargetRot, _stableTargetRot);

                if (isPointerNear)
                {
                    // High-Stability Mode: Deadband of 3.2cm and 8.0 degrees
                    // Ignores micro-jitter and camera occlusion from right hand approaching!
                    if (moveDist > 0.032f)
                    {
                        _stableTargetPos = Vector3.Lerp(_stableTargetPos, rawTargetPos, Time.deltaTime * 3.5f);
                    }
                    if (rotAngle > 8.0f)
                    {
                        _stableTargetRot = Quaternion.Slerp(_stableTargetRot, rawTargetRot, Time.deltaTime * 3.5f);
                    }
                }
                else
                {
                    // Smooth tracking when not interacting
                    if (moveDist > 0.008f)
                    {
                        _stableTargetPos = Vector3.Lerp(_stableTargetPos, rawTargetPos, Time.deltaTime * 10f);
                    }
                    if (rotAngle > 2.0f)
                    {
                        _stableTargetRot = Quaternion.Slerp(_stableTargetRot, rawTargetRot, Time.deltaTime * 10f);
                    }
                }

                _slateRoot.transform.position = _stableTargetPos;
                _slateRoot.transform.rotation = _stableTargetRot;
            }
            else
            {
                _isAnchorInitialized = false;
            }
        }

        /// <summary>
        /// Locates the Right and Left Index Fingertips accurately for true direct-touch interaction.
        /// When the menu is pinned to the room, both hands can interact simultaneously.
        /// </summary>
        private void UpdateRightFingertipPosition()
        {
            _isRightFingerValid = false;

            // 0. High-Precision Tracking from ShiroHandVisualizer (OpenXR Hand Skeleton)
            if (ShiroHandVisualizer.Instance != null && ShiroHandVisualizer.Instance.IsRightHandTracked)
            {
                Vector3 vizPos = ShiroHandVisualizer.Instance.RightIndexTipPosition;
                if (vizPos != Vector3.zero)
                {
                    _lastRightFingerPos = vizPos;
                    _isRightFingerValid = true;
                }
            }

            // 1. Try finding Hand_IndexTip bone from OVRSkeleton
            if (!_isRightFingerValid && _rightSkeleton != null && _rightSkeleton.Bones != null && _rightSkeleton.Bones.Count > 0)
            {
                foreach (var b in _rightSkeleton.Bones)
                {
                    if (b.Id == OVRSkeleton.BoneId.Hand_IndexTip)
                    {
                        _lastRightFingerPos = b.Transform.position;
                        _isRightFingerValid = true;
                        break;
                    }
                }
            }

            // 2. Pure Hand Tracking Index Tip Projection
            if (!_isRightFingerValid)
            {
                try
                {
                    OVRPlugin.HandState rightState = default;
                    if (OVRPlugin.GetHandState(OVRPlugin.Step.Render, OVRPlugin.Hand.HandRight, ref rightState))
                    {
                        if ((rightState.Status & OVRPlugin.HandStatus.HandTracked) != 0)
                        {
                            OVRPose pose = rightState.PointerPose.ToOVRPose();
                            Vector3 pPos = (_trackingSpace != null) ? _trackingSpace.TransformPoint(pose.position) : pose.position;
                            Vector3 pFwd = (_trackingSpace != null) ? _trackingSpace.TransformDirection(pose.orientation * Vector3.forward) : (pose.orientation * Vector3.forward);

                            // Project forward 7.5cm from pinch knuckle to the physical index fingernail tip!
                            _lastRightFingerPos = pPos + pFwd * 0.075f;
                            _isRightFingerValid = true;
                        }
                    }
                }
                catch (Exception swallowed) { ShiroLog.Caught("ShiroHandSlate.UpdateRightFingertipPosition", swallowed); }
            }

            // 3. Touch Controller Tip Fallback
            if (!_isRightFingerValid)
            {
                if (_rightControllerAnchor != null && _rightControllerAnchor.gameObject.activeInHierarchy)
                {
                    _lastRightFingerPos = _rightControllerAnchor.position + _rightControllerAnchor.forward * 0.085f;
                    _isRightFingerValid = true;
                }
                else if (_rightHandAnchor != null && _rightHandAnchor.gameObject.activeInHierarchy)
                {
                    _lastRightFingerPos = _rightHandAnchor.position + _rightHandAnchor.forward * 0.085f;
                    _isRightFingerValid = true;
                }
            }

            // 4. Track Left Index Tip when Menu is Pinned to the room (both hands can touch)
            _isLeftFingerValid = false;
            if (isPinnedToWorld && ShiroHandVisualizer.Instance != null && ShiroHandVisualizer.Instance.IsLeftHandTracked)
            {
                Vector3 lTip = ShiroHandVisualizer.Instance.LeftIndexTipPosition;
                if (lTip != Vector3.zero)
                {
                    _lastLeftFingerPos = lTip;
                    _isLeftFingerValid = true;
                }
            }

            // Update visual touch bead on the fingertip
            if (_touchBead != null)
            {
                if (_isRightFingerValid && ((isSlateVisible && _slateRoot != null && _slateRoot.activeSelf) || (_wristBadgeObj != null && _wristBadgeObj.activeSelf)))
                {
                    Vector3 targetSlatePos = isSlateVisible && _slateRoot != null ? _slateRoot.transform.position : _wristBadgeObj.transform.position;
                    float distToSlate = Vector3.Distance(_lastRightFingerPos, targetSlatePos);
                    bool isNear = distToSlate < 0.35f; // Within 35cm of slate
                    _touchBead.SetActive(isNear);
                    if (isNear)
                    {
                        _touchBead.transform.position = _lastRightFingerPos;
                    }
                }
                else
                {
                    _touchBead.SetActive(false);
                }
            }
        }

        /// <summary>
        /// Direct Touchscreen ("Poke") Engine:
        /// Checks buttons on the slate and mini badge. Touching within touchClickDistance triggers immediate click!
        /// Supports both hands when the slate is pinned to the room.
        /// </summary>
        private void UpdateDirectTouchInteraction()
        {
            if (_touchDebounceTimer > 0f)
            {
                _touchDebounceTimer -= Time.deltaTime;
            }

            // Determine active touching finger position (closest finger to the panel)
            Vector3 activeFingerPos = _lastRightFingerPos;
            bool isFingerValid = _isRightFingerValid;

            if (isPinnedToWorld && _isLeftFingerValid)
            {
                if (!_isRightFingerValid)
                {
                    activeFingerPos = _lastLeftFingerPos;
                    isFingerValid = true;
                }
                else if (_slateRoot != null)
                {
                    float dR = Vector3.Distance(_lastRightFingerPos, _slateRoot.transform.position);
                    float dL = Vector3.Distance(_lastLeftFingerPos, _slateRoot.transform.position);
                    if (dL < dR)
                    {
                        activeFingerPos = _lastLeftFingerPos;
                    }
                }
            }

            if (!isFingerValid)
            {
                ResetButtonHover();
                return;
            }

            // 1. Check Mini Wrist Badge Touch (when collapsed)
            if (!isSlateVisible && _wristBadgeBtn != null && _wristBadgeBtn.gameObject.activeInHierarchy)
            {
                float distToBadge = Vector3.Distance(activeFingerPos, _wristBadgeBtn.transform.position);
                if (distToBadge <= touchClickDistance && _touchDebounceTimer <= 0f)
                {
                    _touchDebounceTimer = 0.35f;
                    ToggleSlateVisibility();
                    return;
                }
            }

            if (!isSlateVisible || _slateRoot == null || !_slateRoot.activeSelf)
            {
                ResetButtonHover();
                return;
            }

            Button closestBtn = null;
            float closestDist = float.MaxValue;

            foreach (var btn in _registeredButtons)
            {
                if (btn == null || !btn.gameObject.activeInHierarchy || !btn.interactable) continue;

                Vector3 btnWorldPos = btn.transform.position;
                float dist = Vector3.Distance(activeFingerPos, btnWorldPos);

                if (dist < closestDist)
                {
                    closestDist = dist;
                    closestBtn = btn;
                }
            }

            // Hover feedback
            if (closestBtn != null && closestDist <= touchHoverDistance)
            {
                if (_currentlyHoveredButton != closestBtn)
                {
                    ResetButtonHover();
                    _currentlyHoveredButton = closestBtn;
                    HighlightButton(closestBtn, true);
                }

                // Click Trigger (Physical touch contact)
                if (closestDist <= touchClickDistance && _touchDebounceTimer <= 0f)
                {
                    _touchDebounceTimer = 0.35f;
                    TriggerButtonClick(closestBtn);
                }
            }
            else
            {
                ResetButtonHover();
            }

            // Sync hover distance & touch status to ShiroHandVisualizer for real-time cursor feedback!
            if (ShiroHandVisualizer.Instance != null)
            {
                ShiroHandVisualizer.Instance.RightIndexHoverDistance = _isRightFingerValid ? closestDist : 999f;
                ShiroHandVisualizer.Instance.IsRightIndexTouching = (_isRightFingerValid && closestBtn != null && closestDist <= touchClickDistance);

                if (isPinnedToWorld)
                {
                    ShiroHandVisualizer.Instance.LeftIndexHoverDistance = _isLeftFingerValid ? closestDist : 999f;
                    ShiroHandVisualizer.Instance.IsLeftIndexTouching = (_isLeftFingerValid && closestBtn != null && closestDist <= touchClickDistance);
                }
            }
        }

        private void TriggerButtonClick(Button btn)
        {
            if (btn == null) return;

            PlayClickTone();

            try
            {
                OVRInput.SetControllerVibration(0.5f, 0.25f, OVRInput.Controller.RTouch);
            }
            catch (Exception swallowed) { ShiroLog.Caught("ShiroHandSlate.TriggerButtonClick", swallowed); }

            StartCoroutine(AnimateButtonPressRoutine(btn));
            btn.onClick.Invoke();
        }

        private IEnumerator AnimateButtonPressRoutine(Button btn)
        {
            if (btn == null) yield break;
            Transform tr = btn.transform;
            Vector3 origScale = tr.localScale;
            tr.localScale = origScale * 0.92f;
            yield return new WaitForSeconds(0.08f);
            if (tr != null) tr.localScale = origScale;
        }

        private void HighlightButton(Button btn, bool hover)
        {
            if (btn == null) return;
            var img = btn.GetComponent<Image>();
            if (img == null) return;

            if (hover)
            {
                _cachedButtonImage = img;
                _cachedOriginalButtonColor = img.color;
                img.color = new Color(0.12f, 0.70f, 0.85f, 0.95f); // Vibrant Cyan hover
            }
            else
            {
                img.color = _cachedOriginalButtonColor;
            }
        }

        private void ResetButtonHover()
        {
            if (_currentlyHoveredButton != null)
            {
                HighlightButton(_currentlyHoveredButton, false);
                _currentlyHoveredButton = null;
                _cachedButtonImage = null;
            }
            if (ShiroHandVisualizer.Instance != null)
            {
                ShiroHandVisualizer.Instance.RightIndexHoverDistance = 999f;
                ShiroHandVisualizer.Instance.IsRightIndexTouching = false;
                ShiroHandVisualizer.Instance.LeftIndexHoverDistance = 999f;
                ShiroHandVisualizer.Instance.IsLeftIndexTouching = false;
            }
        }

        public void SelectTab(int tabIndex)
        {
            _currentTabIndex = Mathf.Clamp(tabIndex, 0, TabCount - 1);

            for (int i = 0; i < TabCount; i++)
            {
                if (_tabPanels[i] != null)
                {
                    _tabPanels[i].SetActive(i == _currentTabIndex);
                }
                if (_tabHeaderButtons[i] != null)
                {
                    bool active = (i == _currentTabIndex);
                    _tabHeaderButtons[i].color = active ? new Color(0.06f, 0.55f, 0.75f, 0.95f) : new Color(0.08f, 0.12f, 0.18f, 0.80f);
                }
                if (_tabHeaderTexts[i] != null)
                {
                    bool active = (i == _currentTabIndex);
                    _tabHeaderTexts[i].color = active ? Color.white : new Color(0.70f, 0.75f, 0.82f);
                }
            }

            PlayClickTone();

            if (_currentTabIndex == 1)
            {
                ExecuteIpsLocationFind(silent: false);
            }
        }

        public void ExecuteIpsLocationFind(bool silent = false)
        {
            WardConfig ward = WardSpatialManager.Instance != null
                ? WardSpatialManager.Instance.GetCachedWardConfig()
                : null;

            string targetWardId = ShiroNetworkManager.Instance != null ? ShiroNetworkManager.Instance.targetWardId : "";

            // Without a loaded ward there is nothing to locate against: say so, invent nothing
            if (ward == null || ward.length_x <= 0 || ward.width_y <= 0)
            {
                if (_ipsStatusBadge != null)
                {
                    _ipsStatusBadge.text = string.IsNullOrEmpty(targetWardId) ? "⚠ NO WARD CONFIGURED" : $"⚠ WARD {targetWardId} NOT LOADED";
                    _ipsStatusBadge.color = new Color(0.95f, 0.70f, 0.1f);
                }
                if (_ipsResultSummary != null)
                {
                    _ipsResultSummary.text = string.IsNullOrEmpty(targetWardId)
                        ? "Choose a ward on the Ward tab."
                        : "Check the connection to the edge server (System tab), then try again.";
                }
                if (_ipsCoordinatesText != null) _ipsCoordinatesText.text = "Position: not available";
                if (_ipsDistancesText != null) _ipsDistancesText.text = "";
                if (_ipsNearestAnchorText != null) _ipsNearestAnchorText.text = "";
                if (_ipsNearestBedText != null) _ipsNearestBedText.text = "";
                if (_ipsConfidenceText != null) _ipsConfidenceText.text = "";
                return;
            }

            string wardTitle = !string.IsNullOrEmpty(ward.room_title) ? ward.room_title : ward.ward_id;
            float roomW = ward.length_x;
            float roomL = ward.width_y;
            bool hasDoor = ward.door != null && ward.door.width > 0 && !string.IsNullOrEmpty(ward.door.wall);
            string doorWall = hasDoor ? ward.door.wall.ToUpper() : "";
            float doorPos = hasDoor ? ward.door.x : 0f;
            float doorW = hasDoor ? ward.door.width : 0f;

            Vector3 headWorld = _mainCam != null ? _mainCam.transform.position : Vector3.zero;
            Vector3 wardLocal = headWorld;

            if (WardSpatialManager.Instance != null && WardSpatialManager.Instance.wardOrigin != null)
            {
                wardLocal = WardSpatialManager.Instance.wardOrigin.InverseTransformPoint(headWorld);
            }

            bool isInsideX = (wardLocal.x >= -0.05f && wardLocal.x <= (roomW + 0.05f));
            bool isInsideZ = (wardLocal.z >= -0.05f && wardLocal.z <= (roomL + 0.05f));
            bool isInsideWard = isInsideX && isInsideZ;

            float distNorth = Mathf.Abs(roomL - wardLocal.z);
            float distSouth = Mathf.Abs(wardLocal.z);
            float distWest = Mathf.Abs(wardLocal.x);
            float distEast = Mathf.Abs(roomW - wardLocal.x);

            float distToDoor = -1f; // -1 = the ward has no door configured
            if (hasDoor)
            {
                Vector3 doorCenter = (doorWall == "EAST")
                    ? new Vector3(roomW, 0, doorPos + doorW / 2.0f)
                    : new Vector3(doorPos + doorW / 2.0f, 0, 0);
                distToDoor = Vector3.Distance(new Vector3(wardLocal.x, 0, wardLocal.z), doorCenter);
            }

            string nearestAnchorInfo = "No anchors configured in this ward";
            if (ward.anchors != null && ward.anchors.Count > 0)
            {
                WardAnchor nearest = null;
                float minD = float.MaxValue;
                foreach (var a in ward.anchors)
                {
                    Vector3 aPos = new Vector3(a.x, a.z, a.y);
                    float d = Vector3.Distance(wardLocal, aPos);
                    if (d < minD)
                    {
                        minD = d;
                        nearest = a;
                    }
                }
                if (nearest != null)
                {
                    // Distance from the headset position; the signal value is an estimate from the radio model, not a measurement
                    int estRssi = Mathf.RoundToInt(-45f - 10f * 3.2f * Mathf.Log10(Mathf.Max(0.5f, minD)));
                    nearestAnchorInfo = $"{nearest.anchor_id} [{nearest.wall_location}] ({minD:F2}m | est. {estRssi} dBm)";
                }
            }

            if (_ipsStatusBadge != null)
            {
                if (isInsideWard)
                {
                    _ipsStatusBadge.text = $"✅ INSIDE {targetWardId} (CLINICAL ZONE)";
                    _ipsStatusBadge.color = new Color(0.1f, 0.95f, 0.4f);
                }
                else
                {
                    _ipsStatusBadge.text = $"🚶 IN TRANSIT: CORRIDOR (Outside {targetWardId})";
                    _ipsStatusBadge.color = new Color(0.95f, 0.70f, 0.1f);
                }
            }

            if (_ipsResultSummary != null)
            {
                _ipsResultSummary.text = isInsideWard
                    ? $"Doctor is inside {wardTitle} ({targetWardId}).\nDigital twin coordinates locked to physical ward geometry."
                    : (distToDoor >= 0f
                        ? $"Doctor is in hallway outside {wardTitle}.\nDistance to entrance door: {distToDoor:F2}m."
                        : $"Doctor is outside {wardTitle}.\nNo door is configured for this ward.");
            }

            if (_ipsCoordinatesText != null)
            {
                _ipsCoordinatesText.text = $"X: {wardLocal.x:F2}m  |  Y (Eye Level): {wardLocal.y:F2}m  |  Z: {wardLocal.z:F2}m";
            }

            if (_ipsDistancesText != null)
            {
                _ipsDistancesText.text = $"North Wall: {distNorth:F2}m  |  South Wall: {distSouth:F2}m\nEast (Door): {distEast:F2}m  |  West Wall: {distWest:F2}m";
            }

            if (_ipsNearestAnchorText != null)
            {
                _ipsNearestAnchorText.text = nearestAnchorInfo;
            }

            if (_ipsNearestBedText != null)
            {
                // Nearest bed of the loaded ward, measured to the bed centre on the floor
                WardBed nearestBed = null;
                float bedDist = float.MaxValue;
                if (ward.beds != null)
                {
                    foreach (var b in ward.beds)
                    {
                        Vector3 centre = new Vector3(b.x + b.width / 2f, 0f, b.y + b.length / 2f);
                        float d = Vector3.Distance(new Vector3(wardLocal.x, 0f, wardLocal.z), centre);
                        if (d < bedDist) { bedDist = d; nearestBed = b; }
                    }
                }
                _ipsNearestBedText.text = nearestBed != null
                    ? $"{(string.IsNullOrEmpty(nearestBed.bed_code) ? nearestBed.bed_id : nearestBed.bed_code)} ({bedDist:F2}m away) - Status: {(string.IsNullOrEmpty(nearestBed.status) ? "unknown" : nearestBed.status)}"
                    : "No beds configured in this ward";
            }

            if (_ipsConfidenceText != null)
            {
                // No confidence figure is computed, so none is shown
                _ipsConfidenceText.text = "Source: headset tracking against the calibrated ward outline";
            }

            if (!silent)
            {
                PlayClickTone();
                try
                {
                    OVRInput.SetControllerVibration(0.4f, 0.3f, OVRInput.Controller.RTouch);
                }
                catch (Exception swallowed) { ShiroLog.Caught("ShiroHandSlate.ExecuteIpsLocationFind", swallowed); }
            }
        }

        public void SaveSpatialAnchor()
        {
            if (WardAlignmentTool.Instance != null)
            {
                // The result (saved, sent, or why not) arrives through OnAlignmentMessage
                if (_wardStatusText != null)
                {
                    _wardStatusText.text = "⏳ Saving the spatial anchor…";
                    _wardStatusText.color = new Color(0.95f, 0.75f, 0.2f);
                }
                WardAlignmentTool.Instance.SavePersistentAnchor();
            }
            PlayClickTone();
        }

        public void ToggleAutoRefreshIps()
        {
            _isAutoRefreshIps = !_isAutoRefreshIps;
            PlayClickTone();
        }

        public void TogglePinToWorld()
        {
            isPinnedToWorld = !isPinnedToWorld;
            _isAnchorInitialized = false;
            if (_pinButtonText != null)
            {
                _pinButtonText.text = isPinnedToWorld ? "🧲 Dock to Wrist" : "📌 Pin to Room";
            }
            PlayClickTone();
        }

        public void ToggleSlateVisibility()
        {
            isSlateVisible = !isSlateVisible;
            _isAnchorInitialized = false;
            if (_slateRoot != null)
            {
                _slateRoot.SetActive(isSlateVisible);
            }
            if (_wristBadgeObj != null)
            {
                _wristBadgeObj.SetActive(!isSlateVisible);
            }
            PlayClickTone();
        }

        private void OnWardLoaded(WardConfig ward, List<TrackedSubject> subjects)
        {
            if (_wardInfoText != null && ward != null)
            {
                _wardInfoText.text = $"Ward: {ward.room_title} ({ward.ward_id})\nSize: {ward.length_x:F2}m × {ward.width_y:F2}m × {ward.height_z:F2}m";
            }
            if (_sysAnchorUuid != null && ward != null)
            {
                _sysAnchorUuid.text = $"Anchor UUID: {ward.spatial_anchor_uuid}";
            }

            RebuildWardButtons();

            _cachedSubjects = subjects ?? new List<TrackedSubject>();

            // Dynamically bind patient from MySQL database matching active wristband
            if (_cachedSubjects.Count > 0)
            {
                if (_activePatient == null)
                {
                    _activePatient = _cachedSubjects[0];
                }
                UpdatePatientProfileUi();
            }
        }

        private void OnWardListLoaded(List<WardSummary> wards)
        {
            RebuildWardButtons();
        }

        private void OnActiveWardChanged(string newWardId)
        {
            RebuildWardButtons();
            if (_wardInfoText != null)
            {
                _wardInfoText.text = $"Ward: Loading {newWardId} from server...";
            }
            if (_sysAnchorUuid != null)
            {
                _sysAnchorUuid.text = $"Active Ward: {newWardId}";
            }
        }

        /// <summary>
        /// Dynamically builds interactive buttons for each ward registered in the hospital.
        /// Clinicians can switch between wards with a single fingertip tap!
        /// </summary>
        private void RebuildWardButtons()
        {
            if (_wardButtonContainer == null) return;

            foreach (var b in _wardButtons)
            {
                if (b != null)
                {
                    _registeredButtons.Remove(b);
                    Destroy(b.gameObject);
                }
            }
            _wardButtons.Clear();

            string currentWard = ShiroNetworkManager.Instance != null ? ShiroNetworkManager.Instance.targetWardId : "";
            List<string> wardIds = new List<string>();

            // Only wards the server reports. Before the list has arrived, no buttons
            // are shown (the Ward tab text says why), rather than guessed ward IDs.
            if (ShiroNetworkManager.Instance != null)
            {
                foreach (var w in ShiroNetworkManager.Instance.AvailableWards)
                {
                    if (!string.IsNullOrEmpty(w.ward_id)) wardIds.Add(w.ward_id);
                }
            }

            float colWidth = 215f;
            float rowHeight = 44f;
            for (int i = 0; i < wardIds.Count && i < 6; i++)
            {
                string wid = wardIds[i];
                bool isActive = wid.Equals(currentWard, StringComparison.OrdinalIgnoreCase);
                int col = i % 2;
                int row = i / 2;
                float posX = (col == 0) ? -115f : 115f;
                float posY = 35f - (row * (rowHeight + 8f));

                string label = isActive ? $"✅ {wid} (ACTIVE)" : $"🏥 {wid}";
                Color btnColor = isActive ? new Color(0.10f, 0.55f, 0.45f) : new Color(0.12f, 0.22f, 0.32f);

                Button btn = CreateButton(_wardButtonContainer.transform, $"Btn_{wid}", label, new Vector2(colWidth, rowHeight), btnColor, () =>
                {
                    if (ShiroNetworkManager.Instance != null)
                    {
                        ShiroNetworkManager.Instance.SwitchWard(wid);
                    }
                });
                btn.transform.localPosition = new Vector3(posX, posY, 0);
                _wardButtons.Add(btn);
            }
        }

        private void TryBindPatientByTag(string tag)
        {
            if (string.IsNullOrEmpty(tag) || _cachedSubjects == null || _cachedSubjects.Count == 0) return;
            string clean = tag.ToUpper().Trim();

            if (_activePatient != null)
            {
                if ((!string.IsNullOrEmpty(_activePatient.device_id) && _activePatient.device_id.ToUpper() == clean) ||
                    (!string.IsNullOrEmpty(_activePatient.mac_address) && _activePatient.mac_address.ToUpper() == clean))
                {
                    return; // Already matched to active transmitter
                }
            }

            foreach (var s in _cachedSubjects)
            {
                if ((!string.IsNullOrEmpty(s.device_id) && s.device_id.ToUpper() == clean) ||
                    (!string.IsNullOrEmpty(s.mac_address) && s.mac_address.ToUpper() == clean))
                {
                    _activePatient = s;
                    UpdatePatientProfileUi();
                    return;
                }
            }
        }

        private void UpdatePatientProfileUi()
        {
            if (_vitalsPatientName != null && _activePatient != null)
            {
                string bedStr = !string.IsNullOrEmpty(_activePatient.assigned_bed_id) ? _activePatient.assigned_bed_id : "no bed assigned";
                _vitalsPatientName.text = $"👤 Patient: {_activePatient.full_name} | ID: {_activePatient.patient_id} | Wristband: {_activePatient.device_id} ({bedStr})";
            }
        }

        private void SetMotionState(string m)
        {
            if (_vitalsMotionText == null || string.IsNullOrEmpty(m)) return;

            string motionUpper = m.ToUpper().Trim();
            _vitalsMotionText.text = motionUpper;

            if (motionUpper == "WALKING")
                _vitalsMotionText.color = new Color(0.2f, 0.95f, 0.5f); // Green
            else if (motionUpper == "HAND_MOVEMENT")
                _vitalsMotionText.color = new Color(0.95f, 0.75f, 0.2f); // Amber
            else if (motionUpper == "SETTLING")
                _vitalsMotionText.color = new Color(0.4f, 0.8f, 0.95f);  // Cyan
            else
                _vitalsMotionText.color = Color.white; // Stationary
        }

        private void OnTelemetryUpdated(TelemetryUpdate update)
        {
            if (update == null) return;
            TryBindPatientByTag(update.EffectiveTagId);

            // 0 or below means "no valid reading now" (battery: -1 = not reported)
            int bpm = update.EffectiveBpm, spo2 = update.EffectiveSpo2, bat = update.EffectiveBattery;
            if (_vitalsBpmText != null) _vitalsBpmText.text = bpm > 0 ? $"{bpm} BPM" : "-- BPM";
            if (_vitalsSpo2Text != null) _vitalsSpo2Text.text = spo2 > 0 ? $"~{spo2} %" : "-- %";
            if (_vitalsBatteryText != null) _vitalsBatteryText.text = bat >= 0 ? $"{bat} %" : "-- %";

            if (!string.IsNullOrEmpty(update.EffectiveMotion))
            {
                SetMotionState(update.EffectiveMotion);
            }
        }

        /// <summary>
        /// Synchronizes Motion State with IPS Position Updates so wrist panel matches the floating dot 100%!
        /// </summary>
        private void OnPositionUpdated(IpsPositionUpdate pos)
        {
            if (pos == null) return;
            TryBindPatientByTag(pos.tag_id);

            if (!string.IsNullOrEmpty(pos.motion_state))
            {
                SetMotionState(pos.motion_state);
            }
        }

        public void ReAttachPatientHologram()
        {
            if (ShiroMRManager.Instance != null)
            {
                foreach (var kvp in ShiroMRManager.Instance.ActiveHolograms)
                {
                    if (kvp.Value != null)
                    {
                        kvp.Value.BeginManualAim();
                        if (_vitalsTrackingModeText != null)
                        {
                            _vitalsTrackingModeText.text = "🎯 MANUAL AIM: POINT AT PATIENT & PINCH / CLICK TO LOCK";
                            _vitalsTrackingModeText.color = new Color(1.0f, 0.85f, 0.2f);
                        }
                        PlayClickTone();
                        return;
                    }
                }
            }
            PlayClickTone();
        }

        public void TogglePatientDockMode()
        {
            if (ShiroMRManager.Instance != null)
            {
                foreach (var kvp in ShiroMRManager.Instance.ActiveHolograms)
                {
                    if (kvp.Value != null)
                    {
                        kvp.Value.ToggleDockMode();
                        UpdateTrackingStatusUi(kvp.Value);
                        PlayClickTone();
                        return;
                    }
                }
            }
            PlayClickTone();
        }

        private void UpdateTrackingStatusUi(PatientHologram holo)
        {
            if (_vitalsTrackingModeText == null || holo == null) return;

            if (holo.trackingState == PatientTrackingState.BedDocked)
            {
                _vitalsTrackingModeText.text = $"🛏️ DOCKED: Headwall of {holo.assignedBed} ({holo.dockMode}) | Zero Jitter: ACTIVE";
                _vitalsTrackingModeText.color = new Color(0.2f, 0.85f, 1.0f);
            }
            else if (holo.trackingState == PatientTrackingState.ManualAim)
            {
                _vitalsTrackingModeText.text = "🎯 MANUAL AIM: Aim at patient & pinch/click to lock position";
                _vitalsTrackingModeText.color = new Color(1.0f, 0.85f, 0.2f);
            }
            else
            {
                _vitalsTrackingModeText.text = holo.isPersonDetected
                    ? "🟢 IN-TRANSIT: Following wristband position (pulse detected)"
                    : "🟡 IN-TRANSIT: Following wristband position (no pulse reading now)";
                _vitalsTrackingModeText.color = holo.isPersonDetected ? new Color(0.2f, 0.95f, 0.5f) : new Color(0.95f, 0.85f, 0.35f);
            }
        }

        private void OnConnectionStatusChanged(bool connected)
        {
            if (_sysServerStatus != null)
            {
                string ip = ShiroNetworkManager.Instance != null ? ShiroNetworkManager.Instance.serverIp : "192.168.1.229";
                int port = ShiroNetworkManager.Instance != null ? ShiroNetworkManager.Instance.serverPort : 3000;
                _sysServerStatus.text = connected ? $"Edge Server: ✅ CONNECTED ({ip}:{port})" : $"Edge Server: ❌ DISCONNECTED ({ip}:{port})";
                _sysServerStatus.color = connected ? new Color(0.1f, 0.95f, 0.4f) : new Color(0.95f, 0.3f, 0.2f);
            }
            if (!connected) RefreshPairingStatus();
        }

        #region UI Builder

        private void BuildHandSlateUI()
        {
            // Root Object
            _slateRoot = new GameObject("ShiroHandSlateRoot");
            _slateRoot.transform.SetParent(this.transform);

            // World Space Canvas (28cm width × 20cm height, scale factor 0.00025 = 1120 × 800 px)
            _slateCanvas = _slateRoot.AddComponent<Canvas>();
            _slateCanvas.renderMode = RenderMode.WorldSpace;
            _slateCanvasRect = _slateCanvas.GetComponent<RectTransform>();
            _slateCanvasRect.sizeDelta = new Vector2(1120f, 800f);
            _slateRoot.transform.localScale = Vector3.one * 0.00025f;

            var scaler = _slateRoot.AddComponent<CanvasScaler>();
            scaler.dynamicPixelsPerUnit = 4f;

            _slateRoot.AddComponent<GraphicRaycaster>();

            // Main Backplate
            CreatePanel(_slateRoot.transform, "Backplate", new Vector2(1120f, 800f), new Color(0.04f, 0.07f, 0.12f, 0.94f));

            // Top Header Bar
            BuildHeaderBar(_slateRoot.transform);

            // Tab Navigation Bar
            BuildTabBar(_slateRoot.transform);

            // Build 4 Tab Content Panels
            BuildTab0_WardSetup(_slateRoot.transform);
            BuildTab1_IpsLocation(_slateRoot.transform);
            BuildTab2_PatientVitals(_slateRoot.transform);
            BuildTab3_System(_slateRoot.transform);
            BuildTab4_LiveMap(_slateRoot.transform);

            // Emergency alert overlay: above every tab
            BuildAlertOverlay(_slateRoot.transform);

            // Build Mini Wrist Badge (Shown when collapsed so user can tap wrist to reopen!)
            BuildMiniWristBadge();

            // Build Fingertip Touch Bead (Visual Feedback Cursor)
            BuildTouchBead();
        }

        private void BuildHeaderBar(Transform parent)
        {
            GameObject header = CreatePanel(parent, "HeaderBar", new Vector2(1080f, 80f), new Color(0.08f, 0.14f, 0.22f, 0.95f));
            header.transform.localPosition = new Vector3(0, 340f, 0);

            Text title = CreateText(header.transform, "Title", "🏥 SHIRO MR CLINICAL HUB", 34, FontStyle.Bold, TextAnchor.MiddleLeft, new Color(0.1f, 0.85f, 0.95f));
            title.rectTransform.anchoredPosition = new Vector2(-220f, 12f);
            title.rectTransform.sizeDelta = new Vector2(600f, 44f);

            // Who uses this headset (assigned on the dashboard): actions are recorded in this name
            _headerUserText = CreateText(header.transform, "UsedBy", "👤 Used by: not known yet", 20, FontStyle.Normal, TextAnchor.MiddleLeft, new Color(0.75f, 0.85f, 0.95f));
            _headerUserText.rectTransform.anchoredPosition = new Vector2(-220f, -22f);
            _headerUserText.rectTransform.sizeDelta = new Vector2(600f, 28f);

            // Pin / Dock Button
            Button pinBtn = CreateButton(header.transform, "PinBtn", "📌 Pin to Room", new Vector2(180f, 55f), new Color(0.12f, 0.35f, 0.50f), TogglePinToWorld);
            pinBtn.transform.localPosition = new Vector3(320f, 0, 0);
            _pinButtonText = pinBtn.GetComponentInChildren<Text>();

            // Close / Collapse Button
            Button closeBtn = CreateButton(header.transform, "CloseBtn", "➖", new Vector2(60f, 55f), new Color(0.45f, 0.15f, 0.18f), ToggleSlateVisibility);
            closeBtn.transform.localPosition = new Vector3(480f, 0, 0);
        }

        private void BuildTabBar(Transform parent)
        {
            GameObject tabGroup = CreatePanel(parent, "TabBar", new Vector2(1080f, 65f), Color.clear);
            tabGroup.transform.localPosition = new Vector3(0, 255f, 0);
            _tabBarObj = tabGroup;

            string[] tabNames = { "🚪 Ward Setup", "📍 Location", "🛏️ Patient", "⚙️ System", "🗺️ Live Map" };
            float stepX = 212f;
            float startX = -stepX * (TabCount - 1) / 2f;

            for (int i = 0; i < TabCount; i++)
            {
                int index = i;
                Button btn = CreateButton(tabGroup.transform, $"TabBtn_{i}", tabNames[i], new Vector2(204f, 60f), new Color(0.08f, 0.12f, 0.18f), () => SelectTab(index));
                btn.transform.localPosition = new Vector3(startX + i * stepX, 0, 0);

                _tabHeaderButtons[i] = btn.GetComponent<Image>();
                _tabHeaderTexts[i] = btn.GetComponentInChildren<Text>();
            }
        }

        private void BuildTab0_WardSetup(Transform parent)
        {
            GameObject p = CreatePanel(parent, "Tab0_WardSetup", new Vector2(1080f, 480f), Color.clear);
            p.transform.localPosition = new Vector3(0, -30f, 0);
            _tabPanels[0] = p;

            _wardInfoText = CreateText(p.transform, "WardInfo", "Ward: not configured\nChoose a ward below (list loads from the edge server)", 26, FontStyle.Normal, TextAnchor.UpperLeft, Color.white);
            _wardInfoText.rectTransform.anchoredPosition = new Vector2(-240f, 185f);
            _wardInfoText.rectTransform.sizeDelta = new Vector2(560f, 70f);

            // Primary Entrance Alignment Button (Door Frame)
            Button doorBtn = CreateButton(p.transform, "DoorCalBtn", "🚪 Start Door Frame Calibration (L->R)", new Vector2(540f, 55f), new Color(0.08f, 0.45f, 0.55f), () =>
            {
                if (WardAlignmentTool.Instance != null)
                {
                    WardAlignmentTool.Instance.StartDoorCalibration();
                }
            });
            doorBtn.transform.localPosition = new Vector3(-240f, 125f, 0);

            // SAVE SPATIAL ANCHOR BUTTON
            Button saveAnchorBtn = CreateButton(p.transform, "SaveAnchorBtn", "💾 Save Persistent Spatial Anchor", new Vector2(540f, 50f), new Color(0.10f, 0.48f, 0.35f), SaveSpatialAnchor);
            saveAnchorBtn.transform.localPosition = new Vector3(-240f, 68f, 0);

            // PURGE & RESET ANCHOR BUTTON (Wipes stale/crashed anchor from device and database)
            Button purgeBtn = CreateButton(p.transform, "PurgeAnchorBtn", "🗑️ Purge Anchor & Reset Alignment", new Vector2(540f, 50f), new Color(0.65f, 0.22f, 0.18f), () =>
            {
                if (WardAlignmentTool.Instance != null)
                {
                    WardAlignmentTool.Instance.PurgeAnchorAndResetAlignment();
                    if (_wardStatusText != null)
                    {
                        _wardStatusText.text = "🗑️ Anchor & alignment purged! Local & Server DB reset.\nYou can now calibrate fresh with the door frame.";
                        _wardStatusText.color = new Color(0.95f, 0.85f, 0.2f);
                    }
                }
            });
            purgeBtn.transform.localPosition = new Vector3(-240f, 12f, 0);

            // Perspective Toggle
            Button perspBtn = CreateButton(p.transform, "PerspBtn", "👀 Perspective: Inside Ward", new Vector2(540f, 50f), new Color(0.14f, 0.32f, 0.42f), () =>
            {
                if (WardAlignmentTool.Instance != null)
                {
                    WardAlignmentTool.Instance.isInsideRoomLookingAtDoor = !WardAlignmentTool.Instance.isInsideRoomLookingAtDoor;
                    bool inside = WardAlignmentTool.Instance.isInsideRoomLookingAtDoor;
                    if (_perspectiveBtnText != null) _perspectiveBtnText.text = inside ? "👀 Perspective: Inside Ward" : "👀 Perspective: In Hallway";
                }
            });
            perspBtn.transform.localPosition = new Vector3(-240f, -44f, 0);
            _perspectiveBtnText = perspBtn.GetComponentInChildren<Text>();

            // Re-Sync Button
            Button resyncBtn = CreateButton(p.transform, "ResyncBtn", "⚡ 1-Click Re-Sync Alignment", new Vector2(540f, 50f), new Color(0.12f, 0.40f, 0.30f), () =>
            {
                if (WardAlignmentTool.Instance != null) WardAlignmentTool.Instance.QuickReSync();
            });
            resyncBtn.transform.localPosition = new Vector3(-240f, -100f, 0);

            // Digital Twin Overlay Toggle
            Button overlayBtn = CreateButton(p.transform, "OverlayBtn", "👁️ Toggle 3D Digital Twin Overlay", new Vector2(540f, 50f), new Color(0.25f, 0.20f, 0.38f), () =>
            {
                if (WardVisualizer.Instance != null)
                {
                    WardVisualizer.Instance.ToggleOverlay(!WardVisualizer.Instance.showDigitalTwinOverlay);
                }
            });
            overlayBtn.transform.localPosition = new Vector3(-240f, -156f, 0);
            _overlayBtnText = overlayBtn.GetComponentInChildren<Text>();

            // Automatic ward detection from this headset's saved anchors (on/off)
            Button autoWardBtn = CreateButton(p.transform, "AutoWardBtn", "🧭 Auto ward: …", new Vector2(540f, 45f), new Color(0.10f, 0.30f, 0.40f), () =>
            {
                var det = ShiroWardAutoDetect.Instance;
                if (det != null) det.SetEnabled(!det.IsEnabled);
                RefreshAutoWardLabel();
            });
            autoWardBtn.transform.localPosition = new Vector3(-240f, -210f, 0);
            _autoWardBtnText = autoWardBtn.GetComponentInChildren<Text>();
            RefreshAutoWardLabel();

            // Right Status Card
            GameObject rightCard = CreatePanel(p.transform, "StatusCard", new Vector2(480f, 430f), new Color(0.06f, 0.10f, 0.16f, 0.90f));
            rightCard.transform.localPosition = new Vector3(270f, 0, 0);

            Text cardTitle = CreateText(rightCard.transform, "CardTitle", "CALIBRATION STATUS", 24, FontStyle.Bold, TextAnchor.MiddleCenter, new Color(0.1f, 0.85f, 0.95f));
            cardTitle.rectTransform.anchoredPosition = new Vector2(0, 180f);
            cardTitle.rectTransform.sizeDelta = new Vector2(440f, 35f);

            _wardStatusText = CreateText(rightCard.transform, "StatusText", "Aim at floor bottom-left, then bottom-right of physical door frame.\nClick 'Save Persistent Spatial Anchor' to lock coordinates permanently.", 20, FontStyle.Normal, TextAnchor.UpperLeft, new Color(0.85f, 0.90f, 0.95f));
            _wardStatusText.rectTransform.anchoredPosition = new Vector2(0, 115f);
            _wardStatusText.rectTransform.sizeDelta = new Vector2(440f, 85f);

            // Hospital Ward Selector Section
            Text wardSelectTitle = CreateText(rightCard.transform, "WardSelectTitle", "🏥 SWITCH HOSPITAL WARD:", 22, FontStyle.Bold, TextAnchor.MiddleLeft, new Color(0.1f, 0.85f, 0.95f));
            wardSelectTitle.rectTransform.anchoredPosition = new Vector2(0, 35f);
            wardSelectTitle.rectTransform.sizeDelta = new Vector2(440f, 30f);

            _wardButtonContainer = new GameObject("WardButtonsGroup");
            _wardButtonContainer.transform.SetParent(rightCard.transform, false);
            _wardButtonContainer.transform.localPosition = new Vector3(0, -65f, 0);

            RebuildWardButtons();
        }

        private void BuildTab1_IpsLocation(Transform parent)
        {
            GameObject p = CreatePanel(parent, "Tab1_IpsLocation", new Vector2(1080f, 480f), Color.clear);
            p.transform.localPosition = new Vector3(0, -30f, 0);
            _tabPanels[1] = p;

            Button findBtn = CreateButton(p.transform, "FindIpsBtn", "🔍 Find My Current Ward / Room", new Vector2(540f, 75f), new Color(0.08f, 0.52f, 0.38f), () => ExecuteIpsLocationFind(silent: false));
            findBtn.transform.localPosition = new Vector3(-240f, 170f, 0);

            Button autoBtn = CreateButton(p.transform, "AutoIpsBtn", "🔄 Auto-Refresh: Continuous (4Hz)", new Vector2(540f, 60f), new Color(0.15f, 0.30f, 0.45f), ToggleAutoRefreshIps);
            autoBtn.transform.localPosition = new Vector3(-240f, 85f, 0);

            GameObject leftCard = CreatePanel(p.transform, "LeftCard", new Vector2(540f, 250f), new Color(0.06f, 0.10f, 0.16f, 0.90f));
            leftCard.transform.localPosition = new Vector3(-240f, -90f, 0);

            Text coordHeader = CreateText(leftCard.transform, "CoordHeader", "📐 3D HEADSET COORDINATES (SI METERS):", 22, FontStyle.Bold, TextAnchor.UpperLeft, new Color(0.1f, 0.85f, 0.95f));
            coordHeader.rectTransform.anchoredPosition = new Vector2(0, 95f);
            coordHeader.rectTransform.sizeDelta = new Vector2(500f, 35f);

            _ipsCoordinatesText = CreateText(leftCard.transform, "CoordsText", "Position: not available yet", 24, FontStyle.Bold, TextAnchor.UpperLeft, Color.white);
            _ipsCoordinatesText.rectTransform.anchoredPosition = new Vector2(0, 55f);
            _ipsCoordinatesText.rectTransform.sizeDelta = new Vector2(500f, 35f);

            Text distHeader = CreateText(leftCard.transform, "DistHeader", "📏 DISTANCE TO WARD BOUNDARIES:", 22, FontStyle.Bold, TextAnchor.UpperLeft, new Color(0.1f, 0.85f, 0.95f));
            distHeader.rectTransform.anchoredPosition = new Vector2(0, 5f);
            distHeader.rectTransform.sizeDelta = new Vector2(500f, 35f);

            _ipsDistancesText = CreateText(leftCard.transform, "DistancesText", "", 22, FontStyle.Normal, TextAnchor.UpperLeft, new Color(0.85f, 0.90f, 0.95f));
            _ipsDistancesText.rectTransform.anchoredPosition = new Vector2(0, -50f);
            _ipsDistancesText.rectTransform.sizeDelta = new Vector2(500f, 60f);

            GameObject rightCard = CreatePanel(p.transform, "RightCard", new Vector2(490f, 430f), new Color(0.06f, 0.11f, 0.18f, 0.95f));
            rightCard.transform.localPosition = new Vector3(275f, 0, 0);

            _ipsStatusBadge = CreateText(rightCard.transform, "StatusBadge", "📍 LOCATION NOT CHECKED YET", 26, FontStyle.Bold, TextAnchor.MiddleCenter, new Color(0.95f, 0.80f, 0.1f));
            _ipsStatusBadge.rectTransform.anchoredPosition = new Vector2(0, 175f);
            _ipsStatusBadge.rectTransform.sizeDelta = new Vector2(460f, 45f);

            _ipsResultSummary = CreateText(rightCard.transform, "ResultSummary", "Click 'Find My Current Ward' to query the IPS engine and spatial mapping.", 22, FontStyle.Normal, TextAnchor.UpperLeft, Color.white);
            _ipsResultSummary.rectTransform.anchoredPosition = new Vector2(0, 95f);
            _ipsResultSummary.rectTransform.sizeDelta = new Vector2(450f, 85f);

            Text anchorTitle = CreateText(rightCard.transform, "AnchorTitle", "📡 NEAREST BLE WALL ANCHOR:", 20, FontStyle.Bold, TextAnchor.UpperLeft, new Color(0.1f, 0.85f, 0.95f));
            anchorTitle.rectTransform.anchoredPosition = new Vector2(0, 20f);
            anchorTitle.rectTransform.sizeDelta = new Vector2(450f, 30f);

            _ipsNearestAnchorText = CreateText(rightCard.transform, "NearestAnchor", "--", 22, FontStyle.Normal, TextAnchor.UpperLeft, new Color(0.85f, 0.92f, 0.98f));
            _ipsNearestAnchorText.rectTransform.anchoredPosition = new Vector2(0, -15f);
            _ipsNearestAnchorText.rectTransform.sizeDelta = new Vector2(450f, 35f);

            Text bedTitle = CreateText(rightCard.transform, "BedTitle", "🛏️ NEAREST CLINICAL BED:", 20, FontStyle.Bold, TextAnchor.UpperLeft, new Color(0.1f, 0.85f, 0.95f));
            bedTitle.rectTransform.anchoredPosition = new Vector2(0, -65f);
            bedTitle.rectTransform.sizeDelta = new Vector2(450f, 30f);

            _ipsNearestBedText = CreateText(rightCard.transform, "NearestBed", "--", 22, FontStyle.Normal, TextAnchor.UpperLeft, new Color(0.85f, 0.92f, 0.98f));
            _ipsNearestBedText.rectTransform.anchoredPosition = new Vector2(0, -100f);
            _ipsNearestBedText.rectTransform.sizeDelta = new Vector2(450f, 35f);

            _ipsConfidenceText = CreateText(rightCard.transform, "Confidence", "", 20, FontStyle.Italic, TextAnchor.MiddleCenter, new Color(0.2f, 0.90f, 0.70f));
            _ipsConfidenceText.rectTransform.anchoredPosition = new Vector2(0, -170f);
            _ipsConfidenceText.rectTransform.sizeDelta = new Vector2(450f, 35f);
        }

        private void BuildTab2_PatientVitals(Transform parent)
        {
            GameObject p = CreatePanel(parent, "Tab2_PatientVitals", new Vector2(1080f, 480f), Color.clear);
            p.transform.localPosition = new Vector3(0, -30f, 0);
            _tabPanels[2] = p;

            _vitalsPatientName = CreateText(p.transform, "PatientName", "👤 No patient yet: waiting for the ward and its patients from the edge server", 26, FontStyle.Bold, TextAnchor.MiddleLeft, Color.white);
            _vitalsPatientName.rectTransform.anchoredPosition = new Vector2(0, 195f);
            _vitalsPatientName.rectTransform.sizeDelta = new Vector2(1040f, 40f);

            // Real-Time Docking & Tracking Status Line
            _vitalsTrackingModeText = CreateText(p.transform, "TrackingMode", "Panel position: no patient panel yet", 22, FontStyle.Bold, TextAnchor.MiddleLeft, new Color(0.2f, 0.85f, 1.0f));
            _vitalsTrackingModeText.rectTransform.anchoredPosition = new Vector2(0, 155f);
            _vitalsTrackingModeText.rectTransform.sizeDelta = new Vector2(1040f, 35f);

            // 4 Vitals Tiles
            GameObject tileHr = CreatePanel(p.transform, "TileHr", new Vector2(245f, 150f), new Color(0.12f, 0.16f, 0.24f, 0.90f));
            tileHr.transform.localPosition = new Vector3(-390f, 45f, 0);
            CreateText(tileHr.transform, "Lbl", "❤️ HEART RATE", 20, FontStyle.Bold, TextAnchor.MiddleCenter, new Color(0.95f, 0.35f, 0.40f)).rectTransform.anchoredPosition = new Vector2(0, 42f);
            _vitalsBpmText = CreateText(tileHr.transform, "Val", "-- BPM", 36, FontStyle.Bold, TextAnchor.MiddleCenter, Color.white);
            _vitalsBpmText.rectTransform.anchoredPosition = new Vector2(0, -12f);

            GameObject tileSpo2 = CreatePanel(p.transform, "TileSpo2", new Vector2(245f, 150f), new Color(0.12f, 0.16f, 0.24f, 0.90f));
            tileSpo2.transform.localPosition = new Vector3(-130f, 45f, 0);
            CreateText(tileSpo2.transform, "Lbl", "🫁 OXYGEN (SpO2)", 20, FontStyle.Bold, TextAnchor.MiddleCenter, new Color(0.2f, 0.85f, 0.95f)).rectTransform.anchoredPosition = new Vector2(0, 42f);
            _vitalsSpo2Text = CreateText(tileSpo2.transform, "Val", "-- %", 36, FontStyle.Bold, TextAnchor.MiddleCenter, Color.white);
            _vitalsSpo2Text.rectTransform.anchoredPosition = new Vector2(0, -12f);

            GameObject tileMotion = CreatePanel(p.transform, "TileMotion", new Vector2(245f, 150f), new Color(0.12f, 0.16f, 0.24f, 0.90f));
            tileMotion.transform.localPosition = new Vector3(130f, 45f, 0);
            CreateText(tileMotion.transform, "Lbl", "🏃 MOTION STATE", 20, FontStyle.Bold, TextAnchor.MiddleCenter, new Color(0.95f, 0.75f, 0.20f)).rectTransform.anchoredPosition = new Vector2(0, 42f);
            _vitalsMotionText = CreateText(tileMotion.transform, "Val", "--", 30, FontStyle.Bold, TextAnchor.MiddleCenter, Color.white);
            _vitalsMotionText.rectTransform.anchoredPosition = new Vector2(0, -12f);

            GameObject tileBat = CreatePanel(p.transform, "TileBat", new Vector2(245f, 150f), new Color(0.12f, 0.16f, 0.24f, 0.90f));
            tileBat.transform.localPosition = new Vector3(390f, 45f, 0);
            CreateText(tileBat.transform, "Lbl", "🔋 WRISTBAND", 20, FontStyle.Bold, TextAnchor.MiddleCenter, new Color(0.3f, 0.95f, 0.45f)).rectTransform.anchoredPosition = new Vector2(0, 42f);
            _vitalsBatteryText = CreateText(tileBat.transform, "Val", "-- %", 36, FontStyle.Bold, TextAnchor.MiddleCenter, Color.white);
            _vitalsBatteryText.rectTransform.anchoredPosition = new Vector2(0, -12f);

            // Phase A Action Buttons: [🎯 Re-Attach Hologram] and [📍 Toggle Headboard / Bedside]
            Button reattachBtn = CreateButton(p.transform, "Btn_ReattachHolo", "🎯 Re-Attach Hologram to Gaze / Aim", new Vector2(510f, 54f),
                new Color(0.12f, 0.45f, 0.65f, 0.95f), ReAttachPatientHologram);
            reattachBtn.transform.localPosition = new Vector3(-265f, -65f, 0);

            Button toggleDockBtn = CreateButton(p.transform, "Btn_ToggleDock", "📍 Toggle Mount: Headboard / Bedside", new Vector2(510f, 54f),
                new Color(0.10f, 0.32f, 0.48f, 0.95f), TogglePatientDockMode);
            toggleDockBtn.transform.localPosition = new Vector3(265f, -65f, 0);

            // Emergency Banner
            // Neutral until the headset shows real fall alerts (Phase 8C); green would claim "stable"
            GameObject banner = CreatePanel(p.transform, "EmergencyBanner", new Vector2(1040f, 65f), new Color(0.12f, 0.15f, 0.20f, 0.95f));
            banner.transform.localPosition = new Vector3(0, -145f, 0);
            _vitalsEmergencyStatus = CreateText(banner.transform, "AlertText", "⚪ FALL ALERTS: waiting for the edge server", 22, FontStyle.Bold, TextAnchor.MiddleCenter, new Color(0.85f, 0.88f, 0.92f));
            _vitalsEmergencyStatus.rectTransform.anchoredPosition = Vector2.zero;
            _vitalsEmergencyStatus.rectTransform.sizeDelta = new Vector2(1000f, 55f);
        }

        /// <summary>
        /// Builds Tab 3 (System Diagnostics) with perfectly centered and balanced text!
        /// Zero left-bleeding, with comfortable 40px padding on all sides.
        /// </summary>
        private void BuildTab3_System(Transform parent)
        {
            GameObject p = CreatePanel(parent, "Tab3_System", new Vector2(1080f, 480f), Color.clear);
            p.transform.localPosition = new Vector3(0, -30f, 0);
            _tabPanels[3] = p;

            string ip = ShiroNetworkManager.Instance != null ? ShiroNetworkManager.Instance.serverIp : "192.168.1.229";
            int port = ShiroNetworkManager.Instance != null ? ShiroNetworkManager.Instance.serverPort : 3000;

            // Header (Centered, Width 1000)
            Text header = CreateText(p.transform, "SysHeader", "SYSTEM DIAGNOSTICS & TELEMETRY", 28, FontStyle.Bold, TextAnchor.MiddleLeft, new Color(0.1f, 0.85f, 0.95f));
            header.rectTransform.anchoredPosition = new Vector2(0f, 175f);
            header.rectTransform.sizeDelta = new Vector2(1000f, 50f);

            // Server Status (Centered, Width 1000)
            bool isConn = ShiroNetworkManager.Instance != null && ShiroNetworkManager.Instance.IsConnected;
            _sysServerStatus = CreateText(p.transform, "ServerStatus", isConn ? $"Edge Server: ✅ CONNECTED ({ip}:{port})" : $"Edge Server: ❌ DISCONNECTED ({ip}:{port})", 24, FontStyle.Normal, TextAnchor.MiddleLeft, isConn ? new Color(0.1f, 0.95f, 0.4f) : new Color(0.95f, 0.3f, 0.2f));
            _sysServerStatus.rectTransform.anchoredPosition = new Vector2(0f, 115f);
            _sysServerStatus.rectTransform.sizeDelta = new Vector2(1000f, 45f);

            // Headset Battery (Centered, Width 1000)
            _sysBatteryStatus = CreateText(p.transform, "HeadsetBat", SystemInfo.batteryLevel >= 0 ? $"Meta Quest 3 Battery: {Mathf.RoundToInt(SystemInfo.batteryLevel * 100)} %" : "Meta Quest 3 Battery: not reported", 24, FontStyle.Normal, TextAnchor.MiddleLeft, Color.white);
            _sysBatteryStatus.rectTransform.anchoredPosition = new Vector2(0f, 55f);
            _sysBatteryStatus.rectTransform.sizeDelta = new Vector2(1000f, 45f);

            // Spatial Anchor UUID (Centered, Width 1000)
            string curWard = ShiroNetworkManager.Instance != null ? ShiroNetworkManager.Instance.targetWardId : "";
            string headsetId = ShiroNetworkManager.Instance != null && ShiroNetworkManager.Instance.Identity != null ? ShiroNetworkManager.Instance.Identity.DeviceId : "unknown";
            _sysAnchorUuid = CreateText(p.transform, "AnchorUuid", string.IsNullOrEmpty(curWard)
                ? $"Headset: {headsetId}  |  Active Ward: not configured"
                : $"Headset: {headsetId}  |  Active Ward: {curWard}", 24, FontStyle.Normal, TextAnchor.MiddleLeft, new Color(0.80f, 0.85f, 0.95f));
            _sysAnchorUuid.rectTransform.anchoredPosition = new Vector2(0f, -5f);
            _sysAnchorUuid.rectTransform.sizeDelta = new Vector2(1000f, 45f);

            // Row 1: Reconnect & Quick IP Preset Buttons
            Button reconnectBtn = CreateButton(p.transform, "ReconnectBtn", "🔄 Reconnect", new Vector2(240f, 55f), new Color(0.12f, 0.35f, 0.50f), () =>
            {
                if (ShiroNetworkManager.Instance != null) ShiroNetworkManager.Instance.Connect();
            });
            reconnectBtn.transform.localPosition = new Vector3(-350f, -85f, 0);

            Button wifiIpBtn = CreateButton(p.transform, "WifiIpBtn", "📶 Wi-Fi (.1.229)", new Vector2(310f, 55f), new Color(0.10f, 0.42f, 0.35f), () =>
            {
                if (ShiroNetworkManager.Instance != null) ShiroNetworkManager.Instance.SetServerIp("192.168.1.229");
            });
            wifiIpBtn.transform.localPosition = new Vector3(-55f, -85f, 0);

            Button hotspotIpBtn = CreateButton(p.transform, "HotspotIpBtn", "📱 Hotspot (.137.1)", new Vector2(310f, 55f), new Color(0.35f, 0.25f, 0.55f), () =>
            {
                if (ShiroNetworkManager.Instance != null) ShiroNetworkManager.Instance.SetServerIp("192.168.137.1");
            });
            hotspotIpBtn.transform.localPosition = new Vector3(280f, -85f, 0);

            // Row 2: Localhost option for Quest Link PC testing, and pairing
            Button localIpBtn = CreateButton(p.transform, "LocalIpBtn", "💻 Localhost (127.0.0.1 for PC Link)", new Vector2(480f, 45f), new Color(0.20f, 0.25f, 0.32f), () =>
            {
                if (ShiroNetworkManager.Instance != null) ShiroNetworkManager.Instance.SetServerIp("127.0.0.1");
            });
            localIpBtn.transform.localPosition = new Vector3(-250f, -150f, 0);

            Button pairBtn = CreateButton(p.transform, "PairBtn", "🔑 Pair headset (code)", new Vector2(420f, 45f), new Color(0.55f, 0.40f, 0.08f), OpenPairingPad);
            pairBtn.transform.localPosition = new Vector3(250f, -150f, 0);

            // Row 3: depth test view (8D) and its movement rule
            Button depthBtn = CreateButton(p.transform, "DepthBtn", "🔬 Depth test: OFF", new Vector2(480f, 45f), new Color(0.22f, 0.18f, 0.40f), () =>
            {
                var probe = ShiroDepthProbe.Instance;
                if (probe != null) probe.SetRunning(!probe.IsRunning);
                RefreshAutoWardLabel();
            });
            depthBtn.transform.localPosition = new Vector3(-250f, -205f, 0);
            _depthBtnText = depthBtn.GetComponentInChildren<Text>();

            Button moveBtn = CreateButton(p.transform, "MoveReqBtn", "🚶 Movement required: ON", new Vector2(420f, 45f), new Color(0.22f, 0.30f, 0.22f), () =>
            {
                var probe = ShiroDepthProbe.Instance;
                if (probe != null) probe.SetMovementRequired(!probe.MovementRequired);
                RefreshAutoWardLabel();
            });
            moveBtn.transform.localPosition = new Vector3(250f, -205f, 0);
            _moveReqBtnText = moveBtn.GetComponentInChildren<Text>();

            BuildPairingPad(p.transform);
            RefreshPairingStatus();
        }

        // ----- Pairing: 6-digit code from the dashboard (ADMIN → Headset Pairing) -----

        private GameObject _pairPanel;
        private Text _pairCodeText;
        private Text _pairStatusText;
        private string _pairDigits = "";

        private void BuildPairingPad(Transform parent)
        {
            _pairPanel = CreatePanel(parent, "PairingPad", new Vector2(1080f, 480f), new Color(0.03f, 0.06f, 0.10f, 0.97f));
            _pairPanel.transform.localPosition = Vector3.zero;

            Text title = CreateText(_pairPanel.transform, "PairTitle", "🔑 PAIR THIS HEADSET", 28, FontStyle.Bold, TextAnchor.MiddleCenter, new Color(0.95f, 0.75f, 0.2f));
            title.rectTransform.anchoredPosition = new Vector2(0f, 200f);
            title.rectTransform.sizeDelta = new Vector2(1000f, 45f);

            _pairCodeText = CreateText(_pairPanel.transform, "PairCode", "_ _ _ _ _ _", 52, FontStyle.Bold, TextAnchor.MiddleCenter, Color.white);
            _pairCodeText.rectTransform.anchoredPosition = new Vector2(-170f, 140f);
            _pairCodeText.rectTransform.sizeDelta = new Vector2(500f, 70f);

            string[] keys = { "1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "C" };
            for (int i = 0; i < keys.Length; i++)
            {
                string key = keys[i];
                float x = -300f + (i % 3) * 130f;
                float y = 65f - (i / 3) * 65f;
                Button k = CreateButton(_pairPanel.transform, $"Key_{i}", key, new Vector2(115f, 55f), new Color(0.12f, 0.20f, 0.30f), () => PressPairKey(key));
                k.transform.localPosition = new Vector3(x, y, 0);
            }

            Button submit = CreateButton(_pairPanel.transform, "PairSubmit", "✓ Pair", new Vector2(300f, 60f), new Color(0.10f, 0.50f, 0.30f), () =>
            {
                if (ShiroNetworkManager.Instance != null) ShiroNetworkManager.Instance.Pair(_pairDigits);
            });
            submit.transform.localPosition = new Vector3(300f, 65f, 0);

            Button close = CreateButton(_pairPanel.transform, "PairClose", "✖ Close", new Vector2(300f, 55f), new Color(0.30f, 0.20f, 0.22f), () =>
            {
                _pairPanel.SetActive(false);
            });
            close.transform.localPosition = new Vector3(300f, 0f, 0);

            _pairStatusText = CreateText(_pairPanel.transform, "PairStatus", "", 21, FontStyle.Normal, TextAnchor.UpperCenter, new Color(0.85f, 0.9f, 1f));
            _pairStatusText.rectTransform.anchoredPosition = new Vector2(0f, -185f);
            _pairStatusText.rectTransform.sizeDelta = new Vector2(1020f, 90f);

            _pairPanel.SetActive(false);

            if (ShiroNetworkManager.Instance != null)
            {
                ShiroNetworkManager.Instance.OnPairingStatusChanged -= OnPairingStatusChanged;
                ShiroNetworkManager.Instance.OnPairingStatusChanged += OnPairingStatusChanged;
            }
        }

        private void OpenPairingPad()
        {
            if (_pairPanel == null) return;
            _pairDigits = "";
            UpdatePairCode();
            _pairPanel.SetActive(true);
            RefreshPairingStatus();
        }

        private void PressPairKey(string key)
        {
            if (key == "⌫") { if (_pairDigits.Length > 0) _pairDigits = _pairDigits.Substring(0, _pairDigits.Length - 1); }
            else if (key == "C") _pairDigits = "";
            else if (_pairDigits.Length < 6) _pairDigits += key;
            UpdatePairCode();
        }

        private void UpdatePairCode()
        {
            if (_pairCodeText == null) return;
            var shown = new StringBuilder();
            for (int i = 0; i < 6; i++)
            {
                if (i > 0) shown.Append(' ');
                shown.Append(i < _pairDigits.Length ? _pairDigits[i] : '_');
            }
            _pairCodeText.text = shown.ToString();
        }

        private void OnPairingStatusChanged(bool paired, string message)
        {
            if (paired && _pairPanel != null) _pairPanel.SetActive(false);
            RefreshPairingStatus();
        }

        private void RefreshPairingStatus()
        {
            var net = ShiroNetworkManager.Instance;
            if (net == null) return;
            if (_pairStatusText != null)
            {
                _pairStatusText.text = $"Headset {(net.Identity != null ? net.Identity.DeviceId : "?")} → {net.serverIp}:{net.serverPort}\n{net.PairingMessage}";
                _pairStatusText.color = net.IsPaired ? new Color(0.4f, 0.95f, 0.6f) : new Color(1f, 0.8f, 0.4f);
            }
            if (!net.IsPaired && _sysServerStatus != null)
            {
                _sysServerStatus.text = $"Edge Server: 🔑 NOT PAIRED ({net.serverIp}:{net.serverPort}) – tap \"Pair headset\"";
                _sysServerStatus.color = new Color(1f, 0.75f, 0.2f);
            }
        }

        private void BuildTab4_LiveMap(Transform parent)
        {
            GameObject p = CreatePanel(parent, "Tab4_LiveMap", new Vector2(1080f, 480f), Color.clear);
            p.transform.localPosition = new Vector3(0, -30f, 0);
            _tabPanels[4] = p;
            // The map's buttons (wards, patient dots, card) are made here, so fingertip touch reaches them
            p.AddComponent<ShiroWardMiniMap>().Build(
                p.transform,
                (parentT, name, label, size, color, onClick) => CreateButton(parentT, name, label, size, color, onClick),
                (btn) => _registeredButtons.Remove(btn));
        }

        // ----- Emergency alert overlay (ShiroAlertManager) -----
        private GameObject _alertPanel;
        private Image _alertPanelImage;
        private Text _alertTitle;
        private Text _alertPatient;
        private Text _alertDetails;
        private Text _alertState;
        private Button _alertAckBtn;
        private Text _alertAckBtnText;
        private Button _alertOkBtn;
        private Text _alertMuteBtnText;
        private Button _headerAlertBtn;
        private Text _headerAlertBtnText;
        private Text _wristBadgeText;
        private bool _alertOverlayHidden;     // "Show on map" hides it until the next alert
        private bool _alertSubscribed;
        private float _alertBlinkTimer;
        private float _ownAckNoticeUntil;
        private string _lastOwnAckShown;

        private void BuildAlertOverlay(Transform parent)
        {
            _alertPanel = CreatePanel(parent, "AlertOverlay", new Vector2(1080f, 560f), new Color(0.30f, 0.03f, 0.05f, 0.97f));
            _alertPanel.transform.localPosition = new Vector3(0, -10f, 0);
            _alertPanelImage = _alertPanel.GetComponent<Image>();

            _alertTitle = CreateText(_alertPanel.transform, "AlertTitle", "", 38, FontStyle.Bold, TextAnchor.MiddleCenter, Color.white);
            _alertTitle.rectTransform.anchoredPosition = new Vector2(0, 225f);
            _alertTitle.rectTransform.sizeDelta = new Vector2(1040f, 60f);

            _alertPatient = CreateText(_alertPanel.transform, "AlertPatient", "", 30, FontStyle.Bold, TextAnchor.MiddleCenter, Color.white);
            _alertPatient.rectTransform.anchoredPosition = new Vector2(0, 160f);
            _alertPatient.rectTransform.sizeDelta = new Vector2(1040f, 50f);

            _alertDetails = CreateText(_alertPanel.transform, "AlertDetails", "", 23, FontStyle.Normal, TextAnchor.UpperCenter, new Color(1f, 0.88f, 0.88f));
            _alertDetails.rectTransform.anchoredPosition = new Vector2(0, 65f);
            _alertDetails.rectTransform.sizeDelta = new Vector2(1020f, 120f);

            _alertState = CreateText(_alertPanel.transform, "AlertState", "", 24, FontStyle.Bold, TextAnchor.MiddleCenter, new Color(1f, 0.85f, 0.4f));
            _alertState.rectTransform.anchoredPosition = new Vector2(0, -35f);
            _alertState.rectTransform.sizeDelta = new Vector2(1020f, 70f);

            _alertAckBtn = CreateButton(_alertPanel.transform, "AlertAck", "✓ ACKNOWLEDGE & RESPOND", new Vector2(560f, 80f), new Color(0.80f, 0.10f, 0.12f), () =>
            {
                var am = ShiroAlertManager.Instance;
                if (am != null) am.Acknowledge(am.Current);
                PlayClickTone();
            });
            _alertAckBtn.transform.localPosition = new Vector3(-215f, -130f, 0);
            _alertAckBtnText = _alertAckBtn.GetComponentInChildren<Text>();
            _alertAckBtnText.fontSize = 30;

            _alertOkBtn = CreateButton(_alertPanel.transform, "AlertOk", "OK, close", new Vector2(560f, 80f), new Color(0.05f, 0.55f, 0.35f), () =>
            {
                var am = ShiroAlertManager.Instance;
                if (am != null) am.Dismiss(am.Current);
                PlayClickTone();
            });
            _alertOkBtn.transform.localPosition = new Vector3(-215f, -130f, 0);
            _alertOkBtn.GetComponentInChildren<Text>().fontSize = 30;

            Button mapBtn = CreateButton(_alertPanel.transform, "AlertMap", "🗺️ Show on map", new Vector2(300f, 80f), new Color(0.10f, 0.35f, 0.60f), () =>
            {
                _alertOverlayHidden = true;
                RefreshAlertUi();
                SelectTab(4);
            });
            mapBtn.transform.localPosition = new Vector3(225f, -130f, 0);

            Button muteBtn = CreateButton(_alertPanel.transform, "AlertMute", "🔔 Mute", new Vector2(150f, 80f), new Color(0.25f, 0.20f, 0.22f), () =>
            {
                if (ShiroAlertManager.Instance != null) ShiroAlertManager.Instance.ToggleMute();
                PlayClickTone();
            });
            muteBtn.transform.localPosition = new Vector3(450f, -130f, 0);
            _alertMuteBtnText = muteBtn.GetComponentInChildren<Text>();

            Text hint = CreateText(_alertPanel.transform, "AlertHint", "The acknowledgement is recorded for this headset and its pairing, and every dashboard sees it.", 19, FontStyle.Italic, TextAnchor.MiddleCenter, new Color(1f, 0.8f, 0.8f, 0.85f));
            hint.rectTransform.anchoredPosition = new Vector2(0, -220f);
            hint.rectTransform.sizeDelta = new Vector2(1040f, 40f);

            _alertPanel.SetActive(false);

            // Header button: brings the alert back after "Show on map"
            Transform header = _slateRoot.transform.Find("HeaderBar");
            if (header != null)
            {
                _headerAlertBtn = CreateButton(header, "HeaderAlertBtn", "🚨 ALERT", new Vector2(190f, 55f), new Color(0.75f, 0.08f, 0.10f), () =>
                {
                    _alertOverlayHidden = false;
                    RefreshAlertUi();
                    PlayClickTone();
                });
                _headerAlertBtn.transform.localPosition = new Vector3(120f, 0, 0);
                _headerAlertBtnText = _headerAlertBtn.GetComponentInChildren<Text>();
                _headerAlertBtn.gameObject.SetActive(false);
            }
        }

        private bool _alignSubscribed;
        private Text _headerUserText;

        private void OnAssignmentChanged(ClinicianRef who)
        {
            if (_headerUserText == null) return;
            if (who != null)
            {
                _headerUserText.text = $"👤 Used by: {who.name} ({who.id})";
                _headerUserText.color = new Color(0.75f, 0.95f, 0.85f);
            }
            else
            {
                _headerUserText.text = "👤 No clinician assigned: ask an admin (dashboard → ADMIN → Headsets)";
                _headerUserText.color = new Color(1f, 0.75f, 0.3f);
            }
        }

        /// <summary>Alignment messages (save, re-sync, re-localization after sleep) on the Ward tab.</summary>
        private void TrySubscribeAlignment()
        {
            if (WardAlignmentTool.Instance == null || WardSpatialManager.Instance == null) return;
            WardAlignmentTool.Instance.OnAlignmentMessage += ShowWardStatus;
            WardSpatialManager.Instance.OnRelocalized += HandleRelocalized;
            _alignSubscribed = true;
        }

        private void ShowWardStatus(string text, Color color)
        {
            if (_wardStatusText == null) return;
            _wardStatusText.text = text;
            _wardStatusText.color = color;
        }

        private void HandleRelocalized(bool ok, string message)
        {
            ShowWardStatus(message, ok ? new Color(0.1f, 0.95f, 0.4f) : new Color(0.95f, 0.5f, 0.2f));
        }

        private void TrySubscribeAlerts()
        {
            var am = ShiroAlertManager.Instance;
            if (am == null) return;
            am.OnAlertsChanged += RefreshAlertUi;
            am.OnAlertRaised += HandleAlertRaised;
            _alertSubscribed = true;
            RefreshAlertUi();
        }

        private void HandleAlertRaised(ShiroAlertManager.HeadsetAlert alert)
        {
            // A new alert always comes to the front: open the slate and the overlay
            _alertOverlayHidden = false;
            if (!isSlateVisible) ToggleSlateVisibility();
            try { OVRInput.SetControllerVibration(0.6f, 0.6f, OVRInput.Controller.LTouch); }
            catch (Exception swallowed) { ShiroLog.Caught("ShiroHandSlate.HandleAlertRaised", swallowed); }
            RefreshAlertUi();
        }

        /// <summary>Shows the current alert, the header button, the wrist badge and the Patient tab banner.</summary>
        private void RefreshAlertUi()
        {
            var am = ShiroAlertManager.Instance;
            var current = am != null ? am.Current : null;
            int pending = am != null ? am.PendingCount : 0;
            int total = am != null ? am.Alerts.Count : 0;

            bool showOverlay = current != null && !_alertOverlayHidden;
            if (_alertPanel != null)
            {
                _alertPanel.SetActive(showOverlay);
                // Buttons of the hidden tab must not be touchable through the overlay
                if (_tabBarObj != null) _tabBarObj.SetActive(!showOverlay);
                if (_tabPanels[_currentTabIndex] != null) _tabPanels[_currentTabIndex].SetActive(!showOverlay);
            }

            if (showOverlay) FillAlertOverlay(current, total);

            if (_headerAlertBtn != null)
            {
                _headerAlertBtn.gameObject.SetActive(current != null && _alertOverlayHidden);
                if (_headerAlertBtnText != null) _headerAlertBtnText.text = pending > 0 ? $"🚨 {pending} ALERT{(pending > 1 ? "S" : "")}" : "✔ ALERT";
            }

            if (_wristBadgeBtn != null)
            {
                if (_wristBadgeText == null) _wristBadgeText = _wristBadgeBtn.GetComponentInChildren<Text>();
                var img = _wristBadgeBtn.GetComponent<Image>();
                if (pending > 0)
                {
                    if (_wristBadgeText != null) _wristBadgeText.text = "🚨 ALERT – TAP TO OPEN";
                    if (img != null) img.color = new Color(0.80f, 0.08f, 0.10f, 0.95f);
                }
                else
                {
                    if (_wristBadgeText != null) _wristBadgeText.text = "📱 TAP TO OPEN MENU";
                    if (img != null) img.color = new Color(0.06f, 0.45f, 0.65f, 0.95f);
                }
            }

            if (_vitalsEmergencyStatus != null)
            {
                var net = ShiroNetworkManager.Instance;
                Image banner = _vitalsEmergencyStatus.transform.parent != null ? _vitalsEmergencyStatus.transform.parent.GetComponent<Image>() : null;
                if (pending > 0)
                {
                    _vitalsEmergencyStatus.text = $"🚨 {pending} ALERT{(pending > 1 ? "S" : "")} WAITING FOR RESPONSE: {current.incident.CategoryLabel} – {current.incident.patient_name ?? "unknown patient"}";
                    _vitalsEmergencyStatus.color = Color.white;
                    if (banner != null) banner.color = new Color(0.70f, 0.06f, 0.08f, 0.95f);
                }
                else if (net != null && net.IsConnected)
                {
                    _vitalsEmergencyStatus.text = $"🟢 No alert waiting for response ({am?.ServerCheckText ?? "connected"})";
                    _vitalsEmergencyStatus.color = new Color(0.2f, 0.95f, 0.5f);
                    if (banner != null) banner.color = new Color(0.08f, 0.25f, 0.18f, 0.95f);
                }
                else
                {
                    _vitalsEmergencyStatus.text = "⚪ ALERTS: not connected to the edge server – alerts cannot arrive";
                    _vitalsEmergencyStatus.color = new Color(0.85f, 0.88f, 0.92f);
                    if (banner != null) banner.color = new Color(0.12f, 0.15f, 0.20f, 0.95f);
                }
            }

            // A new confirmation from this headset: shown on the banner for 6 s
            if (am != null && !string.IsNullOrEmpty(am.LastOwnAcknowledgement) && am.LastOwnAcknowledgement != _lastOwnAckShown)
            {
                _lastOwnAckShown = am.LastOwnAcknowledgement;
                _ownAckNoticeUntil = Time.time + 6f;
            }
        }

        private void FillAlertOverlay(ShiroAlertManager.HeadsetAlert alert, int total)
        {
            var inc = alert.incident;
            bool elsewhere = alert.status == ShiroAlertManager.AlertStatus.AcknowledgedElsewhere;

            _alertTitle.text = $"{(elsewhere ? "✔" : "🚨")} {(inc.IsSimulated ? "[TEST] " : "")}{inc.CategoryLabel}{(total > 1 ? $"   (1 of {total})" : "")}";
            string place = string.IsNullOrEmpty(inc.ward_id) ? "ward unknown" : inc.ward_id + (string.IsNullOrEmpty(inc.bed_id) ? "" : $" · {inc.bed_id}");
            _alertPatient.text = $"{inc.patient_name ?? "Unknown patient"} ({inc.patient_id ?? "no patient record"}) – {place}";

            var parts = new List<string>();
            if (inc.kinematic_impact_force > 0) parts.Add($"impact {inc.kinematic_impact_force:F2} g");
            if (inc.freefall_min_g > 0) parts.Add($"free-fall min {inc.freefall_min_g:F2} g");
            if (inc.post_impact_stillness > 0) parts.Add($"stillness {inc.post_impact_stillness:F2} g");
            if (inc.heart_rate > 0) parts.Add($"HR {inc.heart_rate} bpm");
            if (inc.spo2 > 0) parts.Add($"SpO2 ~{Mathf.RoundToInt(inc.spo2)} %");
            string measured = parts.Count > 0 ? string.Join(" · ", parts) : "no measurements reported";
            bool here = ShiroAlertManager.Instance != null && ShiroAlertManager.Instance.FindHologram(inc) != null;
            _alertDetails.text = $"{measured}\n{(here ? "The patient's panel is flashing red in the room." : "This patient has no panel in this ward view.")}\n{inc.alert_message}";

            _alertAckBtn.gameObject.SetActive(!elsewhere);
            _alertOkBtn.gameObject.SetActive(elsewhere);
            if (_alertMuteBtnText != null) _alertMuteBtnText.text = ShiroAlertManager.Instance != null && ShiroAlertManager.Instance.IsMuted ? "🔕 Muted" : "🔔 Mute";

            if (elsewhere)
            {
                _alertPanelImage.color = new Color(0.03f, 0.28f, 0.18f, 0.97f);
                _alertState.text = alert.acknowledgedBy != null
                    ? $"Acknowledged by {alert.acknowledgedBy}{(alert.acknowledgedAt != null ? $" at {alert.acknowledgedAt}" : "")}. No action needed from this headset."
                    : "Handled while this headset was not connected (the responder is in the dashboard's incident history).";
                _alertState.color = new Color(0.7f, 1f, 0.8f);
            }
            else if (alert.status == ShiroAlertManager.AlertStatus.Sending)
            {
                _alertState.text = "⏳ Sending the acknowledgement to the edge server…";
                _alertState.color = new Color(1f, 0.9f, 0.5f);
                _alertAckBtnText.text = "⏳ Sending…";
            }
            else
            {
                _alertAckBtnText.text = "✓ ACKNOWLEDGE & RESPOND";
                _alertState.text = alert.note ?? "Waiting for a clinician to respond.";
                _alertState.color = alert.note != null ? new Color(1f, 0.6f, 0.4f) : new Color(1f, 0.85f, 0.4f);
            }
        }

        /// <summary>Called every frame: the pending overlay blinks; a short notice after acknowledging here.</summary>
        private void RefreshAutoWardLabel()
        {
            var det = ShiroWardAutoDetect.Instance;
            string text = det == null ? "🧭 Auto ward: not available"
                : det.IsEnabled ? $"🧭 Auto ward ON · {det.StatusText}" : "🧭 Auto ward OFF";
            if (_autoWardBtnText != null && _autoWardBtnText.text != text) _autoWardBtnText.text = text;
            var probe = ShiroDepthProbe.Instance;
            if (_depthBtnText != null) _depthBtnText.text = probe != null && probe.IsRunning ? "🔬 Depth test: ON" : "🔬 Depth test: OFF";
            if (_moveReqBtnText != null) _moveReqBtnText.text = probe == null || probe.MovementRequired ? "🚶 Movement required: ON" : "🚶 Movement required: OFF (test)";
        }

        private void UpdateAlertBlink()
        {
            if (!_alignSubscribed) TrySubscribeAlignment();
            if (!_alertSubscribed) { TrySubscribeAlerts(); return; }
            var am = ShiroAlertManager.Instance;
            if (_alertPanel != null && _alertPanel.activeSelf && am != null && am.Current != null &&
                am.Current.status != ShiroAlertManager.AlertStatus.AcknowledgedElsewhere)
            {
                _alertBlinkTimer += Time.deltaTime;
                bool on = Mathf.Repeat(_alertBlinkTimer, 0.8f) < 0.4f;
                _alertPanelImage.color = on ? new Color(0.55f, 0.04f, 0.07f, 0.97f) : new Color(0.30f, 0.03f, 0.05f, 0.97f);
            }

            // "Acknowledged by this headset" on the Patient tab banner for a few seconds
            if (_ownAckNoticeUntil > 0f && am != null && _vitalsEmergencyStatus != null && am.PendingCount == 0)
            {
                if (Time.time < _ownAckNoticeUntil)
                {
                    _vitalsEmergencyStatus.text = am.LastOwnAcknowledgement;
                    _vitalsEmergencyStatus.color = new Color(0.2f, 0.95f, 0.5f);
                }
                else
                {
                    _ownAckNoticeUntil = 0f;
                    RefreshAlertUi();
                }
            }
        }

        /// <summary>
        /// Builds the floating Mini Wrist Badge shown when the slate is collapsed.
        /// Tapping it with the right fingertip re-opens the full slate immediately!
        /// </summary>
        private void BuildMiniWristBadge()
        {
            _wristBadgeObj = new GameObject("ShiroMiniWristBadge");
            _wristBadgeObj.transform.SetParent(this.transform);

            Canvas badgeCanvas = _wristBadgeObj.AddComponent<Canvas>();
            badgeCanvas.renderMode = RenderMode.WorldSpace;
            var rt = badgeCanvas.GetComponent<RectTransform>();
            rt.sizeDelta = new Vector2(400f, 110f);
            _wristBadgeObj.transform.localScale = Vector3.one * 0.0003f; // ~12cm wide badge

            _wristBadgeObj.AddComponent<CanvasScaler>();
            _wristBadgeObj.AddComponent<GraphicRaycaster>();

            _wristBadgeBtn = CreateButton(_wristBadgeObj.transform, "OpenBadgeBtn", "📱 TAP TO OPEN MENU", new Vector2(400f, 110f), new Color(0.06f, 0.45f, 0.65f, 0.95f), ToggleSlateVisibility);
            _wristBadgeBtn.transform.localPosition = Vector3.zero;

            _wristBadgeObj.SetActive(false);
        }

        private void BuildTouchBead()
        {
            _touchBead = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            _touchBead.name = "VR_FingertipTouchBead";
            _touchBead.transform.SetParent(this.transform);
            _touchBead.transform.localScale = Vector3.one * 0.018f; // 1.8cm diameter touch sphere
            Destroy(_touchBead.GetComponent<Collider>());

            Shader unlit = Shader.Find("Sprites/Default") ?? Shader.Find("Universal Render Pipeline/Unlit") ?? Shader.Find("Unlit/Color");
            _touchBeadRenderer = _touchBead.GetComponent<Renderer>();
            if (_touchBeadRenderer != null)
            {
                Material m = new Material(unlit);
                m.color = new Color(0.1f, 0.95f, 0.85f, 0.85f); // Glowing Cyan
                _touchBeadRenderer.material = m;
            }
            _touchBead.SetActive(false);
        }

        #endregion

        #region UI Helpers

        private GameObject CreatePanel(Transform parent, string name, Vector2 size, Color color)
        {
            GameObject obj = new GameObject(name);
            obj.transform.SetParent(parent, false);

            var img = obj.AddComponent<Image>();
            img.color = color;

            var rt = obj.GetComponent<RectTransform>();
            rt.sizeDelta = size;
            return obj;
        }

        private Text CreateText(Transform parent, string name, string content, int fontSize, FontStyle fontStyle, TextAnchor alignment, Color color)
        {
            GameObject obj = new GameObject(name);
            obj.transform.SetParent(parent, false);

            var txt = obj.AddComponent<Text>();
            txt.text = content;
            txt.fontSize = fontSize;
            txt.fontStyle = fontStyle;
            txt.alignment = alignment;
            txt.color = color;
            txt.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf") ?? Resources.GetBuiltinResource<Font>("Arial.ttf");

            var rt = obj.GetComponent<RectTransform>();
            rt.sizeDelta = new Vector2(400f, 60f);
            return txt;
        }

        private Button CreateButton(Transform parent, string name, string label, Vector2 size, Color color, Action onClick)
        {
            GameObject obj = new GameObject(name);
            obj.transform.SetParent(parent, false);

            var img = obj.AddComponent<Image>();
            img.color = color;

            var btn = obj.AddComponent<Button>();
            var colors = btn.colors;
            colors.highlightedColor = color * 1.25f;
            colors.pressedColor = new Color(0.1f, 0.95f, 0.4f);
            btn.colors = colors;

            var col = obj.AddComponent<BoxCollider>();
            col.size = new Vector3(size.x, size.y, 4f);

            var rt = obj.GetComponent<RectTransform>();
            rt.sizeDelta = size;

            Text txt = CreateText(obj.transform, "Label", label, 24, FontStyle.Bold, TextAnchor.MiddleCenter, Color.white);
            txt.rectTransform.sizeDelta = size;

            if (onClick != null)
            {
                btn.onClick.AddListener(() => onClick.Invoke());
            }

            _registeredButtons.Add(btn);
            return btn;
        }

        private void GenerateClickAudio()
        {
            _audioSource = gameObject.AddComponent<AudioSource>();
            _audioSource.playOnAwake = false;
            _audioSource.spatialBlend = 0f;

            int sampleRate = 44100;
            float duration = 0.035f;
            int numSamples = Mathf.RoundToInt(sampleRate * duration);
            float[] samples = new float[numSamples];

            for (int i = 0; i < numSamples; i++)
            {
                float t = (float)i / sampleRate;
                float envelope = Mathf.Exp(-t * 120f);
                samples[i] = Mathf.Sin(2f * Mathf.PI * 1400f * t) * envelope * 0.45f;
            }

            _clickToneClip = AudioClip.Create("TouchClick", numSamples, 1, sampleRate, false);
            _clickToneClip.SetData(samples, 0);
        }

        private void PlayClickTone()
        {
            if (_audioSource != null && _clickToneClip != null)
            {
                _audioSource.PlayOneShot(_clickToneClip, 0.40f);
            }
        }

        #endregion
    }
}
