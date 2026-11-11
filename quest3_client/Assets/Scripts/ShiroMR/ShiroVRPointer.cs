// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Universal VR Pointer: Touch Controller & Pure Hand Tracking UI Interactor
// =============================================================================
using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;
using Meta.XR;
using Meta.XR.MRUtilityKit;

namespace ShiroMR
{
    public class ShiroVRPointer : MonoBehaviour
    {
        public static ShiroVRPointer Instance { get; private set; }

        private static EnvironmentRaycastManager _envRaycastManager;

        /// <summary>
        /// Retrieves the real-world physical floor height in Unity world space using Meta Quest's:
        /// 1. MRUK Scanned Room Floor Anchor (if Space Setup / Scene Model is present)
        /// 2. OVRManager FloorLevel Origin
        /// 3. Standard OpenXR & Meta XR Floor Level Tracking (FloorLevel tracking space sets floor at Y = 0.0m)
        /// </summary>
        public static float GetPhysicalFloorHeight()
        {
            // Tier 1: MRUK Scanned Room Floor Anchor
            try
            {
                if (MRUK.Instance != null)
                {
                    var room = MRUK.Instance.GetCurrentRoom();
                    if (room != null && room.FloorAnchor != null)
                    {
                        return room.FloorAnchor.transform.position.y;
                    }
                }
            }
            catch { }

            // Tier 2: OVRManager FloorLevel Origin
            try
            {
                if (OVRManager.instance != null)
                {
                    if (OVRManager.instance.trackingOriginType == OVRManager.TrackingOrigin.FloorLevel)
                    {
                        return 0f;
                    }
                    else if (Camera.main != null && Camera.main.transform.position.y < 0.60f)
                    {
                        return Camera.main.transform.position.y - 1.65f;
                    }
                }
            }
            catch { }

            // Tier 3: Standard OpenXR & Meta XR Floor Level Tracking
            // In Unity VR/MR on Meta Quest 3, FloorLevel tracking space sets the physical floor at Y = 0.0m.
            if (Camera.main != null)
            {
                // If camera is at standing/sitting height (> 0.60m), origin is ALREADY at Floor Level (0.0m)
                if (Camera.main.transform.position.y > 0.60f)
                {
                    return 0f;
                }
                else
                {
                    // Only if camera is near 0 (EyeLevel tracking mode where headset is at tracking origin)
                    return Camera.main.transform.position.y - 1.65f;
                }
            }

            return 0f;
        }

        private static void EnsureEnvironmentRaycaster()
        {
            if (_envRaycastManager == null)
            {
                _envRaycastManager = UnityEngine.Object.FindObjectOfType<EnvironmentRaycastManager>();
                if (_envRaycastManager == null)
                {
                    try
                    {
                        if (EnvironmentRaycastManager.IsSupported)
                        {
                            GameObject go = new GameObject("SHIRO_EnvironmentRaycaster");
                            _envRaycastManager = go.AddComponent<EnvironmentRaycastManager>();
                            UnityEngine.Object.DontDestroyOnLoad(go);
                            Debug.Log("[SHIRO POINTER] Instantiated EnvironmentRaycastManager for physical depth raycasting.");
                        }
                    }
                    catch (Exception ex)
                    {
                        Debug.LogWarning($"[SHIRO POINTER] Could not create EnvironmentRaycastManager: {ex.Message}");
                    }
                }
            }
        }

        [Header("Pointer Tracking References")]
        [Tooltip("Transform used as pointer origin for controllers. Auto-resolved if null.")]
        public Transform pointerSource;

        [Header("Laser Visual Tuning")]
        public float defaultLaserLength = 4.0f;
        public float manualLaserDistance = 2.0f;
        public Color laserNormalColor = new Color(0.06f, 0.71f, 0.83f, 0.65f); // Translucent Cyan
        public Color laserHoverColor = new Color(0.10f, 0.95f, 0.45f, 0.90f);  // Emerald Green on Button
        public Color laserClickColor = new Color(1.00f, 0.85f, 0.20f, 1.00f);  // Amber Yellow on Click

