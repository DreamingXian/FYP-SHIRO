// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Sleek Holographic Hand Outline Visualizer & Direct-Touch Fingertip Cursor
// =============================================================================
using System;
using UnityEngine;

namespace ShiroMR
{
    /// <summary>
    /// Displays a sleek, luminous hand boundary outline (Meta Quest gesture style)
    /// without internal skeleton clutter. Only displays the pointer hand when the menu
    /// is docked to the wrist, and displays both hands when the menu is pinned in the room.
    /// </summary>
    public class ShiroHandVisualizer : MonoBehaviour
    {
        public static ShiroHandVisualizer Instance { get; private set; }

        [Header("Visualization Configuration")]
        [Tooltip("Whether to render the luminous hand edge outline.")]
        public bool showHandOutline = true;

        [Tooltip("Whether to render the direct touch reticle cursor on active index fingertips.")]
        public bool showTouchReticle = true;

        [Tooltip("Width (meters) of the hand boundary contour line.")]
        public float outlineLineWidth = 0.0024f; // 2.4mm sleek contour

        [Header("Color Themes")]
        public Color rightOutlineColor = new Color(0.0f, 0.90f, 1.0f, 0.85f);      // Electric Cyan
        public Color leftOutlineColor = new Color(0.20f, 0.75f, 1.0f, 0.65f);       // Soft Cyan-Blue
        public Color reticleIdleColor = new Color(0.0f, 0.90f, 1.0f, 0.75f);       // Idle Cyan
        public Color reticleHoverColor = new Color(0.06f, 0.95f, 0.50f, 0.95f);    // Hover Emerald Green
        public Color reticlePressColor = new Color(1.0f, 0.75f, 0.05f, 1.0f);      // Click Golden Amber

        [Header("Public Hand Tracking State")]
        public bool IsLeftHandTracked { get; private set; } = false;
        public bool IsRightHandTracked { get; private set; } = false;
        public Vector3 RightIndexTipPosition { get; private set; } = Vector3.zero;
        public Vector3 LeftIndexTipPosition { get; private set; } = Vector3.zero;
        public Vector3 LeftWristPosition { get; private set; } = Vector3.zero;
        public Quaternion LeftWristRotation { get; private set; } = Quaternion.identity;

        // Feedback passed from ShiroHandSlate for Right & Left Index fingers
        [HideInInspector] public float RightIndexHoverDistance = 999f;
        [HideInInspector] public bool IsRightIndexTouching = false;
        [HideInInspector] public float LeftIndexHoverDistance = 999f;
        [HideInInspector] public bool IsLeftIndexTouching = false;

        private const int TotalBones = 26;
        private const int OutlinePointCount = 27;

        // Pre-allocated OVRPlugin Hand States to eliminate heap allocations
        private OVRPlugin.HandState _leftHandState = new OVRPlugin.HandState
        {
            BonePositions = new OVRPlugin.Vector3f[(int)OVRPlugin.SkeletonConstants.MaxXRHandBones],
            BoneRotations = new OVRPlugin.Quatf[(int)OVRPlugin.SkeletonConstants.MaxXRHandBones],
            PinchStrength = new float[(int)OVRPlugin.HandFinger.Max],
            FingerConfidences = new OVRPlugin.TrackingConfidence[(int)OVRPlugin.HandFinger.Max]
        };

        private OVRPlugin.HandState _rightHandState = new OVRPlugin.HandState
        {
            BonePositions = new OVRPlugin.Vector3f[(int)OVRPlugin.SkeletonConstants.MaxXRHandBones],
            BoneRotations = new OVRPlugin.Quatf[(int)OVRPlugin.SkeletonConstants.MaxXRHandBones],
            PinchStrength = new float[(int)OVRPlugin.HandFinger.Max],
            FingerConfidences = new OVRPlugin.TrackingConfidence[(int)OVRPlugin.HandFinger.Max]
        };

        // World-space cache for joints
        private readonly Vector3[] _leftJointWorld = new Vector3[TotalBones];
        private readonly Vector3[] _rightJointWorld = new Vector3[TotalBones];

