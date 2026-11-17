// Realistic tests of the person detector: a small ray-caster produces the depth
// points the way the headset does (40 x 30 rays over the view, shifted by a random
// fraction of a ray each update, two updates combined, up to 6 m), with occlusion,
// the floor, walls and furniture. Objects are simple shapes; the clothes rack is
// hollow like the real one (a thin pole, a hanging jacket, a hook bar).
// The earlier point-based tests had no occlusion and too many points, so passing
// them did not mean the detector would work on the headset.
using System;
using System.Collections.Generic;
using ShiroMR.Detection;

internal static class SceneTests
{
    public static void RunAll(Action<string, Action> run)
    {
        run("scene: walking around a room for 2 minutes (rack, cabinet, monitor, chair): nobody is a person", WalkAroundRoom);
        run("scene: walking a full circle around a still rack at 1.2 m: it is not a person", CircleAroundRack);
        run("scene: an object seen for the first time is never green at once", FirstLookNotGreen);
        run("scene: a rack pushed 0.5 m sideways becomes a person candidate", RackPushedSideways);
        run("scene: a rack pushed 0.5 m away with a foot while looking down, then stepped back: moved", RackPushedAwayLookingDown);
        run("scene: a person walking across the room becomes a person candidate", PersonWalksAcross);
        run("scene: a person pacing 0.35 m back and forth becomes a person candidate", PersonPacing);
    }

    // ----- Scenarios -----

    private static void WalkAroundRoom()
    {
        var sim = new Sim(1);
        Room(sim);
        sim.Static.AddRange(Rack(0.6f, 3.3f));
        sim.Static.Add(new Box(-1.8f, -0.8f, 0f, 1.8f, 4.3f, 4.8f));       // cabinet against the back wall
        sim.Static.Add(new Box(1.2f, 2.2f, 0f, 0.75f, 4.2f, 4.9f));        // desk
        sim.Static.Add(new Box(1.4f, 2.0f, 0.95f, 1.35f, 4.6f, 4.65f));    // monitor on it
        sim.Static.Add(new Box(1.65f, 1.75f, 0.75f, 0.95f, 4.55f, 4.7f));  // monitor stand
        sim.Static.Add(new Box(-2.2f, -1.75f, 0f, 0.9f, 1.0f, 1.45f));     // chair at the left wall
        var d = new PersonDetector();
        for (int i = 0; i < 600; i++) // 2 minutes
        {
            float t = i * 0.2f;
            double a = t * 2 * Math.PI / 40;                         // one round in 40 s
            sim.CamX = (float)(0.9 * Math.Sin(a));
            sim.CamZ = 2.0f - (float)(0.9 * Math.Cos(a));
            float toCentre = (float)Math.Atan2(0 - sim.CamX, 2.6f - sim.CamZ);
            sim.Yaw = toCentre + 0.9f * (float)Math.Sin(t * 2 * Math.PI / 7);
            sim.Pitch = -0.25f + 0.15f * (float)Math.Sin(t * 2 * Math.PI / 5);
            sim.Step(d, t);
            NobodyGreen(d, $"at {t:0.0} s");
        }
    }

    private static void CircleAroundRack()
    {
        var sim = new Sim(2);
        Room(sim);
        sim.Static.AddRange(Rack(0f, 2.5f));
        var d = new PersonDetector();
        for (int i = 0; i < 300; i++) // one minute, two rounds, always looking at the rack
        {
            float t = i * 0.2f;
            double a = t * 2 * Math.PI / 30;
            sim.CamX = (float)(1.2 * Math.Sin(a));
            sim.CamZ = 2.5f - (float)(1.2 * Math.Cos(a));
            sim.Yaw = (float)Math.Atan2(0 - sim.CamX, 2.5f - sim.CamZ) + 0.25f * (float)Math.Sin(t);
            sim.Pitch = -0.3f;
            sim.Step(d, t);
            NobodyGreen(d, $"at {t:0.0} s");
        }
    }

    private static void FirstLookNotGreen()
    {
        var sim = new Sim(3);
        Room(sim);
        sim.Static.Add(new Box(1.2f, 2.2f, 0f, 0.75f, 4.2f, 4.9f));
        sim.Static.Add(new Box(1.4f, 2.0f, 0.95f, 1.35f, 4.6f, 4.65f));
        sim.Static.Add(new Box(-1.8f, -0.8f, 0f, 1.8f, 4.3f, 4.8f));
        var d = new PersonDetector();
        sim.CamX = 0f; sim.CamZ = 1.0f; sim.Pitch = -0.2f;
        float t = 0f;
        for (int i = 0; i < 50; i++, t += 0.2f) { sim.Yaw = -1.6f; sim.Step(d, t); }   // looking at the left wall
        for (int i = 0; i < 20; i++, t += 0.2f) { sim.Yaw = -1.6f + i * 0.08f; sim.Step(d, t); NobodyGreen(d, $"turning, {t:0.0} s"); }
        for (int i = 0; i < 30; i++, t += 0.2f) { sim.Step(d, t); NobodyGreen(d, $"looking, {t:0.0} s"); }
    }

