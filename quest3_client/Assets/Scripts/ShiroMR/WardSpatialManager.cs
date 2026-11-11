// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Spatial Coordinator: Transforms Ward Coordinate System to Unity World Space
// =============================================================================
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEngine;

namespace ShiroMR
{
    public class WardSpatialManager : MonoBehaviour
    {
        public static WardSpatialManager Instance { get; private set; }

        [Header("Ward Origin Reference")]
        [Tooltip("The reference transform representing (0,0,0) at the South-West corner of the ward.")]
        public Transform wardOrigin;

        [Header("Room Alignment Parameters")]
        public Vector3 originPositionOffset = Vector3.zero;
        public float originRotationYaw = 0f;

        [Header("Native Meta Quest Spatial Anchor")]
        public OVRSpatialAnchor currentNativeAnchor;
        public string activeAnchorUuid = "";

        private GameObject _nativeAnchorHost;
        private WardConfig _cachedWardConfig;

        public WardConfig GetCachedWardConfig()
        {
            if (_cachedWardConfig != null) return _cachedWardConfig;
            if (WardAlignmentTool.Instance != null && WardAlignmentTool.Instance.CachedWardConfig != null)
                return WardAlignmentTool.Instance.CachedWardConfig;
            return null;
        }

        private void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Destroy(gameObject);
                return;
            }
            Instance = this;

