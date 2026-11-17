// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Depth test view (feature 8D, step 8D-0).
//
// Switched on from the System tab ("Depth test"). While on, it casts a grid of
// 40 × 30 rays into the depth sensor's view five times per second
// (EnvironmentRaycastManager, Meta MR Utility Kit), gives the 3D points to the
// person detector (ShiroPersonDetection.cs) and shows:
//   - the depth points, coloured by height above the floor (blue = floor);
//   - every object found: a vertical line from the floor to its measured height
//     and a label "#id height · still / PERSON? / not person";
//   - a status line in front of the wearer: depth state, hits, objects, frame
//     rate and processing time.
// "Movement required" (System tab) can be switched off to test with height
// only, for example with a clothes rack that cannot walk.
// Nothing is recorded: points live for one update only, and no camera image is
// used. Over Quest Link, depth needs "Spatial Data over Meta Quest Link" in the
// Meta Quest Link app (Settings → Developer).
// Creates itself when the scene loads (off): nothing has to be added to the scene.
// =============================================================================
using System.Collections.Generic;
using System.Diagnostics;
using Meta.XR;
using ShiroMR.Detection;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace ShiroMR
{
    public class ShiroDepthProbe : MonoBehaviour
    {
        public static ShiroDepthProbe Instance { get; private set; }

        private const string PrefMovement = "Shiro_DetectMovementRequired";
        private const int Cols = 40;
        private const int Rows = 30;
        private const float Interval = 0.2f;   // s: five updates per second
        private const float MaxRange = 6f;     // m
        private const float PointSize = 0.012f;

        public bool IsRunning { get; private set; }
        public bool MovementRequired => _detector.Settings.MovementRequired;
        public PersonDetector Detector => _detector;
        public string StatusText { get; private set; } = "off";

        private readonly PersonDetector _detector = new PersonDetector();
        private readonly List<DepthPoint> _points = new List<DepthPoint>(Cols * Rows);
        private readonly Vector3[] _hitPoints = new Vector3[Cols * Rows];
        private readonly bool[] _hasHit = new bool[Cols * Rows];
        private EnvironmentRaycastManager _raycaster;
        private float _timer;
        private float _fps = 72f;
        private float _floorY;

        // Visuals
        private Material _mat;
        private Mesh _pointMesh;
        private GameObject _pointObj;
        private TextMesh _statusText;
        private readonly List<Marker> _markers = new List<Marker>();

        private class Marker
        {
            public GameObject root;
            public LineRenderer line;
            public TextMesh label;
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Bootstrap()
        {
            if (Instance == null && FindAnyObjectByType<ShiroDepthProbe>() == null)
            {
                new GameObject("ShiroDepthProbe").AddComponent<ShiroDepthProbe>();
            }
        }

        private void Awake()
        {
            if (Instance != null && Instance != this) { Destroy(gameObject); return; }
            Instance = this;
            DontDestroyOnLoad(gameObject);
            _detector.Settings.MovementRequired = PlayerPrefs.GetInt(PrefMovement, 1) == 1;
        }

        public void SetMovementRequired(bool on)
        {
            _detector.Settings.MovementRequired = on;
            PlayerPrefs.SetInt(PrefMovement, on ? 1 : 0);
            PlayerPrefs.Save();
        }

        public void SetRunning(bool on)
        {
            if (on == IsRunning) return;
            IsRunning = on;
            _detector.Reset();
            if (on)
            {
                EnsureVisuals();
                EnsureRaycaster();
                if (_raycaster != null) _raycaster.enabled = true;
                StatusText = "starting";
            }
            else
            {
                if (_raycaster != null) _raycaster.enabled = false;
                StatusText = "off";
            }
            if (_pointObj != null) _pointObj.SetActive(on);
            if (_statusText != null) _statusText.gameObject.SetActive(on);
            foreach (var m in _markers) m.root.SetActive(false);
        }

        private void EnsureRaycaster()
        {
            if (_raycaster != null) return;
            _raycaster = FindAnyObjectByType<EnvironmentRaycastManager>();
            if (_raycaster == null) _raycaster = gameObject.AddComponent<EnvironmentRaycastManager>();
        }

        private void Update()
        {
            float dt = Time.unscaledDeltaTime;
            if (dt > 0f) _fps += (1f / dt - _fps) * 0.05f;
            if (!IsRunning) return;

            Camera cam = Camera.main;
            if (cam == null) return;
            PlaceStatus(cam);

            _timer += Time.deltaTime;
            if (_timer < Interval) return;
            _timer = 0f;

            if (!EnvironmentRaycastManager.IsSupported)
            {
                SetStatus("Depth NOT SUPPORTED here. Over Link: Meta Quest Link app → Settings → Developer → Spatial Data over Meta Quest Link.");
                return;
            }

            var watch = Stopwatch.StartNew();
            int hits = 0, notReady = 0, outside = 0;
            _points.Clear();

            // Cast the grid; remember for each column the highest row the sensor still sees
            for (int i = 0; i < _hasHit.Length; i++) _hasHit[i] = false;
            var topRow = new int[Cols];
            for (int c = 0; c < Cols; c++) topRow[c] = -1;
            for (int r = 0; r < Rows; r++)
            {
                for (int c = 0; c < Cols; c++)
                {
                    Ray ray = cam.ViewportPointToRay(new Vector3((c + 0.5f) / Cols, (r + 0.5f) / Rows, 0f));
                    _raycaster.Raycast(ray, out EnvironmentRaycastHit hit, MaxRange);
                    switch (hit.status)
                    {
                        case EnvironmentRaycastHitStatus.Hit:
                            _hitPoints[r * Cols + c] = hit.point;
                            _hasHit[r * Cols + c] = true;
                            hits++;
                            topRow[c] = r;
                            break;
                        case EnvironmentRaycastHitStatus.NotReady: notReady++; break;
                        case EnvironmentRaycastHitStatus.HitPointOutsideOfCameraFrustum: outside++; break;
                        default: topRow[c] = r; break; // seen, nothing hit (far away)
                    }
                }
            }

            if (hits == 0)
            {
                SetStatus(notReady > 0 ? "Depth starting… (look around for a few seconds)" : "Depth on, but no surface found in range");
                return;
            }

            for (int r = 0; r < Rows; r++)
                for (int c = 0; c < Cols; c++)
                {
                    int i = r * Cols + c;
                    if (!_hasHit[i]) continue;
                    Vector3 p = _hitPoints[i];
                    _points.Add(new DepthPoint(p.x, p.y, p.z, r >= topRow[c] - 1));
                }

            _floorY = ShiroVRPointer.GetPhysicalFloorHeight();
            Vector3 head = cam.transform.position;
            _detector.Process(_points, _floorY, head.x, head.z, Time.realtimeSinceStartup);
            watch.Stop();

            DrawPoints(cam);
            DrawTracks(cam);

            int persons = 0;
            foreach (var t in _detector.Tracks) if (t.Kind == TrackKind.PersonCandidate) persons++;
            SetStatus($"Depth OK · {hits}/{Cols * Rows} hits{(outside > 0 ? $" ({outside} outside sensor)" : "")} · " +
                      $"{_detector.Tracks.Count} objects, {persons} PERSON? · {_fps:0} fps · {watch.Elapsed.TotalMilliseconds:0.0} ms\n" +
                      $"Movement required: {(MovementRequired ? "ON" : "OFF (TEST: height only)")} · floor y {_floorY:0.00} m");
        }

        private void SetStatus(string text)
        {
            StatusText = text;
            if (_statusText != null) _statusText.text = text;
        }

        // ----- Visuals -----

        private void EnsureVisuals()
        {
            if (_mat != null) return;
            Shader sh = Shader.Find("Sprites/Default");
            _mat = new Material(sh);

            _pointObj = new GameObject("DepthProbePoints");
            _pointObj.transform.SetParent(transform, false);
            _pointMesh = new Mesh { name = "DepthProbePoints" };
            _pointMesh.MarkDynamic();
            _pointObj.AddComponent<MeshFilter>().sharedMesh = _pointMesh;
            _pointObj.AddComponent<MeshRenderer>().sharedMaterial = _mat;

            var statusObj = new GameObject("DepthProbeStatus");
            statusObj.transform.SetParent(transform, false);
            _statusText = statusObj.AddComponent<TextMesh>();
            _statusText.fontSize = 40;
            _statusText.characterSize = 0.004f;
            _statusText.anchor = TextAnchor.MiddleCenter;
            _statusText.alignment = TextAlignment.Center;
            _statusText.color = new Color(0.85f, 0.95f, 1f, 0.95f);
        }

        private void PlaceStatus(Camera cam)
        {
            if (_statusText == null) return;
            Transform t = cam.transform;
            Vector3 fwd = Vector3.ProjectOnPlane(t.forward, Vector3.up).normalized;
            if (fwd.sqrMagnitude < 0.01f) fwd = Vector3.forward;
            _statusText.transform.position = t.position + fwd * 1.2f + Vector3.down * 0.45f;
            _statusText.transform.rotation = Quaternion.LookRotation(fwd);
        }

        private void DrawPoints(Camera cam)
        {
            int n = _points.Count;
            var verts = new Vector3[n * 4];
            var cols = new Color[n * 4];
            var tris = new int[n * 6];
            Vector3 right = cam.transform.right * PointSize;
            Vector3 up = cam.transform.up * PointSize;
            for (int i = 0; i < n; i++)
            {
                var p = _points[i];
                Vector3 c = new Vector3(p.x, p.y, p.z);
                int v = i * 4;
                verts[v] = c - right - up;
                verts[v + 1] = c - right + up;
                verts[v + 2] = c + right + up;
                verts[v + 3] = c + right - up;
                Color col = HeightColour(p.y - _floorY);
                cols[v] = cols[v + 1] = cols[v + 2] = cols[v + 3] = col;
                int k = i * 6;
                tris[k] = v; tris[k + 1] = v + 1; tris[k + 2] = v + 2;
                tris[k + 3] = v; tris[k + 4] = v + 2; tris[k + 5] = v + 3;
            }
            _pointMesh.Clear();
            _pointMesh.vertices = verts;
            _pointMesh.colors = cols;
            _pointMesh.triangles = tris;
            _pointMesh.RecalculateBounds();
        }

        private Color HeightColour(float h)
        {
            var s = _detector.Settings;
            if (h < s.MinPointHeight) return new Color(0.2f, 0.4f, 1f, 0.6f);   // floor
            if (h > s.MaxPointHeight) return new Color(0.5f, 0.5f, 0.5f, 0.6f); // ceiling
            float k = Mathf.Clamp01(h / 2f);
            return new Color(k, 1f - k * 0.6f, 0.2f, 0.9f);                    // green (low) → orange (high)
        }

        private void DrawTracks(Camera cam)
        {
            var tracks = _detector.Tracks;
            while (_markers.Count < tracks.Count) _markers.Add(NewMarker());
            for (int i = 0; i < _markers.Count; i++)
            {
                var m = _markers[i];
                if (i >= tracks.Count) { m.root.SetActive(false); continue; }
                var t = tracks[i];
                m.root.SetActive(true);

                Color col = t.Kind == TrackKind.PersonCandidate ? new Color(0.1f, 1f, 0.4f)
                          : t.Kind == TrackKind.StillObject ? new Color(1f, 0.85f, 0.2f)
                          : new Color(0.6f, 0.6f, 0.6f);
                Vector3 bottom = new Vector3(t.X, _floorY, t.Z);
                Vector3 top = new Vector3(t.X, _floorY + t.Height, t.Z);
                m.line.SetPosition(0, bottom);
                m.line.SetPosition(1, top);
                m.line.startColor = m.line.endColor = col;

                string kind = t.Kind == TrackKind.PersonCandidate ? "PERSON?"
                            : t.Kind == TrackKind.StillObject ? "still"
                            : "not person";
                m.label.text = $"#{t.Id} {t.Height:0.00} m{(t.HeightMaybeCut ? "+" : "")}\n{kind} · moved {t.MaxDisplacement:0.0} m";
                m.label.color = col;
                m.label.transform.position = top + Vector3.up * 0.12f;
                Vector3 look = m.label.transform.position - cam.transform.position;
                look.y = 0f;
                if (look.sqrMagnitude > 0.001f) m.label.transform.rotation = Quaternion.LookRotation(look);
            }
        }

        private Marker NewMarker()
        {
            var root = new GameObject("DepthProbeObject");
            root.transform.SetParent(transform, false);
            var line = root.AddComponent<LineRenderer>();
            line.sharedMaterial = _mat;
            line.positionCount = 2;
            line.useWorldSpace = true;
            line.startWidth = line.endWidth = 0.025f;

            var labelObj = new GameObject("Label");
            labelObj.transform.SetParent(root.transform, false);
            var label = labelObj.AddComponent<TextMesh>();
            label.fontSize = 40;
            label.characterSize = 0.004f;
            label.anchor = TextAnchor.LowerCenter;
            label.alignment = TextAlignment.Center;
            return new Marker { root = root, line = line, label = label };
        }

        private void OnDestroy()
        {
            if (_pointMesh != null) Destroy(_pointMesh);
            if (_mat != null) Destroy(_mat);
        }
    }
}
