// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Person-like object detection from depth points (feature 8D).
//
// Plain C# with no Unity dependency, so it can be tested automatically outside
// Unity (quest3_client/Tests~/DetectionTests). The headset feeds it the 3D
// points the depth sensor sees (world metres, y up) a few times per second.
//
// 1. Points are put into a floor grid of 10 cm cells; each cell keeps the
//    highest point above the floor. Points near the floor, very high points and
//    points close to the wearer (own hands and body) are left out, and so are
//    cells with a single point (sensor noise at edges).
// 2. Cells taller than any person (walls, door frames, wardrobes: top above
//    2.25 m) are structure and are removed before grouping, so a bed against a
//    wall is not merged with the wall and keeps its own height.
// 3. Touching cells form objects: height, footprint, and a position taken from
//    the object's upper part (its top 30 cm), which looks the same from every
//    side; the lower part a hollow object shows changes with the view.
// 4. A tracker follows each object. An object only continues as the same one
//    when the new one is close AND of similar height (a hidden rack cannot be
//    taken over by the chair next to it). "Moved" needs sustained movement: the
//    median of the last five positions must stay at least 0.4 m from the median
//    of the first five, for five updates in a row (1 s at 5 Hz), seen without a
//    gap and at a steady height. Single jumps from noise or a momentary merge
//    never count. A sudden height jump does not move the object. Why an object
//    counts as moved is kept (walked how far, or seen moving here before).
// 5. A person candidate is person-sized and, unless switched off for testing,
//    has moved. "Moved" stays while tracked and is remembered for a short time
//    at the spot where it was lost (looked away), so a person who stands still
//    does not become furniture. An object that never moved stays "not a
//    person": a cabinet missing from the ward plan is ignored.
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
        public float MoveDistance = 0.40f;      // m between the start and the current position
        public int MedianOf = 5;                // updates in the start and current medians
        public int MoveConfirmUpdates = 5;      // updates in a row beyond MoveDistance
        public float MaxHeightJump = 0.35f;     // m: a bigger change in one update is a merge
        public int MaxJumpSkips = 3;            // after that many, the new height is accepted
        public float MatchDistance = 0.60f;     // m between updates to stay the same object
        public float MatchHeightDiff = 0.50f;   // m: a bigger height difference is another object
        public float MaxGapInStreak = 0.5f;     // s unseen that restarts the movement count
        public float StreakHeightDiff = 0.25f;  // m height change that restarts the movement count
        public float MemoryHeightDiff = 0.25f;  // m: a remembered moved object must have a similar height
        public float LostAfter = 2.0f;          // s unseen before an object is dropped
        public float RememberMovedFor = 30f;    // s a lost moved object is remembered at its spot
        public float HeightSmoothing = 0.3f;
    }

    public sealed class Blob
    {
        public float X, Z;          // position of the upper part, world metres
        public float Top;           // m above the floor
        public bool TopMaybeCut;    // its highest points were at the top edge of the view
        public int Cells;
        public float Footprint;     // m²
        public float SpanX, SpanZ;  // m
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
        public bool HasMoved;
        /// <summary>Why it counts as moved: Walked (MovedDistance m) or SeenMovingHere (remembered).</summary>
        public MovedEvidence MovedBy;
        public float MovedDistance;
        public float Speed;             // m/s, smoothed
        public TrackKind Kind;
        public bool SeenThisUpdate;

        internal readonly List<float> FirstXs = new List<float>(), FirstZs = new List<float>();
        internal readonly List<float> RecentXs = new List<float>(), RecentZs = new List<float>();
        internal int MoveStreak;
        internal float StreakHeight;
        internal int JumpSkips;
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

        private readonly List<float> _recent = new List<float>();

        /// <summary>The measured floor (world y), or null while the floor has not been seen.</summary>
        public float? Floor { get; private set; }

        public void Reset() { _recent.Clear(); Floor = null; }

        /// <summary>Measures the floor in this update's points; returns the floor to use.</summary>
        public float Update(IReadOnlyList<DepthPoint> points, float guessY)
        {
            float? m = Measure(points, guessY);
            // The floor does not rise: a higher layer is a bed or table top seen without the
            // floor. A clearly lower layer means the earlier one was not the floor.
            if (m.HasValue && Floor.HasValue && m.Value > Floor.Value + Tolerance) m = null;
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

    public sealed class PersonDetector
    {
        public readonly DetectorSettings Settings;
        private readonly List<Track> _tracks = new List<Track>();
        private readonly List<(float x, float z, float height, float until)> _movedMemory = new List<(float, float, float, float)>();
        private int _nextId = 1;

        public IReadOnlyList<Track> Tracks => _tracks;
        public int LastPointCount { get; private set; }
        public int LastUsedPointCount { get; private set; }
        public int LastStructureCells { get; private set; }
        public IReadOnlyList<Blob> LastBlobs => _lastBlobs;
        private List<Blob> _lastBlobs = new List<Blob>();

        public PersonDetector(DetectorSettings settings = null)
        {
            Settings = settings ?? new DetectorSettings();
        }

        public void Reset()
        {
            _tracks.Clear();
            _movedMemory.Clear();
            _lastBlobs.Clear();
        }

        /// <summary>
        /// One update. floorY: floor height (world y). head: the wearer's head position.
        /// now: time in seconds (any clock that only goes forward).
        /// </summary>
        public void Process(IReadOnlyList<DepthPoint> points, float floorY, float headX, float headZ, float now)
        {
            _lastBlobs = FindBlobs(points, floorY, headX, headZ);
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

        public List<Blob> FindBlobs(IReadOnlyList<DepthPoint> points, float floorY, float headX, float headZ)
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
                blobs.Add(MakeBlob(kept, members));
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
            foreach (long k in members)
            {
                if (cells[k].top < top - s.TopBand) continue;
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
            };
        }

        private static void SetLabel(Dictionary<long, Cell> grid, long key, int label)
        {
            Cell c = grid[key];
            c.label = label;
            grid[key] = c;
        }

        private static long Key(int ix, int iz) => ((long)ix << 32) ^ (uint)iz;
        private static void Unkey(long key, out int ix, out int iz)
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
                t.Kind = Classify(t);
            }
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
            t.Displacement = Dist(t.X, t.Z, t.StartX, t.StartZ);
            if (t.Displacement > t.MaxDisplacement) t.MaxDisplacement = t.Displacement;
            if (t.Displacement >= s.MoveDistance)
            {
                if (t.MoveStreak == 0) t.StreakHeight = t.Height;
                // the same object all along: its height stays steady while it moves
                t.MoveStreak = Math.Abs(t.Height - t.StreakHeight) <= s.StreakHeightDiff ? t.MoveStreak + 1 : 0;
            }
            else
            {
                t.MoveStreak = 0;
            }
            if (t.MoveStreak >= s.MoveConfirmUpdates && !t.HasMoved)
            {
                t.HasMoved = true;
                t.MovedBy = MovedEvidence.Walked;
                t.MovedDistance = t.Displacement;
            }
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
            bool sizeOk = t.Footprint <= s.MaxFootprint && t.Span <= s.MaxSpan;
            // A height cut off at the top of the view is a lower bound: too short cannot be decided
            bool heightOk = t.Height <= s.PersonMaxHeight && (t.Height >= s.PersonMinHeight || t.HeightMaybeCut);
            if (!sizeOk || !heightOk) return TrackKind.NotPerson;
            if (s.MovementRequired && !t.HasMoved) return TrackKind.StillObject;
            return TrackKind.PersonCandidate;
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
