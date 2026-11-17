// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Person-like object detection from depth points (feature 8D).
//
// Plain C# with no Unity dependency, so it can be tested automatically outside
// Unity (quest3_client/Tests~/DetectionTests). The headset feeds it the 3D
// points the depth sensor sees (world metres, y up) a few times per second.
//
// 1. Points are put into a floor grid of 10 cm cells; each cell keeps the
//    highest point above the floor. Points near the floor, very high points,
//    points close to the wearer's head (own body) and on the wearer's arms
//    (from the tracked hands) are left out, and so are cells with a single
//    point (sensor noise at edges).
// 2. Cells taller than any person (walls, door frames, wardrobes: top above
//    2.25 m) are structure and are removed before grouping, so a bed against a
//    wall is not merged with the wall and keeps its own height.
// 3. Touching cells form objects: height, footprint, and a position taken from
//    the object's upper part (its top 30 cm), which looks the same from every
//    side; the lower part a hollow object shows changes with the view.
// 4. A tracker follows each object. An object only continues as the same one
//    when the new one is close AND of similar height (a hidden rack cannot be
//    taken over by the chair next to it). A piece of a followed object (its blob
//    split for a moment) does not become a new object. Movement is counted in
//    steps: the median of the last five positions must stay at least 0.3 m from
//    a reference spot (first: the median of the first five positions) for five
//    updates in a row (1 s at 5 Hz), seen without a gap and at a steady height.
//    That step is added to the object's path and its new spot becomes the
//    reference; while the object comes to rest the step still grows with it
//    (the median lags behind). "Moved" = path of at least 0.4 m, so pacing back
//    and forth in a small area counts too. Single jumps from noise or a
//    momentary merge never count. A sudden height jump does not move the object.
//    A step also needs evidence that the object really moved, from space SEEN
//    EMPTY (the view passed through it, at the height of the object's upper
//    part, to something farther away). Either side is enough:
//    a) the spot it left is seen empty now (moving away or sideways), when
//       something solid stood there (not a surface's points spilling into the
//       empty cell next to it), or
//    b) the place it moved into was seen empty before it got there (moving
//       towards the wearer or sideways: the spot it left is then hidden behind
//       it). A still object cannot appear in space that was seen empty.
//    When the wearer walks around a still object, its measured centre can shift
//    with the view, but neither happens: its spot is never seen empty, and the
//    "new" place is a part of it that was hidden or out of view before.
//    Empty space is remembered per 10 cm cell and 25 cm height layer: a place
//    counts as empty once it was seen empty in 3 updates with nothing hit in it
//    or right next to it (so the edges of furniture never count), until
//    something has stood in it for 5 s. (Moving-object detection in robotics
//    uses the same idea: points in space that was seen free are dynamic.)
//    Why an object counts as moved, or what a step is waiting for, is kept.
// 5. A person candidate is person-sized and, unless switched off for testing,
//    has moved. "Moved" stays while tracked and is remembered for a short time
//    at the spot where it was lost (looked away), so a person who stands still
//    does not become furniture. An object that never moved stays "not a
//    person": a cabinet missing from the ward plan is ignored. A change to or
//    from "not a person" needs 3 updates in a row; the reason is kept.
// 6. When the tracking space jumps (headset taken off and put on, tracking
//    lost, recentring), every object would seem to move at once: detection
//    then starts again (the headset reports these events; a head jump faster
//    than a person can move is detected here too).
// =============================================================================
using System;
using System.Collections.Generic;

namespace ShiroMR.Detection
{
    /// <summary>A depth point in world metres (y up).</summary>
    public struct DepthPoint
    {
        public float x, y, z;
        /// <summary>True when the point came from the top edge of the sensor view: an object's
        /// top may be cut off there, so its height is then only a lower bound.</summary>
        public bool atTopEdge;
        public DepthPoint(float x, float y, float z, bool atTopEdge = false)
        {
            this.x = x; this.y = y; this.z = z; this.atTopEdge = atTopEdge;
        }
    }

    /// <summary>A part of the wearer to leave out: a capsule from A to B (e.g. shoulder to hand).</summary>
    public struct ExcludeSegment
    {
        public float ax, ay, az, bx, by, bz, radius;
        public ExcludeSegment(float ax, float ay, float az, float bx, float by, float bz, float radius)
        {
            this.ax = ax; this.ay = ay; this.az = az; this.bx = bx; this.by = by; this.bz = bz; this.radius = radius;
        }

        public bool Contains(float x, float y, float z)
        {
            float vx = bx - ax, vy = by - ay, vz = bz - az;
            float wx = x - ax, wy = y - ay, wz = z - az;
            float vv = vx * vx + vy * vy + vz * vz;
            float t = vv > 1e-6f ? Math.Max(0f, Math.Min(1f, (wx * vx + wy * vy + wz * vz) / vv)) : 0f;
            float dx = wx - t * vx, dy = wy - t * vy, dz = wz - t * vz;
            return dx * dx + dy * dy + dz * dz < radius * radius;
        }
    }