    private static void RackPushedSideways()
    {
        var sim = new Sim(4);
        Room(sim);
        var d = new PersonDetector();
        sim.CamX = 0f; sim.CamZ = 1.0f; sim.Yaw = 0f; sim.Pitch = -0.25f;
        float t = 0f, rx = 0f;
        for (int i = 0; i < 15; i++, t += 0.2f) { sim.Moving = Rack(rx, 2.6f); sim.Step(d, t); }
        NobodyGreen(d, "before the push");
        for (int i = 0; i < 12; i++, t += 0.2f) { rx += 0.5f / 12; sim.Moving = Rack(rx, 2.6f); sim.Step(d, t); }
        bool green = false;
        for (int i = 0; i < 20; i++, t += 0.2f)
        {
            sim.Moving = Rack(rx, 2.6f);
            sim.Step(d, t);
            if (Near(d, rx, 2.6f)?.Kind == TrackKind.PersonCandidate) green = true;
        }
        True(green, "the pushed rack became a person candidate within 4 s " + Dump(d));
    }

    private static void RackPushedAwayLookingDown()
    {
        var sim = new Sim(5);
        Room(sim);
        var d = new PersonDetector();
        float t = 0f, rz = 2.5f;
        sim.CamX = 0f; sim.CamZ = 1.0f; sim.Yaw = 0f; sim.Pitch = -0.2f;
        for (int i = 0; i < 15; i++, t += 0.2f) { sim.Moving = Rack(0f, rz); sim.Step(d, t); }
        for (int i = 0; i < 8; i++, t += 0.2f) { sim.CamZ += 0.1f; sim.Pitch -= 0.05f; sim.Moving = Rack(0f, rz); sim.Step(d, t); } // walks up, looks down
        for (int i = 0; i < 12; i++, t += 0.2f) { rz += 0.5f / 12; sim.CamZ += 0.5f / 12; sim.Moving = Rack(0f, rz); sim.Step(d, t); }
        for (int i = 0; i < 5; i++, t += 0.2f) { sim.Moving = Rack(0f, rz); sim.Step(d, t); }
        bool green = false;
        for (int i = 0; i < 8; i++, t += 0.2f)
        {
            sim.CamZ -= 0.1f; sim.Pitch += 0.05f; sim.Moving = Rack(0f, rz); sim.Step(d, t);  // steps back, looks up
            if (Near(d, 0f, rz)?.Kind == TrackKind.PersonCandidate) green = true;
        }
        for (int i = 0; i < 15; i++, t += 0.2f)
        {
            sim.Moving = Rack(0f, rz);
            sim.Step(d, t);
            if (Near(d, 0f, rz)?.Kind == TrackKind.PersonCandidate) green = true;
        }
        True(green, "the pushed rack became a person candidate " + Dump(d));
    }

    private static void PersonWalksAcross()
    {
        var sim = new Sim(6);
        Room(sim);
        var d = new PersonDetector();
        sim.CamX = 0f; sim.CamZ = 0.5f; sim.Yaw = 0f; sim.Pitch = -0.15f;
        float t = 0f, px = -1.5f;
        bool green = false;
        for (int i = 0; i < 30; i++, t += 0.2f)
        {
            px += 0.12f; // 0.6 m/s
            sim.Moving = Person(px, 3.0f, 1.70f);
            sim.Step(d, t);
            if (Near(d, px, 3.0f)?.Kind == TrackKind.PersonCandidate) green = true;
        }
        True(green, "the walking person became a person candidate " + Dump(d));
    }

    private static void PersonPacing()
    {
        var sim = new Sim(7);
        Room(sim);
        var d = new PersonDetector();
        sim.CamX = 0f; sim.CamZ = 0.5f; sim.Yaw = 0f; sim.Pitch = -0.15f;
        float t = 0f, px = 0f;
        bool green = false;
        void Hold(int n) { for (int i = 0; i < n; i++, t += 0.2f) { sim.Moving = Person(px, 3f, 1.65f); sim.Step(d, t); if (Near(d, px, 3f)?.Kind == TrackKind.PersonCandidate) green = true; } }
        void Walk(float to) { float from = px; for (int i = 1; i <= 3; i++, t += 0.2f) { px = from + (to - from) * i / 3f; sim.Moving = Person(px, 3f, 1.65f); sim.Step(d, t); } }
        Hold(8);
        for (int c = 0; c < 4; c++) { Walk(0.35f); Hold(6); Walk(0f); Hold(6); }
        True(green, "pacing became a person candidate " + Dump(d));
    }

