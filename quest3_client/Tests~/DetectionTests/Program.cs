// Automated tests of the person detection core (ShiroPersonDetection.cs), with
// made-up depth points: objects are sampled the way the headset sees them, on
// the side facing the wearer. Exit code 0 = all passed.
using System;
using System.Collections.Generic;
using ShiroMR.Detection;

internal static class Program
{
    private const float Floor = 0f;
    private const float HeadX = 0f, HeadZ = 0f; // the wearer stands at the origin
    private static int _passed, _failed;

    private static int Main()
    {
        Run("a standing person's height is measured from the visible side (±5 cm)", PersonHeight);
        Run("floor points alone are no object", FloorOnly);
        Run("the wearer's own hands and body are left out", SelfIgnored);
        Run("a tall cabinet that never moves is not a person (stays 'still')", StaticCabinet);
        Run("with movement switched off (test), the same cabinet counts on height alone", CabinetHeightOnly);
        Run("a moved clothes rack becomes a person candidate and stays one when it stops", RackMovedThenStill);
        Run("a low moving object (trolley, pet) is not a person", LowMovingObject);
        Run("a 1.1 m child who walks is a person candidate", ChildWalking);
        Run("an object taller than a person is not one", TooTall);
        Run("a long wall is not a person", Wall);
        Run("two people keep their own ids while walking side by side", TwoPeople);
        Run("a person who moved is still 'moved' after being out of view for a few seconds", LostAndFound);
        Run("an object lost for longer than the memory starts again as 'still'", LostTooLong);
        Run("a height cut off at the top of the view is not rejected as too short", TopCut);
        Run("a bed against a wall keeps its own height (the wall is not part of it)", BedAgainstWall);
        Run("a full-height wall is removed, not shown as an object", FullWall);
        Run("a still rack seen with noisy, partial views never counts as moved", NoisyStillRack);
        Run("a chair briefly merging with a still rack does not move it", MergeGlitch);
        Run("scattered single noise points make no object", ScatteredNoise);
        Run("a person who walks 0.6 m and stops counts as moved", ShortWalk);
        Run("the floor is measured from the points even when the headset's guess is 25 cm off", FloorMeasured);
        Run("the floor measurement ignores a bed top and keeps its value when no floor is seen", FloorNotFooledByBed);
        Run("a still rack next to a wall, floor guessed 25 cm low, noisy views: still, correct height", RoomScene);

        Console.WriteLine();
        Console.WriteLine($"{_passed} passed, {_failed} failed");
        return _failed == 0 ? 0 : 1;
    }

    // ----- Scenarios -----

    private static void PersonHeight()
    {
        var d = new PersonDetector();
        d.Process(Cylinder(0f, 2.5f, 0.2f, 1.62f), Floor, HeadX, HeadZ, 0f);
        Equal(1, d.Tracks.Count, "objects");
        Near(1.62f, d.Tracks[0].Height, 0.05f, "height");
        Near(2.5f, d.Tracks[0].Z, 0.25f, "distance");
    }

    private static void FloorOnly()
    {
        var d = new PersonDetector();
        var pts = new List<DepthPoint>();
        for (float x = -2; x <= 2; x += 0.1f)
            for (float z = 0.5f; z <= 4; z += 0.1f)
                pts.Add(new DepthPoint(x, Floor + 0.02f, z));
        d.Process(pts, Floor, HeadX, HeadZ, 0f);
        Equal(0, d.Tracks.Count, "objects");
    }

    private static void SelfIgnored()
    {
        var d = new PersonDetector();
        var pts = Cylinder(0.1f, 0.3f, 0.1f, 1.3f); // hands / body right in front of the wearer
        d.Process(pts, Floor, HeadX, HeadZ, 0f);
        Equal(0, d.Tracks.Count, "objects");
    }

    private static void StaticCabinet()
    {
        var d = new PersonDetector();
        for (int i = 0; i <= 600; i++) // 120 s at 5 Hz
            d.Process(Box(1.0f, 3.0f, 0.6f, 0.4f, 1.9f), Floor, HeadX, HeadZ, i * 0.2f);
        Equal(1, d.Tracks.Count, "objects");
        Equal(TrackKind.StillObject, d.Tracks[0].Kind, "kind");
    }