    public sealed class DetectorSettings
    {
        public float CellSize = 0.10f;          // m
        public int MinCellPoints = 2;           // a cell with fewer points is noise
        public float MinPointHeight = 0.15f;    // m above the floor: lower points are floor
        public float MaxPointHeight = 2.40f;    // m above the floor: higher points are ceiling/lamps
        public float StructureHeight = 2.25f;   // m: a cell this tall is wall/door frame/wardrobe
        public float SelfRadius = 0.55f;        // m around the wearer's head (own hands, body)
        public int MinBlobCells = 3;            // smaller objects are noise
        public float MaxFootprint = 1.2f;       // m², larger objects are furniture or walls
        public float MaxSpan = 1.4f;            // m, longest side of the footprint
        public float TopBand = 0.30f;           // m: the upper part that gives the position
        public float PersonMinHeight = 0.90f;   // m, standing or walking
        public float PersonMaxHeight = 2.10f;   // m
        public bool MovementRequired = true;    // false only for testing (height only)
        public float MoveDistance = 0.40f;      // m of path (sum of steps) that counts as moved
        public float StepDistance = 0.30f;      // m from the reference spot that counts as a step
        public int MedianOf = 5;                // updates in the start and current medians
        public int MoveConfirmUpdates = 5;      // updates in a row beyond StepDistance
        public int SettleUpdates = 8;           // updates after a step in which it still grows while the object comes to rest
        public float MaxHeightJump = 0.35f;     // m: a bigger change in one update is a merge
        public int MaxJumpSkips = 3;            // after that many, the new height is accepted
        public float MatchDistance = 0.60f;     // m between updates to stay the same object
        public float MatchHeightDiff = 0.50f;   // m: a bigger height difference is another object
        public float FragmentDistance = 0.45f;  // m: a new object this close to a followed one is a piece of it
        public float MaxGapInStreak = 0.5f;     // s unseen that restarts the movement count
        public float StreakHeightDiff = 0.25f;  // m height change that restarts the movement count
        public float MemoryHeightDiff = 0.25f;  // m: a remembered moved object must have a similar height
        public float LostAfter = 2.0f;          // s unseen before an object is dropped
        public float RememberMovedFor = 30f;    // s a lost moved object is remembered at its spot
        public float HeightSmoothing = 0.3f;
        public bool RequireSpaceEvidence = true; // a step needs its old spot seen empty, or its new place seen empty before
        public float SpotCheckDistance = 0.15f; // m: the object is at its spot when checking what stood there
        public int MinVacatedObservations = 2;  // updates in which the old spot was seen empty ...
        public float MaxOccupiedShare = 0.25f;  // ... and at most this share of them with something there
        public float PassBandLow = 0.30f;       // m: the view passing through the old spot ...
        public float PassBandHigh = 1.80f;      // ...
        public float PassBandDepth = 0.50f;     // ... at the height of the object's upper part (its top 0.5 m) shows it is empty
        public float LayerBase = 0.25f;         // m: empty space is remembered from this height ...
        public float LayerHeight = 0.25f;       // ... in layers this thick ...
        public int Layers = 7;                  // ... up to 2.0 m
        public int MapCells = 200;              // cells per side of the remembered area (20 m)
        public float RecentreAfter = 4f;        // m the wearer walks from its centre before it is moved (and cleared)
        public float FreeMargin = 0.15f;        // m before a hit point where the view no longer counts as passing through
        public int EmptyAfterUpdates = 3;       // updates seen empty, with nothing in or next to it, before a place is empty space
        public float EmptyForgetAfter = 5f;     // s something stands in a place before it is no longer empty space
        public int MinArrivedCells = 2;         // cells of the object's upper part that must be in empty space ...
        public int MinArrivedUpdates = 2;       // ... in this many updates
        public int KindConfirmUpdates = 3;      // updates in a row to change to or from "not a person"
        public float HeadJumpDistance = 0.4f;   // m: a head jump this far (walking: at most 0.3 m per update) ...
        public float HeadJumpSpeed = 2.5f;      // m/s ... and this fast is a tracking jump
    }

    public sealed class Blob
    {
        public float X, Z;          // position of the upper part, world metres
        public float Top;           // m above the floor
        public bool TopMaybeCut;    // its highest points were at the top edge of the view
        public int Cells;
        public float Footprint;     // m²
        public float SpanX, SpanZ;  // m
        internal HashSet<long> CellKeys;
        internal List<long> TopCellKeys; // cells of the upper part (they give the position)
    }

    public enum TrackKind
    {
        /// <summary>Too low, too high or too big for a person.</summary>
        NotPerson,
        /// <summary>Person-sized but has not moved yet.</summary>
        StillObject,
        /// <summary>Person-sized and has moved (or movement is not required).</summary>
        PersonCandidate,
    }

    public enum MovedEvidence { None, Walked, SeenMovingHere }

    public sealed class Track
    {
        public int Id;
        public float X, Z;              // median of the recent positions
        public float Height;            // smoothed height above the floor
        public bool HeightMaybeCut;
        public float Footprint;
        public float Span;              // m, longest side of the footprint
        public float StartX, StartZ;    // median of the first positions (once known)
        public bool StartKnown;
        public float FirstSeen, LastSeen;
        public float Displacement;      // m, current position from the start
        public float MaxDisplacement;   // m, largest Displacement so far
        public float PathLength;        // m, sum of the confirmed steps
        public int Steps;               // confirmed steps
        public float RefX, RefZ;        // spot the next step is measured from
        public bool RefKnown;
        public bool HasMoved;
        /// <summary>Why it counts as moved: Walked (MovedDistance m of path) or SeenMovingHere (remembered).</summary>
        public MovedEvidence MovedBy;
        public float MovedDistance;
        public float Speed;             // m/s, smoothed
        public TrackKind Kind;
        public bool SeenThisUpdate;
        /// <summary>Why it is not a person (too short, too wide ...), or null.</summary>
        public string NotPersonReason;
        /// <summary>What a possible step is waiting for, or null.</summary>
        public string Waiting;
        /// <summary>What proved the last step (its old spot seen empty / it moved into space seen empty), or null.</summary>
        public string LastStepProof;

        internal readonly List<float> FirstXs = new List<float>(), FirstZs = new List<float>();
        internal readonly List<float> RecentXs = new List<float>(), RecentZs = new List<float>();
        internal int MoveStreak;
        internal float StreakHeight;
        internal int JumpSkips;
        internal int StreakFree, StreakOccupied;
        internal int StreakArrived;
        internal bool RefSolid;              // something solid stood at the reference spot
        internal float StepFromX, StepFromZ; // where the last step started
        internal int SettleLeft;              // updates in which the last step can still grow
        internal TrackKind PendingKind;
        internal int PendingCount;
        internal bool Classified;
    }

    /// <summary>
    /// Measures the floor height from the depth points: the lowest height at which
    /// many points lie (the floor is the largest surface at the bottom of the view).
    /// The headset's own floor level is only a guess and can be off by 10-30 cm;
    /// then the floor itself would count as an object. The estimate is kept between
    /// updates and only changes when the floor is seen.
    /// </summary>
    public sealed class FloorEstimator
    {
        public float SearchRange = 0.6f;     // m above and below the guess
        public float BinSize = 0.02f;        // m
        public int MinPoints = 20;           // floor points needed for a measurement
        public float MinShare = 0.15f;       // share of the points in the search range
        public int MedianOf = 9;             // measurements combined
        public float Tolerance = 0.08f;      // m: measurements this close to the floor are combined
        public float GuessAgreement = 0.12f; // m: a higher floor is accepted when it agrees with the headset's
        public int RiseVotes = 3;            // ... in this many measurements in a row
        private int _rise;