        [Header("Live State")]
        public bool isHittingUi = false;
        public Vector3 currentHitPoint;
        public Vector3 currentHitNormal;
        public Button currentHoveredButton;
        public bool isTriggerDown = false;
        public bool wasTriggerPressedThisFrame = false;
        public bool wasTriggerReleasedThisFrame = false;
        public Vector3 PointerOrigin { get; private set; }
        public Vector3 PointerForward { get; private set; }
        public Ray PointerRay => new Ray(PointerOrigin, PointerForward != Vector3.zero ? PointerForward : Vector3.forward);
        public bool isHandTrackingActive = false;
        public bool isReattaching = false;

        public void SetReattachTargeting(bool active)
        {
            isReattaching = active;
        }

        // Visual components
        private LineRenderer _lineRenderer;
        private GameObject _reticleCursor;
        private Renderer _reticleRenderer;
        private GameObject _distanceBadgeObj;
        private TextMesh _distanceBadgeText;

        // Internal State
        private bool _wasTriggerHeldLastFrame = false;
        private Button _lastPressedButton = null;
        private Color _originalButtonColor = Color.white;
        private Graphic _hoveredButtonGraphic = null;
        private Transform _trackingSpace = null;
        private Transform _rightControllerAnchor = null;
        private Transform _rightHandAnchor = null;

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
            EnsureTrackingReferences();
            CreateLaserVisuals();
        }

        private void Update()
        {
            EnsureTrackingReferences();
            UpdatePointerRay();
            HandleTriggerInput();
        }

        private void EnsureTrackingReferences()
        {
            if (_trackingSpace == null)
            {
                GameObject tsObj = GameObject.Find("TrackingSpace");
                if (tsObj != null) _trackingSpace = tsObj.transform;
            }

            if (_rightControllerAnchor == null)
            {
                GameObject rca = GameObject.Find("RightControllerAnchor");
                if (rca != null) _rightControllerAnchor = rca.transform;
            }

            if (_rightHandAnchor == null)
            {
                GameObject rha = GameObject.Find("RightHandAnchor");
                if (rha != null) _rightHandAnchor = rha.transform;
            }

            if (pointerSource == null || !pointerSource.gameObject.activeInHierarchy)
            {
                if (_rightControllerAnchor != null && _rightControllerAnchor.gameObject.activeInHierarchy)
                {
                    pointerSource = _rightControllerAnchor;
                }
                else if (_rightHandAnchor != null && _rightHandAnchor.gameObject.activeInHierarchy)
                {
                    pointerSource = _rightHandAnchor;
                }
                else if (Camera.main != null)
                {
                    pointerSource = Camera.main.transform;
                }
            }
        }

        private void CreateLaserVisuals()
        {
            // Shader fallback: Sprites/Default or Unlit
            Shader unlitShader = Shader.Find("Sprites/Default") ??
                                 Shader.Find("Universal Render Pipeline/Unlit") ??
                                 Shader.Find("Unlit/Color");

            // 1. Laser Beam (LineRenderer)
            GameObject lineObj = new GameObject("VR_LaserBeam");
            lineObj.transform.SetParent(this.transform);
            _lineRenderer = lineObj.AddComponent<LineRenderer>();
            _lineRenderer.positionCount = 2;
            _lineRenderer.startWidth = 0.006f; // 6mm beam
            _lineRenderer.endWidth = 0.002f;   // 2mm beam tip
            _lineRenderer.useWorldSpace = true;

            Material lineMat = new Material(unlitShader);
            _lineRenderer.material = lineMat;
            _lineRenderer.startColor = laserNormalColor;
            _lineRenderer.endColor = laserNormalColor;

            // 2. Reticle Cursor Dot
            _reticleCursor = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            _reticleCursor.name = "VR_ReticleCursor";
            _reticleCursor.transform.SetParent(this.transform);
            _reticleCursor.transform.localScale = new Vector3(0.022f, 0.022f, 0.022f); // 2.2cm
            Destroy(_reticleCursor.GetComponent<Collider>());

            _reticleRenderer = _reticleCursor.GetComponent<Renderer>();
            if (_reticleRenderer != null)
            {
                _reticleRenderer.material = new Material(unlitShader);
                _reticleRenderer.material.color = laserNormalColor;
            }

            // 3. Floating Laser Distance & Touch Indicator Badge
            _distanceBadgeObj = new GameObject("VR_DistanceBadge");
            _distanceBadgeObj.transform.SetParent(this.transform);
            _distanceBadgeText = _distanceBadgeObj.AddComponent<TextMesh>();
            _distanceBadgeText.fontSize = 32;
            _distanceBadgeText.characterSize = 0.005f;
            _distanceBadgeText.alignment = TextAlignment.Left;
            _distanceBadgeText.anchor = TextAnchor.MiddleLeft;
            _distanceBadgeText.color = new Color(0.85f, 0.95f, 1.0f, 0.95f);
            _distanceBadgeObj.SetActive(false);
        }

