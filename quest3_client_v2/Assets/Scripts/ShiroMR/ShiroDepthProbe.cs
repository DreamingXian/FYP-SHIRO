// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Depth test view (feature 8D, step 8D-0).
//
// Switched on from the System tab ("Depth test"). While on, it casts a grid of
// 40 × 30 rays into the depth sensor's view five times per second, spread over
// five frames (240 rays per frame) so no frame carries them all
// (EnvironmentRaycastManager, Meta MR Utility Kit). The grid shifts by a random
// fraction of a ray each time and the last two updates are combined, so thin or
// hollow objects get twice as many points. The floor height is measured from the
// points (the headset's floor level is only a guess); when the ward is aligned,
// points outside its walls are left out. The points go to the person detector
// (ShiroPersonDetection.cs), and the view shows:
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
        private const int RowsPerFrame = 6;     // 240 rays per frame: a sweep takes 5 frames

        /// <summary>The depth view (points, objects, status line) is shown.</summary>
        public bool IsRunning { get; private set; }
        /// <summary>Depth sensing runs: for the view, or because person linking needs it.</summary>
        public bool IsSensing => IsRunning || _sensingRequested;
        /// <summary>Raised after every detection update (five times per second while sensing).</summary>
        public event System.Action OnDetectionUpdated;
        /// <summary>Optional text added to an object's label (for example the linked patient).</summary>
        public System.Func<int, string> ExtraLabel;
        private bool _sensingRequested;
        public bool MovementRequired => _detector.Settings.MovementRequired;
        public PersonDetector Detector => _detector;
        /// <summary>The floor height (world y) of the last detection update.</summary>
        public float FloorY => _floorY;
        public string StatusText { get; private set; } = "off";

        private readonly PersonDetector _detector = new PersonDetector();
        private readonly List<DepthPoint> _points = new List<DepthPoint>(Cols * Rows);
        private readonly List<DepthPoint> _previous = new List<DepthPoint>(Cols * Rows);
        private readonly List<DepthPoint> _combined = new List<DepthPoint>(Cols * Rows * 2);
        private readonly List<DepthPoint> _rowPoints = new List<DepthPoint>(Cols * RowsPerFrame);
        private readonly FloorEstimator _floor = new FloorEstimator();
        private readonly System.Random _rnd = new System.Random();
        private int _outsideWard;
        private readonly int[] _topRow = new int[Cols];
        private int _sweepRow = -1;            // next row of the sweep in progress; -1 = none
        private int _sweepHits, _sweepNotReady, _sweepOutside;
        private float _sweepJx, _sweepJy, _sweepMaxFrameMs;
        private readonly Vector3[] _hitPoints = new Vector3[Cols * Rows];
        private readonly bool[] _hasHit = new bool[Cols * Rows];
        private readonly List<ExcludeSegment> _exclude = new List<ExcludeSegment>(4);
        private OVRCameraRig _rig;
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
            // The memory of empty space is fed row by row while sweeping (spreads the work over frames)
            _detector.EmptySpaceFedByCaller = true;
        }

        public void SetMovementRequired(bool on)
        {
            _detector.Settings.MovementRequired = on;
            PlayerPrefs.SetInt(PrefMovement, on ? 1 : 0);
            PlayerPrefs.Save();
        }

        /// <summary>Shows or hides the depth view (sensing starts with it when needed).</summary>
        public void SetRunning(bool on)
        {
            if (on == IsRunning) return;
            bool wasSensing = IsSensing;
            IsRunning = on;
            if (on) EnsureVisuals();
            if (_pointObj != null) _pointObj.SetActive(on);
            if (_statusText != null) _statusText.gameObject.SetActive(on);
            foreach (var m in _markers) m.root.SetActive(false);
            SensingChanged(wasSensing);
        }

        /// <summary>Person linking asks for depth sensing (without the view).</summary>
        public void SetSensingRequested(bool on)
        {
            if (on == _sensingRequested) return;
            bool wasSensing = IsSensing;
            _sensingRequested = on;
            SensingChanged(wasSensing);
        }

        private void SensingChanged(bool wasSensing)
        {
            if (IsSensing == wasSensing) return;
            _detector.Reset();
            _floor.Reset();
            _sweepRow = -1;
            _previous.Clear();
            if (IsSensing)
            {
                EnsureRaycaster();
                if (_raycaster != null) _raycaster.enabled = true;
                StatusText = "starting";
            }
            else
            {
                if (_raycaster != null) _raycaster.enabled = false;
                StatusText = "off";
            }
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
            HookTrackingEvents();
            if (!IsSensing) return;

            Camera cam = Camera.main;
            if (cam == null) return;
            PlaceStatus(cam);

            _timer += Time.deltaTime;

            if (!EnvironmentRaycastManager.IsSupported)
            {
                SetStatus("Depth NOT SUPPORTED here. Over Link: Meta Quest Link app → Settings → Developer → Spatial Data over Meta Quest Link.");
                return;
            }

            // As an app on the headset, depth starts only after "spatial data" is allowed
            if (ShiroPermissions.SpatialDataState == ShiroPermissions.State.Refused || ShiroPermissions.SpatialDataState == ShiroPermissions.State.Asking)
            {
                SetStatus("Depth waits for the spatial data permission: hand slate → System → 🛡 Spatial data.");
                return;
            }

            // A sweep of the grid is spread over several frames (RowsPerFrame rows each),
            // so no single frame carries all the rays
            if (_sweepRow < 0)
            {
                if (_timer < Interval) return;
                _timer = 0f;
                _sweepRow = 0;
                _sweepHits = _sweepNotReady = _sweepOutside = 0;
                _sweepMaxFrameMs = 0f;
                _sweepJx = (float)_rnd.NextDouble() - 0.5f; // shift within one ray spacing
                _sweepJy = (float)_rnd.NextDouble() - 0.5f;
                for (int i = 0; i < _hasHit.Length; i++) _hasHit[i] = false;
                for (int c = 0; c < Cols; c++) _topRow[c] = -1;
                Vector3 eye = cam.transform.position;
                _detector.EmptySpace.BeginUpdate(eye.x, eye.z);
            }

            var watch = Stopwatch.StartNew();
            int firstRow = _sweepRow;
            int lastRow = Mathf.Min(Rows, _sweepRow + RowsPerFrame);
            for (int r = _sweepRow; r < lastRow; r++)
            {
                for (int c = 0; c < Cols; c++)
                {
                    Ray ray = cam.ViewportPointToRay(new Vector3(Mathf.Clamp01((c + 0.5f + _sweepJx) / Cols), Mathf.Clamp01((r + 0.5f + _sweepJy) / Rows), 0f));
                    _raycaster.Raycast(ray, out EnvironmentRaycastHit hit, MaxRange);
                    switch (hit.status)
                    {
                        case EnvironmentRaycastHitStatus.Hit:
                            _hitPoints[r * Cols + c] = hit.point;
                            _hasHit[r * Cols + c] = true;
                            _sweepHits++;
                            _topRow[c] = r; // remember for each column the highest row the sensor still sees
                            break;
                        case EnvironmentRaycastHitStatus.NotReady: _sweepNotReady++; break;
                        case EnvironmentRaycastHitStatus.HitPointOutsideOfCameraFrustum: _sweepOutside++; break;
                        default: _topRow[c] = r; break; // seen, nothing hit (far away)
                    }
                }
            }
            _sweepRow = lastRow;
            AddRowsToEmptySpace(cam, firstRow, lastRow);
            float frameMs = (float)watch.Elapsed.TotalMilliseconds;
            if (_sweepRow < Rows)
            {
                if (frameMs > _sweepMaxFrameMs) _sweepMaxFrameMs = frameMs;
                return;
            }
            _sweepRow = -1; // sweep complete: detect in this frame
            _detector.EmptySpace.EndUpdate(Time.realtimeSinceStartup);

            if (_sweepHits == 0)
            {
                SetStatus(_sweepNotReady > 0 ? "Depth starting… (look around for a few seconds)" : "Depth on, but no surface found in range");
                return;
            }

            _points.Clear();
            for (int r = 0; r < Rows; r++)
                for (int c = 0; c < Cols; c++)
                {
                    int i = r * Cols + c;
                    if (!_hasHit[i]) continue;
                    Vector3 p = _hitPoints[i];
                    _points.Add(new DepthPoint(p.x, p.y, p.z, r >= _topRow[c] - 1));
                }

            _floorY = _floor.Update(_points, ShiroVRPointer.GetPhysicalFloorHeight());

            // This update and the previous one together; inside the ward's walls when aligned
            _combined.Clear();
            _outsideWard = 0;
            AddInsideWard(_points);
            AddInsideWard(_previous);
            _previous.Clear();
            _previous.AddRange(_points);

            Vector3 head = cam.transform.position;
            _detector.Process(_combined, _floorY, head.x, head.y, head.z, Time.realtimeSinceStartup, OwnArms(cam));
            if (IsRunning)
            {
                DrawPoints(cam);
                DrawTracks(cam);
            }
            OnDetectionUpdated?.Invoke();
            frameMs = (float)watch.Elapsed.TotalMilliseconds;
            if (frameMs > _sweepMaxFrameMs) _sweepMaxFrameMs = frameMs;

            int persons = 0;
            foreach (var t in _detector.Tracks) if (t.Kind == TrackKind.PersonCandidate) persons++;
            SetStatus($"Depth OK · {_sweepHits}/{Cols * Rows} hits{(_sweepOutside > 0 ? $" ({_sweepOutside} outside sensor)" : "")} · " +
                      $"{_detector.Tracks.Count} objects, {persons} PERSON? · {_fps:0} fps · max {_sweepMaxFrameMs:0.0} ms per frame\n" +
                      $"Movement required: {(MovementRequired ? "ON" : "OFF (TEST: height only)")} · " +
                      $"floor {(_floor.Floor.HasValue ? $"measured y {_floorY:0.00} m" : $"NOT SEEN, guess y {_floorY:0.00} m (look at the floor)")}" +
                      $"{(_wardWalls ? $" · {_outsideWard} points outside the ward left out" : "")}" +
                      RestartText());
        }

        private string RestartText()
        {
            // The detector also restarts by itself on a head jump faster than a person moves
            if (_detector.LastRestartReason != null && _detector.LastRestartReason != _restartNote)
            {
                _restartNote = _detector.LastRestartReason;
                _restartNoteUntil = Time.realtimeSinceStartup + 5f;
            }
            return _restartNote != null && Time.realtimeSinceStartup < _restartNoteUntil
                ? $"\nRESTARTED: {_restartNote}"
                : "";
        }

        private bool _wardWalls;

        /// <summary>
        /// The wearer's own arms, left out of detection: a capsule from each shoulder
        /// (estimated from the head) to the tracked hand or controller, 0.15 m thick.
        /// </summary>
        private List<ExcludeSegment> OwnArms(Camera cam)
        {
            _exclude.Clear();
            if (_rig == null) _rig = FindAnyObjectByType<OVRCameraRig>();
            if (_rig == null) return _exclude;
            Transform head = cam.transform;
            Vector3 right = Vector3.ProjectOnPlane(head.right, Vector3.up).normalized;
            Vector3 neck = head.position + Vector3.down * 0.25f;
            AddArm(neck - right * 0.18f, _rig.leftHandAnchor);
            AddArm(neck + right * 0.18f, _rig.rightHandAnchor);
            return _exclude;
        }

        /// <summary>
        /// Adds the rays of the rows just swept to the detector's memory of empty space, with the
        /// eye where it was when they were cast (spreads the work over the frames of a sweep).
        /// </summary>
        private void AddRowsToEmptySpace(Camera cam, int firstRow, int lastRow)
        {
            if (!_detector.Settings.RequireSpaceEvidence) return;
            _rowPoints.Clear();
            for (int r = firstRow; r < lastRow; r++)
                for (int c = 0; c < Cols; c++)
                {
                    int i = r * Cols + c;
                    if (!_hasHit[i]) continue;
                    Vector3 p = _hitPoints[i];
                    _rowPoints.Add(new DepthPoint(p.x, p.y, p.z));
                }
            if (_rowPoints.Count == 0) return;
            Vector3 eye = cam.transform.position;
            float floorY = _floor.Floor ?? ShiroVRPointer.GetPhysicalFloorHeight();
            _detector.EmptySpace.AddRays(_rowPoints, 0, _rowPoints.Count, floorY, eye.x, eye.y, eye.z, OwnArms(cam));
        }

        private void AddArm(Vector3 shoulder, Transform hand)
        {
            if (hand == null) return;
            Vector3 h = hand.position;
            if ((h - shoulder).sqrMagnitude > 1.2f * 1.2f) return; // not a real hand position
            _exclude.Add(new ExcludeSegment(shoulder.x, shoulder.y, shoulder.z, h.x, h.y, h.z, 0.15f));
        }

        /// <summary>Adds the points that are inside the aligned ward (0.15 m inside its walls), or all of them.</summary>
        private void AddInsideWard(List<DepthPoint> points)
        {
            var spatial = WardSpatialManager.Instance;
            var tool = WardAlignmentTool.Instance;
            WardConfig ward = spatial != null ? spatial.GetCachedWardConfig() : null;
            _wardWalls = ward != null && ward.length_x > 0f && ward.width_y > 0f &&
                         spatial.wardOrigin != null && tool != null && tool.isAligned;
            if (!_wardWalls) { _combined.AddRange(points); return; }

            const float margin = 0.15f;
            Transform origin = spatial.wardOrigin;
            foreach (var p in points)
            {
                Vector3 local = origin.InverseTransformPoint(new Vector3(p.x, p.y, p.z));
                if (local.x < margin || local.z < margin || local.x > ward.length_x - margin || local.z > ward.width_y - margin)
                {
                    _outsideWard++;
                    continue;
                }
                _combined.Add(p);
            }
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
                m.line.startWidth = m.line.endWidth = t.Kind == TrackKind.NotPerson ? 0.008f : 0.025f;

                string kind = t.Kind == TrackKind.PersonCandidate ? "PERSON?"
                            : t.Kind == TrackKind.StillObject ? "still"
                            : "not person";
                m.label.text = t.Kind == TrackKind.NotPerson
                    ? $"{t.Height:0.00} m · {t.NotPersonReason}"
                    : $"#{t.Id} {t.Height:0.00} m{(t.HeightMaybeCut ? "+" : "")}\n{kind} · {MovedText(t)}" +
                      $"{(t.Merged ? "\nseen as one with the thing next to it: kept in place" : "")}{LinkedText(t.Id)}";
                m.label.characterSize = t.Kind == TrackKind.NotPerson ? 0.0025f : 0.004f;
                m.label.color = col;
                m.label.transform.position = top + Vector3.up * 0.12f;
                Vector3 look = m.label.transform.position - cam.transform.position;
                look.y = 0f;
                if (look.sqrMagnitude > 0.001f) m.label.transform.rotation = Quaternion.LookRotation(look);
            }
        }

        private string LinkedText(int trackId)
        {
            string extra = ExtraLabel?.Invoke(trackId);
            return string.IsNullOrEmpty(extra) ? "" : $"\n{extra}";
        }

        /// <summary>Why the object counts as moved, or how far it is from where it started.</summary>
        private static string MovedText(Track t)
        {
            if (t.MovedBy == MovedEvidence.Walked)
                return $"walked {t.MovedDistance:0.0} m ({t.Steps} step{(t.Steps == 1 ? "" : "s")})" +
                       (t.LastStepProof != null ? $"\n{t.LastStepProof}" : "");
            if (t.MovedBy == MovedEvidence.SeenMovingHere) return "seen moving here before";
            if (t.Waiting != null) return t.Waiting;
            return t.Steps > 0 ? $"path {t.PathLength:0.0} m" : "not moved";
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
            if (_trackingEventsHooked)
            {
                OVRManager.HMDMounted -= OnHeadsetOn;
                OVRManager.HMDUnmounted -= OnHeadsetOff;
                OVRManager.TrackingLost -= OnTrackingLost;
                OVRManager.TrackingAcquired -= OnTrackingBack;
                if (_display != null) _display.RecenteredPose -= OnRecentred;
            }
        }

        // ----- Tracking-space changes: everything seen before is forgotten -----
        // Taking the headset off and putting it on, losing tracking or recentring can shift
        // the whole tracking space; every object would then seem to move at once, and the
        // floor height would be wrong. Detection (and the floor measurement) starts again.

        private bool _trackingEventsHooked;
        private OVRDisplay _display;
        private string _restartNote;
        private float _restartNoteUntil;

        private void HookTrackingEvents()
        {
            if (!_trackingEventsHooked)
            {
                OVRManager.HMDMounted += OnHeadsetOn;
                OVRManager.HMDUnmounted += OnHeadsetOff;
                OVRManager.TrackingLost += OnTrackingLost;
                OVRManager.TrackingAcquired += OnTrackingBack;
                _trackingEventsHooked = true;
            }
            if (_display == null && OVRManager.display != null)
            {
                _display = OVRManager.display;
                _display.RecenteredPose += OnRecentred;
            }
        }

        private void OnHeadsetOn() => RestartDetection("headset put on");
        private void OnHeadsetOff() => RestartDetection("headset taken off");
        private void OnTrackingLost() => RestartDetection("tracking lost");
        private void OnTrackingBack() => RestartDetection("tracking back");
        private void OnRecentred() => RestartDetection("view recentred");

        private void OnApplicationPause(bool paused)
        {
            if (!paused) RestartDetection("app resumed");
        }

        public void RestartDetection(string reason)
        {
            _detector.Restart(reason);
            _floor.Reset();
            _previous.Clear();
            _sweepRow = -1;
            _restartNote = reason;
            _restartNoteUntil = Time.realtimeSinceStartup + 5f;
            Debug.Log($"[SHIRO DEPTH] Detection restarted: {reason}.");
        }
    }
}