        private readonly List<float> _recent = new List<float>();

        /// <summary>The measured floor (world y), or null while the floor has not been seen.</summary>
        public float? Floor { get; private set; }

        public void Reset() { _recent.Clear(); Floor = null; _rise = 0; }

        /// <summary>Measures the floor in this update's points; returns the floor to use.</summary>
        public float Update(IReadOnlyList<DepthPoint> points, float guessY)
        {
            float? m = Measure(points, guessY);
            // The floor does not rise: a higher layer is a bed or table top seen without the
            // floor. Except when that layer agrees with the headset's own floor level several
            // times in a row: then the earlier, lower floor was wrong (for example measured
            // while the tracking space was shifting after the headset was put on).
            // A clearly lower layer means the earlier one was not the floor.
            if (m.HasValue && Floor.HasValue && m.Value > Floor.Value + Tolerance)
            {
                if (Math.Abs(m.Value - guessY) <= GuessAgreement && ++_rise >= RiseVotes)
                {
                    _recent.Clear();
                    _rise = 0;
                }
                else
                {
                    m = null;
                }
            }
            else if (m.HasValue)
            {
                _rise = 0;
            }
            if (m.HasValue && Floor.HasValue && m.Value < Floor.Value - Tolerance) _recent.Clear();
            if (m.HasValue)
            {
                _recent.Add(m.Value);
                if (_recent.Count > MedianOf) _recent.RemoveAt(0);
                var sorted = new List<float>(_recent);
                sorted.Sort();
                Floor = sorted[sorted.Count / 2];
            }
            return Floor ?? guessY;
        }

        public float? Measure(IReadOnlyList<DepthPoint> points, float guessY)
        {
            float lo = guessY - SearchRange;
            int bins = (int)Math.Ceiling(2 * SearchRange / BinSize);
            var count = new int[bins];
            int total = 0;
            foreach (var p in points)
            {
                int b = (int)Math.Floor((p.y - lo) / BinSize);
                if (b < 0 || b >= bins) continue;
                count[b]++;
                total++;
            }
            if (total < MinPoints) return null;
            // Lowest layer (3 bins = 6 cm thick) holding enough of the points
            for (int b = 1; b < bins - 1; b++)
            {
                int layer = count[b - 1] + count[b] + count[b + 1];
                if (layer >= MinPoints && layer >= MinShare * total && count[b] >= count[b - 1] && count[b] >= count[b + 1])
                {
                    float sum = 0f;
                    int n = 0;
                    foreach (var p in points)
                    {
                        if (p.y >= lo + (b - 1) * BinSize && p.y < lo + (b + 2) * BinSize) { sum += p.y; n++; }
                    }
                    return sum / n;
                }
            }
            return null;
        }
    }

    /// <summary>
    /// Remembers which places have been seen EMPTY: the view passed through them to something
    /// farther away. Kept per floor cell (10 cm) and height layer (25 cm, 0.25 m to 2.0 m above
    /// the floor) over a 20 m square around the wearer. Each update looks at the rays of the
    /// newest sweep: the cell where a ray ends is HIT, the cells it passes before are SEEN EMPTY
    /// (unless something is hit in the same update in that cell or right next to it).
    /// An update is BeginUpdate, AddRays (all at once, or row by row over several frames) and
    /// EndUpdate; Integrate does all three.
    /// A place becomes EMPTY SPACE after EmptyAfterUpdates such updates and stays so until
    /// something has stood in it for EmptyForgetAfter seconds. An object hit in empty space has
    /// moved there: a still object cannot appear where the view passed through before.
    /// </summary>
    public sealed class FreeSpaceMap
    {
        private readonly DetectorSettings _s;
        private int _size, _layers;
        private int _cx, _cz, _ox, _oz; // centre and corner cell of the remembered area
        private bool _placed;
        private int _update;
        private int[] _hitStamp, _freeStamp; // update in which the place was last hit / passed through
        private int[] _nearStamp;            // update in which something was hit right next to it
        private bool _inUpdate;
        private byte[] _freeRun;             // updates seen empty in a row
        private bool[] _empty;               // counts as empty space
        private float[] _occupiedSince;      // s, when something started standing there (-1: nothing)
        private readonly List<int> _touched = new List<int>();
        private readonly List<int> _hits = new List<int>();

        public FreeSpaceMap(DetectorSettings settings)
        {
            _s = settings;
            Allocate(); // when the app starts, not in the middle of use
        }

        public void Clear() { _placed = false; _inUpdate = false; }

        private void Allocate()
        {
            _size = _s.MapCells;
            _layers = _s.Layers;
            int n = _size * _size * _layers;
            _hitStamp = new int[n];
            _freeStamp = new int[n];
            _nearStamp = new int[n];
            _freeRun = new byte[n];
            _empty = new bool[n];
            _occupiedSince = new float[n];
        }

        private void Place(int cx, int cz)
        {
            if (_size != _s.MapCells || _layers != _s.Layers)
            {
                Allocate();
            }
            else
            {
                Array.Clear(_hitStamp, 0, _hitStamp.Length);
                Array.Clear(_freeStamp, 0, _freeStamp.Length);
                Array.Clear(_nearStamp, 0, _nearStamp.Length);
                Array.Clear(_freeRun, 0, _freeRun.Length);
                Array.Clear(_empty, 0, _empty.Length);
            }
            for (int i = 0; i < _occupiedSince.Length; i++) _occupiedSince[i] = -1f;
            _update = 0;
            _cx = cx; _cz = cz;
            _ox = cx - _size / 2; _oz = cz - _size / 2;
            _placed = true;
        }

        private int Index(int ix, int iz, int layer)
        {
            int lx = ix - _ox, lz = iz - _oz;
            if (lx < 0 || lz < 0 || lx >= _size || lz >= _size || layer < 0 || layer >= _layers) return -1;
            return (lx * _size + lz) * _layers + layer;
        }

        private int Cell(float v) => (int)Math.Floor(v / _s.CellSize);
        private int Layer(float h) => (int)Math.Floor((h - _s.LayerBase) / _s.LayerHeight);

