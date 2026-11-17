// Automated tests of the wristband-to-person linking (ShiroPersonLinking.cs).
// Tracks are made directly (as the person detector would report them).
using System;
using System.Collections.Generic;
using ShiroMR.Detection;
using ShiroMR.Linking;

internal static class LinkingTests
{
    public static void RunAll(Action<string, Action> run)
    {
        run("linking: one person near the wristband is linked; the panel uses the person's position", OnePerson);
        run("linking: a wandering Bluetooth position (up to 2.4 m off) keeps the link for 60 s", WanderingBle);
        run("linking: the Bluetooth position far away for 5 s ends the link", FarBleBreaks);
        run("linking: a still object (never moved) is not linked", StillObjectNotLinked);
        run("linking: two similar people at the same distance: unclear, no guess", TwoSimilarUnclear);
        run("linking: the recorded height picks the right one of two people", HeightDecides);
        run("linking: the wristband's motion picks the moving one of two people", MotionDecides);
        run("linking: a slightly better person does not take over; a clearly better one after 2 s", Hysteresis);
        run("linking: a person chosen by hand is kept even far from the wristband, until lost", ManualChoice);
        run("linking: the linked person lost: back to the Bluetooth position", LinkedLost);
        run("linking: a height cut off at the top of the view is not held against the person", CutHeightNeutral);
    }

    private static Track Person(int id, float x, float z, float h = 1.65f, float speed = 0f, TrackKind kind = TrackKind.PersonCandidate) =>
        new Track { Id = id, X = x, Z = z, Height = h, Speed = speed, Kind = kind };

    private static List<Track> L(params Track[] t) => new List<Track>(t);

    private static void OnePerson()
    {
        var l = new PersonLinker();
        var p = Person(1, 0.5f, 3f);
        l.Update(L(p), true, 1.2f, 2.0f, WristMotion.Unknown, 0f, 0f);
        Equal(LinkState.Linked, l.State, "state");
        Equal(1, l.LinkedTrackId, "person");
        Near(0.5f, l.X, 0.001f, "x");
        Near(3f, l.Z, 0.001f, "z");
    }

    private static void WanderingBle()
    {
        var l = new PersonLinker();
        var rnd = new Random(1);
        var p = Person(1, 0f, 3f);
        float bx = 0f, bz = 3f, tx = 0f, tz = 3f;
        for (int i = 0; i < 300; i++)
        {
            // smooth random walk within 1.2 m of a centre 1.2 m from the person
            if (Math.Abs(bx - tx) + Math.Abs(bz - tz) < 0.05f)
            {
                double a = rnd.NextDouble() * Math.PI * 2, r = rnd.NextDouble() * 1.2;
                tx = 1.2f + (float)(r * Math.Cos(a));
                tz = 3f + (float)(r * Math.Sin(a));
            }
            float dx = tx - bx, dz = tz - bz, len = (float)Math.Sqrt(dx * dx + dz * dz);
            float step = Math.Min(len, 0.06f); // 0.3 m/s at 5 Hz
            if (len > 0) { bx += dx / len * step; bz += dz / len * step; }
            l.Update(L(p), true, bx, bz, WristMotion.Unknown, 0f, i * 0.2f);
            Equal(LinkState.Linked, l.State, $"state at {i * 0.2f:0.0} s");
            Near(0f, l.X, 0.001f, "panel stays at the person");
        }
    }

    private static void FarBleBreaks()
    {
        var l = new PersonLinker();
        var p = Person(1, 0f, 3f);
        l.Update(L(p), true, 0.5f, 3f, WristMotion.Unknown, 0f, 0f);
        Equal(LinkState.Linked, l.State, "linked first");
        float t = 0.2f;
        for (; t < 4.5f; t += 0.2f) l.Update(L(p), true, 5f, 3f, WristMotion.Unknown, 0f, t);
        Equal(LinkState.Linked, l.State, "still linked after 4 s");
        for (; t < 6f; t += 0.2f) l.Update(L(p), true, 5f, 3f, WristMotion.Unknown, 0f, t);
        Equal(LinkState.BleOnly, l.State, "link ended");
        Near(5f, l.X, 0.001f, "panel at the Bluetooth position");
    }

    private static void StillObjectNotLinked()
    {
        var l = new PersonLinker();
        l.Update(L(Person(1, 0f, 3f, kind: TrackKind.StillObject)), true, 0.2f, 3f, WristMotion.Unknown, 0f, 0f);
        Equal(LinkState.BleOnly, l.State, "state");
    }