        private void UpdatePointerRay()
        {
            // Dynamic Distance Dial via Right Thumbstick or Mouse Scroll
            float stickY = 0f;
            try
            {
                Vector2 stick = OVRInput.Get(OVRInput.Axis2D.PrimaryThumbstick, OVRInput.Controller.RTouch);
                if (Mathf.Abs(stick.y) > 0.15f) stickY = stick.y;
            }
            catch { }

#if ENABLE_INPUT_SYSTEM
            if (UnityEngine.InputSystem.Mouse.current != null)
            {
                float scroll = UnityEngine.InputSystem.Mouse.current.scroll.ReadValue().y;
                if (Mathf.Abs(scroll) > 0.01f) stickY += Mathf.Sign(scroll) * 0.4f;
            }
#endif

            if (Mathf.Abs(stickY) > 0.05f)
            {
                manualLaserDistance = Mathf.Clamp(manualLaserDistance + stickY * Time.deltaTime * 2.2f, 0.10f, 8.0f);
            }

            // Pure Hand Tracking Distance Control via Left Hand Extension (Tape-Measure Gesture)
            bool isLeftHandAdjusting = false;
            try
            {
                OVRPlugin.HandState leftState = default;
                if (OVRPlugin.GetHandState(OVRPlugin.Step.Render, OVRPlugin.Hand.HandLeft, ref leftState))
                {
                    if ((leftState.Status & OVRPlugin.HandStatus.HandTracked) != 0)
                    {
                        OVRPose leftPose = leftState.PointerPose.ToOVRPose();
                        Vector3 leftHandWorld = (_trackingSpace != null) ? _trackingSpace.TransformPoint(leftPose.position) : leftPose.position;

                        if (Camera.main != null)
                        {
                            Vector3 camToHand = leftHandWorld - Camera.main.transform.position;
                            float forwardReach = Vector3.Dot(camToHand, Camera.main.transform.forward);

                            // Left hand forward reach (0.22m near chest to 0.58m extended) maps to 0.8m to 5.0m
                            if (forwardReach > 0.18f && forwardReach < 0.80f)
                            {
                                float targetDist = Mathf.Lerp(0.80f, 5.0f, Mathf.InverseLerp(0.22f, 0.58f, forwardReach));
                                manualLaserDistance = Mathf.Lerp(manualLaserDistance, targetDist, Time.deltaTime * 5.0f);
                                isLeftHandAdjusting = true;
                            }
                        }
                    }
                }
            }
            catch { }

            Vector3 origin = Vector3.zero;
            Vector3 forward = Vector3.forward;
            bool foundAim = false;

            // 1. Meta Quest Pure Hand Tracking (Pinch Ray)
            try
            {
                OVRPlugin.HandState handState = default;
                if (OVRPlugin.GetHandState(OVRPlugin.Step.Render, OVRPlugin.Hand.HandRight, ref handState))
                {
                    if ((handState.Status & OVRPlugin.HandStatus.HandTracked) != 0)
                    {
                        isHandTrackingActive = true;
                        OVRPose pose = handState.PointerPose.ToOVRPose();
                        if (pose.position != Vector3.zero)
                        {
                            if (_trackingSpace != null)
                            {
                                origin = _trackingSpace.TransformPoint(pose.position);
                                forward = _trackingSpace.TransformDirection(pose.orientation * Vector3.forward);
                            }
                            else
                            {
                                origin = pose.position;
                                forward = pose.orientation * Vector3.forward;
                            }
                            foundAim = true;
                        }
                    }
                    else
                    {
                        isHandTrackingActive = false;
                    }
                }
            }
            catch { }

            // 2. Meta Quest Touch Controller Anchor (Right Hand Controller)
            if (!foundAim)
            {
                if (_rightControllerAnchor != null && _rightControllerAnchor.gameObject.activeInHierarchy)
                {
                    origin = _rightControllerAnchor.position;
                    forward = _rightControllerAnchor.forward;
                    foundAim = true;
                }
                else if (pointerSource != null && pointerSource.gameObject.activeInHierarchy)
                {
                    origin = pointerSource.position;
                    forward = pointerSource.forward;
                    foundAim = true;
                }
            }

            // 3. Fallback for Unity Editor testing without VR Headset (Mouse / Screen Center)
            if (!foundAim && Camera.main != null)
            {
#if UNITY_EDITOR && ENABLE_INPUT_SYSTEM
                if (UnityEngine.InputSystem.Mouse.current != null)
                {
                    Vector2 mPos = UnityEngine.InputSystem.Mouse.current.position.ReadValue();
                    Ray mRay = Camera.main.ScreenPointToRay(mPos);
                    origin = mRay.origin;
                    forward = mRay.direction;
                    foundAim = true;
                }
                else
                {
                    origin = Camera.main.transform.position;
                    forward = Camera.main.transform.forward;
                    foundAim = true;
                }
#else
                origin = Camera.main.transform.position;
                forward = Camera.main.transform.forward;
                foundAim = true;
#endif
            }

            if (!foundAim) return;

            PointerOrigin = origin;
            PointerForward = forward;

            // -------------------------------------------------------------
            // Hand Tracking & Proximity Laser Beam Suppression
            // -------------------------------------------------------------
            // User Clinical Rule:
            // 1. When Hand Slate menu is CLOSED: Laser pointer is ACTIVE from right hand/controller
            //    so the doctor can aim across the room to click buttons on the bed panel or floating patient HUD!
            // 2. When Hand Slate menu is OPEN: Switch to fingertip touch mode (laser suppressed when near slate)!
            // 3. During room landmark calibration or manual patient re-attach: Laser is ALWAYS active.
            bool isRoomCalibrating = (WardAlignmentTool.Instance != null &&
                                      WardAlignmentTool.Instance.currentStep != AlignmentStep.Idle &&
                                      WardAlignmentTool.Instance.currentStep != AlignmentStep.Completed);

            bool isHandMenuOpen = (ShiroHandSlate.Instance != null && ShiroHandSlate.Instance.isSlateVisible && ShiroHandSlate.Instance.gameObject.activeInHierarchy);

            bool shouldLaserBeActive = !isHandMenuOpen || isRoomCalibrating || isReattaching;

            if (isHandTrackingActive && !shouldLaserBeActive)
            {
                if (_lineRenderer != null) _lineRenderer.enabled = false;
                if (_reticleCursor != null) _reticleCursor.SetActive(false);
                if (_distanceBadgeObj != null) _distanceBadgeObj.SetActive(false);
                isHittingUi = false;
                currentHoveredButton = null;
                return;
            }

            // Suppress laser pointer when close to the Hand Slate for direct fingertip touch (ONLY when slate is open and not calibrating/re-attaching!)
            if (isHandMenuOpen && !isRoomCalibrating && !isReattaching && ShiroHandSlate.Instance != null)
            {
                Vector3 slatePos = ShiroHandSlate.Instance.SlateWorldPosition;
                float distToSlate = Vector3.Distance(origin, slatePos);
                if (distToSlate < 0.45f)
                {
                    if (_lineRenderer != null) _lineRenderer.enabled = false;
                    if (_reticleCursor != null) _reticleCursor.SetActive(false);
                    if (_distanceBadgeObj != null) _distanceBadgeObj.SetActive(false);
                    isHittingUi = false;
                    currentHoveredButton = null;
                    return;
                }
            }

            Ray ray = new Ray(origin, forward);
            float hitDistance = defaultLaserLength;
            isHittingUi = false;
            Button hitButton = null;

            // Strategy A: 3D Physics Raycast against UI buttons with BoxCollider
            if (Physics.Raycast(ray, out RaycastHit physHit, defaultLaserLength))
            {
                Button btn = physHit.collider.GetComponentInParent<Button>();
                if (btn != null && btn.gameObject.activeInHierarchy && btn.interactable)
                {
                    hitButton = btn;
                    isHittingUi = true;
                    hitDistance = physHit.distance;
                    currentHitPoint = physHit.point;
                    currentHitNormal = physHit.normal;
                }
            }

            // Strategy B: Geometric Plane Raycast against RectTransforms (Zero-collider fallback)
            if (!isHittingUi)
            {
                Button[] allButtons = FindObjectsOfType<Button>();
                float closestBtnDist = defaultLaserLength;

                foreach (var btn in allButtons)
                {
                    if (!btn.gameObject.activeInHierarchy || !btn.interactable) continue;

                    RectTransform rt = btn.GetComponent<RectTransform>();
                    if (rt == null) continue;

                    // Test both front and back plane normal to avoid back-face culling
                    Plane plane = new Plane(rt.forward, rt.position);
                    if (!plane.Raycast(ray, out float enter))
                    {
                        Plane backPlane = new Plane(-rt.forward, rt.position);
                        backPlane.Raycast(ray, out enter);
                    }

                    if (enter > 0 && enter < closestBtnDist)
                    {
                        Vector3 worldPt = ray.GetPoint(enter);
                        Vector3 localPt = rt.InverseTransformPoint(worldPt);

                        // Allow 6px margin for comfortable targeting
                        Rect bounds = rt.rect;
                        bounds.xMin -= 6f; bounds.xMax += 6f;
                        bounds.yMin -= 6f; bounds.yMax += 6f;

                        if (bounds.Contains(localPt))
                        {
                            closestBtnDist = enter;
                            hitDistance = enter;
                            currentHitPoint = worldPt;
                            currentHitNormal = -ray.direction;
                            hitButton = btn;
                            isHittingUi = true;
                        }
                    }
                }
            }

            // Strategy C: Physical Environment & Floor Sensing
            if (!isHittingUi)
            {
                bool isCalibrating = (WardAlignmentTool.Instance != null &&
                                     WardAlignmentTool.Instance.currentStep != AlignmentStep.Idle &&
                                     WardAlignmentTool.Instance.currentStep != AlignmentStep.Completed);

                bool hitValidEnv = false;
                float physFloorY = GetPhysicalFloorHeight();

                // 1. Meta Quest 3 Hardware Depth API (EnvironmentRaycastManager)
                // Directly hits real-world physical surfaces (carpet, tiles, door frame, physical walls, physical beds)
                EnsureEnvironmentRaycaster();
                if (_envRaycastManager != null && EnvironmentRaycastManager.IsSupported)
                {
                    try
                    {
                        if (_envRaycastManager.Raycast(ray, out EnvironmentRaycastHit envDepthHit, 15f))
                        {
                            if (envDepthHit.status == EnvironmentRaycastHitStatus.Hit)
                            {
                                hitValidEnv = true;
                                hitDistance = Vector3.Distance(origin, envDepthHit.point);
                                currentHitPoint = envDepthHit.point;
                                currentHitNormal = envDepthHit.normal;
                            }
                        }
                    }
                    catch { }
                }

                // 2. Meta MR Utility Kit (MRUK) Room Mesh Raycast (Scanned room surfaces)
                if (!hitValidEnv)
                {
                    try
                    {
                        if (MRUK.Instance != null)
                        {
                            var room = MRUK.Instance.GetCurrentRoom();
                            if (room != null && room.Raycast(ray, 15f, out RaycastHit roomHit, out MRUKAnchor anchor))
                            {
                                hitValidEnv = true;
                                hitDistance = roomHit.distance;
                                currentHitPoint = roomHit.point;
                                currentHitNormal = roomHit.normal;
                            }
                        }
                    }
                    catch { }
                }

                // 3. Unity Physics Raycast against physical colliders (excluding virtual ward objects during calibration)
                if (!hitValidEnv)
                {
                    RaycastHit envHit;
                    if (!isCalibrating && Physics.Raycast(ray, out envHit, defaultLaserLength, ~LayerMask.GetMask("Ignore Raycast")))
                    {
                        bool isVirtualWard = false;
                        if (WardSpatialManager.Instance != null && WardSpatialManager.Instance.wardOrigin != null)
                        {
                            if (envHit.transform.IsChildOf(WardSpatialManager.Instance.wardOrigin))
                                isVirtualWard = true;
                        }
                        if (WardVisualizer.Instance != null && envHit.transform.IsChildOf(WardVisualizer.Instance.transform))
                        {
                            isVirtualWard = true;
                        }

                        if (!isVirtualWard || envHit.point.y >= (physFloorY - 0.05f))
                        {
                            hitValidEnv = true;
                            hitDistance = envHit.distance;
                            currentHitPoint = envHit.point;
                            currentHitNormal = envHit.normal;
                        }
                    }
                }

                // 4. Physical Floor Plane Projection (when looking downward towards the floor)
                if (!hitValidEnv)
                {
                    hitDistance = manualLaserDistance;

                    if (manualLaserDistance <= 0.25f)
                    {
                        // Direct Touch Mode: Point right at controller/finger tip
                        currentHitPoint = origin + forward * 0.05f;
                        currentHitNormal = -forward;
                    }
                    else if (forward.y < -0.02f && origin.y > (physFloorY + 0.02f))
                    {
                        // Exact Physical Floor Plane Projection (using Meta Quest's calibrated physical floor height)
                        float tFloor = (physFloorY - origin.y) / forward.y;
                        if (tFloor > 0.05f && tFloor < 20.0f)
                        {
                            hitDistance = tFloor;
                            currentHitPoint = new Vector3(origin.x + forward.x * tFloor, physFloorY, origin.z + forward.z * tFloor);
                            currentHitNormal = Vector3.up;
                            hitValidEnv = true;
                        }
                        else
                        {
                            currentHitPoint = origin + forward * hitDistance;
                            currentHitNormal = -forward;
                        }
                    }
                    else
                    {
                        currentHitPoint = origin + forward * hitDistance;
                        currentHitNormal = -forward;
                    }
                }

                // Strict physical floor height protection: reticle can never sink below the calibrated physical floor
                if (currentHitPoint.y < physFloorY)
                {
                    currentHitPoint.y = physFloorY;
                }
            }

            // Update UI Button Hover State
            UpdateHoverButton(hitButton);

            // Update Visual Laser & Reticle
            if (_lineRenderer != null)
            {
                _lineRenderer.enabled = true; // Ensure laser beam is visible during active raycasting!
                _lineRenderer.SetPosition(0, origin);
                _lineRenderer.SetPosition(1, currentHitPoint);

                Color targetCol = isReattaching 
                    ? new Color(1.0f, 0.75f, 0.1f, 0.95f) 
                    : (isTriggerDown ? laserClickColor : (isHittingUi ? laserHoverColor : laserNormalColor));
                _lineRenderer.startColor = targetCol;
                _lineRenderer.endColor = new Color(targetCol.r, targetCol.g, targetCol.b, 0.20f);
            }

            if (_reticleCursor != null)
            {
                _reticleCursor.SetActive(true); // Ensure reticle cursor is visible on target surface!
                _reticleCursor.transform.position = currentHitPoint - forward * 0.005f;
                _reticleCursor.transform.rotation = Quaternion.LookRotation(-forward);

                float scale = isHittingUi ? 0.030f : (isReattaching ? 0.026f : 0.018f);
                _reticleCursor.transform.localScale = Vector3.one * scale;

                if (_reticleRenderer != null)
                {
                    Color targetCol = isReattaching 
                        ? new Color(1.0f, 0.75f, 0.1f, 0.95f) 
                        : (isTriggerDown ? laserClickColor : (isHittingUi ? laserHoverColor : laserNormalColor));
                    _reticleRenderer.material.color = targetCol;
                }
            }

            // Update Floating Distance Badge
            if (_distanceBadgeObj != null && _distanceBadgeText != null)
            {
                if (isHittingUi && !isReattaching)
                {
                    _distanceBadgeObj.SetActive(false);
                }
                else
                {
                    _distanceBadgeObj.SetActive(true);
                    _distanceBadgeObj.transform.position = currentHitPoint + Vector3.up * 0.04f + Vector3.right * 0.02f;
                    if (Camera.main != null)
                    {
                        _distanceBadgeObj.transform.rotation = Quaternion.LookRotation(_distanceBadgeObj.transform.position - Camera.main.transform.position);
                    }

                    if (isReattaching)
                    {
                        _distanceBadgeText.text = $"🎯 LOCK PATIENT ({hitDistance:F2}m - PINCH/CLICK)";
                        _distanceBadgeText.color = new Color(1.0f, 0.85f, 0.2f);
                    }
                    else if (currentHitNormal == Vector3.up || Mathf.Abs(currentHitPoint.y - GetPhysicalFloorHeight()) < 0.05f)
                    {
                        _distanceBadgeText.text = $"🎯 Floor: {hitDistance:F2}m";
                        _distanceBadgeText.color = new Color(0.2f, 0.95f, 0.6f);
                    }
                    else if (isLeftHandAdjusting)
                    {
                        _distanceBadgeText.text = $"✋ {hitDistance:F2}m (Left Hand ↔)";
                        _distanceBadgeText.color = new Color(0.3f, 0.85f, 1.0f);
                    }
                    else if (hitDistance <= 0.25f)
                    {
                        _distanceBadgeText.text = "👉 TOUCH (0cm)";
                        _distanceBadgeText.color = new Color(0.1f, 0.95f, 0.4f);
                    }
                    else
                    {
                        _distanceBadgeText.text = $"{hitDistance:F2}m (Thumbstick / Hand ↕)";
                        _distanceBadgeText.color = new Color(0.95f, 0.85f, 0.35f);
                    }
                }
            }
        }