    private static void CabinetHeightOnly()
    {
        var d = new PersonDetector(new DetectorSettings { MovementRequired = false });
        d.Process(Box(1.0f, 3.0f, 0.6f, 0.4f, 1.9f), Floor, HeadX, HeadZ, 0f);
        Equal(TrackKind.PersonCandidate, d.Tracks[0].Kind, "kind");
    }

    private static void RackMovedThenStill()
    {
        var d = new PersonDetector();
        float t = 0f;
        for (int i = 0; i < 10; i++, t += 0.2f) d.Process(Rack(0f, 3f), Floor, HeadX, HeadZ, t);
        Equal(TrackKind.StillObject, d.Tracks[0].Kind, "before moving");
        int id = d.Tracks[0].Id;
        for (int i = 1; i <= 10; i++, t += 0.2f) d.Process(Rack(i * 0.06f, 3f), Floor, HeadX, HeadZ, t); // 0.6 m in 2 s
        for (int i = 0; i < 6; i++, t += 0.2f) d.Process(Rack(0.6f, 3f), Floor, HeadX, HeadZ, t);     // stays there 1.2 s
        Equal(TrackKind.PersonCandidate, d.Tracks[0].Kind, "after moving");
        for (int i = 0; i < 300; i++, t += 0.2f) d.Process(Rack(0.6f, 3f), Floor, HeadX, HeadZ, t);    // 60 s still
        Equal(1, d.Tracks.Count, "objects");
        Equal(id, d.Tracks[0].Id, "same object");
        Equal(TrackKind.PersonCandidate, d.Tracks[0].Kind, "after standing still");
    }

    private static void LowMovingObject()
    {
        var d = new PersonDetector();
        for (int i = 0; i < 20; i++) d.Process(Box(-1f + i * 0.08f, 2.5f, 0.5f, 0.4f, 0.6f), Floor, HeadX, HeadZ, i * 0.2f);
        Equal(1, d.Tracks.Count, "objects");
        True(d.Tracks[0].HasMoved, "it moved");
        Equal(TrackKind.NotPerson, d.Tracks[0].Kind, "kind");
    }

    private static void ChildWalking()
    {
        var d = new PersonDetector();
        for (int i = 0; i < 20; i++) d.Process(Cylinder(-1f + i * 0.08f, 2.5f, 0.15f, 1.1f), Floor, HeadX, HeadZ, i * 0.2f);
        Equal(TrackKind.PersonCandidate, d.Tracks[0].Kind, "kind");
    }

    private static void TooTall()
    {
        var d = new PersonDetector();
        for (int i = 0; i < 20; i++) d.Process(Box(-1f + i * 0.08f, 3f, 0.5f, 0.5f, 2.3f), Floor, HeadX, HeadZ, i * 0.2f);
        foreach (var t in d.Tracks) True(t.Kind != TrackKind.PersonCandidate, "never a person");
    }

    private static void Wall()
    {
        var d = new PersonDetector(new DetectorSettings { MovementRequired = false });
        d.Process(Box(0f, 3.5f, 3.0f, 0.15f, 1.8f), Floor, HeadX, HeadZ, 0f);
        Equal(TrackKind.NotPerson, d.Tracks[0].Kind, "kind");
    }

    private static void TwoPeople()
    {
        var d = new PersonDetector();
        d.Process(Join(Cylinder(-0.8f, 3f, 0.2f, 1.7f), Cylinder(0.8f, 3f, 0.2f, 1.5f)), Floor, HeadX, HeadZ, 0f);
        Equal(2, d.Tracks.Count, "objects");
        int left = IdNear(d, -0.8f), right = IdNear(d, 0.8f);
        for (int i = 1; i <= 25; i++)
            d.Process(Join(Cylinder(-0.8f, 3f + i * 0.05f, 0.2f, 1.7f), Cylinder(0.8f, 3f + i * 0.05f, 0.2f, 1.5f)), Floor, HeadX, HeadZ, i * 0.2f);
        Equal(2, d.Tracks.Count, "objects");
        Equal(left, IdNear(d, -0.8f), "left keeps its id");
        Equal(right, IdNear(d, 0.8f), "right keeps its id");
        True(d.Tracks[0].Kind == TrackKind.PersonCandidate && d.Tracks[1].Kind == TrackKind.PersonCandidate, "both walked");
    }