        /// <summary>One update with the rays from the eye to the first <paramref name="count"/> points
        /// (the newest sweep). Points on the wearer (near the head, on the arms) are left out.</summary>
        public void Integrate(IReadOnlyList<DepthPoint> points, int count, float floorY, float hx, float hy, float hz,
                              IReadOnlyList<ExcludeSegment> exclude, float now)
        {
            BeginUpdate(hx, hz);
            AddRays(points, 0, count, floorY, hx, hy, hz, exclude);
            EndUpdate(now);
        }

        /// <summary>Starts an update (one sweep); the wearer is at (hx, hz).</summary>
        public void BeginUpdate(float hx, float hz)
        {
            var s = _s;
            int hcx = Cell(hx), hcz = Cell(hz);
            int recentre = (int)(s.RecentreAfter / s.CellSize);
            if (!_placed || _size != s.MapCells || _layers != s.Layers ||
                Math.Abs(hcx - _cx) > recentre || Math.Abs(hcz - _cz) > recentre)
                Place(hcx, hcz);
            _update++;
            _touched.Clear();
            _hits.Clear();
            _inUpdate = true;
        }

        /// <summary>Adds the rays from the eye (hx, hy, hz) to points[start .. start+count).</summary>
        public void AddRays(IReadOnlyList<DepthPoint> points, int start, int count, float floorY, float hx, float hy, float hz,
                            IReadOnlyList<ExcludeSegment> exclude)
        {
            if (!_inUpdate) return;
            var s = _s;
            float inv = 1f / s.CellSize, invLayer = 1f / s.LayerHeight;
            float self2 = s.SelfRadius * s.SelfRadius;
            float step = s.CellSize * 0.5f;
            // In grid units from the corner of the remembered area
            float gx0 = hx * inv - _ox, gz0 = hz * inv - _oz;
            float gl0 = (hy - floorY - s.LayerBase) * invLayer;
            int end = Math.Min(points.Count, start + count);
            for (int i = start; i < end; i++)
            {
                DepthPoint p = points[i];
                float dx = p.x - hx, dz = p.z - hz;
                float xz2 = dx * dx + dz * dz;
                if (xz2 < self2) continue;
                if (exclude != null && PersonDetector.Excluded(exclude, p)) continue;
                float dy = p.y - hy;
                float gdx = dx * inv, gdz = dz * inv, gdl = dy * invLayer;

                // Where the ray ends, something is
                int hit = GridIndex(gx0 + gdx, gz0 + gdz, gl0 + gdl);
                if (hit >= 0 && _hitStamp[hit] != _update)
                {
                    if (_freeStamp[hit] != _update) _touched.Add(hit);
                    _hitStamp[hit] = _update;
                    _hits.Add(hit);
                }

                // On the way there, the view passed through empty space (up to FreeMargin
                // before the end), at the heights the layers cover
                float flat = (float)Math.Sqrt(xz2);
                float len = (float)Math.Sqrt(xz2 + dy * dy);
                float reach = 1f - s.FreeMargin / len;
                if (reach <= 0f) continue;
                float inc = step / flat;
                int k0 = 0, k1 = (int)(flat * reach / step);
                if (Math.Abs(gdl) > 1e-6f)
                {
                    float fa = -gl0 / gdl, fb = (_layers - gl0) / gdl;
                    k0 = Math.Max(k0, (int)Math.Floor(Math.Min(fa, fb) / inc - 0.5f));
                    k1 = Math.Min(k1, (int)Math.Ceiling(Math.Max(fa, fb) / inc - 0.5f) + 1);
                }
                else if (gl0 < 0f || gl0 >= _layers) continue;
                int last = -1;
                for (int k = k0; k < k1; k++)
                {
                    float f = (k + 0.5f) * inc;
                    int idx = GridIndex(gx0 + f * gdx, gz0 + f * gdz, gl0 + f * gdl);
                    if (idx < 0 || idx == last) continue;
                    last = idx;
                    if (_freeStamp[idx] == _update) continue;
                    if (_hitStamp[idx] != _update) _touched.Add(idx);
                    _freeStamp[idx] = _update;
                }
            }
        }

        /// <summary>Ends the update: what was seen empty, and what stands somewhere.</summary>
        public void EndUpdate(float now)
        {
            if (!_inUpdate) return;
            _inUpdate = false;
            var s = _s;
            // Passing right next to something that was hit proves nothing (its edge)
            foreach (int h in _hits)
            {
                int layer = h % _layers, c = h / _layers;
                int lx = c / _size, lz = c % _size;
                for (int ox = -1; ox <= 1; ox++)
                    for (int oz = -1; oz <= 1; oz++)
                    {
                        int nx = lx + ox, nz = lz + oz;
                        if ((ox == 0 && oz == 0) || nx < 0 || nz < 0 || nx >= _size || nz >= _size) continue;
                        _nearStamp[(nx * _size + nz) * _layers + layer] = _update;
                    }
            }

            foreach (int idx in _touched)
            {
                if (_hitStamp[idx] == _update)
                {
                    // Something stands there; after a while it is no longer empty space
                    _freeRun[idx] = 0;
                    if (_occupiedSince[idx] < 0f) _occupiedSince[idx] = now;
                    else if (_empty[idx] && now - _occupiedSince[idx] >= s.EmptyForgetAfter) _empty[idx] = false;
                    continue;
                }
                _occupiedSince[idx] = -1f;
                if (_nearStamp[idx] == _update) { _freeRun[idx] = 0; continue; }
                if (_freeRun[idx] < 255) _freeRun[idx]++;
                if (_freeRun[idx] >= s.EmptyAfterUpdates) _empty[idx] = true;
            }
        }

        private int GridIndex(float gx, float gz, float gl)
        {
            if (gx < 0f || gz < 0f || gl < 0f) return -1;
            int lx = (int)gx, lz = (int)gz, l = (int)gl;
            if (lx >= _size || lz >= _size || l >= _layers) return -1;
            return (lx * _size + lz) * _layers + l;
        }

        /// <summary>
        /// Of the given cells, hit in this update between heights low and high (above the floor):
        /// how many are in empty space (something came there), and how many are not (something
        /// stood there before, or the place was never seen empty: hidden or out of view).
        /// A hit in empty space only counts when the place is surrounded by empty space: next to
        /// something that stood there before, or next to a place never seen (the inside of a
        /// cabinet), it is the edge of that thing (its surface spilling into the next cell,
        /// depth noise), not proof.
        /// </summary>
        public void Arrival(List<long> cells, float low, float high, out int inEmpty, out int notEmpty)
            => Arrival(cells, low, high, out inEmpty, out notEmpty, out _);