        private void UpdateHoverButton(Button newBtn)
        {
            if (currentHoveredButton == newBtn) return;

            // Revert previous hover
            if (currentHoveredButton != null && _hoveredButtonGraphic != null)
            {
                _hoveredButtonGraphic.color = _originalButtonColor;
            }

            currentHoveredButton = newBtn;
            _hoveredButtonGraphic = null;

            // Apply hover visual to new button
            if (currentHoveredButton != null)
            {
                _hoveredButtonGraphic = currentHoveredButton.targetGraphic ?? currentHoveredButton.GetComponent<Graphic>();
                if (_hoveredButtonGraphic != null)
                {
                    _originalButtonColor = _hoveredButtonGraphic.color;
                    _hoveredButtonGraphic.color = new Color(0.06f, 0.71f, 0.83f, 0.90f); // Bright Cyan
                }
            }
        }

        private void HandleTriggerInput()
        {
            // 1. Meta Quest Pure Hand Tracking Pinch Check
            bool isPinch = false;
            try
            {
                OVRPlugin.HandState handState = default;
                if (OVRPlugin.GetHandState(OVRPlugin.Step.Render, OVRPlugin.Hand.HandRight, ref handState))
                {
                    if ((handState.Status & OVRPlugin.HandStatus.HandTracked) != 0)
                    {
                        isPinch = (handState.Pinches & OVRPlugin.HandFingerPinch.Index) != 0;
                        if (!isPinch && handState.PinchStrength != null && handState.PinchStrength.Length > 1)
                        {
                            isPinch = handState.PinchStrength[1] > 0.45f; // Responsive pinch threshold
                        }
                    }
                }
            }
            catch { }

            // 2. Meta Quest Touch Controller Trigger & A Button
            bool isControllerTrigger = false;
            try
            {
                if (OVRInput.Get(OVRInput.Button.PrimaryIndexTrigger, OVRInput.Controller.RTouch) ||
                    OVRInput.Get(OVRInput.Button.One, OVRInput.Controller.RTouch) ||
                    OVRInput.Get(OVRInput.Axis1D.PrimaryIndexTrigger, OVRInput.Controller.RTouch) > 0.35f ||
                    OVRInput.Get(OVRInput.Button.PrimaryIndexTrigger, OVRInput.Controller.RHand))
                {
                    isControllerTrigger = true;
                }
            }
            catch { }

            // 3. Unity Editor Mouse & Keyboard
            bool isEditorClick = false;
#if ENABLE_INPUT_SYSTEM
            if (UnityEngine.InputSystem.Mouse.current != null && UnityEngine.InputSystem.Mouse.current.leftButton.isPressed) isEditorClick = true;
            if (UnityEngine.InputSystem.Keyboard.current != null && (UnityEngine.InputSystem.Keyboard.current.spaceKey.isPressed || UnityEngine.InputSystem.Keyboard.current.enterKey.isPressed)) isEditorClick = true;
#elif ENABLE_LEGACY_INPUT_MANAGER
            if (Input.GetMouseButton(0) || Input.GetKey(KeyCode.Space)) isEditorClick = true;
#endif

            bool currentPressed = isPinch || isControllerTrigger || isEditorClick;
            wasTriggerPressedThisFrame = currentPressed && !_wasTriggerHeldLastFrame;
            bool triggerReleasedThisFrame = !currentPressed && _wasTriggerHeldLastFrame;
            wasTriggerReleasedThisFrame = triggerReleasedThisFrame;
            _wasTriggerHeldLastFrame = currentPressed;
            isTriggerDown = currentPressed;

            // Check if Re-Attach Target Mode is active and user pinches or pulls trigger
            if (wasTriggerPressedThisFrame && isReattaching)
            {
                if (ShiroMRManager.Instance != null)
                {
                    foreach (var kvp in ShiroMRManager.Instance.ActiveHolograms)
                    {
                        if (kvp.Value != null && kvp.Value.trackingState == PatientTrackingState.ManualAim)
                        {
                            kvp.Value.LockManualPosition(currentHitPoint);
                            break;
                        }
                    }
                }
                isReattaching = false;
                try
                {
                    OVRInput.SetControllerVibration(0.6f, 0.3f, OVRInput.Controller.RTouch);
                    Invoke(nameof(StopHaptics), 0.15f);
                }
                catch { }
                return;
            }

            // Trigger Down on Button
            if (wasTriggerPressedThisFrame)
            {
                if (currentHoveredButton != null)
                {
                    _lastPressedButton = currentHoveredButton;
                    if (_hoveredButtonGraphic != null)
                    {
                        _hoveredButtonGraphic.color = new Color(0.95f, 0.8f, 0.1f, 1.0f); // Amber Yellow press
                    }
                }
            }

            // Trigger Up: Click Button
            if (triggerReleasedThisFrame)
            {
                if (_lastPressedButton != null)
                {
                    if (_lastPressedButton == currentHoveredButton)
                    {
                        // Fire Button OnClick!
                        _lastPressedButton.onClick.Invoke();
                        Debug.Log($"[SHIRO POINTER] Clicked UI Button: {_lastPressedButton.gameObject.name}");

                        // Haptic Buzz on Controller
                        try
                        {
                            OVRInput.SetControllerVibration(0.6f, 0.4f, OVRInput.Controller.RTouch);
                            Invoke(nameof(StopHaptics), 0.12f);
                        }
                        catch { }
                    }

                    // Restore visual color
                    if (_hoveredButtonGraphic != null)
                    {
                        _hoveredButtonGraphic.color = isHittingUi ? new Color(0.06f, 0.71f, 0.83f, 0.90f) : _originalButtonColor;
                    }
                    _lastPressedButton = null;
                }
            }
        }

        private void StopHaptics()
        {
            try
            {
                OVRInput.SetControllerVibration(0, 0, OVRInput.Controller.RTouch);
            }
            catch { }
        }
    }
}