            if (wardOrigin == null)
            {
                GameObject originObj = new GameObject("WardOrigin_SW_Corner");
                originObj.transform.SetParent(this.transform);
                originObj.transform.localPosition = originPositionOffset;
                originObj.transform.localRotation = Quaternion.Euler(0, originRotationYaw, 0);
                wardOrigin = originObj.transform;
            }
        }

        private void Start()
        {
            // Subscribe to headset re-centering & proximity mount events
            try
            {
                if (OVRManager.display != null)
                {
                    OVRManager.display.RecenteredPose += HandleHeadsetRecentered;
                }
                OVRManager.HMDMounted += HandleHeadsetMounted;
            }
            catch { }

            if (ShiroNetworkManager.Instance != null)
            {
                ShiroNetworkManager.Instance.OnWardInitialized += (ward, subjects) => { _cachedWardConfig = ward; };
            }
        }

        /// <summary>
        /// Detaches and destroys any currently active spatial anchor host GameObject.
        /// Must be called before or during any calibration to prevent stale anchors from overwriting ward coordinates.
        /// </summary>
        public void DetachCurrentAnchor()
        {
            if (_nativeAnchorHost != null)
            {
                Destroy(_nativeAnchorHost);
                _nativeAnchorHost = null;
            }
            currentNativeAnchor = null;
            activeAnchorUuid = "";
            Debug.Log("[SHIRO SPATIAL] Detached and destroyed active native anchor host.");
        }

        private void LateUpdate()
        {
            // During calibration, NEVER allow an active anchor to fight or overwrite calibration!
            if (WardAlignmentTool.Instance != null &&
                WardAlignmentTool.Instance.currentStep != AlignmentStep.Idle &&
                WardAlignmentTool.Instance.currentStep != AlignmentStep.Completed)
            {
                return;
            }

            // Maintain continuous SLAM tracking alignment to native anchor host without reparenting
            if (_nativeAnchorHost != null && currentNativeAnchor != null && wardOrigin != null)
            {
                wardOrigin.position = _nativeAnchorHost.transform.position;
                wardOrigin.rotation = _nativeAnchorHost.transform.rotation;
            }
        }

        private void OnDestroy()
        {
            try
            {
                if (OVRManager.display != null)
                {
                    OVRManager.display.RecenteredPose -= HandleHeadsetRecentered;
                }
                OVRManager.HMDMounted -= HandleHeadsetMounted;
            }
            catch { }
        }

        private void HandleHeadsetRecentered()
        {
            Debug.Log("[SHIRO SPATIAL] Headset recentered event received. Checking spatial anchor sync.");
            SyncWardOriginToAnchor();
        }

        private void HandleHeadsetMounted()
        {
            Debug.Log("[SHIRO SPATIAL] Headset mounted on user face. Re-verifying anchor localization.");
            SyncWardOriginToAnchor();
        }

        private void SyncWardOriginToAnchor()
        {
            if (_nativeAnchorHost != null && currentNativeAnchor != null)
            {
                // Ensure wardOrigin maintains exact position relative to localized anchor
                wardOrigin.position = _nativeAnchorHost.transform.position;
                wardOrigin.rotation = _nativeAnchorHost.transform.rotation;
            }
            else
            {
                // PC VR / Quest Link mode auto-restore from PlayerPrefs
                ReSyncAlignment();
            }
        }

        /// <summary>
        /// Instant 1-click Re-Sync: Reloads the saved room calibration from local storage.
        /// Use this anytime you remove/replace the headset or tracking resets.
        /// </summary>
        public bool ReSyncAlignment()
        {
            string targetWard = ShiroNetworkManager.Instance != null ? ShiroNetworkManager.Instance.targetWardId : "WARD-005";
            return LoadAlignmentFromPrefs(targetWard);
        }

        /// <summary>
        /// Converts 2D Ward Coordinates (X = Width, Y = Length) and Elevation (Z = Up)
        /// to Unity 3D World Space coordinates.
        /// </summary>
        public Vector3 WardToWorldPosition(float wardX, float wardY, float elevation = 0.85f)
        {
            if (wardOrigin == null) return new Vector3(wardX, elevation, wardY);
            Vector3 localPos = new Vector3(wardX, elevation, wardY);
            return wardOrigin.TransformPoint(localPos);
        }

        /// <summary>
        /// Converts a Ward rotation angle (degrees around vertical axis) to Unity World Quaternion.
        /// </summary>
        public Quaternion WardRotationToWorld(float wardYawDeg)
        {
            if (wardOrigin == null) return Quaternion.Euler(0, wardYawDeg, 0);
            return wardOrigin.rotation * Quaternion.Euler(0, wardYawDeg, 0);
        }

        /// <summary>
        /// 1-Click Alignment: Snaps the Ward Origin so that a specific landmark matches physical space.
        /// </summary>
        public void AlignWardToPhysicalLandmark(float landmarkWardX, float landmarkWardY, float landmarkElevation, Vector3 physicalWorldPosition, float physicalYawDegrees = 0f)
        {
            if (wardOrigin == null) return;
            DetachCurrentAnchor();
            wardOrigin.rotation = Quaternion.Euler(0, physicalYawDegrees, 0);
            Vector3 localOffset = new Vector3(landmarkWardX, landmarkElevation, landmarkWardY);
            Vector3 rotatedOffset = wardOrigin.rotation * localOffset;
            wardOrigin.position = physicalWorldPosition - rotatedOffset;
            Debug.Log($"[SHIRO SPATIAL] Ward aligned to physical landmark ({landmarkWardX:F2}, {landmarkWardY:F2}). Origin: {wardOrigin.position}.");
        }

        /// <summary>
        /// 2-Point Bed Alignment: Snaps ward origin using physical bed Headboard and Foot points.
        /// </summary>
        public bool AlignWardByBedTwoPoints(WardBed bed, Vector3 physicalHeadboard, Vector3 physicalFoot, out float measuredLength, out float calculatedYaw)
        {
            measuredLength = 0f;
            calculatedYaw = 0f;
            if (wardOrigin == null || bed == null) return false;
            DetachCurrentAnchor();

            float bw = bed.width > 0 ? bed.width : 0.90f;
            float bl = bed.length > 0 ? bed.length : 2.00f;
            int rot = bed.rotation_deg;

            bool isRotatedHorizontal = (rot == 90 || rot == 270);
            float spanX = isRotatedHorizontal ? bl : bw;
            float spanY = isRotatedHorizontal ? bw : bl;

            float centerX = bed.x + spanX / 2.0f;
            float centerY = bed.y + spanY / 2.0f;

            Vector3 wardHeadboard;
            Vector3 wardFoot;

            if (rot == 0) // North
            {
                wardHeadboard = new Vector3(centerX, 0.50f, bed.y + bl);
                wardFoot = new Vector3(centerX, 0.50f, bed.y);
            }
            else if (rot == 180) // South
            {
                wardHeadboard = new Vector3(centerX, 0.50f, bed.y);
                wardFoot = new Vector3(centerX, 0.50f, bed.y + bl);
            }
            else if (rot == 90) // East
            {
                wardHeadboard = new Vector3(bed.x + bl, 0.50f, centerY);
                wardFoot = new Vector3(bed.x, 0.50f, centerY);
            }
            else // 270 West
            {
                wardHeadboard = new Vector3(bed.x, 0.50f, centerY);
                wardFoot = new Vector3(bed.x + bl, 0.50f, centerY);
            }

            Vector3 wardVec = wardHeadboard - wardFoot;
            float wardAngle = Mathf.Atan2(wardVec.x, wardVec.z) * Mathf.Rad2Deg;

            Vector3 physVec = physicalHeadboard - physicalFoot;
            physVec.y = 0;
            measuredLength = physVec.magnitude;
            if (measuredLength < 0.20f)
            {
                Debug.LogWarning("[SHIRO SPATIAL] Points too close together for valid bed alignment.");
                return false;
            }

            float physAngle = Mathf.Atan2(physVec.x, physVec.z) * Mathf.Rad2Deg;
            float deltaYaw = physAngle - wardAngle;
            wardOrigin.rotation = Quaternion.Euler(0, deltaYaw, 0);

            Vector3 wardCenter = new Vector3(centerX, (physicalHeadboard.y + physicalFoot.y) / 2.0f, centerY);
            Vector3 physCenter = (physicalHeadboard + physicalFoot) / 2.0f;

            wardOrigin.position = physCenter - wardOrigin.rotation * wardCenter;
            float physicalFloorY = (physicalHeadboard.y + physicalFoot.y) / 2.0f - 0.50f;
            if (ShiroVRPointer.Instance != null && Mathf.Abs(physicalFloorY) < 0.05f)
            {
                physicalFloorY = ShiroVRPointer.GetPhysicalFloorHeight();
            }
            wardOrigin.position = new Vector3(wardOrigin.position.x, physicalFloorY, wardOrigin.position.z);
            calculatedYaw = deltaYaw;

            Debug.Log($"[SHIRO SPATIAL] Ward aligned to Bed {bed.bed_code}. Measured: {measuredLength:F2}m (expected: {bl:F2}m), Yaw: {deltaYaw:F1} deg, Origin: {wardOrigin.position}");
            return true;
        }

        /// <summary>
        /// Calculates the exact World Space position for a clinical headwall monitor above a bed's headboard (~1.28m eye-level height).
        /// </summary>
        public Vector3 GetBedHeadboardWorldPosition(WardBed bed)
        {
            if (bed == null || wardOrigin == null) return Vector3.zero;
            float bw = bed.width > 0 ? bed.width : 0.90f;
            float bl = bed.length > 0 ? bed.length : 2.00f;
            int rot = bed.rotation_deg;
            bool isRotatedHorizontal = (rot == 90 || rot == 270);
            float spanX = isRotatedHorizontal ? bl : bw;
            float spanY = isRotatedHorizontal ? bw : bl;
            float centerX = bed.x + spanX / 2.0f;
            float centerY = bed.y + spanY / 2.0f;

            Vector3 localBedCenter = new Vector3(centerX, 0f, centerY);
            Vector3 headboardOffset = Quaternion.Euler(0, rot, 0) * new Vector3(0, 1.28f, (bl / 2.0f) - 0.05f);
            return wardOrigin.TransformPoint(localBedCenter + headboardOffset);
        }

        /// <summary>
        /// Calculates the static World Space orientation for a poster/monitor mounted on the headboard facing outward into the room.
        /// Matches the 3D bed rotation directly so the front face of the Canvas points along the bed towards the footboard.
        /// Does NOT rotate or billboard when the doctor moves around the room.
        /// </summary>
        public Quaternion GetBedHeadboardRotation(WardBed bed)
        {
            if (bed == null || wardOrigin == null) return Quaternion.identity;
            int rot = bed.rotation_deg;
            return wardOrigin.rotation * Quaternion.Euler(0, rot, 0);
        }

        /// <summary>
        /// Calculates the exact World Space position for a bedside vitals cart (~1.05m height).
        /// </summary>
        public Vector3 GetBedSideWorldPosition(WardBed bed)
        {
            if (bed == null || wardOrigin == null) return Vector3.zero;
            float bw = bed.width > 0 ? bed.width : 0.90f;
            float bl = bed.length > 0 ? bed.length : 2.00f;
            int rot = bed.rotation_deg;
            bool isRotatedHorizontal = (rot == 90 || rot == 270);
            float spanX = isRotatedHorizontal ? bl : bw;
            float spanY = isRotatedHorizontal ? bw : bl;
            float centerX = bed.x + spanX / 2.0f;
            float centerY = bed.y + spanY / 2.0f;

            Vector3 localBedCenter = new Vector3(centerX, 0f, centerY);
            Vector3 bedsideOffset = Quaternion.Euler(0, rot, 0) * new Vector3((bw / 2.0f) + 0.35f, 1.05f, 0f);
            return wardOrigin.TransformPoint(localBedCenter + bedsideOffset);
        }

        /// <summary>
        /// Calculates Euclidean distance from a 2D Ward coordinate (wardX, wardY) to a bed's center.
        /// </summary>
        public float GetDistanceToBedCenter(float wardX, float wardY, WardBed bed)
        {
            if (bed == null) return 999f;
            float bw = bed.width > 0 ? bed.width : 0.90f;
            float bl = bed.length > 0 ? bed.length : 2.00f;
            int rot = bed.rotation_deg;
            bool isRotatedHorizontal = (rot == 90 || rot == 270);
            float spanX = isRotatedHorizontal ? bl : bw;
            float spanY = isRotatedHorizontal ? bw : bl;
            float centerX = bed.x + spanX / 2.0f;
            float centerY = bed.y + spanY / 2.0f;

            return Vector2.Distance(new Vector2(wardX, wardY), new Vector2(centerX, centerY));
        }

        /// <summary>
        /// Checks if a 2D Ward coordinate (wardX, wardY) falls strictly within the mattress area of a bed.
        /// Uses a tight margin (0.25m) and distance check to prevent swallowing small ward rooms.
        /// </summary>
        public bool IsPointInsideBedArea(float wardX, float wardY, WardBed bed, float margin = 0.25f)
        {
            if (bed == null) return false;
            float bw = bed.width > 0 ? bed.width : 0.90f;
            float bl = bed.length > 0 ? bed.length : 2.00f;
            int rot = bed.rotation_deg;
            bool isRotatedHorizontal = (rot == 90 || rot == 270);
            float spanX = isRotatedHorizontal ? bl : bw;
            float spanY = isRotatedHorizontal ? bw : bl;

            bool inBox = (wardX >= bed.x - margin && wardX <= bed.x + spanX + margin &&
                         wardY >= bed.y - margin && wardY <= bed.y + spanY + margin);

            if (!inBox) return false;

            // Also verify Euclidean distance to bed center is strictly within 1.15m
            float dist = GetDistanceToBedCenter(wardX, wardY, bed);
            return dist <= 1.15f;
        }

        /// <summary>
        /// Wall Anchors Alignment (Node A + Node B):
        /// Uses permanent, fixed wall hardware nodes. Completely immune to blankets, pillows, or clutter.
        /// </summary>
        public bool AlignWardByWallAnchors(WardAnchor a, WardAnchor b, Vector3 physA, Vector3 physB, out float measuredDist, out float calculatedYaw)
        {
            measuredDist = 0f;
            calculatedYaw = 0f;
            if (wardOrigin == null || a == null || b == null) return false;
            DetachCurrentAnchor();

            Vector3 wardVec = new Vector3(b.x - a.x, 0, b.y - a.y);
            float expectedDist = wardVec.magnitude;
            float wardAngle = Mathf.Atan2(wardVec.x, wardVec.z) * Mathf.Rad2Deg;

            Vector3 physVec = physB - physA;
            physVec.y = 0;
            measuredDist = physVec.magnitude;

            if (measuredDist < 0.20f)
            {
                Debug.LogWarning("[SHIRO SPATIAL] Wall anchor points are too close.");
                return false;
            }

            float physAngle = Mathf.Atan2(physVec.x, physVec.z) * Mathf.Rad2Deg;
            float deltaYaw = physAngle - wardAngle;
            wardOrigin.rotation = Quaternion.Euler(0, deltaYaw, 0);

            // Anchor A in Ward coordinate system (Unity coordinates: X, Z(elevation), Y)
            float elevA = a.z > 0 ? a.z : 1.80f;
            Vector3 wardPosA = new Vector3(a.x, elevA, a.y);
            wardOrigin.position = physA - wardOrigin.rotation * wardPosA;
            float physicalFloorY = physA.y - elevA;
            wardOrigin.position = new Vector3(wardOrigin.position.x, physicalFloorY, wardOrigin.position.z);
            calculatedYaw = deltaYaw;

            Debug.Log($"[SHIRO SPATIAL] Ward aligned to Wall Anchors {a.anchor_id}->{b.anchor_id}. Measured: {measuredDist:F2}m (expected: {expectedDist:F2}m), Yaw: {deltaYaw:F1} deg, Origin: {wardOrigin.position}");
            return true;
        }

        /// <summary>
        /// 2-Corner Room Alignment (South-West Corner (0,0) and North-West Corner (0, Length)):
        /// User touches the floor corner at SW, then NW along the wall.
        /// Completely independent of beds or wall anchors!
        /// </summary>
        public bool AlignWardByTwoCorners(Vector3 physCornerSW, Vector3 physCornerNW, float expectedLength, out float measuredDist, out float calculatedYaw)
        {
            measuredDist = 0f;
            calculatedYaw = 0f;
            if (wardOrigin == null) return false;
            DetachCurrentAnchor();

            // Vector in Ward coordinate system: From SW (0,0) to NW (0, Length)
            Vector3 wardVec = new Vector3(0, 0, expectedLength > 0 ? expectedLength : 4.0f);
            float wardAngle = 0f; // along +Z (North)

            Vector3 physVec = physCornerNW - physCornerSW;
            physVec.y = 0;
            measuredDist = physVec.magnitude;

            if (measuredDist < 0.20f)
            {
                Debug.LogWarning("[SHIRO SPATIAL] Corner points are too close.");
                return false;
            }

            float physicalFloorY = (physCornerSW.y + physCornerNW.y) / 2f;
            if (ShiroVRPointer.Instance != null && Mathf.Abs(physicalFloorY) < 0.001f)
            {
                physicalFloorY = ShiroVRPointer.GetPhysicalFloorHeight();
            }

            float physAngle = Mathf.Atan2(physVec.x, physVec.z) * Mathf.Rad2Deg;
            float deltaYaw = physAngle - wardAngle;
            wardOrigin.rotation = Quaternion.Euler(0, deltaYaw, 0);

            // SW Corner is (0,0,0) in Ward space, so wardOrigin directly snaps to physCornerSW at true physical floor height!
            wardOrigin.position = new Vector3(physCornerSW.x, physicalFloorY, physCornerSW.z);
            calculatedYaw = deltaYaw;

            Debug.Log($"[SHIRO SPATIAL] Ward aligned by Room Corners SW->NW. Measured: {measuredDist:F2}m (expected: {expectedLength:F2}m), Yaw: {deltaYaw:F1} deg, Origin: {wardOrigin.position}");
            return true;
        }

        /// <summary>
        /// Door Frame 2-Point Alignment (Floor Level Left Post -> Right Post):
        /// Doctor aims at the bottom-left of the door frame, then bottom-right at floor level.
        /// Uses the ward's actual geometry (SOUTH, NORTH, EAST, WEST) and user perspective (inside vs hallway)
        /// to snap the virtual digital twin directly to the physical entrance with millimeter precision.
        /// </summary>
        public bool AlignWardByDoorFrame(WardConfig ward, Vector3 physLeftPost, Vector3 physRightPost, bool standingInside, out float measuredWidth, out float calculatedYaw)
        {
            measuredWidth = 0f;
            calculatedYaw = 0f;
            if (wardOrigin == null || ward == null || ward.door == null) return false;
            DetachCurrentAnchor();

            CalculateDoorPosts(ward, standingInside, out Vector3 wardLeftPost, out Vector3 wardRightPost, out Vector3 wardDoorCenter, out float expectedW, out string wall);

            Vector3 wardVec = wardRightPost - wardLeftPost;
            float wardAngle = Mathf.Atan2(wardVec.x, wardVec.z) * Mathf.Rad2Deg;

            Vector3 physVec = physRightPost - physLeftPost;
            physVec.y = 0;
            measuredWidth = physVec.magnitude;

            if (measuredWidth < 0.20f)
            {
                Debug.LogWarning("[SHIRO SPATIAL] Door frame points are too close.");
                return false;
            }

            // Sanity check: Ensure Left post is actually to the user's left (only if user is standing >0.4m away)
            if (Camera.main != null)
            {
                Vector3 userPos = Camera.main.transform.position;
                userPos.y = 0;
                Vector3 doorMid = (physLeftPost + physRightPost) / 2f;
                doorMid.y = 0;
                Vector3 toDoor = doorMid - userPos;
                if (toDoor.magnitude > 0.40f)
                {
                    Vector3 lookDir = toDoor.normalized;
                    Vector3 toUserRight = Vector3.Cross(Vector3.up, lookDir);

                    // Only swap if user clearly clicked the Right post before the Left post
                    if (Vector3.Dot(physVec.normalized, toUserRight) < -0.40f)
                    {
                        Debug.Log("[SHIRO SPATIAL] Auto-swapping door posts: Right post was clicked before Left post.");
                        Vector3 temp = physLeftPost;
                        physLeftPost = physRightPost;
                        physRightPost = temp;
                        physVec = physRightPost - physLeftPost;
                        physVec.y = 0;
                    }
                }
            }

            float physAngle = Mathf.Atan2(physVec.x, physVec.z) * Mathf.Rad2Deg;
            float deltaYaw = physAngle - wardAngle;
            wardOrigin.rotation = Quaternion.Euler(0, deltaYaw, 0);

            // Shift origin so that Door Center matches physical door center (with true physical floor height snapping)
            float physicalFloorY = (physLeftPost.y + physRightPost.y) / 2f;
            if (ShiroVRPointer.Instance != null && Mathf.Abs(physicalFloorY) < 0.001f)
            {
                physicalFloorY = ShiroVRPointer.GetPhysicalFloorHeight();
            }

            Vector3 physDoorMid = (physLeftPost + physRightPost) / 2f;
            physDoorMid.y = physicalFloorY;
            wardOrigin.position = physDoorMid - wardOrigin.rotation * wardDoorCenter;
            wardOrigin.position = new Vector3(wardOrigin.position.x, physicalFloorY, wardOrigin.position.z);
            calculatedYaw = deltaYaw;

            Debug.Log($"[SHIRO SPATIAL] Ward aligned to Door Frame ({wall})! Measured: {measuredWidth:F2}m (expected: {expectedW:F2}m), Yaw: {deltaYaw:F1} deg, Origin: {wardOrigin.position}");
            return true;
        }

        /// <summary>
        /// Backward-compatible overload for WardDoor without full config.
        /// </summary>
        public bool AlignWardByDoorFrame(WardDoor door, Vector3 physLeftPost, Vector3 physRightPost, out float measuredWidth, out float calculatedYaw)
        {
            WardConfig fallback = new WardConfig { length_x = 5.0f, width_y = 6.0f, door = door };
            return AlignWardByDoorFrame(fallback, physLeftPost, physRightPost, true, out measuredWidth, out calculatedYaw);
        }

        /// <summary>
        /// Mathematical Door Frame Coordinates Calculator:
        /// Accurately computes Left Post, Right Post, and Center coordinates in Ward space
        /// for SOUTH, NORTH, EAST, and WEST wall configurations, factoring in whether
        /// the user is standing inside the room looking out, or in the hallway looking in.
        /// </summary>
        public static void CalculateDoorPosts(
            WardConfig ward,
            bool standingInside,
            out Vector3 wardLeftPost,
            out Vector3 wardRightPost,
            out Vector3 wardDoorCenter,
            out float expectedWidth,
            out string wallName)
        {
            float roomW = (ward != null && ward.length_x > 0) ? ward.length_x : 5.0f;
            float roomL = (ward != null && ward.width_y > 0) ? ward.width_y : 6.0f;
            wallName = (ward != null && ward.door != null && !string.IsNullOrEmpty(ward.door.wall)) ? ward.door.wall.ToUpper() : "SOUTH";
            float dw = (ward != null && ward.door != null && ward.door.width > 0) ? ward.door.width : 0.90f;
            float doorPos = (ward != null && ward.door != null) ? ward.door.x : 0f;
            expectedWidth = dw;

            if (wallName == "SOUTH")
            {
                wardDoorCenter = new Vector3(doorPos + dw / 2f, 0, 0);
                if (standingInside)
                {
                    wardLeftPost = new Vector3(doorPos + dw, 0, 0);
                    wardRightPost = new Vector3(doorPos, 0, 0);
                }
                else
                {
                    wardLeftPost = new Vector3(doorPos, 0, 0);
                    wardRightPost = new Vector3(doorPos + dw, 0, 0);
                }
            }
            else if (wallName == "NORTH")
            {
                wardDoorCenter = new Vector3(doorPos + dw / 2f, 0, roomL);
                if (standingInside)
                {
                    wardLeftPost = new Vector3(doorPos, 0, roomL);
                    wardRightPost = new Vector3(doorPos + dw, 0, roomL);
                }
                else
                {
                    wardLeftPost = new Vector3(doorPos + dw, 0, roomL);
                    wardRightPost = new Vector3(doorPos, 0, roomL);
                }
            }
            else if (wallName == "WEST")
            {
                wardDoorCenter = new Vector3(0, 0, doorPos + dw / 2f);
                if (standingInside)
                {
                    wardLeftPost = new Vector3(0, 0, doorPos);
                    wardRightPost = new Vector3(0, 0, doorPos + dw);
                }
                else
                {
                    wardLeftPost = new Vector3(0, 0, doorPos + dw);
                    wardRightPost = new Vector3(0, 0, doorPos);
                }
            }
            else // EAST
            {
                wardDoorCenter = new Vector3(roomW, 0, doorPos + dw / 2f);
                if (standingInside)
                {
                    wardLeftPost = new Vector3(roomW, 0, doorPos + dw);
                    wardRightPost = new Vector3(roomW, 0, doorPos);
                }
                else
                {
                    wardLeftPost = new Vector3(roomW, 0, doorPos);
                    wardRightPost = new Vector3(roomW, 0, doorPos + dw);
                }
            }
        }

        /// <summary>
        /// Creates a native Meta Quest Spatial Anchor, localizes it with Quest SLAM vision map,
        /// and saves it to device persistent storage so it stays locked across restarts and headset removals.
        /// </summary>
        public async Task<string> SaveNativeSpatialAnchorAsync(string wardId)
        {
            if (wardOrigin == null) return null;

            try
            {
                if (_nativeAnchorHost != null)
                {
                    Destroy(_nativeAnchorHost);
                    _nativeAnchorHost = null;
                }

                _nativeAnchorHost = new GameObject($"SpatialAnchorHost_{wardId}");
                _nativeAnchorHost.transform.position = wardOrigin.position;
                _nativeAnchorHost.transform.rotation = wardOrigin.rotation;

                var spatialAnchor = _nativeAnchorHost.AddComponent<OVRSpatialAnchor>();

                // Await native localization
                await spatialAnchor.WhenLocalizedAsync();

                // Save to local Meta headset persistent anchor store
                var saveResult = await spatialAnchor.SaveAnchorAsync();
                if (saveResult.Success)
                {
                    currentNativeAnchor = spatialAnchor;
                    activeAnchorUuid = spatialAnchor.Uuid.ToString();

                    SaveAlignmentToPrefs(wardId);
                    PlayerPrefs.SetString($"WARD_ANCHOR_UUID_{wardId}", activeAnchorUuid);
                    PlayerPrefs.Save();

                    Debug.Log($"[SHIRO SPATIAL] Native OVRSpatialAnchor saved successfully! UUID: {activeAnchorUuid}");
                    return activeAnchorUuid;
                }
                else
                {
                    Debug.LogWarning($"[SHIRO SPATIAL] SaveAnchorAsync failed: {saveResult.Status}");
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[SHIRO SPATIAL] Native anchor runtime exception (Editor fallback active): {ex.Message}");
            }

            // Fallback for PC editor testing
            SaveAlignmentToPrefs(wardId);
            return null;
        }

        /// <summary>
        /// Restores and localizes a previously saved native Meta Spatial Anchor by UUID.
        /// </summary>
        public async Task<bool> LoadNativeSpatialAnchorAsync(string uuidString)
        {
            if (string.IsNullOrEmpty(uuidString) || !Guid.TryParse(uuidString, out Guid guid))
            {
                return false;
            }

            try
            {
                var unboundAnchors = new List<OVRSpatialAnchor.UnboundAnchor>();
                var result = await OVRSpatialAnchor.LoadUnboundAnchorsAsync(new[] { guid }, unboundAnchors);

                if (result.Success && unboundAnchors.Count > 0)
                {
                    var unbound = unboundAnchors[0];
                    if (await unbound.LocalizeAsync())
                    {
                        if (_nativeAnchorHost != null)
                        {
                            Destroy(_nativeAnchorHost);
                            _nativeAnchorHost = null;
                        }

                        _nativeAnchorHost = new GameObject($"RestoredSpatialAnchor_{guid}");
                        var spatialAnchor = _nativeAnchorHost.AddComponent<OVRSpatialAnchor>();
                        unbound.BindTo(spatialAnchor);

                        if (wardOrigin != null)
                        {
                            wardOrigin.position = _nativeAnchorHost.transform.position;
                            wardOrigin.rotation = _nativeAnchorHost.transform.rotation;
                        }

                        currentNativeAnchor = spatialAnchor;
                        activeAnchorUuid = guid.ToString();

                        Debug.Log($"[SHIRO SPATIAL] Successfully localized native OVRSpatialAnchor {guid} at {_nativeAnchorHost.transform.position}!");
                        return true;
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[SHIRO SPATIAL] Error restoring native spatial anchor: {ex.Message}");
            }

            return false;
        }

        public void SaveAlignmentToPrefs(string wardId)
        {
            if (wardOrigin == null) return;
            string key = $"WARD_ALIGN_{wardId}";
            PlayerPrefs.SetFloat($"{key}_PX", wardOrigin.position.x);
            PlayerPrefs.SetFloat($"{key}_PY", wardOrigin.position.y);
            PlayerPrefs.SetFloat($"{key}_PZ", wardOrigin.position.z);
            PlayerPrefs.SetFloat($"{key}_RY", wardOrigin.rotation.eulerAngles.y);
            PlayerPrefs.SetInt($"{key}_SAVED", 1);
            PlayerPrefs.Save();
            Debug.Log($"[SHIRO SPATIAL] Saved ward alignment for {wardId} to local PlayerPrefs.");
        }

        public bool LoadAlignmentFromPrefs(string wardId)
        {
            if (wardOrigin == null) return false;
            string key = $"WARD_ALIGN_{wardId}";
            if (!PlayerPrefs.HasKey($"{key}_SAVED")) return false;

            float px = PlayerPrefs.GetFloat($"{key}_PX", 0f);
            float py = PlayerPrefs.GetFloat($"{key}_PY", 0f);
            float pz = PlayerPrefs.GetFloat($"{key}_PZ", 0f);
            float ry = PlayerPrefs.GetFloat($"{key}_RY", 0f);

            wardOrigin.position = new Vector3(px, py, pz);
            wardOrigin.rotation = Quaternion.Euler(0, ry, 0);
            Debug.Log($"[SHIRO SPATIAL] Restored ward alignment for {wardId} from PlayerPrefs: Pos: {wardOrigin.position}, Yaw: {ry:F1} deg.");
            return true;
        }

        public void ResetAlignment()
        {
            DetachCurrentAnchor();

            if (wardOrigin != null)
            {
                float physicalFloorY = ShiroVRPointer.GetPhysicalFloorHeight();
                wardOrigin.position = new Vector3(0, physicalFloorY, 0);
                wardOrigin.rotation = Quaternion.identity;
            }

            string targetWard = ShiroNetworkManager.Instance != null ? ShiroNetworkManager.Instance.targetWardId : "WARD-005";
            string key = $"WARD_ALIGN_{targetWard}";
            PlayerPrefs.DeleteKey($"{key}_PX");
            PlayerPrefs.DeleteKey($"{key}_PY");
            PlayerPrefs.DeleteKey($"{key}_PZ");
            PlayerPrefs.DeleteKey($"{key}_RY");
            PlayerPrefs.DeleteKey($"{key}_SAVED");
            PlayerPrefs.DeleteKey($"WARD_ANCHOR_UUID_{targetWard}");
            PlayerPrefs.Save();

            Debug.Log($"[SHIRO SPATIAL] Ward alignment and saved anchor purged for {targetWard}. Reset to origin (0,0,0).");
        }
    }
}