    private static void TwoSimilarUnclear()
    {
        var l = new PersonLinker();
        l.Update(L(Person(1, -0.5f, 3f), Person(2, 0.5f, 3f)), true, 0f, 3f, WristMotion.Unknown, 0f, 0f);
        Equal(LinkState.Unclear, l.State, "state");
        Equal(-1, l.LinkedTrackId, "nobody linked");
    }

    private static void HeightDecides()
    {
        var l = new PersonLinker();
        l.Update(L(Person(1, -0.5f, 3f, 1.85f), Person(2, 0.5f, 3f, 1.58f)), true, 0f, 3f, WristMotion.Unknown, 1.60f, 0f);
        Equal(LinkState.Linked, l.State, "state");
        Equal(2, l.LinkedTrackId, "the 1.58 m person");
    }

    private static void MotionDecides()
    {
        var l = new PersonLinker();
        l.Update(L(Person(1, -0.5f, 3f, speed: 0.6f), Person(2, 0.5f, 3f, speed: 0f)), true, 0f, 3f, WristMotion.Moving, 0f, 0f);
        Equal(1, l.LinkedTrackId, "the moving person");
        var l2 = new PersonLinker();
        l2.Update(L(Person(1, -0.5f, 3f, speed: 0.6f), Person(2, 0.5f, 3f, speed: 0f)), true, 0f, 3f, WristMotion.Still, 0f, 0f);
        Equal(2, l2.LinkedTrackId, "the still person");
    }

    private static void Hysteresis()
    {
        var l = new PersonLinker();
        var a = Person(1, 0f, 3f);
        var b = Person(2, 2f, 3f);
        l.Update(L(a, b), true, 0f, 3f, WristMotion.Unknown, 0f, 0f);
        Equal(1, l.LinkedTrackId, "A first");
        // The wristband moves a little towards B: B slightly better, A keeps the link
        float t = 0.2f;
        for (; t < 5f; t += 0.2f) l.Update(L(a, b), true, 1.1f, 3f, WristMotion.Unknown, 0f, t);
        Equal(1, l.LinkedTrackId, "A kept");
        // The wristband is now at B: clearly better; switches only after 2 s
        float start = t;
        l.Update(L(a, b), true, 2f, 3f, WristMotion.Unknown, 0f, t);
        Equal(1, l.LinkedTrackId, "not at once");
        for (t += 0.2f; t < start + 2.2f; t += 0.2f) l.Update(L(a, b), true, 2f, 3f, WristMotion.Unknown, 0f, t);
        Equal(2, l.LinkedTrackId, "B after 2 s");
    }

    private static void ManualChoice()
    {
        var l = new PersonLinker();
        var a = Person(1, 0f, 3f);
        var far = Person(2, 4f, 3f);
        l.ChooseManually(2);
        for (int i = 0; i < 50; i++) l.Update(L(a, far), true, 0f, 3f, WristMotion.Unknown, 0f, i * 0.2f);
        Equal(LinkState.LinkedManual, l.State, "kept");
        Near(4f, l.X, 0.001f, "panel at the chosen person");
        l.Update(L(a), true, 0f, 3f, WristMotion.Unknown, 0f, 10.2f);
        True(l.State != LinkState.LinkedManual, "chosen person lost: no longer manual");
    }

    private static void LinkedLost()
    {
        var l = new PersonLinker();
        l.Update(L(Person(1, 0f, 3f)), true, 0.3f, 3f, WristMotion.Unknown, 0f, 0f);
        l.Update(L(), true, 0.3f, 3f, WristMotion.Unknown, 0f, 0.2f);
        Equal(LinkState.BleOnly, l.State, "state");
        Near(0.3f, l.X, 0.001f, "Bluetooth position");
        True(l.Reason.Contains("out of view"), "reason says why");
    }

    private static void CutHeightNeutral()
    {
        var l = new PersonLinker();
        var close = new Track { Id = 1, X = -0.4f, Z = 1.2f, Height = 1.2f, HeightMaybeCut = true, Kind = TrackKind.PersonCandidate };
        var other = Person(2, 0.6f, 1.2f, 1.2f);
        l.Update(L(close, other), true, 0f, 1.2f, WristMotion.Unknown, 1.60f, 0f);
        Equal(1, l.LinkedTrackId, "the one whose top is out of view (could be 1.60 m)");
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