        /// <summary>As above; edge: cells hit in empty space but not surrounded by it (a surface
        /// spilling into the empty cell next to it).</summary>
        public void Arrival(List<long> cells, float low, float high, out int inEmpty, out int notEmpty, out int edge)
        {
            inEmpty = 0;
            notEmpty = 0;
            edge = 0;
            if (!_placed || cells == null) return;
            int l0 = Math.Max(0, Layer(low)), l1 = Math.Min(_layers - 1, Layer(high));
            foreach (long key in cells)
            {
                PersonDetector.Unkey(key, out int ix, out int iz);
                bool empty = false, occupied = false, atEdge = false;
                for (int l = l0; l <= l1; l++)
                {
                    int idx = Index(ix, iz, l);
                    if (idx < 0 || _hitStamp[idx] != _update) continue;
                    if (!_empty[idx]) occupied = true;
                    else if (SurroundedByEmpty(ix, iz, l)) empty = true;
                    else atEdge = true;
                }
                if (occupied) notEmpty++;
                else if (empty) inEmpty++;
                else if (atEdge) edge++;
            }
        }

        /// <summary>
        /// Looks at the place (x, z) in this update, between heights low and high above the floor:
        /// something hit there, or seen empty (the view passed through it, and nothing was hit in
        /// it or right next to it: passing close by the surface of something is no proof).
        /// </summary>
        public void LookAt(float x, float z, float low, float high, out bool seenEmpty, out bool hit)
        {
            seenEmpty = false;
            hit = false;
            if (!_placed) return;
            int ix = Cell(x), iz = Cell(z);
            int l0 = Math.Max(0, Layer(low)), l1 = Math.Min(_layers - 1, Layer(high));
            for (int l = l0; l <= l1; l++)
            {
                int idx = Index(ix, iz, l);
                if (idx < 0) continue;
                if (_hitStamp[idx] == _update) hit = true;
                else if (_freeStamp[idx] == _update && _nearStamp[idx] != _update) seenEmpty = true;
            }
            if (hit) seenEmpty = false;
        }

        /// <summary>All eight places around this one (same height layer) are empty space.</summary>
        private bool SurroundedByEmpty(int ix, int iz, int layer)
        {
            for (int ox = -1; ox <= 1; ox++)
                for (int oz = -1; oz <= 1; oz++)
                {
                    if (ox == 0 && oz == 0) continue;
                    int idx = Index(ix + ox, iz + oz, layer);
                    if (idx < 0 || !_empty[idx]) return false;
                }
            return true;
        }
    }

    public sealed class PersonDetector
    {
        public readonly DetectorSettings Settings;
        private readonly List<Track> _tracks = new List<Track>();
        private readonly List<(float x, float z, float height, float until)> _movedMemory = new List<(float, float, float, float)>();
        private int _nextId = 1;
        private bool _hasHead;
        private float _lastHeadX, _lastHeadZ, _lastHeadTime;
        /// <summary>Why detection last started again (tracking jump), or null.</summary>
        public string LastRestartReason { get; private set; }
        public int Restarts { get; private set; }

        public IReadOnlyList<Track> Tracks => _tracks;
        public int LastPointCount { get; private set; }
        public int LastUsedPointCount { get; private set; }
        public int LastStructureCells { get; private set; }
        public IReadOnlyList<Blob> LastBlobs => _lastBlobs;
        private List<Blob> _lastBlobs = new List<Blob>();

        /// <summary>Space seen empty (a step needs its old spot seen empty, or its new place seen empty before).</summary>
        public readonly FreeSpaceMap EmptySpace;
        /// <summary>True when the caller adds each sweep to EmptySpace itself (row by row while it
        /// sweeps, which spreads the work over frames); Process then only reads it.</summary>
        public bool EmptySpaceFedByCaller;

        public PersonDetector(DetectorSettings settings = null)
        {
            Settings = settings ?? new DetectorSettings();
            EmptySpace = new FreeSpaceMap(Settings);
        }

        public void Reset()
        {
            _tracks.Clear();
            _movedMemory.Clear();
            _lastBlobs.Clear();
            EmptySpace.Clear();
            _hasHead = false;
        }

        /// <summary>Starts again after a tracking jump (everything seen before is forgotten).</summary>
        public void Restart(string reason)
        {
            Reset();
            LastRestartReason = reason;
            Restarts++;
        }

        /// <summary>
        /// One update. floorY: floor height (world y). head: the wearer's eye position (the
        /// rays start there). now: time in seconds (any clock that only goes forward).
        /// exclude: the wearer's arms (optional). newPoints: how many of the points (at the start
        /// of the list) are from this update's sweep, the rest being the previous sweep's (-1: all
        /// new); only the new ones add to the memory of empty space.
        /// </summary>
        public void Process(IReadOnlyList<DepthPoint> points, float floorY, float headX, float headY, float headZ, float now,
                            IReadOnlyList<ExcludeSegment> exclude = null, int newPoints = -1)
        {
            // The tracking space jumped (faster than any person moves): start again
            if (_hasHead)
            {
                float jump = Dist(headX, headZ, _lastHeadX, _lastHeadZ);
                float dt = Math.Max(1e-3f, now - _lastHeadTime);
                if (jump > Settings.HeadJumpDistance && jump / dt > Settings.HeadJumpSpeed)
                    Restart($"the headset jumped {jump:0.0} m (tracking reset)");
            }
            _hasHead = true;
            _lastHeadX = headX; _lastHeadZ = headZ; _lastHeadTime = now;

            if (Settings.RequireSpaceEvidence && !EmptySpaceFedByCaller)
                EmptySpace.Integrate(points, newPoints < 0 ? points.Count : Math.Min(newPoints, points.Count),
                                     floorY, headX, headY, headZ, exclude, now);
            _lastBlobs = FindBlobs(points, floorY, headX, headZ, exclude);
            UpdateTracks(_lastBlobs, now);
        }

        // ----- 1-3: floor grid, structure, objects -----

        private struct Cell
        {
            public float top;
            public bool topAtEdge;
            public int count;
            public int label;
        }