        // Outline contour point arrays
        private readonly Vector3[] _leftOutlinePoints = new Vector3[OutlinePointCount];
        private readonly Vector3[] _rightOutlinePoints = new Vector3[OutlinePointCount];

        // Visual GameObjects & Renderers
        private Transform _trackingSpace;
        private Camera _mainCam;

        private GameObject _leftRootObj;
        private LineRenderer _leftOutlineLine;

        private GameObject _rightRootObj;
        private LineRenderer _rightOutlineLine;

        // Interactive Touch Reticle Cursors (Right & Left)
        private GameObject _rightReticleRoot;
        private LineRenderer _rightReticleRingLine;
        private GameObject _rightReticleCenterBead;
        private Material _rightReticleRingMat;
        private Material _rightReticleBeadMat;

        private GameObject _leftReticleRoot;
        private LineRenderer _leftReticleRingLine;
        private GameObject _leftReticleCenterBead;
        private Material _leftReticleRingMat;
        private Material _leftReticleBeadMat;

        // Materials with RenderQueue 3200 (Rendered AFTER UI Canvas so hand is on top!)
        private Material _rightOutlineMat;
        private Material _leftOutlineMat;

        private void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Destroy(gameObject);
                return;
            }
            Instance = this;

            LocateTrackingSpace();
            BuildMaterials();
            BuildHandOutlineHierarchy();
            BuildTouchReticleCursors();
        }

        private void LocateTrackingSpace()
        {
            _mainCam = Camera.main;

            GameObject tsObj = GameObject.Find("TrackingSpace");
            if (tsObj != null)
            {
                _trackingSpace = tsObj.transform;
            }
            else
            {
                var camRig = FindObjectOfType<OVRCameraRig>();
                if (camRig != null) _trackingSpace = camRig.trackingSpace;
            }
        }

        private void BuildMaterials()
        {
            Shader overlayShader = Shader.Find("Universal Render Pipeline/Unlit") ??
                                   Shader.Find("Sprites/Default") ??
                                   Shader.Find("Unlit/Color");

            _rightOutlineMat = CreateOverlayMaterial(overlayShader, rightOutlineColor);
            _leftOutlineMat = CreateOverlayMaterial(overlayShader, leftOutlineColor);

            _rightReticleRingMat = CreateOverlayMaterial(overlayShader, reticleIdleColor);
            _rightReticleBeadMat = CreateOverlayMaterial(overlayShader, reticleIdleColor);

            _leftReticleRingMat = CreateOverlayMaterial(overlayShader, reticleIdleColor);
            _leftReticleBeadMat = CreateOverlayMaterial(overlayShader, reticleIdleColor);
        }

        private Material CreateOverlayMaterial(Shader shader, Color color)
        {
            Material mat = new Material(shader);
            mat.color = color;
            // Render Queue 3200 guarantees drawing AFTER standard Transparent UI Canvas (Queue 3000)
            mat.renderQueue = 3200;

            if (mat.HasProperty("_ZTest"))
            {
                mat.SetInt("_ZTest", (int)UnityEngine.Rendering.CompareFunction.Always);
            }
            return mat;
        }

        private void BuildHandOutlineHierarchy()
        {
            // 1. Left Hand Outline LineRenderer
            _leftRootObj = new GameObject("VR_HandOutline_Left");
            _leftRootObj.transform.SetParent(this.transform);

            _leftOutlineLine = _leftRootObj.AddComponent<LineRenderer>();
            _leftOutlineLine.sharedMaterial = _leftOutlineMat;
            _leftOutlineLine.positionCount = OutlinePointCount;
            _leftOutlineLine.loop = true;
            _leftOutlineLine.startWidth = outlineLineWidth;
            _leftOutlineLine.endWidth = outlineLineWidth;
            _leftOutlineLine.useWorldSpace = true;

            // 2. Right Hand Outline LineRenderer
            _rightRootObj = new GameObject("VR_HandOutline_Right");
            _rightRootObj.transform.SetParent(this.transform);

            _rightOutlineLine = _rightRootObj.AddComponent<LineRenderer>();
            _rightOutlineLine.sharedMaterial = _rightOutlineMat;
            _rightOutlineLine.positionCount = OutlinePointCount;
            _rightOutlineLine.loop = true;
            _rightOutlineLine.startWidth = outlineLineWidth;
            _rightOutlineLine.endWidth = outlineLineWidth;
            _rightOutlineLine.useWorldSpace = true;

            _leftRootObj.SetActive(false);
            _rightRootObj.SetActive(false);
        }

        private void BuildTouchReticleCursors()
        {
            // Right Index Reticle
            _rightReticleRoot = CreateReticleObject("VR_RightIndexTouchReticle", _rightReticleRingMat, _rightReticleBeadMat, out _rightReticleRingLine, out _rightReticleCenterBead);

            // Left Index Reticle (used when menu is pinned in room)
            _leftReticleRoot = CreateReticleObject("VR_LeftIndexTouchReticle", _leftReticleRingMat, _leftReticleBeadMat, out _leftReticleRingLine, out _leftReticleCenterBead);
        }

        private GameObject CreateReticleObject(string name, Material ringMat, Material beadMat, out LineRenderer ringLine, out GameObject beadObj)
        {
            GameObject root = new GameObject(name);
            root.transform.SetParent(this.transform);

            // Circular halo ring (32-segment loop)
            GameObject ringObj = new GameObject("ReticleRing");
            ringObj.transform.SetParent(root.transform);
            ringLine = ringObj.AddComponent<LineRenderer>();
            ringLine.sharedMaterial = ringMat;
            ringLine.useWorldSpace = false;
            ringLine.loop = true;
            ringLine.startWidth = 0.0020f;
            ringLine.endWidth = 0.0020f;

            int segments = 32;
            ringLine.positionCount = segments;
            float ringRadius = 0.011f; // 2.2cm diameter
            for (int i = 0; i < segments; i++)
            {
                float angle = (i / (float)segments) * Mathf.PI * 2f;
                ringLine.SetPosition(i, new Vector3(Mathf.Cos(angle) * ringRadius, Mathf.Sin(angle) * ringRadius, 0f));
            }

            // Central contact bead at fingertip
            beadObj = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            beadObj.name = "ReticleCenterBead";
            beadObj.transform.SetParent(root.transform);
            beadObj.transform.localPosition = Vector3.zero;
            beadObj.transform.localScale = Vector3.one * 0.0050f; // 5mm
            Destroy(beadObj.GetComponent<Collider>());

            var ren = beadObj.GetComponent<Renderer>();
            if (ren != null) ren.sharedMaterial = beadMat;

            root.SetActive(false);
            return root;
        }

        private void Update()
        {
            if (_mainCam == null) _mainCam = Camera.main;

            UpdateLeftHandTracking();
            UpdateRightHandTracking();
            ApplyVisibilityRules();
            UpdateTouchReticleCursors();
        }

        private void UpdateLeftHandTracking()
        {
            IsLeftHandTracked = false;

            try
            {
                if (OVRPlugin.GetHandState(OVRPlugin.Step.Render, OVRPlugin.Hand.HandLeft, ref _leftHandState))
                {
                    if ((_leftHandState.Status & OVRPlugin.HandStatus.HandTracked) != 0)
                    {
                        IsLeftHandTracked = true;

                        OVRPose rootPose = _leftHandState.RootPose.ToOVRPose();
                        LeftWristPosition = (_trackingSpace != null) ? _trackingSpace.TransformPoint(rootPose.position) : rootPose.position;
                        LeftWristRotation = (_trackingSpace != null) ? (_trackingSpace.rotation * rootPose.orientation) : rootPose.orientation;

                        bool hasPositions = _leftHandState.BonePositions != null &&
                                            _leftHandState.BonePositions.Length == TotalBones &&
                                            _leftHandState.BonePositions[10].x != 0;

                        if (hasPositions)
                        {
                            for (int i = 0; i < TotalBones; i++)
                            {
                                Vector3 bPos = ConvertOvrVector(_leftHandState.BonePositions[i]);
                                _leftJointWorld[i] = (_trackingSpace != null) ? _trackingSpace.TransformPoint(bPos) : bPos;
                            }
                            LeftIndexTipPosition = _leftJointWorld[10];
                        }
                        else
                        {
                            SynthesizeHandSkeleton(LeftWristPosition, LeftWristRotation, _leftJointWorld, false);
                            LeftIndexTipPosition = _leftJointWorld[10];
                        }

                        // Build sleek outer boundary contour
                        ComputeHandOutlineContour(_leftJointWorld, LeftWristRotation, _leftOutlinePoints, false);
                    }
                }
            }
            catch { }

            if (!IsLeftHandTracked)
            {
                LeftIndexTipPosition = Vector3.zero;
            }
        }

        private void UpdateRightHandTracking()
        {
            IsRightHandTracked = false;

            try
            {
                if (OVRPlugin.GetHandState(OVRPlugin.Step.Render, OVRPlugin.Hand.HandRight, ref _rightHandState))
                {
                    if ((_rightHandState.Status & OVRPlugin.HandStatus.HandTracked) != 0)
                    {
                        IsRightHandTracked = true;

                        OVRPose rootPose = _rightHandState.RootPose.ToOVRPose();
                        Vector3 rightWristPos = (_trackingSpace != null) ? _trackingSpace.TransformPoint(rootPose.position) : rootPose.position;
                        Quaternion rightWristRot = (_trackingSpace != null) ? (_trackingSpace.rotation * rootPose.orientation) : rootPose.orientation;

                        bool hasPositions = _rightHandState.BonePositions != null &&
                                            _rightHandState.BonePositions.Length == TotalBones &&
                                            _rightHandState.BonePositions[10].x != 0;

                        if (hasPositions)
                        {
                            for (int i = 0; i < TotalBones; i++)
                            {
                                Vector3 bPos = ConvertOvrVector(_rightHandState.BonePositions[i]);
                                _rightJointWorld[i] = (_trackingSpace != null) ? _trackingSpace.TransformPoint(bPos) : bPos;
                            }
                            RightIndexTipPosition = _rightJointWorld[10];
                        }
                        else
                        {
                            OVRPose pointerPose = _rightHandState.PointerPose.ToOVRPose();
                            Vector3 pPos = (_trackingSpace != null) ? _trackingSpace.TransformPoint(pointerPose.position) : pointerPose.position;
                            Vector3 pFwd = (_trackingSpace != null) ? _trackingSpace.TransformDirection(pointerPose.orientation * Vector3.forward) : (pointerPose.orientation * Vector3.forward);

                            RightIndexTipPosition = pPos + pFwd * 0.075f;
                            SynthesizeHandSkeleton(rightWristPos, rightWristRot, _rightJointWorld, true);
                            _rightJointWorld[10] = RightIndexTipPosition;
                        }

                        // Build sleek outer boundary contour
                        ComputeHandOutlineContour(_rightJointWorld, rightWristRot, _rightOutlinePoints, true);
                    }
                }
            }
            catch { }

            if (!IsRightHandTracked)
            {
                RightIndexTipPosition = Vector3.zero;
            }
        }

        /// <summary>
        /// Visibility Rules:
        /// - Menu is open and docked to wrist: Left hand outline is HIDDEN (show only the menu). Only right hand pointer is shown.
        /// - Menu is pinned in room or closed: BOTH hands show their outline and can interact with the panel.
        /// </summary>
        private void ApplyVisibilityRules()
        {
            bool isMenuDockedToWrist = (ShiroHandSlate.Instance != null &&
                                        ShiroHandSlate.Instance.isSlateVisible &&
                                        !ShiroHandSlate.Instance.isPinnedToWorld);

            // Left Hand Visibility
            if (IsLeftHandTracked && showHandOutline && !isMenuDockedToWrist)
            {
                if (!_leftRootObj.activeSelf) _leftRootObj.SetActive(true);
                _leftOutlineLine.SetPositions(_leftOutlinePoints);
            }
            else
            {
                if (_leftRootObj.activeSelf) _leftRootObj.SetActive(false);
            }

            // Right Hand Visibility
            if (IsRightHandTracked && showHandOutline)
            {
                if (!_rightRootObj.activeSelf) _rightRootObj.SetActive(true);
                _rightOutlineLine.SetPositions(_rightOutlinePoints);
            }
            else
            {
                if (_rightRootObj.activeSelf) _rightRootObj.SetActive(false);
            }
        }

        /// <summary>
        /// Computes a continuous 27-point loop tracing the outer silhouette edge of the hand
        /// (Wrist Outer -> Pinky -> Ring -> Middle -> Index -> Thumb -> Wrist Inner -> across Wrist Base).
        /// </summary>
        private void ComputeHandOutlineContour(Vector3[] joints, Quaternion wristRot, Vector3[] outline, bool isRightHand)
        {
            float side = isRightHand ? 1f : -1f;

            // 0: Outer Wrist (pinky side)
            outline[0] = joints[1] - (wristRot * Vector3.right) * (0.030f * side);
            // 1: Pinky Metacarpal outer
            outline[1] = joints[21] - (wristRot * Vector3.right) * (0.015f * side);
            // 2: Pinky Proximal
            outline[2] = joints[22] - (wristRot * Vector3.right) * (0.008f * side);
            // 3: Pinky Intermediate
            outline[3] = joints[23] - (wristRot * Vector3.right) * (0.006f * side);
            // 4: Pinky Distal
            outline[4] = joints[24];
            // 5: Pinky Tip
            outline[5] = joints[25];
            // 6: Pinky-Ring Webbing
            outline[6] = (joints[22] + joints[17]) * 0.5f;
            // 7: Ring Proximal
            outline[7] = joints[17];
            // 8: Ring Intermediate
            outline[8] = joints[18];
            // 9: Ring Distal
            outline[9] = joints[19];
            // 10: Ring Tip
            outline[10] = joints[20];
            // 11: Ring-Middle Webbing
            outline[11] = (joints[17] + joints[12]) * 0.5f;
            // 12: Middle Proximal
            outline[12] = joints[12];
            // 13: Middle Intermediate
            outline[13] = joints[13];
            // 14: Middle Distal
            outline[14] = joints[14];
            // 15: Middle Tip
            outline[15] = joints[15];
            // 16: Middle-Index Webbing
            outline[16] = (joints[12] + joints[7]) * 0.5f;
            // 17: Index Proximal
            outline[17] = joints[7];
            // 18: Index Intermediate
            outline[18] = joints[8];
            // 19: Index Distal
            outline[19] = joints[9];
            // 20: Index Tip
            outline[20] = joints[10];
            // 21: Index-Thumb Webbing
            outline[21] = (joints[7] + joints[3]) * 0.5f;
            // 22: Thumb Proximal
            outline[22] = joints[3];
            // 23: Thumb Distal
            outline[23] = joints[4];
            // 24: Thumb Tip
            outline[24] = joints[5];
            // 25: Thumb Metacarpal outer
            outline[25] = joints[2] + (wristRot * Vector3.right) * (0.015f * side);
            // 26: Inner Wrist (thumb side)
            outline[26] = joints[1] + (wristRot * Vector3.right) * (0.028f * side);
        }

        private void UpdateTouchReticleCursors()
        {
            // Right Hand Reticle
            UpdateSingleReticle(_rightReticleRoot, _rightReticleRingMat, _rightReticleBeadMat, RightIndexTipPosition, IsRightHandTracked, RightIndexHoverDistance, IsRightIndexTouching);

            // Left Hand Reticle (active when menu is pinned in room)
            bool isMenuPinned = (ShiroHandSlate.Instance != null && ShiroHandSlate.Instance.isPinnedToWorld && ShiroHandSlate.Instance.isSlateVisible);
            UpdateSingleReticle(_leftReticleRoot, _leftReticleRingMat, _leftReticleBeadMat, LeftIndexTipPosition, IsLeftHandTracked && isMenuPinned, LeftIndexHoverDistance, IsLeftIndexTouching);
        }

        private void UpdateSingleReticle(GameObject root, Material ringMat, Material beadMat, Vector3 tipPos, bool isTracked, float hoverDist, bool isTouching)
        {
            if (!showTouchReticle || !isTracked || tipPos == Vector3.zero)
            {
                if (root.activeSelf) root.SetActive(false);
                return;
            }

            if (!root.activeSelf) root.SetActive(true);
            root.transform.position = tipPos;

            if (_mainCam != null)
            {
                Vector3 lookDir = (root.transform.position - _mainCam.transform.position).normalized;
                root.transform.rotation = Quaternion.LookRotation(lookDir, Vector3.up);
            }

            Color targetColor = reticleIdleColor;
            float targetScale = 1.0f;

            if (isTouching)
            {
                targetColor = reticlePressColor;
                targetScale = 1.35f;
            }
            else if (hoverDist < 0.048f)
            {
                float hoverFactor = Mathf.InverseLerp(0.048f, 0.015f, hoverDist);
                targetColor = Color.Lerp(reticleIdleColor, reticleHoverColor, hoverFactor);
                targetScale = Mathf.Lerp(1.0f, 1.25f, hoverFactor);
            }

            if (ringMat != null) ringMat.color = targetColor;
            if (beadMat != null) beadMat.color = targetColor;
            root.transform.localScale = Vector3.Lerp(root.transform.localScale, Vector3.one * targetScale, Time.deltaTime * 18f);
        }

        private void SynthesizeHandSkeleton(Vector3 wristPos, Quaternion wristRot, Vector3[] output, bool isRightHand)
        {
            float side = isRightHand ? 1f : -1f;

            output[0] = wristPos + wristRot * new Vector3(0f, -0.012f, 0.045f);
            output[1] = wristPos;

            output[2] = wristPos + wristRot * new Vector3(0.022f * side, -0.008f, 0.025f);
            output[3] = wristPos + wristRot * new Vector3(0.038f * side, -0.004f, 0.048f);
            output[4] = wristPos + wristRot * new Vector3(0.048f * side, 0.002f, 0.068f);
            output[5] = wristPos + wristRot * new Vector3(0.054f * side, 0.008f, 0.088f);

            output[6] = wristPos + wristRot * new Vector3(0.018f * side, 0.000f, 0.060f);
            output[7] = wristPos + wristRot * new Vector3(0.019f * side, 0.004f, 0.088f);
            output[8] = wristPos + wristRot * new Vector3(0.019f * side, 0.006f, 0.115f);
            output[9] = wristPos + wristRot * new Vector3(0.019f * side, 0.006f, 0.138f);
            output[10] = wristPos + wristRot * new Vector3(0.019f * side, 0.005f, 0.158f);

            output[11] = wristPos + wristRot * new Vector3(0.000f, 0.000f, 0.062f);
            output[12] = wristPos + wristRot * new Vector3(0.000f, 0.005f, 0.092f);
            output[13] = wristPos + wristRot * new Vector3(0.000f, 0.007f, 0.122f);
            output[14] = wristPos + wristRot * new Vector3(0.000f, 0.007f, 0.148f);
            output[15] = wristPos + wristRot * new Vector3(0.000f, 0.006f, 0.168f);

            output[16] = wristPos + wristRot * new Vector3(-0.016f * side, 0.000f, 0.058f);
            output[17] = wristPos + wristRot * new Vector3(-0.018f * side, 0.004f, 0.086f);
            output[18] = wristPos + wristRot * new Vector3(-0.018f * side, 0.006f, 0.112f);
            output[19] = wristPos + wristRot * new Vector3(-0.018f * side, 0.006f, 0.134f);
            output[20] = wristPos + wristRot * new Vector3(-0.018f * side, 0.005f, 0.152f);

            output[21] = wristPos + wristRot * new Vector3(-0.032f * side, -0.002f, 0.052f);
            output[22] = wristPos + wristRot * new Vector3(-0.035f * side, 0.002f, 0.076f);
            output[23] = wristPos + wristRot * new Vector3(-0.035f * side, 0.004f, 0.096f);
            output[24] = wristPos + wristRot * new Vector3(-0.035f * side, 0.004f, 0.114f);
            output[25] = wristPos + wristRot * new Vector3(-0.035f * side, 0.003f, 0.128f);
        }

        private static Vector3 ConvertOvrVector(OVRPlugin.Vector3f v)
        {
            return new Vector3(v.x, v.y, -v.z);
        }
    }
}
