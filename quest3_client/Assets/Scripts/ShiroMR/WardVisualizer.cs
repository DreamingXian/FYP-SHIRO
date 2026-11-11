// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Ward Digital Twin 3D Visualizer (Beds, Obstacles, Anchors & Room Boundaries)
// =============================================================================
using System.Collections.Generic;
using UnityEngine;

namespace ShiroMR
{
    public class WardVisualizer : MonoBehaviour
    {
        public static WardVisualizer Instance { get; private set; }

        [Header("Visualization Mode")]
        [Tooltip("If enabled, renders 3D digital twin overlays (beds, obstacles, walls). If disabled, keeps room pure passthrough.")]
        public bool showDigitalTwinOverlay = true;

        [Header("Visual Material Colors")]
        public Color bedColor = new Color(0.2f, 0.5f, 0.9f, 0.40f);      // Translucent Hospital Blue
        public Color pillowColor = new Color(0.95f, 0.95f, 0.98f, 0.85f); // White Headrest
        public Color obstacleColor = new Color(0.6f, 0.65f, 0.7f, 0.35f);  // Translucent Pillar/Partition Gray
        public Color anchorColor = new Color(0.06f, 0.8f, 0.7f, 0.80f);    // Glowing Cyan Wall Beacon

        private GameObject _wardGeometryRoot;
        private readonly List<GameObject> _spawnedElements = new List<GameObject>();

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
            if (ShiroNetworkManager.Instance != null)
            {
                ShiroNetworkManager.Instance.OnWardInitialized += OnWardLoaded;
            }
        }

        private void OnDestroy()
        {
            if (ShiroNetworkManager.Instance != null)
            {
                ShiroNetworkManager.Instance.OnWardInitialized -= OnWardLoaded;
            }
        }

        private void OnWardLoaded(WardConfig ward, List<TrackedSubject> subjects)
        {
            BuildWard3D(ward);
        }

        public void BuildWard3D(WardConfig ward)
        {
            ClearWard3D();

            if (ward == null) return;

            Transform parentOrigin = WardSpatialManager.Instance != null ? WardSpatialManager.Instance.wardOrigin : this.transform;
            _wardGeometryRoot = new GameObject($"WardGeometry_{ward.ward_id}");
            _wardGeometryRoot.transform.SetParent(parentOrigin, false);

            // 1. Spawn Hospital Beds
            if (ward.beds != null)
            {
                foreach (var b in ward.beds)
                {
                    SpawnBed3D(b, _wardGeometryRoot.transform);
                }
            }

            // 2. Spawn Obstacles (Pillars, Washroom cubicles)
            if (ward.obstacles != null)
            {
                foreach (var obs in ward.obstacles)
                {
                    SpawnObstacle3D(obs, _wardGeometryRoot.transform);
                }
            }

            // 3. Spawn Wall Anchors
            if (ward.anchors != null)
            {
                foreach (var a in ward.anchors)
                {
                    SpawnAnchor3D(a, _wardGeometryRoot.transform);
                }
            }

            // 4. Spawn Entrance Door Frame (Glowing 3D Archway & Floor Threshold)
            if (ward.door != null)
            {
                SpawnDoor3D(ward, _wardGeometryRoot.transform);
            }

            // 5. Spawn Invisible Ward Bounding Walls & Floor Colliders for precise raycasting
            SpawnRoomWallsAndFloor3D(ward, _wardGeometryRoot.transform);

            _wardGeometryRoot.SetActive(showDigitalTwinOverlay);
        }