    private static void LostAndFound()
    {
        var d = new PersonDetector();
        float t = 0f;
        for (int i = 0; i <= 20; i++, t += 0.2f) d.Process(Cylinder(i * 0.06f, 3f, 0.2f, 1.6f), Floor, HeadX, HeadZ, t);
        Equal(TrackKind.PersonCandidate, d.Tracks[0].Kind, "walked");
        for (int i = 0; i < 25; i++, t += 0.2f) d.Process(new List<DepthPoint>(), Floor, HeadX, HeadZ, t); // 5 s looking away
        Equal(0, d.Tracks.Count, "lost");
        d.Process(Cylinder(1.2f, 3f, 0.2f, 1.6f), Floor, HeadX, HeadZ, t);
        Equal(TrackKind.PersonCandidate, d.Tracks[0].Kind, "found again, standing still");
    }

    private static void LostTooLong()
    {
        var d = new PersonDetector();
        float t = 0f;
        for (int i = 0; i <= 20; i++, t += 0.2f) d.Process(Cylinder(i * 0.06f, 3f, 0.2f, 1.6f), Floor, HeadX, HeadZ, t);
        for (int i = 0; i < 200; i++, t += 0.2f) d.Process(new List<DepthPoint>(), Floor, HeadX, HeadZ, t); // 40 s
        d.Process(Cylinder(1.2f, 3f, 0.2f, 1.6f), Floor, HeadX, HeadZ, t);
        Equal(TrackKind.StillObject, d.Tracks[0].Kind, "starts again");
    }

    private static void TopCut()
    {
        var d = new PersonDetector();
        var pts = Cylinder(0f, 1.0f, 0.2f, 0.8f, topEdgeFrom: 0.75f); // very close: the view ends at 0.8 m
        d.Process(pts, Floor, HeadX, HeadZ, 0f);
        Equal(1, d.Tracks.Count, "objects");
        True(d.Tracks[0].HeightMaybeCut, "height marked as cut");
        Equal(TrackKind.StillObject, d.Tracks[0].Kind, "kind");
    }

    private static void BedAgainstWall()
    {
        var d = new PersonDetector();
        var pts = Join(Box(0f, 3.0f, 2.0f, 0.9f, 0.5f), Box(0f, 3.5f, 4.0f, 0.1f, 2.6f));
        for (int i = 0; i < 10; i++) d.Process(pts, Floor, HeadX, HeadZ, i * 0.2f);
        Equal(1, d.Tracks.Count, "objects");
        Near(0.5f, d.Tracks[0].Height, 0.06f, "bed height");
        Equal(TrackKind.NotPerson, d.Tracks[0].Kind, "kind");
    }

    private static void FullWall()
    {
        var d = new PersonDetector(new DetectorSettings { MovementRequired = false });
        d.Process(Box(0f, 3.5f, 4.0f, 0.1f, 2.6f), Floor, HeadX, HeadZ, 0f);
        Equal(0, d.Tracks.Count, "objects");
    }

    private static void NoisyStillRack()
    {
        var d = new PersonDetector();
        var rnd = new Random(7);
        float t = 0f;
        for (int i = 0; i < 300; i++, t += 0.2f) // 60 s; the wearer walks around: different parts are hit
        {
            var full = Rack(0f, 3f);
            var view = new List<DepthPoint>();
            bool leftOnly = i % 10 < 3, rightOnly = i % 10 >= 7;
            foreach (var p in full)
            {
                if (rnd.NextDouble() < 0.5) continue;                 // half the points missed
                if (leftOnly && p.x > 0.05f) continue;                 // only one side visible
                if (rightOnly && p.x < -0.05f) continue;
                view.Add(new DepthPoint(p.x + Noise(rnd, 0.03f), p.y + Noise(rnd, 0.03f), p.z + Noise(rnd, 0.03f)));
            }
            d.Process(view, Floor, HeadX, HeadZ, t);
        }
        Equal(1, d.Tracks.Count, "objects");
        Equal(TrackKind.StillObject, d.Tracks[0].Kind, "kind");
        True(d.Tracks[0].MaxDisplacement < 0.25f, $"largest displacement small (was {d.Tracks[0].MaxDisplacement:0.00} m)");
    }

    private static void MergeGlitch()
    {
        var d = new PersonDetector();
        for (int i = 0; i < 200; i++)
        {
            var pts = Rack(0f, 3f);
            if (i % 20 == 10) pts = Join(pts, Box(0.45f, 3f, 0.5f, 0.5f, 0.9f)); // a chair touches it for one update
            d.Process(pts, Floor, HeadX, HeadZ, i * 0.2f);
        }
        Equal(TrackKind.StillObject, d.Tracks[0].Kind, "kind");
        True(d.Tracks[0].MaxDisplacement < 0.15f, $"largest displacement small (was {d.Tracks[0].MaxDisplacement:0.00} m)");
    }