        public List<Blob> FindBlobs(IReadOnlyList<DepthPoint> points, float floorY, float headX, float headZ,
                                    IReadOnlyList<ExcludeSegment> exclude = null)
        {
            var s = Settings;
            var grid = new Dictionary<long, Cell>();
            int used = 0;
            float self2 = s.SelfRadius * s.SelfRadius;
            LastPointCount = points.Count;

            for (int i = 0; i < points.Count; i++)
            {
                DepthPoint p = points[i];
                float h = p.y - floorY;
                if (h < s.MinPointHeight || h > s.MaxPointHeight) continue;
                float dx = p.x - headX, dz = p.z - headZ;
                if (dx * dx + dz * dz < self2) continue;
                if (exclude != null && Excluded(exclude, p)) continue;

                int ix = (int)Math.Floor(p.x / s.CellSize);
                int iz = (int)Math.Floor(p.z / s.CellSize);
                long key = Key(ix, iz);
                grid.TryGetValue(key, out Cell c);
                if (c.count == 0 || h > c.top) { c.top = h; c.topAtEdge = p.atTopEdge; }
                c.count++;
                grid[key] = c;
                used++;
            }
            LastUsedPointCount = used;

            // Noise (single points) and structure (taller than any person) are removed
            int structure = 0;
            var keys = new List<long>();
            foreach (var kv in grid)
            {
                if (kv.Value.count < s.MinCellPoints) continue;
                if (kv.Value.top > s.StructureHeight) { structure++; continue; }
                keys.Add(kv.Key);
            }
            LastStructureCells = structure;
            var kept = new Dictionary<long, Cell>(keys.Count);
            foreach (long k in keys) kept[k] = grid[k];

            // Connected cells (8 neighbours) form one object
            var blobs = new List<Blob>();
            int label = 0;
            var stack = new Stack<long>();
            var members = new List<long>();
            foreach (long start in keys)
            {
                if (kept[start].label != 0) continue;
                label++;
                members.Clear();
                stack.Push(start);
                SetLabel(kept, start, label);
                while (stack.Count > 0)
                {
                    long k = stack.Pop();
                    members.Add(k);
                    Unkey(k, out int cx, out int cz);
                    for (int ox = -1; ox <= 1; ox++)
                        for (int oz = -1; oz <= 1; oz++)
                        {
                            if (ox == 0 && oz == 0) continue;
                            long n = Key(cx + ox, cz + oz);
                            if (kept.TryGetValue(n, out Cell nc) && nc.label == 0)
                            {
                                SetLabel(kept, n, label);
                                stack.Push(n);
                            }
                        }
                }

                if (members.Count < s.MinBlobCells) continue;
                var blob = MakeBlob(kept, members);
                blob.CellKeys = new HashSet<long>(members);
                blobs.Add(blob);
            }
            return blobs;
        }

        private Blob MakeBlob(Dictionary<long, Cell> cells, List<long> members)
        {
            var s = Settings;
            float top = 0f;
            bool topCut = false;
            int minX = int.MaxValue, maxX = int.MinValue, minZ = int.MaxValue, maxZ = int.MinValue;
            foreach (long k in members)
            {
                Unkey(k, out int cx, out int cz);
                Cell c = cells[k];
                if (c.top > top) { top = c.top; topCut = c.topAtEdge; }
                if (cx < minX) minX = cx;
                if (cx > maxX) maxX = cx;
                if (cz < minZ) minZ = cz;
                if (cz > maxZ) maxZ = cz;
            }

            // Position: centre of the cells in the upper part (each cell counts once)
            float sumX = 0f, sumZ = 0f;
            int n = 0;
            var topCells = new List<long>();
            foreach (long k in members)
            {
                if (cells[k].top < top - s.TopBand) continue;
                topCells.Add(k);
                Unkey(k, out int cx, out int cz);
                sumX += (cx + 0.5f) * s.CellSize;
                sumZ += (cz + 0.5f) * s.CellSize;
                n++;
            }

            return new Blob
            {
                X = sumX / n,
                Z = sumZ / n,
                Top = top,
                TopMaybeCut = topCut,
                Cells = members.Count,
                Footprint = members.Count * s.CellSize * s.CellSize,
                SpanX = (maxX - minX + 1) * s.CellSize,
                SpanZ = (maxZ - minZ + 1) * s.CellSize,
                TopCellKeys = topCells,
            };
        }

        internal static bool Excluded(IReadOnlyList<ExcludeSegment> exclude, DepthPoint p)
        {
            for (int i = 0; i < exclude.Count; i++) if (exclude[i].Contains(p.x, p.y, p.z)) return true;
            return false;
        }

        private static void SetLabel(Dictionary<long, Cell> grid, long key, int label)
        {
            Cell c = grid[key];
            c.label = label;
            grid[key] = c;
        }

        private static long Key(int ix, int iz) => ((long)ix << 32) ^ (uint)iz;
        internal static void Unkey(long key, out int ix, out int iz)
        {
            ix = (int)(key >> 32);
            iz = (int)(uint)(key & 0xFFFFFFFF);
        }

        // ----- 4 + 5: tracking and classification -----