        private void SpawnDoor3D(WardConfig ward, Transform parent)
        {
            if (ward == null || ward.door == null) return;

            float roomW = ward.length_x > 0 ? ward.length_x : (ward.width > 0 ? ward.width : 5.0f);
            float roomL = ward.width_y > 0 ? ward.width_y : (ward.length > 0 ? ward.length : 6.0f);
            float dw = ward.door.width > 0 ? ward.door.width : 0.90f;
            float doorH = 2.10f; // Standard door height (2.1m)
            float postThickness = 0.08f;
            string wall = !string.IsNullOrEmpty(ward.door.wall) ? ward.door.wall.ToUpper() : "SOUTH";
            float doorPos = ward.door.x;

            Vector3 centerPos;
            Quaternion doorRot;

            if (wall == "SOUTH")
            {
                centerPos = new Vector3(doorPos + dw / 2f, 0, 0);
                doorRot = Quaternion.identity;
            }
            else if (wall == "NORTH")
            {
                centerPos = new Vector3(doorPos + dw / 2f, 0, roomL);
                doorRot = Quaternion.Euler(0, 180, 0);
            }
            else if (wall == "WEST")
            {
                centerPos = new Vector3(0, 0, doorPos + dw / 2f);
                doorRot = Quaternion.Euler(0, 90, 0);
            }
            else // EAST
            {
                centerPos = new Vector3(roomW, 0, doorPos + dw / 2f);
                doorRot = Quaternion.Euler(0, -90, 0);
            }

            GameObject doorRoot = new GameObject($"Door_{wall}");
            doorRoot.transform.SetParent(parent, false);
            doorRoot.transform.localPosition = centerPos;
            doorRoot.transform.localRotation = doorRot;

            // Frame color: Cyan / Emerald glowing portal
            Color doorColor = new Color(0.1f, 0.85f, 0.9f, 0.75f);

            // Left Post (local -X)
            GameObject leftPost = GameObject.CreatePrimitive(PrimitiveType.Cube);
            leftPost.name = "DoorPost_Left";
            leftPost.transform.SetParent(doorRoot.transform, false);
            leftPost.transform.localPosition = new Vector3(-dw / 2f, doorH / 2f, 0);
            leftPost.transform.localScale = new Vector3(postThickness, doorH, postThickness);
            var rL = leftPost.GetComponent<Renderer>();
            if (rL != null) rL.material.color = doorColor;

            // Right Post (local +X)
            GameObject rightPost = GameObject.CreatePrimitive(PrimitiveType.Cube);
            rightPost.name = "DoorPost_Right";
            rightPost.transform.SetParent(doorRoot.transform, false);
            rightPost.transform.localPosition = new Vector3(dw / 2f, doorH / 2f, 0);
            rightPost.transform.localScale = new Vector3(postThickness, doorH, postThickness);
            var rR = rightPost.GetComponent<Renderer>();
            if (rR != null) rR.material.color = doorColor;

            // Header / Lintel
            GameObject header = GameObject.CreatePrimitive(PrimitiveType.Cube);
            header.name = "DoorLintel";
            header.transform.SetParent(doorRoot.transform, false);
            header.transform.localPosition = new Vector3(0, doorH, 0);
            header.transform.localScale = new Vector3(dw + postThickness, postThickness, postThickness);
            var rH = header.GetComponent<Renderer>();
            if (rH != null) rH.material.color = doorColor;

            // Floor Threshold Mat
            GameObject mat = GameObject.CreatePrimitive(PrimitiveType.Cube);
            mat.name = "DoorThreshold";
            mat.transform.SetParent(doorRoot.transform, false);
            mat.transform.localPosition = new Vector3(0, 0.005f, 0);
            mat.transform.localScale = new Vector3(dw, 0.01f, 0.35f);
            var rM = mat.GetComponent<Renderer>();
            if (rM != null) rM.material.color = new Color(0.95f, 0.7f, 0.1f, 0.5f);

            // Floating Label
            GameObject labelObj = new GameObject("DoorLabel");
            labelObj.transform.SetParent(doorRoot.transform, false);
            labelObj.transform.localPosition = new Vector3(0, doorH + 0.30f, 0);
            labelObj.transform.localRotation = Quaternion.identity;
            var tm = labelObj.AddComponent<TextMesh>();
            tm.text = $"🚪 Door ({wall} Wall, {dw:F2}m)";
            tm.characterSize = 0.045f;
            tm.fontSize = 44;
            tm.alignment = TextAlignment.Center;
            tm.anchor = TextAnchor.MiddleCenter;
            tm.color = new Color(0.2f, 0.95f, 0.85f);

            _spawnedElements.Add(doorRoot);
        }