    private static void ScatteredNoise()
    {
        var d = new PersonDetector();
        var rnd = new Random(3);
        var pts = new List<DepthPoint>();
        for (int i = 0; i < 80; i++)
            pts.Add(new DepthPoint(-2.5f + 5f * (float)rnd.NextDouble(), 0.2f + 2.1f * (float)rnd.NextDouble(), 1f + 4f * (float)rnd.NextDouble()));
        d.Process(pts, Floor, HeadX, HeadZ, 0f);
        Equal(0, d.Tracks.Count, "objects");
    }

    private static void ShortWalk()
    {
        var d = new PersonDetector();
        float t = 0f;
        for (int i = 0; i < 5; i++, t += 0.2f) d.Process(Cylinder(0f, 3f, 0.2f, 1.6f), Floor, HeadX, HeadZ, t);
        for (int i = 1; i <= 6; i++, t += 0.2f) d.Process(Cylinder(i * 0.1f, 3f, 0.2f, 1.6f), Floor, HeadX, HeadZ, t);
        for (int i = 0; i < 8; i++, t += 0.2f) d.Process(Cylinder(0.6f, 3f, 0.2f, 1.6f), Floor, HeadX, HeadZ, t);
        Equal(TrackKind.PersonCandidate, d.Tracks[0].Kind, "kind");
    }

    private static void FloorMeasured()
    {
        var fe = new FloorEstimator();
        var pts = Join(FloorPatch(0.0f), Rack(0f, 3f));
        float floor = fe.Update(pts, -0.25f);
        Near(0f, floor, 0.03f, "floor");
    }

    private static void FloorNotFooledByBed()
    {
        var fe = new FloorEstimator();
        var withFloor = Join(FloorPatch(0.0f), Box(0f, 2.5f, 2.0f, 0.9f, 0.55f));
        Near(0f, fe.Update(withFloor, 0.1f), 0.03f, "floor, not the bed top");
        var noFloor = Box(0f, 2.5f, 2.0f, 0.9f, 0.55f);
        for (int i = 0; i < 5; i++) noFloor.RemoveAll(p => p.y < 0.5f); // only the bed top is in view
        Near(0f, fe.Update(noFloor, 0.1f), 0.03f, "kept while the floor is not seen");
        var fe2 = new FloorEstimator();
        fe2.Update(noFloor, 0.1f);                       // first sees only the bed top
        Near(0f, fe2.Update(withFloor, 0.1f), 0.03f, "a lower floor replaces it");
    }

    private static void RoomScene()
    {
        var fe = new FloorEstimator();
        var d = new PersonDetector();
        var rnd = new Random(11);
        float guess = -0.25f; // the headset's floor level is 25 cm too low
        float t = 0f;
        for (int i = 0; i < 300; i++, t += 0.2f)
        {
            var full = Join(Join(FloorPatch(0f), Rack(0f, 3.0f)), Join(Box(0f, 3.2f, 4.0f, 0.1f, 2.6f), Box(1.4f, 2.4f, 2.0f, 0.9f, 0.5f)));
            var view = new List<DepthPoint>();
            int part = i % 3; // the view moves: different parts of the room are hit
            foreach (var p in full)
            {
                if (rnd.NextDouble() < 0.4) continue;
                if (part == 1 && p.x > 0.8f) continue;
                if (part == 2 && p.x < -0.8f) continue;
                view.Add(new DepthPoint(p.x + Noise(rnd, 0.02f), p.y + Noise(rnd, 0.02f), p.z + Noise(rnd, 0.02f)));
            }
            float floor = fe.Update(view, guess);
            d.Process(view, floor, HeadX, HeadZ, t);
        }
        foreach (var tr in d.Tracks)
        {
            True(tr.Kind != TrackKind.PersonCandidate, $"nothing moved (#{tr.Id} at {tr.X:0.0},{tr.Z:0.0} h {tr.Height:0.00} moved {tr.MaxDisplacement:0.00})");
            True(tr.Height < 2.2f, $"no wall-height object (#{tr.Id} h {tr.Height:0.00})");
        }
        int rack = IdNear(d, 0f);
        True(rack > 0, "the rack is found");
        foreach (var tr in d.Tracks) if (tr.Id == rack) Near(1.65f, tr.Height, 0.08f, "rack height");
    }