    // ----- Room and objects -----

    private static void Room(Sim sim)
    {
        // 5 m x 5.5 m, 2.6 m high
        sim.Static.Add(new Box(-2.5f, 2.5f, 0f, 2.6f, 5.0f, 5.1f));   // back wall
        sim.Static.Add(new Box(-2.6f, -2.5f, 0f, 2.6f, -0.5f, 5.1f)); // left wall
        sim.Static.Add(new Box(2.5f, 2.6f, 0f, 2.6f, -0.5f, 5.1f));   // right wall
    }

    /// <summary>A clothes rack with a jacket: a thin pole, a hook bar on top, the jacket hanging below it.</summary>
    private static List<Shape> Rack(float x, float z) => new List<Shape>
    {
        new Cyl(x, z, 0.015f, 0f, 1.65f),                              // pole
        new Box(x - 0.22f, x + 0.22f, 1.60f, 1.65f, z - 0.015f, z + 0.015f), // hook bar
        new Box(x - 0.25f, x + 0.25f, 0.85f, 1.50f, z - 0.06f, z + 0.06f),   // jacket
        new Box(x - 0.30f, x + 0.30f, 0f, 0.05f, z - 0.03f, z + 0.03f),      // feet
        new Box(x - 0.03f, x + 0.03f, 0f, 0.05f, z - 0.30f, z + 0.30f),
    };

    private static List<Shape> Person(float x, float z, float h) => new List<Shape>
    {
        new Cyl(x, z, 0.17f, 0f, h - 0.25f),          // body
        new Cyl(x, z, 0.10f, h - 0.25f, h),           // head
    };

    // ----- Checks -----

    private static Track Near(PersonDetector d, float x, float z)
    {
        Track best = null;
        float bestD = 0.5f;
        foreach (var t in d.Tracks)
        {
            float dd = (float)Math.Sqrt((t.X - x) * (t.X - x) + (t.Z - z) * (t.Z - z));
            if (dd < bestD) { best = t; bestD = dd; }
        }
        return best;
    }

    private static void NobodyGreen(PersonDetector d, string when)
    {
        foreach (var t in d.Tracks)
            if (t.Kind == TrackKind.PersonCandidate)
                throw new Exception($"{when}: #{t.Id} at ({t.X:0.00}, {t.Z:0.00}) h {t.Height:0.00} is green ({t.MovedBy}, steps {t.Steps}, path {t.PathLength:0.00})");
    }

    private static string Dump(PersonDetector d)
    {
        var parts = new List<string>();
        foreach (var t in d.Tracks)
            parts.Add($"#{t.Id} ({t.X:0.00},{t.Z:0.00}) h {t.Height:0.00} {t.Kind} steps {t.Steps} path {t.PathLength:0.00} {t.Waiting} {t.NotPersonReason}");
        return "[" + string.Join("; ", parts) + "]";
    }

    private static void True(bool cond, string what)
    {
        if (!cond) throw new Exception(what);
    }

    // ----- The ray-caster -----

    internal abstract class Shape
    {
        public abstract bool Hit(float ox, float oy, float oz, float dx, float dy, float dz, out float t);
    }

    internal sealed class Box : Shape
    {
        private readonly float _x0, _x1, _y0, _y1, _z0, _z1;
        public Box(float x0, float x1, float y0, float y1, float z0, float z1) { _x0 = x0; _x1 = x1; _y0 = y0; _y1 = y1; _z0 = z0; _z1 = z1; }

        public override bool Hit(float ox, float oy, float oz, float dx, float dy, float dz, out float t)
        {
            float tmin = 0f, tmax = float.MaxValue;
            t = 0f;
            if (!Slab(ox, dx, _x0, _x1, ref tmin, ref tmax)) return false;
            if (!Slab(oy, dy, _y0, _y1, ref tmin, ref tmax)) return false;
            if (!Slab(oz, dz, _z0, _z1, ref tmin, ref tmax)) return false;
            t = tmin;
            return tmin > 1e-4f;
        }

