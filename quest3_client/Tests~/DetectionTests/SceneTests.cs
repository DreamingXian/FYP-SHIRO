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
    /// <summary>Changes the random ray shifts and noise of every scene (0 = the fixed test runs).</summary>
    public static int SeedOffset;
    private static bool _rowByRow; // new simulators feed the memory of empty space row by row

    public static void RunAll(Action<string, Action> run)
    {
        foreach (var (name, test) in Scenes()) run(name, test);
    }

    /// <summary>
    /// Runs every scene with n different random seeds and prints how often each one passed
    /// (dotnet run -- --seeds 30). The fixed runs above only show that one seed passes.
    /// </summary>
    public static int Stress(int n, string filter = null)
    {
        int failedScenes = 0;
        foreach (var (name, test) in Scenes())
        {
            if (filter != null && name.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;
            int ok = 0;
            string firstFailure = null;
            for (int k = 1; k <= n; k++)
            {
                SeedOffset = k;
                try { test(); ok++; }
                catch (Exception ex) { if (firstFailure == null) firstFailure = $"seed {k}: {ex.Message}"; }
            }
            SeedOffset = 0;
            if (ok < n) failedScenes++;
            Console.WriteLine($"  {ok,3}/{n}  {name}");
            if (firstFailure != null) Console.WriteLine($"          first failure, {firstFailure}");
        }
        return failedScenes;
    }

    private static List<(string, Action)> Scenes()
    {
        var list = new List<(string, Action)>();
        void run(string name, Action test) => list.Add((name, test));
        run("scene: walking around a room for 2 minutes (rack, cabinet, monitor, chair): nobody is a person", WalkAroundRoom);
        run("scene: walking a full circle around a still rack at 1.2 m: it is not a person", CircleAroundRack);
        run("scene: an object seen for the first time is never green at once", FirstLookNotGreen);
        run("scene: a rack pushed 0.5 m sideways becomes a person candidate", RackPushedSideways);
        run("scene: a rack pushed 0.5 m away with a foot while looking down, then stepped back: moved", RackPushedAwayLookingDown);
        run("scene: a person walking across the room becomes a person candidate", PersonWalksAcross);
        run("scene: a person pacing 0.35 m back and forth becomes a person candidate", PersonPacing);
        run("scene: a rack (clothes up to the bar) pulled 0.5 m straight toward the wearer becomes a person candidate", RackPulledToward);
        run("scene: a rack (clothes up to the bar) pulled 0.45 m toward the wearer, then pushed back: two steps", RackTowardAndBack);
        run("scene: a person walking straight toward the wearer becomes a person candidate", PersonWalksToward);
        run("scene: a person walking straight away from the wearer becomes a person candidate", PersonWalksAway);
        run("scene: a person pacing 0.4 m toward and away from the wearer becomes a person candidate", PersonPacingTowardAway);
        run("scene: walking up to a still rack and back, three times: it is not a person", WalkUpToRack);
        run("scene: walking around the room with noisy depth (±3 cm at 2 m): nobody is a person", WalkAroundRoomNoisy);
        run("scene: a rack pushed sideways with noisy depth becomes a person candidate", RackPushedSidewaysNoisy);
        run("scene, fed row by row as on the headset: walking around the room, nobody is a person", () => { _rowByRow = true; try { WalkAroundRoom(); } finally { _rowByRow = false; } });
        run("scene, fed row by row as on the headset: a rack pulled toward the wearer becomes a person candidate", () => { _rowByRow = true; try { RackPulledToward(); } finally { _rowByRow = false; } });
        run("scene: two still things of similar height side by side, the gap between them filled now and then, 3 minutes: neither is a person", SideBySideMerging);
        run("scene: a monitor whose dark screen the sensor often misses, next to a speaker, 3 minutes: not a person", ScreenFlickering);
        run("scene: a person walking past a still rack of the same height becomes a person candidate, the rack does not", PersonWalksPastRack);
        run("scene: a pushed rack, then looked away from and back at for 3 minutes: green until 2 minutes after its last step", PushedRackRemembered);
        run("scene: a rack standing 14 cm in front of a wall pulled 0.5 m toward the wearer becomes a person candidate", RackFromWallTowardWearer);
        run("scene: a person with their back to a wall walks toward the wearer (wall top out of view) and becomes a person candidate", PersonFromWallTowardWearer);
        return list;
    }

    // ----- Scenarios -----

    private static void WalkAroundRoom() => WalkAroundRoomWith(1, 0f);
    private static void WalkAroundRoomNoisy() => WalkAroundRoomWith(11, 0.015f);

    private static void WalkAroundRoomWith(int seed, float noise)
    {
        var sim = new Sim(seed) { Noise = noise };
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

    private static void RackPushedSideways() => RackPushedSidewaysWith(4, 0f);
    private static void RackPushedSidewaysNoisy() => RackPushedSidewaysWith(14, 0.015f);

    private static void RackPushedSidewaysWith(int seed, float noise)
    {
        var sim = new Sim(seed) { Noise = noise };
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

    private static void RackPulledToward()
    {
        var sim = new Sim(8);
        Room(sim);
        var d = new PersonDetector();
        sim.CamX = 0f; sim.CamZ = 0.8f; sim.Yaw = 0f; sim.Pitch = -0.25f;
        float t = 0f, rz = 2.8f;
        for (int i = 0; i < 15; i++, t += 0.2f) { sim.Moving = FullRack(0f, rz); sim.Step(d, t); }
        NobodyGreen(d, "before the pull");
        for (int i = 0; i < 12; i++, t += 0.2f) { rz -= 0.5f / 12; sim.Moving = FullRack(0f, rz); sim.Step(d, t); }
        bool green = false;
        for (int i = 0; i < 20; i++, t += 0.2f)
        {
            sim.Moving = FullRack(0f, rz);
            sim.Step(d, t);
            if (Near(d, 0f, rz)?.Kind == TrackKind.PersonCandidate) green = true;
        }
        True(green, "the rack pulled toward the wearer became a person candidate within 4 s " + Dump(d));
    }

    private static void RackTowardAndBack()
    {
        var sim = new Sim(9);
        Room(sim);
        var d = new PersonDetector();
        sim.CamX = 0f; sim.CamZ = 0.8f; sim.Yaw = 0f; sim.Pitch = -0.25f;
        float t = 0f, rz = 2.8f;
        void Hold(int n) { for (int i = 0; i < n; i++, t += 0.2f) { sim.Moving = FullRack(0f, rz); sim.Step(d, t); } }
        void Move(float to) { float from = rz; for (int i = 1; i <= 8; i++, t += 0.2f) { rz = from + (to - from) * i / 8f; sim.Moving = FullRack(0f, rz); sim.Step(d, t); } }
        Hold(15);
        Move(2.35f);
        Hold(10);
        Move(2.8f);
        Hold(12);
        var r = Near(d, 0f, rz);
        True(r != null && r.Steps >= 2 && r.Kind == TrackKind.PersonCandidate,
             "toward and back counted as two steps " + Dump(d));
    }

    private static void PersonWalksToward()
    {
        var sim = new Sim(10);
        Room(sim);
        var d = new PersonDetector();
        sim.CamX = 0f; sim.CamZ = 0.5f; sim.Yaw = 0f; sim.Pitch = -0.15f;
        float t = 0f, pz = 4.4f;
        bool green = false;
        for (int i = 0; i < 8; i++, t += 0.2f) { sim.Moving = Person(0.1f, pz, 1.70f); sim.Step(d, t); }
        for (int i = 0; i < 22; i++, t += 0.2f)
        {
            pz -= 0.1f; // 0.5 m/s, from 4.4 m to 2.2 m
            sim.Moving = Person(0.1f, pz, 1.70f);
            sim.Step(d, t);
            if (Near(d, 0.1f, pz)?.Kind == TrackKind.PersonCandidate) green = true;
        }
        True(green, "the person walking toward the wearer became a person candidate " + Dump(d));
    }

    private static void PersonWalksAway()
    {
        var sim = new Sim(12);
        Room(sim);
        var d = new PersonDetector();
        sim.CamX = 0f; sim.CamZ = 0.5f; sim.Yaw = 0f; sim.Pitch = -0.15f;
        float t = 0f, pz = 1.9f;
        bool green = false;
        for (int i = 0; i < 8; i++, t += 0.2f) { sim.Moving = Person(0.1f, pz, 1.70f); sim.Step(d, t); }
        for (int i = 0; i < 22; i++, t += 0.2f)
        {
            pz += 0.1f; // 0.5 m/s, from 1.9 m to 4.1 m
            sim.Moving = Person(0.1f, pz, 1.70f);
            sim.Step(d, t);
            if (Near(d, 0.1f, pz)?.Kind == TrackKind.PersonCandidate) green = true;
        }
        True(green, "the person walking away from the wearer became a person candidate " + Dump(d));
    }

    private static void PersonPacingTowardAway()
    {
        var sim = new Sim(13);
        Room(sim);
        var d = new PersonDetector();
        sim.CamX = 0f; sim.CamZ = 0.5f; sim.Yaw = 0f; sim.Pitch = -0.15f;
        float t = 0f, pz = 2.8f;
        bool green = false;
        void Hold(int n) { for (int i = 0; i < n; i++, t += 0.2f) { sim.Moving = Person(0f, pz, 1.65f); sim.Step(d, t); if (Near(d, 0f, pz)?.Kind == TrackKind.PersonCandidate) green = true; } }
        void Walk(float to) { float from = pz; for (int i = 1; i <= 3; i++, t += 0.2f) { pz = from + (to - from) * i / 3f; sim.Moving = Person(0f, pz, 1.65f); sim.Step(d, t); } }
        Hold(8);
        for (int c = 0; c < 4; c++) { Walk(3.2f); Hold(6); Walk(2.8f); Hold(6); }
        True(green, "pacing toward and away became a person candidate " + Dump(d));
    }

    private static void WalkUpToRack()
    {
        var sim = new Sim(15);
        Room(sim);
        sim.Static.AddRange(Rack(0f, 3.0f));
        sim.Static.Add(new Box(1.4f, 2.0f, 0.95f, 1.35f, 4.6f, 4.65f));    // monitor
        sim.Static.Add(new Box(1.2f, 2.2f, 0f, 0.75f, 4.2f, 4.9f));        // desk
        var d = new PersonDetector();
        sim.CamX = 0f; sim.CamZ = 0.8f; sim.Yaw = 0f;
        float t = 0f;
        for (int round = 0; round < 3; round++)
        {
            for (int i = 0; i < 15; i++, t += 0.2f)   // walks up to 0.8 m from the rack, looking down more
            {
                sim.CamZ = 0.8f + 1.4f * i / 14f;
                sim.Pitch = -0.2f - 0.3f * i / 14f;
                sim.Yaw = 0.15f * (float)Math.Sin(t);
                sim.Step(d, t);
                NobodyGreen(d, $"walking up, {t:0.0} s");
            }
            for (int i = 0; i < 15; i++, t += 0.2f)   // and back
            {
                sim.CamZ = 2.2f - 1.4f * i / 14f;
                sim.Pitch = -0.5f + 0.3f * i / 14f;
                sim.Yaw = 0.15f * (float)Math.Sin(t);
                sim.Step(d, t);
                NobodyGreen(d, $"walking back, {t:0.0} s");
            }
        }
    }

    /// <summary>Two still things of similar height 25 cm apart (as next to the monitor on the headset).
    /// The depth sensor sometimes fills the gap between them for a few seconds (points in between at
    /// their edges): then they are one object whose position is between them.</summary>
    private static void SideBySideMerging()
    {
        var sim = new Sim(16);
        Room(sim);
        var rnd = new Random(16 + 1000 * SeedOffset);
        sim.Static.Add(new Box(-0.45f, -0.15f, 0f, 1.30f, 3.9f, 4.15f));
        sim.Static.Add(new Box(0.10f, 0.40f, 0f, 1.25f, 3.9f, 4.15f));
        var gap = new List<Shape> { new Box(-0.15f, 0.10f, 0.9f, 1.20f, 3.95f, 4.10f) };
        var d = new PersonDetector();
        bool filled = false;
        float switchAt = 4f;
        for (int i = 0; i < 900; i++) // 3 minutes
        {
            float t = i * 0.2f;
            if (t >= switchAt) { filled = !filled; switchAt = t + 1f + 5f * (float)rnd.NextDouble(); }
            sim.Moving = filled ? gap : new List<Shape>();
            LookAtThingsAhead(sim, t);
            sim.Step(d, t);
            NobodyGreen(d, $"at {t:0.0} s (gap {(filled ? "filled" : "open")})");
        }
    }

    /// <summary>A desk with a monitor and a speaker. The depth sensor often misses the dark, glossy
    /// screen (only its stand is seen), for a moment or for several seconds.</summary>
    private static void ScreenFlickering()
    {
        var sim = new Sim(17);
        Room(sim);
        var rnd = new Random(17 + 1000 * SeedOffset);
        sim.Static.Add(new Box(-0.7f, 0.6f, 0f, 0.75f, 3.8f, 4.4f));        // desk
        sim.Static.Add(new Box(-0.25f, -0.15f, 0.75f, 0.95f, 4.15f, 4.25f)); // monitor stand
        sim.Static.Add(new Box(0.30f, 0.45f, 0.75f, 1.15f, 4.0f, 4.15f));    // speaker
        var screen = new List<Shape> { new Box(-0.5f, 0.1f, 0.95f, 1.30f, 4.10f, 4.13f) };
        var d = new PersonDetector();
        bool seen = true;
        float switchAt = 5f;
        for (int i = 0; i < 900; i++) // 3 minutes
        {
            float t = i * 0.2f;
            if (t >= switchAt) { seen = !seen; switchAt = t + (seen ? 1f + 6f * (float)rnd.NextDouble() : 0.4f + 5f * (float)rnd.NextDouble()); }
            sim.Moving = seen ? screen : new List<Shape>();
            LookAtThingsAhead(sim, t);
            sim.Step(d, t);
            NobodyGreen(d, $"at {t:0.0} s (screen {(seen ? "seen" : "missed")})");
        }
    }

    /// <summary>Standing about 2 m from the things ahead, the head moving a little; every 30 s the
    /// wearer looks away for 3 s (they are lost, and a moved one would be remembered).</summary>
    private static void LookAtThingsAhead(Sim sim, float t)
    {
        bool away = t % 30f >= 27f;
        sim.CamX = 0.3f * (float)Math.Sin(t * 2 * Math.PI / 23);
        sim.CamZ = 2.0f;
        sim.Yaw = away ? 2.2f : 0.25f * (float)Math.Sin(t * 2 * Math.PI / 6);
        sim.Pitch = -0.2f + 0.08f * (float)Math.Sin(t * 2 * Math.PI / 4);
    }

    private static void PersonWalksPastRack()
    {
        var sim = new Sim(19);
        Room(sim);
        sim.Static.AddRange(FullRack(0.3f, 3.35f));
        var d = new PersonDetector();
        sim.CamX = 0f; sim.CamZ = 0.5f; sim.Yaw = 0f; sim.Pitch = -0.15f;
        float t = 0f, px = -1.5f;
        bool green = false;
        for (int i = 0; i < 8; i++, t += 0.2f) { sim.Moving = Person(px, 3.0f, 1.68f); sim.Step(d, t); }
        for (int i = 0; i < 30; i++, t += 0.2f)
        {
            px += 0.12f; // 0.6 m/s, passing 12 cm in front of the rack
            sim.Moving = Person(px, 3.0f, 1.68f);
            sim.Step(d, t);
            if (Near(d, px, 3.0f)?.Kind == TrackKind.PersonCandidate) green = true;
        }
        for (int i = 0; i < 10; i++, t += 0.2f) { sim.Moving = Person(px, 3.0f, 1.68f); sim.Step(d, t); }
        True(green, "the person walking past the rack became a person candidate " + Dump(d));
        var rack = Near(d, 0.3f, 3.35f);
        True(rack == null || rack.Kind != TrackKind.PersonCandidate, "the rack did not become a person candidate " + Dump(d));
    }

    private static void PushedRackRemembered()
    {
        var sim = new Sim(18);
        Room(sim);
        var d = new PersonDetector();
        sim.CamX = 0f; sim.CamZ = 1.0f; sim.Pitch = -0.25f;
        float t = 0f, rx = 0f;
        void Look(int n, float yaw) { for (int i = 0; i < n; i++, t += 0.2f) { sim.Yaw = yaw; sim.Moving = Rack(rx, 2.6f); sim.Step(d, t); } }
        Look(15, 0f);
        for (int i = 0; i < 12; i++, t += 0.2f) { rx += 0.5f / 12; sim.Moving = Rack(rx, 2.6f); sim.Step(d, t); }
        Look(20, 0f);
        float pushedAt = t;
        True(Near(d, rx, 2.6f)?.Kind == TrackKind.PersonCandidate, "green after the push " + Dump(d));
        while (t < pushedAt + 180f)
        {
            Look(25, 2.5f); // looks away for 5 s
            Look(25, 0f);   // and back for 5 s
            bool green = Near(d, rx, 2.6f)?.Kind == TrackKind.PersonCandidate;
            float since = t - pushedAt;
            if (since < 100f) True(green, $"{since:0} s after the push, looked back: still green " + Dump(d));
            if (since > 140f) True(!green, $"{since:0} s after the push, looked back: no longer green " + Dump(d));
        }
    }

    /// <summary>The back wall is at z 5.0: a wall right next to the old spot is not "another object".</summary>
    private static void RackFromWallTowardWearer()
    {
        var sim = new Sim(20);
        Room(sim);
        var d = new PersonDetector();
        sim.CamX = 0f; sim.CamZ = 2.8f; sim.Yaw = 0f; sim.Pitch = -0.15f;
        float t = 0f, rz = 4.80f;
        for (int i = 0; i < 15; i++, t += 0.2f) { sim.Moving = FullRack(0f, rz); sim.Step(d, t); }
        NobodyGreen(d, "before the pull");
        for (int i = 0; i < 12; i++, t += 0.2f) { rz -= 0.5f / 12; sim.Moving = FullRack(0f, rz); sim.Step(d, t); }
        bool green = false;
        for (int i = 0; i < 20; i++, t += 0.2f)
        {
            sim.Moving = FullRack(0f, rz);
            sim.Step(d, t);
            if (Near(d, 0f, rz)?.Kind == TrackKind.PersonCandidate) green = true;
        }
        True(green, "the rack pulled away from the wall became a person candidate within 4 s " + Dump(d));
    }

    /// <summary>Looking down a little, so the wall's top is out of view: the wall is then a long
    /// object, not structure.</summary>
    private static void PersonFromWallTowardWearer()
    {
        var sim = new Sim(21);
        Room(sim);
        var d = new PersonDetector();
        sim.CamX = 0f; sim.CamZ = 2.6f; sim.Yaw = 0f; sim.Pitch = -0.35f;
        float t = 0f, pz = 4.75f;
        bool green = false;
        for (int i = 0; i < 8; i++, t += 0.2f) { sim.Moving = Person(0.1f, pz, 1.70f); sim.Step(d, t); }
        for (int i = 0; i < 14; i++, t += 0.2f)
        {
            pz -= 0.1f; // 0.5 m/s, from 4.75 m to 3.35 m
            sim.Moving = Person(0.1f, pz, 1.70f);
            sim.Step(d, t);
            if (Near(d, 0.1f, pz)?.Kind == TrackKind.PersonCandidate) green = true;
        }
        True(green, "the person walking away from the wall became a person candidate " + Dump(d));
    }

    // ----- Room and objects -----

    private static void Room(Sim sim)
    {
        // 5 m x 5.5 m, 2.6 m high
        sim.Static.Add(new Box(-2.5f, 2.5f, 0f, 2.6f, 5.0f, 5.1f));   // back wall
        sim.Static.Add(new Box(-2.6f, -2.5f, 0f, 2.6f, -0.5f, 5.1f)); // left wall
        sim.Static.Add(new Box(2.5f, 2.6f, 0f, 2.6f, -0.5f, 5.1f));   // right wall
    }

    /// <summary>A clothes rack with a jacket: a thin pole, a hook bar on top, the jacket hanging below it
    /// with a 10 cm gap under the bar.</summary>
    private static List<Shape> Rack(float x, float z) => Rack(x, z, 1.50f);

    /// <summary>A clothes rack whose clothes hang right from the hook bar (no gap to see through).</summary>
    private static List<Shape> FullRack(float x, float z) => Rack(x, z, 1.60f);

    private static List<Shape> Rack(float x, float z, float clothesTop) => new List<Shape>
    {
        new Cyl(x, z, 0.015f, 0f, 1.65f),                              // pole
        new Box(x - 0.22f, x + 0.22f, 1.60f, 1.65f, z - 0.015f, z + 0.015f), // hook bar
        new Box(x - 0.25f, x + 0.25f, 0.85f, clothesTop, z - 0.06f, z + 0.06f), // clothes
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
                throw new Exception($"{when}: #{t.Id} at ({t.X:0.00}, {t.Z:0.00}) h {t.Height:0.00} is green ({t.MovedBy}, steps {t.Steps}, path {t.PathLength:0.00}, {t.LastStepProof})");
    }

    private static string Dump(PersonDetector d)
    {
        var parts = new List<string>();
        foreach (var t in d.Tracks)
            parts.Add($"#{t.Id} ({t.X:0.00},{t.Z:0.00}) h {t.Height:0.00} {t.Kind} steps {t.Steps} path {t.PathLength:0.00} {t.LastStepProof} {t.Waiting} {t.NotPersonReason}");
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
        /// <summary>Depth noise: standard deviation as a share of the distance (0.015 = 3 cm at 2 m).</summary>
        public float Noise;
        public readonly List<Shape> Static = new List<Shape>();
        public List<Shape> Moving = new List<Shape>();
        private readonly Random _rnd;
        private List<DepthPoint> _previous = new List<DepthPoint>();

        public Sim(int seed) { _rnd = new Random(seed + 1000 * SeedOffset); RowByRow = _rowByRow; }

        /// <summary>One detection update, as on the headset: this sweep plus the previous one.</summary>
        /// <summary>As on the headset: the memory of empty space is fed 6 rows (240 rays) at a time
        /// while the sweep goes on, and the detector only reads it.</summary>
        public bool RowByRow;

        public void Step(PersonDetector d, float now)
        {
            var points = Cast();
            var combined = new List<DepthPoint>(points);
            combined.AddRange(_previous);
            _previous = points;
            if (RowByRow)
            {
                d.EmptySpaceFedByCaller = true;
                d.EmptySpace.BeginUpdate(CamX, CamZ);
                for (int start = 0; start < points.Count; start += Cols * 6)
                    d.EmptySpace.AddRays(points, start, Cols * 6, 0f, CamX, CamY, CamZ, null);
                d.EmptySpace.EndUpdate(now);
            }
            d.Process(combined, 0f, CamX, CamY, CamZ, now, null, points.Count);
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
                    if (Noise > 0f) best *= 1f + Noise * Gauss();
                    pts.Add(new DepthPoint(CamX + dx * best, CamY + dy * best, CamZ + dz * best, r >= Rows - 2));
                }
            return pts;
        }

        private float Gauss()
        {
            double u1 = 1.0 - _rnd.NextDouble(), u2 = _rnd.NextDouble();
            return (float)(Math.Sqrt(-2.0 * Math.Log(u1)) * Math.Cos(2 * Math.PI * u2));
        }
    }
}