        private void SpawnRoomWallsAndFloor3D(WardConfig ward, Transform parent)
        {
            float w = ward.length_x > 0 ? ward.length_x : (ward.width > 0 ? ward.width : 5.0f);
            float l = ward.width_y > 0 ? ward.width_y : (ward.length > 0 ? ward.length : 6.0f);
            float wallH = 2.80f; // Standard hospital ceiling height
            float wallThickness = 0.04f;

            GameObject wallsRoot = new GameObject("WardBoundaryColliders");
            wallsRoot.transform.SetParent(parent, false);

            // South Wall (Y = 0 in ward coordinates -> Z = 0 in Unity)
            CreateWallCollider(wallsRoot.transform, "Wall_South", new Vector3(w / 2f, wallH / 2f, 0), new Vector3(w, wallH, wallThickness));
            // North Wall (Z = length)
            CreateWallCollider(wallsRoot.transform, "Wall_North", new Vector3(w / 2f, wallH / 2f, l), new Vector3(w, wallH, wallThickness));
            // West Wall (X = 0)
            CreateWallCollider(wallsRoot.transform, "Wall_West", new Vector3(0, wallH / 2f, l / 2f), new Vector3(wallThickness, wallH, l));
            // East Wall (X = width)
            CreateWallCollider(wallsRoot.transform, "Wall_East", new Vector3(w, wallH / 2f, l / 2f), new Vector3(wallThickness, wallH, l));
            // Floor (Y = 0)
            GameObject floorObj = CreateWallCollider(wallsRoot.transform, "Floor_Collider", new Vector3(w / 2f, -0.01f, l / 2f), new Vector3(w, 0.02f, l));
            if (floorObj != null) floorObj.layer = 2; // Built-in "Ignore Raycast" so virtual floor never intercepts MR pointers

            _spawnedElements.Add(wallsRoot);
        }

        private GameObject CreateWallCollider(Transform parent, string name, Vector3 pos, Vector3 size)
        {
            GameObject wallObj = new GameObject(name);
            wallObj.transform.SetParent(parent, false);
            wallObj.transform.localPosition = pos;
            BoxCollider col = wallObj.AddComponent<BoxCollider>();
            col.size = size;
            return wallObj;
        }

        public void SetCollidersEnabled(bool enableColliders)
        {
            if (_wardGeometryRoot != null)
            {
                Collider[] cols = _wardGeometryRoot.GetComponentsInChildren<Collider>(true);
                foreach (var c in cols)
                {
                    c.enabled = enableColliders;
                }
            }
        }

        public void ToggleOverlay(bool visible)
        {
            showDigitalTwinOverlay = visible;
            if (_wardGeometryRoot != null)
            {
                _wardGeometryRoot.SetActive(visible);
                SetCollidersEnabled(visible);
            }
        }

        private void ClearWard3D()
        {
            if (_wardGeometryRoot != null)
            {
                Destroy(_wardGeometryRoot);
                _wardGeometryRoot = null;
            }
            _spawnedElements.Clear();
        }