        private static bool Slab(float o, float d, float lo, float hi, ref float tmin, ref float tmax)
        {
            if (Math.Abs(d) < 1e-9f) return o >= lo && o <= hi;
            float t1 = (lo - o) / d, t2 = (hi - o) / d;
            if (t1 > t2) { float tmp = t1; t1 = t2; t2 = tmp; }
            if (t1 > tmin) tmin = t1;
            if (t2 < tmax) tmax = t2;
            return tmin <= tmax;
        }
    }

    internal sealed class Cyl : Shape
    {
        private readonly float _x, _z, _r, _y0, _y1;
        public Cyl(float x, float z, float r, float y0, float y1) { _x = x; _z = z; _r = r; _y0 = y0; _y1 = y1; }

        public override bool Hit(float ox, float oy, float oz, float dx, float dy, float dz, out float t)
        {
            t = float.MaxValue;
            bool hit = false;
            float px = ox - _x, pz = oz - _z;
            float a = dx * dx + dz * dz;
            if (a > 1e-9f)
            {
                float b = 2 * (px * dx + pz * dz);
                float c = px * px + pz * pz - _r * _r;
                float disc = b * b - 4 * a * c;
                if (disc >= 0)
                {
                    float t1 = (-b - (float)Math.Sqrt(disc)) / (2 * a);
                    float y = oy + t1 * dy;
                    if (t1 > 1e-4f && y >= _y0 && y <= _y1) { t = t1; hit = true; }
                }
            }
            if (Math.Abs(dy) > 1e-9f)
            {
                float tc = (_y1 - oy) / dy; // top cap
                float cx = px + tc * dx, cz = pz + tc * dz;
                if (tc > 1e-4f && cx * cx + cz * cz <= _r * _r && tc < t) { t = tc; hit = true; }
            }
            return hit;
        }
    }

    internal sealed class Sim
    {
        private const int Cols = 40, Rows = 30;
        private const float HFov = 1.57f, VFov = 1.22f, MaxRange = 6f; // 90° x 70°
        public float CamX, CamY = 1.6f, CamZ, Yaw, Pitch;
        public readonly List<Shape> Static = new List<Shape>();
        public List<Shape> Moving = new List<Shape>();
        private readonly Random _rnd;
        private List<DepthPoint> _previous = new List<DepthPoint>();

        public Sim(int seed) { _rnd = new Random(seed); }

        /// <summary>One detection update, as on the headset: this sweep plus the previous one.</summary>
        public void Step(PersonDetector d, float now)
        {
            var points = Cast();
            var combined = new List<DepthPoint>(points);
            combined.AddRange(_previous);
            _previous = points;
            d.Process(combined, 0f, CamX, CamY, CamZ, now);
        }

        public List<DepthPoint> Cast()
        {
            var pts = new List<DepthPoint>(Cols * Rows);
            float jx = (float)_rnd.NextDouble() - 0.5f, jy = (float)_rnd.NextDouble() - 0.5f;
            float th = (float)Math.Tan(HFov / 2), tv = (float)Math.Tan(VFov / 2);
            float cp = (float)Math.Cos(Pitch), sp = (float)Math.Sin(Pitch);
            float cy = (float)Math.Cos(Yaw), sy = (float)Math.Sin(Yaw);
            for (int r = 0; r < Rows; r++)
                for (int c = 0; c < Cols; c++)
                {
                    float u = (((c + 0.5f + jx) / Cols) - 0.5f) * 2 * th;
                    float v = (((r + 0.5f + jy) / Rows) - 0.5f) * 2 * tv;
                    float len = (float)Math.Sqrt(u * u + v * v + 1);
                    float x0 = u / len, y0 = v / len, z0 = 1 / len;
                    float y1 = y0 * cp + z0 * sp, z1 = -y0 * sp + z0 * cp;  // pitch
                    float dx = x0 * cy + z1 * sy, dz = -x0 * sy + z1 * cy;  // yaw
                    float dy = y1;

                    float best = MaxRange;
                    bool hit = false;
                    if (dy < -1e-6f) { float tf = -CamY / dy; if (tf < best) { best = tf; hit = true; } }
                    foreach (var s in Static) if (s.Hit(CamX, CamY, CamZ, dx, dy, dz, out float ts) && ts < best) { best = ts; hit = true; }
                    foreach (var s in Moving) if (s.Hit(CamX, CamY, CamZ, dx, dy, dz, out float ts) && ts < best) { best = ts; hit = true; }
                    if (!hit) continue;
                    pts.Add(new DepthPoint(CamX + dx * best, CamY + dy * best, CamZ + dz * best, r >= Rows - 2));
                }
            return pts;
        }
    }
}