    /// <summary>Floor points in front of the wearer, as the lower part of the view sees them.</summary>
    private static List<DepthPoint> FloorPatch(float y)
    {
        var pts = new List<DepthPoint>();
        for (float x = -2f; x <= 2f; x += 0.1f)
            for (float z = 0.8f; z <= 3.2f; z += 0.1f)
                pts.Add(new DepthPoint(x, y, z));
        return pts;
    }

    private static float Noise(Random rnd, float amp) => (float)(rnd.NextDouble() * 2 - 1) * amp;

    // ----- Made-up depth points -----

    /// <summary>The half of a vertical cylinder that faces the wearer (a person seen from one side).</summary>
    private static List<DepthPoint> Cylinder(float cx, float cz, float r, float h, float topEdgeFrom = float.MaxValue)
    {
        var pts = new List<DepthPoint>();
        float facing = (float)Math.Atan2(HeadZ - cz, HeadX - cx);
        for (float y = 0f; y <= h + 1e-4f; y += 0.05f)
            for (int a = -4; a <= 4; a++)
            {
                double ang = facing + a * Math.PI / 10;
                pts.Add(new DepthPoint(cx + r * (float)Math.Cos(ang), Floor + y, cz + r * (float)Math.Sin(ang), y >= topEdgeFrom));
            }
        return pts;
    }

    /// <summary>The front face of a box (x width, z depth) as seen from the wearer, plus its top.</summary>
    private static List<DepthPoint> Box(float cx, float cz, float w, float dz, float h)
    {
        var pts = new List<DepthPoint>();
        for (float y = 0f; y <= h + 1e-4f; y += 0.05f)
            for (float x = -w / 2; x <= w / 2 + 1e-4f; x += 0.05f)
                pts.Add(new DepthPoint(cx + x, Floor + y, cz - dz / 2));
        for (float x = -w / 2; x <= w / 2 + 1e-4f; x += 0.05f)
            for (float z = -dz / 2; z <= dz / 2 + 1e-4f; z += 0.05f)
                pts.Add(new DepthPoint(cx + x, Floor + h, cz + z));
        return pts;
    }

    /// <summary>A clothes rack with a jacket: thin pole, jacket from 0.9 to 1.5 m, hook at 1.65 m.</summary>
    private static List<DepthPoint> Rack(float cx, float cz)
    {
        var pts = new List<DepthPoint>();
        for (float y = 0f; y <= 1.65f; y += 0.05f) pts.Add(new DepthPoint(cx, Floor + y, cz));
        for (float y = 0.9f; y <= 1.5f; y += 0.05f)
            for (float x = -0.25f; x <= 0.25f; x += 0.05f) pts.Add(new DepthPoint(cx + x, Floor + y, cz - 0.05f));
        for (float x = -0.3f; x <= 0.3f; x += 0.05f) pts.Add(new DepthPoint(cx + x, Floor + 0.03f, cz)); // feet on the floor
        return pts;
    }

    private static List<DepthPoint> Join(List<DepthPoint> a, List<DepthPoint> b)
    {
        var all = new List<DepthPoint>(a);
        all.AddRange(b);
        return all;
    }

    private static int IdNear(PersonDetector d, float x)
    {
        foreach (var t in d.Tracks) if (Math.Abs(t.X - x) < 0.4f) return t.Id;
        return -1;
    }

    // ----- Minimal test harness -----

    private static void Run(string name, Action test)
    {
        try
        {
            test();
            _passed++;
            Console.WriteLine($"  ok    {name}");
        }
        catch (Exception ex)
        {
            _failed++;
            Console.WriteLine($"  FAIL  {name}\n        {ex.Message}");
        }
    }

    private static void Equal<T>(T expected, T actual, string what)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
            throw new Exception($"{what}: expected {expected}, got {actual}");
    }

    private static void Near(float expected, float actual, float tol, string what)
    {
        if (Math.Abs(expected - actual) > tol) throw new Exception($"{what}: expected {expected} ± {tol}, got {actual:0.000}");
    }

    private static void True(bool cond, string what)
    {
        if (!cond) throw new Exception($"{what}: not true");
    }
}