        private void UpdateTracks(List<Blob> blobs, float now)
        {
            var s = Settings;
            foreach (var t in _tracks) t.SeenThisUpdate = false;

            // Greedy matching: closest pairs first
            var pairs = new List<(float d, int b, Track t)>();
            for (int b = 0; b < blobs.Count; b++)
                foreach (var t in _tracks)
                {
                    float d = Dist(blobs[b].X, blobs[b].Z, t.X, t.Z);
                    float dh = Math.Abs(blobs[b].Top - t.Height);
                    if (d <= s.MatchDistance && dh <= s.MatchHeightDiff) pairs.Add((d + 0.5f * dh, b, t));
                }
            pairs.Sort((a, c) => a.d.CompareTo(c.d));
            var blobUsed = new bool[blobs.Count];
            foreach (var (_, b, t) in pairs)
            {
                if (blobUsed[b] || t.SeenThisUpdate) continue;
                blobUsed[b] = true;
                Update(t, blobs[b], now);
            }

            for (int b = 0; b < blobs.Count; b++)
            {
                if (blobUsed[b]) continue;
                var blob = blobs[b];
                // A piece of an object that is already followed (its blob split for a moment):
                // as a new object it would take over the object's position every other update,
                // and neither would ever add up the whole movement
                if (NextToFollowed(blob, blobs, blobUsed)) continue;
                var t = new Track
                {
                    Id = _nextId++,
                    X = blob.X, Z = blob.Z,
                    Height = blob.Top, HeightMaybeCut = blob.TopMaybeCut,
                    Footprint = blob.Footprint, Span = Math.Max(blob.SpanX, blob.SpanZ),
                    FirstSeen = now, LastSeen = now, SeenThisUpdate = true,
                };
                AddPosition(t, blob.X, blob.Z);
                // A moved object that was lost here a moment ago (looked away): still moved
                for (int m = _movedMemory.Count - 1; m >= 0; m--)
                {
                    if (_movedMemory[m].until < now) { _movedMemory.RemoveAt(m); continue; }
                    if (Dist(_movedMemory[m].x, _movedMemory[m].z, blob.X, blob.Z) <= s.MatchDistance &&
                        Math.Abs(_movedMemory[m].height - blob.Top) <= s.MemoryHeightDiff)
                    {
                        t.HasMoved = true;
                        t.MovedBy = MovedEvidence.SeenMovingHere;
                        _movedMemory.RemoveAt(m);
                        break;
                    }
                }
                _tracks.Add(t);
            }

            for (int i = _tracks.Count - 1; i >= 0; i--)
            {
                var t = _tracks[i];
                if (now - t.LastSeen > s.LostAfter)
                {
                    if (t.HasMoved) _movedMemory.Add((t.X, t.Z, t.Height, now + s.RememberMovedFor));
                    _tracks.RemoveAt(i);
                    continue;
                }
                SetKind(t, Classify(t));
            }
        }

        private bool NextToFollowed(Blob blob, List<Blob> blobs, bool[] blobUsed)
        {
            for (int o = 0; o < blobs.Count; o++)
                if (blobUsed[o] && Dist(blob.X, blob.Z, blobs[o].X, blobs[o].Z) <= Settings.FragmentDistance) return true;
            return false;
        }

        private void Update(Track t, Blob blob, float now)
        {
            var s = Settings;
            float gap = now - t.LastSeen;
            float dt = Math.Max(1e-3f, gap);
            t.LastSeen = now;
            if (gap > s.MaxGapInStreak) t.MoveStreak = 0; // movement must be seen without a gap
            t.SeenThisUpdate = true;

            // A sudden height jump is a merge with something next to it (or a split):
            // keep the object where it was, unless the new height persists
            if (Math.Abs(blob.Top - t.Height) > s.MaxHeightJump && t.JumpSkips < s.MaxJumpSkips)
            {
                t.JumpSkips++;
                return;
            }
            t.JumpSkips = 0;

            float oldX = t.X, oldZ = t.Z;
            AddPosition(t, blob.X, blob.Z);
            float speed = Dist(t.X, t.Z, oldX, oldZ) / dt;
            t.Speed += (speed - t.Speed) * 0.5f;
            t.Height += (blob.Top - t.Height) * s.HeightSmoothing;
            t.HeightMaybeCut = blob.TopMaybeCut;
            t.Footprint = blob.Footprint;
            t.Span = Math.Max(blob.SpanX, blob.SpanZ);

            if (!t.StartKnown) return;
            if (!t.RefKnown)
            {
                t.RefX = t.StartX;
                t.RefZ = t.StartZ;
                t.RefKnown = true;
            }
            t.Displacement = Dist(t.X, t.Z, t.StartX, t.StartZ);
            if (t.Displacement > t.MaxDisplacement) t.MaxDisplacement = t.Displacement;

            // A step is confirmed while the position (a median of the last updates) is still
            // catching up: until the object comes to rest, the step grows with it, so a 0.5 m push
            // counts as 0.5 m and not as the 0.4 m measured at the moment of confirmation
            if (t.SettleLeft > 0)
            {
                t.SettleLeft--;
                float nowFrom = Dist(t.X, t.Z, t.StepFromX, t.StepFromZ);
                float refFrom = Dist(t.RefX, t.RefZ, t.StepFromX, t.StepFromZ);
                if (nowFrom > refFrom + 0.02f && Dist(t.X, t.Z, t.RefX, t.RefZ) < s.StepDistance)
                {
                    t.PathLength += nowFrom - refFrom;
                    t.RefX = t.X;
                    t.RefZ = t.Z;
                }
            }

            // A step: the position stays at least StepDistance from the reference spot for
            // MoveConfirmUpdates updates in a row, seen without a gap and at a steady height
            float fromRef = Dist(t.X, t.Z, t.RefX, t.RefZ);
            if (fromRef >= s.StepDistance)
            {
                if (t.MoveStreak == 0) { t.StreakHeight = t.Height; t.StreakFree = 0; t.StreakOccupied = 0; t.StreakArrived = 0; }
                // the same object all along: its height stays steady while it moves
                t.MoveStreak = Math.Abs(t.Height - t.StreakHeight) <= s.StreakHeightDiff ? t.MoveStreak + 1 : 0;
                if (t.MoveStreak > 0 && s.RequireSpaceEvidence)
                {
                    if (t.RefSolid) LookAtOldSpot(t, blob);
                    if (CameIntoEmptySpace(blob)) t.StreakArrived++;
                }
            }
            else
            {
                t.MoveStreak = 0;
                t.Waiting = null;
                // While it stands at its spot: was something solid there? Only then can that spot
                // seen empty later prove a move (not when the "object" was only a surface's points
                // spilling into the empty cell next to it)
                if (!t.RefSolid && s.RequireSpaceEvidence &&
                    Dist(blob.X, blob.Z, t.RefX, t.RefZ) <= s.SpotCheckDistance && SolidHere(blob))
                    t.RefSolid = true;
            }

            // Evidence, either side: a) the old spot seen empty (and hardly anything hit there),
            // b) the object's upper part now in space that was seen empty before
            bool leftSpotEmpty = t.StreakFree >= s.MinVacatedObservations &&
                                 t.StreakOccupied <= s.MaxOccupiedShare * (t.StreakFree + t.StreakOccupied);
            bool cameIntoEmpty = t.StreakArrived >= s.MinArrivedUpdates;
            bool proven = !s.RequireSpaceEvidence || leftSpotEmpty || cameIntoEmpty;
            if (t.MoveStreak >= s.MoveConfirmUpdates && !proven)
            {
                t.Waiting = $"{fromRef:0.0} m from its spot, not proven yet:\nold spot not seen empty, new place not seen empty before";
            }
            if (t.MoveStreak >= s.MoveConfirmUpdates && proven)
            {
                t.Waiting = null;
                t.LastStepProof = !s.RequireSpaceEvidence ? null
                                : leftSpotEmpty && cameIntoEmpty ? "old spot seen empty, moved into empty space"
                                : leftSpotEmpty ? "old spot seen empty"
                                : "moved into space seen empty before";
                // The step is added to the path; the object's new spot is the next reference
                t.PathLength += fromRef;
                t.Steps++;
                t.StepFromX = t.RefX;
                t.StepFromZ = t.RefZ;
                t.SettleLeft = s.SettleUpdates;
                t.RefSolid = false; // checked again at the new spot
                t.RefX = t.X;
                t.RefZ = t.Z;
                t.MoveStreak = 0;
                t.StreakFree = 0;
                t.StreakOccupied = 0;
                t.StreakArrived = 0;
            }
            if (t.PathLength >= s.MoveDistance && t.MovedBy != MovedEvidence.Walked)
            {
                t.HasMoved = true;
                t.MovedBy = MovedEvidence.Walked;
            }
            if (t.MovedBy == MovedEvidence.Walked) t.MovedDistance = t.PathLength;
        }

