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
        Run("a rack hidden for 1.6 s is not taken over by the chair next to it", HiddenRackNextToChair);
        Run("'moved' is not inherited by an object of another height at the same spot", MemoryNeedsSimilarHeight);
        Run("why an object counts as moved is recorded", MovedReasonRecorded);
        Run("pacing 0.35 m away and back, with pauses, counts as moved (two steps)", PacingWithPauses);
        Run("pacing back and forth without stopping counts as moved", PacingContinuously);
        Run("a still rack seen from one side, then the other, for 2 minutes: no step", StillRackSeenFromEachSide);
        Run("a cabinet coming into view at the edge while the wearer walks past: no step", CabinetComingIntoView);
        Run("a cabinet partly hidden, then whole, three times: not a person", CabinetPartlyHidden);
        Run("a rack pushed by hand: same object, right height, moved; the arms are not people", PushedByHand);
        Run("an object lost for 2.6 s and seen again keeps its identity (no step)", BrieflyLostKeepsIdentity);
        Run("a rack pushed with a foot while looking down: same object, height kept, moved, never grey", PushedWithLegLookingDown);
        Run("the tracking space jumps (headset off and on): detection restarts, nothing 'moved'", TrackingJumpRestarts);
        Run("a wrong low floor goes back up to the floor that agrees with the headset", FloorRisesBackToHeadsetFloor);
        Run("a single odd update does not turn an object grey", NoGreyFlicker);

        LinkingTests.RunAll(Run);

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

    private static void HiddenRackNextToChair()
    {
        var d = new PersonDetector();
        var chair = Box(0.55f, 3f, 0.3f, 0.4f, 0.9f);
        float t = 0f;
        for (int i = 0; i < 10; i++, t += 0.2f) d.Process(Join(Rack(0f, 3f), chair), Floor, HeadX, HeadZ, t);
        int rack = IdNear(d, 0f);
        for (int i = 0; i < 8; i++, t += 0.2f) d.Process(chair, Floor, HeadX, HeadZ, t);          // rack hidden 1.6 s
        for (int i = 0; i < 20; i++, t += 0.2f) d.Process(Join(Rack(0f, 3f), chair), Floor, HeadX, HeadZ, t);
        foreach (var tr in d.Tracks)
            True(tr.Kind != TrackKind.PersonCandidate, $"nothing counts as moved (#{tr.Id} h {tr.Height:0.00} by {tr.MovedBy})");
        Equal(rack, IdNear(d, 0f), "the rack keeps its id");
    }

    private static void MemoryNeedsSimilarHeight()
    {
        var d = new PersonDetector();
        float t = 0f;
        for (int i = 0; i <= 20; i++, t += 0.2f) d.Process(Cylinder(i * 0.06f, 3f, 0.2f, 1.6f), Floor, HeadX, HeadZ, t);
        for (int i = 0; i < 15; i++, t += 0.2f) d.Process(new List<DepthPoint>(), Floor, HeadX, HeadZ, t); // lost
        d.Process(Box(1.2f, 3f, 0.5f, 0.4f, 1.95f), Floor, HeadX, HeadZ, t);                              // a cabinet there
        Equal(TrackKind.StillObject, d.Tracks[0].Kind, "the cabinet does not inherit 'moved'");
        Equal(MovedEvidence.None, d.Tracks[0].MovedBy, "no evidence");
    }

    private static void MovedReasonRecorded()
    {
        var d = new PersonDetector();
        float t = 0f;
        for (int i = 0; i <= 20; i++, t += 0.2f) d.Process(Cylinder(i * 0.06f, 3f, 0.2f, 1.6f), Floor, HeadX, HeadZ, t);
        Equal(MovedEvidence.Walked, d.Tracks[0].MovedBy, "walked");
        True(d.Tracks[0].MovedDistance >= 0.4f, "distance recorded");
        for (int i = 0; i < 15; i++, t += 0.2f) d.Process(new List<DepthPoint>(), Floor, HeadX, HeadZ, t);
        d.Process(Cylinder(1.2f, 3f, 0.2f, 1.6f), Floor, HeadX, HeadZ, t);
        Equal(MovedEvidence.SeenMovingHere, d.Tracks[0].MovedBy, "remembered");
    }

    private static void PacingWithPauses()
    {
        // 0.35 m right, pause, back to the start, pause: never 0.4 m from where it was first seen
        var d = new PersonDetector();
        float t = 0f;
        float x = 0f;
        void Hold(int updates) { for (int i = 0; i < updates; i++, t += 0.2f) d.Process(Cylinder(x, 3f, 0.2f, 1.6f), Floor, HeadX, HeadZ, t); }
        void Walk(float to) { float from = x; for (int i = 1; i <= 4; i++, t += 0.2f) { x = from + (to - from) * i / 4f; d.Process(Cylinder(x, 3f, 0.2f, 1.6f), Floor, HeadX, HeadZ, t); } }
        Hold(6);
        Walk(0.35f); Hold(8);
        True(d.Tracks[0].MaxDisplacement < 0.4f, "never 0.4 m from the start");
        Walk(0f); Hold(8);
        Equal(TrackKind.PersonCandidate, d.Tracks[0].Kind, "two 0.35 m steps count as moved");
        Equal(2, d.Tracks[0].Steps, "steps");
    }

    private static void PacingContinuously()
    {
        // walks back and forth over 0.6 m (0.3 m either side of the start) without stopping
        var d = new PersonDetector();
        float t = 0f;
        for (int i = 0; i < 60; i++, t += 0.2f)
        {
            float x = 0.3f * (float)Math.Sin(i * 2 * Math.PI / 25); // one cycle in 5 s
            d.Process(Cylinder(x, 3f, 0.2f, 1.6f), Floor, HeadX, HeadZ, t);
        }
        Equal(TrackKind.PersonCandidate, d.Tracks[0].Kind, "pacing counts as moved");
    }

    private static void StillRackSeenFromEachSide()
    {
        // the wearer walks around a still rack: for 2 s at a time only one side is visible
        var d = new PersonDetector();
        var rnd = new Random(5);
        float t = 0f;
        for (int i = 0; i < 600; i++, t += 0.2f) // 2 minutes
        {
            bool left = (i / 10) % 2 == 0;
            var view = new List<DepthPoint>();
            foreach (var p in Rack(0f, 3f))
            {
                if (left && p.x > 0.05f) continue;
                if (!left && p.x < -0.05f) continue;
                if (rnd.NextDouble() < 0.3) continue;
                view.Add(new DepthPoint(p.x + Noise(rnd, 0.03f), p.y + Noise(rnd, 0.03f), p.z + Noise(rnd, 0.03f)));
            }
            d.Process(view, Floor, HeadX, HeadZ, t);
        }
        Equal(1, d.Tracks.Count, "objects");
        Equal(0, d.Tracks[0].Steps, "no step");
        Equal(TrackKind.StillObject, d.Tracks[0].Kind, "kind");
    }

    /// <summary>A cabinet (1.0 m wide, 1.8 m tall) of which only x in [from, to] is visible; the cut side is at the view edge.</summary>
    private static List<DepthPoint> CabinetPart(float from, float to, bool cutLeft, bool cutRight)
    {
        var pts = new List<DepthPoint>();
        foreach (var p in Box(0f, 3f, 1.0f, 0.5f, 1.8f))
        {
            if (p.x < from - 1e-4f || p.x > to + 1e-4f) continue;
            bool edge = (cutLeft && p.x < from + 0.1f) || (cutRight && p.x > to - 0.1f);
            pts.Add(new DepthPoint(p.x, p.y, p.z, false, edge));
        }
        return pts;
    }

    private static void CabinetComingIntoView()
    {
        // The wearer walks past a cabinet three times: it comes into view from one side, is
        // whole for 2 s, and leaves on the other side
        var d = new PersonDetector();
        float t = 0f;
        for (int cycle = 0; cycle < 3; cycle++)
        {
            for (int i = 0; i <= 9; i++, t += 0.2f) d.Process(CabinetPart(0.4f - i * 0.1f, 0.5f, true, false), Floor, HeadX, HeadZ, t);
            for (int i = 0; i < 10; i++, t += 0.2f) d.Process(CabinetPart(-0.5f, 0.5f, false, false), Floor, HeadX, HeadZ, t);
            for (int i = 0; i <= 9; i++, t += 0.2f) d.Process(CabinetPart(-0.5f, 0.5f - i * 0.1f, false, true), Floor, HeadX, HeadZ, t);
        }
        foreach (var tr in d.Tracks)
        {
            Equal(0, tr.Steps, $"no step for #{tr.Id}");
            True(tr.Kind != TrackKind.PersonCandidate, $"#{tr.Id} is not a person");
        }
    }

    private static void CabinetPartlyHidden()
    {
        // Something in front hides the left 60 % of a cabinet for 3 s, then it is whole for 3 s (three times)
        var d = new PersonDetector();
        float t = 0f;
        for (int cycle = 0; cycle < 3; cycle++)
        {
            for (int i = 0; i < 15; i++, t += 0.2f) d.Process(CabinetPart(0.1f, 0.5f, false, false), Floor, HeadX, HeadZ, t);
            for (int i = 0; i < 15; i++, t += 0.2f) d.Process(CabinetPart(-0.5f, 0.5f, false, false), Floor, HeadX, HeadZ, t);
        }
        foreach (var tr in d.Tracks) True(tr.Kind != TrackKind.PersonCandidate, $"#{tr.Id} is not a person (steps {tr.Steps})");
    }

    private static void PushedByHand()
    {
        // The wearer walks up to the rack, pushes it 0.7 m with both hands, and steps back
        var d = new PersonDetector();
        float t = 0f, zr = 1.5f;
        List<ExcludeSegment> Arms(float headZ) => new List<ExcludeSegment>
        {
            new ExcludeSegment(-0.18f, 1.35f, headZ, -0.2f, 1.0f, zr - 0.12f, 0.15f),
            new ExcludeSegment(0.18f, 1.35f, headZ, 0.2f, 1.0f, zr - 0.12f, 0.15f),
        };
        List<DepthPoint> Scene(float headZ, bool arms)
        {
            var pts = Rack(0f, zr);
            if (!arms) return pts;
            foreach (float side in new[] { -1f, 1f })
                for (int k = 0; k <= 10; k++)
                {
                    float a = k / 10f; // shoulder -> hand, as the sensor sees the arm
                    pts.Add(new DepthPoint(side * (0.18f + 0.02f * a), 1.35f - 0.35f * a, headZ + (zr - 0.12f - headZ) * a));
                    pts.Add(new DepthPoint(side * (0.18f + 0.02f * a) + 0.03f, 1.33f - 0.35f * a, headZ + (zr - 0.12f - headZ) * a));
                }
            return pts;
        }
        for (int i = 0; i < 10; i++, t += 0.2f) d.Process(Scene(zr - 1.2f, false), Floor, 0f, zr - 1.2f, t);
        int rackId = IdNear(d, 0f);
        for (int i = 1; i <= 5; i++, t += 0.2f) d.Process(Scene(zr - 1.2f + i * 0.15f, false), Floor, 0f, zr - 1.2f + i * 0.15f, t); // walks up
        for (int i = 0; i < 5; i++, t += 0.2f) d.Process(Scene(zr - 0.45f, true), Floor, 0f, zr - 0.45f, t, Arms(zr - 0.45f));
        for (int i = 0; i < 18; i++, t += 0.2f)
        {
            zr += 0.04f;
            d.Process(Scene(zr - 0.45f, true), Floor, 0f, zr - 0.45f, t, Arms(zr - 0.45f));
        }
        for (int i = 1; i <= 5; i++, t += 0.2f) d.Process(Scene(zr - 0.45f - i * 0.15f, false), Floor, 0f, zr - 0.45f - i * 0.15f, t); // steps back
        for (int i = 0; i < 15; i++, t += 0.2f) d.Process(Scene(zr - 1.2f, false), Floor, 0f, zr - 1.2f, t);

        Track rack = null;
        foreach (var tr in d.Tracks) if (Math.Abs(tr.X) < 0.4f && Math.Abs(tr.Z - zr) < 0.4f) rack = tr;
        True(rack != null, "the rack is tracked");
        Equal(rackId, rack.Id, "the rack kept its identity while pushed");
        Near(1.65f, rack.Height, 0.1f, "its height while pushed and after");
        Equal(TrackKind.PersonCandidate, rack.Kind, "the push counts as moved");
        foreach (var tr in d.Tracks) if (tr != rack) True(tr.Kind != TrackKind.PersonCandidate, $"#{tr.Id} (the arms?) is not a person");
    }

    private static void BrieflyLostKeepsIdentity()
    {
        var d = new PersonDetector();
        float t = 0f;
        for (int i = 0; i < 10; i++, t += 0.2f) d.Process(Rack(0f, 3f), Floor, HeadX, HeadZ, t);
        int id = d.Tracks[0].Id;
        for (int i = 0; i < 13; i++, t += 0.2f) d.Process(new List<DepthPoint>(), Floor, HeadX, HeadZ, t); // 2.6 s away
        for (int i = 0; i < 10; i++, t += 0.2f) d.Process(Rack(0.1f, 3f), Floor, HeadX, HeadZ, t);
        Equal(id, d.Tracks[0].Id, "same object");
        Equal(0, d.Tracks[0].Steps, "reappearing is not a step");
    }

    private static void PushedWithLegLookingDown()
    {
        // The wearer walks up to 0.7 m, looks down (the rack's top is out of view above 1.2 m),
        // pushes it 0.6 m with a foot, then steps back and sees it whole
        var d = new PersonDetector();
        float t = 0f, zr = 2.0f, head = zr - 1.5f;
        var kinds = new List<TrackKind>();
        var heights = new List<float>();
        List<DepthPoint> Scene(bool lookingDown, bool leg)
        {
            var pts = new List<DepthPoint>();
            foreach (var p in Rack(0f, zr))
            {
                if (lookingDown && p.y > 1.2f) continue;
                pts.Add(new DepthPoint(p.x, p.y, p.z, lookingDown && p.y >= 1.1f));
            }
            if (leg)
                for (int k = 0; k <= 12; k++)
                {
                    float a = k / 12f; // hip -> foot at the rack's base
                    pts.Add(new DepthPoint(0.1f, 0.9f - 0.7f * a, head + 0.1f + (zr - 0.15f - head - 0.1f) * a));
                    pts.Add(new DepthPoint(0.15f, 0.9f - 0.7f * a, head + 0.1f + (zr - 0.15f - head - 0.1f) * a));
                }
            return pts;
        }
        void Step(bool down, bool leg)
        {
            d.Process(Scene(down, leg), Floor, 0f, head, t);
            t += 0.2f;
            Track r = null;
            foreach (var tr in d.Tracks) if (Math.Abs(tr.X) < 0.4f && Math.Abs(tr.Z - zr) < 0.4f) r = tr;
            if (r != null) { kinds.Add(r.Kind); heights.Add(r.Height); }
        }
        for (int i = 0; i < 10; i++) Step(false, false);
        int id = IdNear(d, 0f);
        for (int i = 0; i < 8; i++) { head += 0.1f; Step(false, false); }   // walks up to 0.7 m
        for (int i = 0; i < 5; i++) Step(true, true);                        // looks down, foot on the rack
        for (int i = 0; i < 15; i++) { zr += 0.04f; head += 0.04f; Step(true, true); } // pushes 0.6 m
        for (int i = 0; i < 8; i++) Step(true, false);                       // still looking down
        for (int i = 0; i < 8; i++) { head -= 0.1f; Step(false, false); }   // steps back
        for (int i = 0; i < 10; i++) Step(false, false);

        Track rack = null;
        foreach (var tr in d.Tracks) if (Math.Abs(tr.X) < 0.4f && Math.Abs(tr.Z - zr) < 0.4f) rack = tr;
        True(rack != null, "the rack is tracked");
        Equal(id, rack.Id, "same object all along");
        Equal(TrackKind.PersonCandidate, rack.Kind, "the push counts as moved");
        True(!kinds.Contains(TrackKind.NotPerson), "never grey while pushed");
        foreach (float h in heights) True(h > 1.5f, $"height kept while the top was out of view (was {h:0.00} m)");
        foreach (var tr in d.Tracks) if (tr != rack) True(tr.Kind != TrackKind.PersonCandidate, $"#{tr.Id} (the leg?) is not a person");
    }

    private static void TrackingJumpRestarts()
    {
        // The headset is taken off and put on: the whole tracking space shifts by 0.5 m at once
        var d = new PersonDetector();
        float t = 0f, sx = 0f, sz = 0f;
        List<DepthPoint> Scene()
        {
            var pts = Join(Rack(0f, 3f), Box(1.2f, 3.2f, 0.4f, 0.3f, 1.3f)); // rack and a monitor
            var moved = new List<DepthPoint>();
            foreach (var p in pts) moved.Add(new DepthPoint(p.x + sx, p.y, p.z + sz));
            return moved;
        }
        for (int i = 0; i < 15; i++, t += 0.2f) d.Process(Scene(), Floor, sx, sz, t);
        sx = 0.4f; sz = 0.35f;
        for (int i = 0; i < 25; i++, t += 0.2f) d.Process(Scene(), Floor, sx, sz, t);
        True(d.Restarts >= 1, "the jump restarts detection");
        foreach (var tr in d.Tracks) True(tr.Kind != TrackKind.PersonCandidate, $"#{tr.Id} did not move (h {tr.Height:0.00})");
    }

    private static void FloorRisesBackToHeadsetFloor()
    {
        var fe = new FloorEstimator();
        Near(-0.3f, fe.Update(FloorPatch(-0.3f), 0f), 0.03f, "a wrong low floor while tracking shifted");
        fe.Update(FloorPatch(0f), 0f);
        fe.Update(FloorPatch(0f), 0f);
        Near(0f, fe.Update(FloorPatch(0f), 0f), 0.03f, "back to the floor that agrees with the headset after 3 measurements");
    }

    private static void NoGreyFlicker()
    {
        // A still rack; every 10th update it merges with something wide for one update
        var d = new PersonDetector();
        var kinds = new List<TrackKind>();
        for (int i = 0; i < 80; i++)
        {
            var pts = Rack(0f, 3f);
            if (i % 10 == 9) pts = Join(pts, Box(0.95f, 3f, 1.4f, 0.3f, 0.7f));
            d.Process(pts, Floor, HeadX, HeadZ, i * 0.2f);
            int id = IdNear(d, 0f);
            foreach (var tr in d.Tracks) if (tr.Id == id && i > 2) kinds.Add(tr.Kind);
        }
        True(!kinds.Contains(TrackKind.NotPerson), "never grey for a single odd update");
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
