// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Person-like object detection from depth points (feature 8D).
//
// Plain C# with no Unity dependency, so it can be tested automatically outside
// Unity (tools/detection_tests). The headset feeds it the 3D points the depth
// sensor sees (world metres, y up) a few times per second.
//
// 1. Points are put into a floor grid of 10 cm cells; each cell keeps the
//    highest point above the floor. Points near the floor, very high points and
//    points close to the wearer (own hands and body) are left out.
// 2. Touching cells form objects ("blobs"): position, height, footprint.
// 3. A tracker follows each object over time (id, position, height, how far it
//    has moved since it was first seen, speed).
// 4. An object is a person candidate when its height is in the person range
//    and, unless switched off for testing, it has moved at least 0.4 m since it
//    was first seen. "Has moved" stays for that object while it is tracked, and
//    is remembered for a short time at that spot if it is lost (looked away),
//    so a person who stands still does not become furniture.
// An object that never moved stays "not a person" however tall it is: a
// cabinet missing from the ward plan is ignored without being configured.
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
        public float MinPointHeight = 0.15f;    // m above the floor: lower points are floor
        public float MaxPointHeight = 2.40f;    // m above the floor: higher points are ceiling/lamps
        public float SelfRadius = 0.55f;        // m around the wearer's head (own hands, body)
        public int MinBlobCells = 3;            // smaller objects are noise
        public float MaxFootprint = 1.2f;       // m², larger objects are furniture or walls
        public float MaxSpan = 1.4f;            // m, longest side of the footprint
        public float PersonMinHeight = 0.90f;   // m, standing or walking
        public float PersonMaxHeight = 2.10f;   // m
        public bool MovementRequired = true;    // false only for testing (height only)
        public float MoveDistance = 0.40f;      // m since first seen
        public float MatchDistance = 0.60f;     // m between updates to stay the same object
        public float LostAfter = 2.0f;          // s unseen before an object is dropped
        public float RememberMovedFor = 30f;    // s a lost moved object is remembered at its spot
        public float PositionSmoothing = 0.5f;  // 0..1, weight of the new measurement
        public float HeightSmoothing = 0.3f;
    }

    public sealed class Blob
    {
        public float X, Z;          // centre on the floor, world metres
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

    public sealed class Track
    {
        public int Id;
        public float X, Z;              // smoothed position
        public float Height;            // smoothed height above the floor
        public bool HeightMaybeCut;
        public float Footprint;
        public float Span;              // m, longest side of the footprint
        public float FirstX, FirstZ;
        public float FirstSeen, LastSeen;
        public float MaxDisplacement;   // m from where it was first seen
        public bool HasMoved;
        public float Speed;             // m/s, smoothed
        public TrackKind Kind;
        public bool SeenThisUpdate;
    }

    public sealed class PersonDetector
    {
        public readonly DetectorSettings Settings;
        private readonly List<Track> _tracks = new List<Track>();
        private readonly List<(float x, float z, float until)> _movedMemory = new List<(float, float, float)>();
        private int _nextId = 1;

        public IReadOnlyList<Track> Tracks => _tracks;
        public int LastPointCount { get; private set; }
        public int LastUsedPointCount { get; private set; }
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

        // ----- 1 + 2: floor grid and objects -----

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

            // Connected cells (8 neighbours) form one object
            var blobs = new List<Blob>();
            var keys = new List<long>(grid.Keys);
            int label = 0;
            var stack = new Stack<long>();
            var members = new List<long>();
            foreach (long start in keys)
            {
                if (grid[start].label != 0) continue;
                label++;
                members.Clear();
                stack.Push(start);
                SetLabel(grid, start, label);
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
                            if (grid.TryGetValue(n, out Cell nc) && nc.label == 0)
                            {
                                SetLabel(grid, n, label);
                                stack.Push(n);
                            }
                        }
                }

                if (members.Count < s.MinBlobCells) continue;

                float sumX = 0, sumZ = 0, sumW = 0, top = 0;
                bool topCut = false;
                int minX = int.MaxValue, maxX = int.MinValue, minZ = int.MaxValue, maxZ = int.MinValue;
                foreach (long k in members)
                {
                    Unkey(k, out int cx, out int cz);
                    Cell c = grid[k];
                    float w = c.count;
                    sumX += (cx + 0.5f) * s.CellSize * w;
                    sumZ += (cz + 0.5f) * s.CellSize * w;
                    sumW += w;
                    if (c.top > top) { top = c.top; topCut = c.topAtEdge; }
                    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
                    if (cz < minZ) minZ = cz; if (cz > maxZ) maxZ = cz;
                }
                blobs.Add(new Blob
                {
                    X = sumX / sumW,
                    Z = sumZ / sumW,
                    Top = top,
                    TopMaybeCut = topCut,
                    Cells = members.Count,
                    Footprint = members.Count * s.CellSize * s.CellSize,
                    SpanX = (maxX - minX + 1) * s.CellSize,
                    SpanZ = (maxZ - minZ + 1) * s.CellSize,
                });
            }
            return blobs;
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

        // ----- 3 + 4: tracking and classification -----

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
                    if (d <= s.MatchDistance) pairs.Add((d, b, t));
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
                    X = blob.X, Z = blob.Z, FirstX = blob.X, FirstZ = blob.Z,
                    Height = blob.Top, HeightMaybeCut = blob.TopMaybeCut, Footprint = blob.Footprint, Span = Math.Max(blob.SpanX, blob.SpanZ),
                    FirstSeen = now, LastSeen = now, SeenThisUpdate = true,
                };
                // A moved object that was lost here a moment ago (looked away): still moved
                for (int m = _movedMemory.Count - 1; m >= 0; m--)
                {
                    if (_movedMemory[m].until < now) { _movedMemory.RemoveAt(m); continue; }
                    if (Dist(_movedMemory[m].x, _movedMemory[m].z, blob.X, blob.Z) <= s.MatchDistance)
                    {
                        t.HasMoved = true;
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
                    if (t.HasMoved) _movedMemory.Add((t.X, t.Z, now + s.RememberMovedFor));
                    _tracks.RemoveAt(i);
                    continue;
                }
                t.Kind = Classify(t);
            }
        }

        private void Update(Track t, Blob blob, float now)
        {
            var s = Settings;
            float dt = Math.Max(1e-3f, now - t.LastSeen);
            float nx = t.X + (blob.X - t.X) * s.PositionSmoothing;
            float nz = t.Z + (blob.Z - t.Z) * s.PositionSmoothing;
            float speed = Dist(nx, nz, t.X, t.Z) / dt;
            t.Speed = t.Speed + (speed - t.Speed) * 0.5f;
            t.X = nx;
            t.Z = nz;
            t.Height = t.Height + (blob.Top - t.Height) * s.HeightSmoothing;
            t.HeightMaybeCut = blob.TopMaybeCut;
            t.Footprint = blob.Footprint;
            t.Span = Math.Max(blob.SpanX, blob.SpanZ);
            t.LastSeen = now;
            t.SeenThisUpdate = true;
            float disp = Dist(t.X, t.Z, t.FirstX, t.FirstZ);
            if (disp > t.MaxDisplacement) t.MaxDisplacement = disp;
            if (t.MaxDisplacement >= s.MoveDistance) t.HasMoved = true;
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

        private static float Dist(float ax, float az, float bx, float bz)
        {
            float dx = ax - bx, dz = az - bz;
            return (float)Math.Sqrt(dx * dx + dz * dz);
        }
    }
}