        private void SpawnBed3D(WardBed b, Transform parent)
        {
            float bedW = b.width > 0 ? b.width : 0.90f;
            float bedL = b.length > 0 ? b.length : 2.00f;
            int rot = b.rotation_deg;
            float mattressHeight = 0.50f;

            // In Ward 2D Editor, (b.x, b.y) is the bottom-left corner of the bounding box.
            // Bounding box spans vary by rotation:
            bool isRotatedHorizontal = (rot == 90 || rot == 270);
            float spanX = isRotatedHorizontal ? bedL : bedW;
            float spanY = isRotatedHorizontal ? bedW : bedL;

            float centerX = b.x + spanX / 2.0f;
            float centerY = b.y + spanY / 2.0f;

            // Root anchor for this bed positioned at bed center and rotated to match ward rotation
            GameObject bedAnchor = new GameObject($"Bed_{b.bed_code}");
            bedAnchor.transform.SetParent(parent, false);
            bedAnchor.transform.localPosition = new Vector3(centerX, 0f, centerY);
            bedAnchor.transform.localRotation = Quaternion.Euler(0, rot, 0);

            // 1. Mattress (Preserve BoxCollider for real-time laser hit detection)
            GameObject mattress = GameObject.CreatePrimitive(PrimitiveType.Cube);
            mattress.name = "Mattress";
            mattress.transform.SetParent(bedAnchor.transform, false);
            mattress.transform.localPosition = new Vector3(0, mattressHeight / 2.0f, 0);
            mattress.transform.localScale = new Vector3(bedW, mattressHeight, bedL);
            var ren = mattress.GetComponent<Renderer>();
            if (ren != null) ren.material.color = bedColor;

            // 2. Headboard at local +Z (Preserve BoxCollider)
            GameObject headboard = GameObject.CreatePrimitive(PrimitiveType.Cube);
            headboard.name = "Headboard";
            headboard.transform.SetParent(bedAnchor.transform, false);
            headboard.transform.localPosition = new Vector3(0, 0.40f, (bedL / 2.0f) - 0.03f);
            headboard.transform.localScale = new Vector3(bedW + 0.04f, 0.65f, 0.06f);
            var hbRen = headboard.GetComponent<Renderer>();
            if (hbRen != null) hbRen.material.color = new Color(0.2f, 0.35f, 0.5f, 0.9f);

            // 3. Pillow near the headboard (local +Z)
            GameObject pillow = GameObject.CreatePrimitive(PrimitiveType.Cube);
            pillow.name = "Pillow";
            pillow.transform.SetParent(bedAnchor.transform, false);
            pillow.transform.localPosition = new Vector3(0, mattressHeight + 0.05f, (bedL / 2.0f) - 0.28f);
            pillow.transform.localScale = new Vector3(bedW * 0.70f, 0.10f, 0.32f);
            Destroy(pillow.GetComponent<Collider>());
            var pRen = pillow.GetComponent<Renderer>();
            if (pRen != null) pRen.material.color = pillowColor;

            // 4. Floating Bed Label
            GameObject labelObj = new GameObject("BedLabel");
            labelObj.transform.SetParent(bedAnchor.transform, false);
            labelObj.transform.localPosition = new Vector3(0, mattressHeight + 0.50f, 0);
            labelObj.transform.localRotation = Quaternion.Euler(0, 180f, 0);
            var textMesh = labelObj.AddComponent<TextMesh>();
            textMesh.text = b.bed_code;
            textMesh.characterSize = 0.05f;
            textMesh.fontSize = 48;
            textMesh.alignment = TextAlignment.Center;
            textMesh.anchor = TextAnchor.MiddleCenter;
            textMesh.color = new Color(0.1f, 0.85f, 0.6f);

            _spawnedElements.Add(bedAnchor);
        }

        private void SpawnObstacle3D(WardObstacle obs, Transform parent)
        {
            float centerX = obs.x + obs.width / 2.0f;
            float centerY = obs.y + obs.length / 2.0f;
            float h = obs.height > 0 ? obs.height : 2.0f;

            GameObject obsObj = GameObject.CreatePrimitive(PrimitiveType.Cube);
            obsObj.name = $"Obstacle_{obs.label}";
            obsObj.transform.SetParent(parent, false);
            obsObj.transform.localPosition = new Vector3(centerX, h / 2.0f, centerY);
            obsObj.transform.localScale = new Vector3(obs.width, h, obs.length);

            var ren = obsObj.GetComponent<Renderer>();
            if (ren != null) ren.material.color = obstacleColor;

            _spawnedElements.Add(obsObj);
        }

        private void SpawnAnchor3D(WardAnchor a, Transform parent)
        {
            GameObject anchorObj = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            anchorObj.name = $"Anchor_{a.anchor_id}";
            anchorObj.transform.SetParent(parent, false);
            anchorObj.transform.localPosition = new Vector3(a.x, a.z, a.y);
            anchorObj.transform.localScale = new Vector3(0.18f, 0.18f, 0.18f); // 18cm comfortable targeting sphere

            var ren = anchorObj.GetComponent<Renderer>();
            if (ren != null) ren.material.color = anchorColor;

            _spawnedElements.Add(anchorObj);
        }
    }
}