        /// <summary>Adds a measured position; the track's position is the median of the recent ones.</summary>
        private void AddPosition(Track t, float x, float z)
        {
            int n = Settings.MedianOf;
            t.RecentXs.Add(x);
            t.RecentZs.Add(z);
            if (t.RecentXs.Count > n) { t.RecentXs.RemoveAt(0); t.RecentZs.RemoveAt(0); }
            t.X = Median(t.RecentXs);
            t.Z = Median(t.RecentZs);

            if (!t.StartKnown)
            {
                t.FirstXs.Add(x);
                t.FirstZs.Add(z);
                if (t.FirstXs.Count >= n)
                {
                    t.StartX = Median(t.FirstXs);
                    t.StartZ = Median(t.FirstZs);
                    t.StartKnown = true;
                }
            }
        }

        public TrackKind Classify(Track t)
        {
            var s = Settings;
            // A height cut off at the top of the view is a lower bound: too short cannot be decided
            if (t.Height > s.PersonMaxHeight) return NotPerson(t, $"too tall {t.Height:0.00} m");
            if (t.Height < s.PersonMinHeight && !t.HeightMaybeCut) return NotPerson(t, $"too short {t.Height:0.00} m");
            if (t.Span > s.MaxSpan) return NotPerson(t, $"too long {t.Span:0.0} m");
            if (t.Footprint > s.MaxFootprint) return NotPerson(t, $"too big {t.Footprint:0.0} m²");
            t.NotPersonReason = null;
            if (s.MovementRequired && !t.HasMoved) return TrackKind.StillObject;
            return TrackKind.PersonCandidate;
        }

        private static TrackKind NotPerson(Track t, string reason)
        {
            t.NotPersonReason = reason;
            return TrackKind.NotPerson;
        }

        /// <summary>A change to or from "not a person" needs KindConfirmUpdates updates in a row.</summary>
        private void SetKind(Track t, TrackKind k)
        {
            bool involvesNotPerson = k == TrackKind.NotPerson || t.Kind == TrackKind.NotPerson;
            if (!t.Classified || k == t.Kind || !involvesNotPerson)
            {
                t.Kind = k;
                t.Classified = true;
                t.PendingCount = 0;
                return;
            }
            if (k == t.PendingKind) t.PendingCount++;
            else { t.PendingKind = k; t.PendingCount = 1; }
            if (t.PendingCount >= Settings.KindConfirmUpdates)
            {
                t.Kind = k;
                t.PendingCount = 0;
            }
        }

        /// <summary>
        /// True when most of the object's upper part (at least MinArrivedCells cells) is now in
        /// space that was seen empty before: it came there. Parts that were hidden or out of view
        /// before, or where something already stood, do not count.
        /// </summary>
        private bool CameIntoEmptySpace(Blob blob)
        {
            var s = Settings;
            float low = Math.Max(s.PassBandLow, blob.Top - s.PassBandDepth);
            EmptySpace.Arrival(blob.TopCellKeys, low, blob.Top, out int inEmpty, out int notEmpty);
            return inEmpty >= s.MinArrivedCells && inEmpty >= notEmpty;
        }

        /// <summary>
        /// The object's upper part is something solid: mostly places where something stood (not
        /// seen through) or that it came into, not a surface's points spilling into the empty cell
        /// next to it.
        /// </summary>
        private bool SolidHere(Blob blob)
        {
            var s = Settings;
            float low = Math.Max(s.PassBandLow, blob.Top - s.PassBandDepth);
            EmptySpace.Arrival(blob.TopCellKeys, low, blob.Top, out int inEmpty, out int notEmpty, out int edge);
            int solid = inEmpty + notEmpty;
            return solid >= 1 && solid >= edge;
        }

        /// <summary>
        /// Looks at the object's old spot in this update, at the height of its upper part (its top
        /// 0.5 m: a hollow object, a rack, has gaps lower down): seen empty, or something there.
        /// When the object still covers its old spot (a change of view, not a move), no evidence.
        /// </summary>
        private void LookAtOldSpot(Track t, Blob blob)
        {
            var s = Settings;
            int ix = (int)Math.Floor(t.RefX / s.CellSize), iz = (int)Math.Floor(t.RefZ / s.CellSize);
            if (blob.CellKeys != null && blob.CellKeys.Contains(Key(ix, iz))) return;
            float high = Math.Min(t.Height - 0.05f, s.PassBandHigh);
            float low = Math.Max(s.PassBandLow, t.Height - s.PassBandDepth);
            if (high <= low) return;
            EmptySpace.LookAt(t.RefX, t.RefZ, low, high, out bool seenEmpty, out bool hit);
            if (hit) t.StreakOccupied++;
            else if (seenEmpty) t.StreakFree++;
        }

        private static float Median(List<float> values)
        {
            var sorted = new List<float>(values);
            sorted.Sort();
            int m = sorted.Count / 2;
            return sorted.Count % 2 == 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) * 0.5f;
        }

        private static float Dist(float ax, float az, float bx, float bz)
        {
            float dx = ax - bx, dz = az - bz;
            return (float)Math.Sqrt(dx * dx + dz * dz);
        }
    }
}
