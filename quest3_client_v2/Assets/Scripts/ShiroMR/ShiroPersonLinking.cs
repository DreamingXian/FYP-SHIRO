// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Linking a patient's wristband to a person seen by the depth sensor (8D-4).
//
// Plain C# with no Unity dependency (tested in quest3_client/Tests~). One
// PersonLinker per patient panel. Each update it gets the person candidates of
// the person detector, the wristband's Bluetooth position (world metres, often
// 1-3 m off), the wristband's motion state when known, and the patient's
// recorded height when known. It decides where the panel belongs:
//
//   Linked        the panel follows that detected person (position from depth)
//   LinkedManual  the same, chosen by the clinician; kept until the person is lost
//   BleOnly       no suitable person: the panel uses the Bluetooth position
//   Unclear       two or more people fit about equally: no guess, the clinician
//                 can choose
//
// Only a person within 0.5 m of the Bluetooth position (a circle 1 m across)
// can start a link: in a small ward, a wider circle would link the first person
// seen to any wristband. Once linked, the link holds while the Bluetooth
// position stays within 1.5 m of the person (it wanders while the patient is
// still), and ends when it stays farther away for 5 s.
// Every candidate gets a score from four factors:
//   - distance to the Bluetooth position (wide: Bluetooth is inaccurate),
//   - height compared with the patient's height (neutral when not recorded,
//     or when the measured height may be cut off at the top of the view;
//     a taller person is ruled out, a shorter one only scores lower, as the
//     patient may be sitting or bending),
//   - movement compared with the wristband's motion sensor (neutral when
//     unknown),
//   - a bonus for the person linked a moment ago (hysteresis).
// A link starts only when the best candidate is clearly ahead of the second;
// another person takes over only when clearly better for 2 s; a link ends when
// the person is lost, or the Bluetooth position stays far away for 5 s.
// The bed rule (patient in their own bed) is applied before this, by the panel.
//
// PersonPicker (below) finds the person the clinician aims at, for choosing
// a person by hand.
// =============================================================================
using System;
using System.Collections.Generic;
using ShiroMR.Detection;

namespace ShiroMR.Linking
{
    public enum WristMotion { Unknown, Still, Moving }

    public enum LinkState { BleOnly, Linked, LinkedManual, Unclear }

    public sealed class LinkerSettings
    {
        public float BleSigma = 1.5f;          // m, spread of the Bluetooth position error
        public float LinkDistance = 0.5f;      // m from the Bluetooth position to start a link (1 m circle)
        public float BreakDistance = 1.5f;     // m: a linked person this far away ...
        public float BreakAfter = 5.0f;        // s ... for this long ends the link
        public float MinScore = 0.15f;         // a weaker best candidate is not linked
        public float ClearlyAhead = 1.5f;      // best / second needed to decide
        public float SwitchAfter = 2.0f;       // s another person must be clearly better
        public float CurrentBonus = 1.5f;      // hysteresis for the linked person
        public float HeightTolerance = 0.08f;  // m: within this the height matches fully
        public float HeightSigma = 0.10f;      // m: fall-off beyond the tolerance
        public float ShorterFloor = 0.5f;      // factor never below this for a shorter person (sitting, bending)
        public float MovingSpeed = 0.15f;      // m/s: a person faster than this is moving
        public float MotionMismatch = 0.5f;    // factor when wristband and person disagree
    }

    public sealed class LinkCandidate
    {
        public int TrackId;
        public float Score;
        public float Distance;
        public float Height;
        public float HeightFactor;
        public float MotionFactor;
    }

    public sealed class PersonLinker
    {
        public readonly LinkerSettings Settings;

        public LinkState State { get; private set; } = LinkState.BleOnly;
        /// <summary>The linked person (track id), or -1.</summary>
        public int LinkedTrackId { get; private set; } = -1;
        /// <summary>Where the panel belongs (world x, z): the linked person, or the Bluetooth position.</summary>
        public float X { get; private set; }
        public float Z { get; private set; }
        public bool HasPosition { get; private set; }
        /// <summary>Measured height of the linked person (m), or 0 when not linked.</summary>
        public float LinkedHeight { get; private set; }
        /// <summary>Short reason for the clinician, e.g. "linked: 1.62 m, 0.8 m from the wristband".</summary>
        public string Reason { get; private set; } = "waiting for the wristband position";
        public IReadOnlyList<LinkCandidate> Candidates => _candidates;

        private readonly List<LinkCandidate> _candidates = new List<LinkCandidate>();
        private int _challengerId = -1;
        private float _challengerSince;
        private float _farSince = -1f;

        public PersonLinker(LinkerSettings settings = null)
        {
            Settings = settings ?? new LinkerSettings();
        }

        /// <summary>The clinician chose this person; kept until the person is lost.</summary>
        public void ChooseManually(int trackId)
        {
            LinkedTrackId = trackId;
            State = LinkState.LinkedManual;
            _challengerId = -1;
            _farSince = -1f;
        }

        /// <summary>Back to automatic linking.</summary>
        public void Release()
        {
            LinkedTrackId = -1;
            State = LinkState.BleOnly;
            _challengerId = -1;
            _farSince = -1f;
        }

        /// <param name="tracks">The person detector's tracks (all kinds; only candidates are used).</param>
        /// <param name="hasBle">False while no Bluetooth position is known.</param>
        /// <param name="patientHeightM">The recorded height in metres, or 0 when not recorded.</param>
        public void Update(IReadOnlyList<Track> tracks, bool hasBle, float bleX, float bleZ,
                           WristMotion motion, float patientHeightM, float now)
        {
            var s = Settings;
            _candidates.Clear();
            Track linked = null;
            foreach (var t in tracks)
            {
                if (t.Id == LinkedTrackId) linked = t;
                if (t.Kind != TrackKind.PersonCandidate) continue;
                float d = hasBle ? Dist(t.X, t.Z, bleX, bleZ) : 0f;
                if (hasBle && d > s.LinkDistance && t.Id != LinkedTrackId) continue;
                var c = new LinkCandidate
                {
                    TrackId = t.Id,
                    Distance = d,
                    Height = t.Height,
                    HeightFactor = HeightFactor(t, patientHeightM),
                    MotionFactor = MotionFactor(t, motion),
                };
                float distFactor = hasBle ? (float)Math.Exp(-d * d / (2 * s.BleSigma * s.BleSigma)) : 1f;
                c.Score = distFactor * c.HeightFactor * c.MotionFactor * (t.Id == LinkedTrackId ? s.CurrentBonus : 1f);
                _candidates.Add(c);
            }
            _candidates.Sort((a, b) => b.Score.CompareTo(a.Score));

            // The linked person is gone (lost by the detector): the link ends
            string lostNote = null;
            if (LinkedTrackId >= 0 && linked == null)
            {
                string was = State == LinkState.LinkedManual ? "the chosen person" : "the linked person";
                LinkedTrackId = -1;
                State = LinkState.BleOnly;
                lostNote = $"{was} is out of view: Bluetooth position";
            }

            // A manual choice stays while the person is tracked
            if (State == LinkState.LinkedManual && linked != null)
            {
                SetPosition(linked.X, linked.Z);
                LinkedHeight = linked.Height;
                Reason = $"chosen by you: {linked.Height:0.00} m";
                return;
            }

            // An automatic link ends when the Bluetooth position stays far away
            if (State == LinkState.Linked && linked != null && hasBle)
            {
                float d = Dist(linked.X, linked.Z, bleX, bleZ);
                if (d > s.BreakDistance)
                {
                    if (_farSince < 0f) _farSince = now;
                    if (now - _farSince >= s.BreakAfter)
                    {
                        // It was a candidate only because it was linked: not one any more
                        int was = LinkedTrackId;
                        _candidates.RemoveAll(c => c.TrackId == was);
                        LinkedTrackId = -1;
                        State = LinkState.BleOnly;
                        _farSince = -1f;
                        linked = null;
                    }
                }
                else
                {
                    _farSince = -1f;
                }
            }

            LinkCandidate best = _candidates.Count > 0 ? _candidates[0] : null;
            LinkCandidate second = _candidates.Count > 1 ? _candidates[1] : null;

            if (State == LinkState.Linked && linked != null)
            {
                // Another person takes over only when clearly better for SwitchAfter seconds
                LinkCandidate current = _candidates.Find(c => c.TrackId == LinkedTrackId);
                float currentScore = current != null ? current.Score : 0f;
                if (best != null && best.TrackId != LinkedTrackId && best.Score > s.ClearlyAhead * currentScore)
                {
                    if (_challengerId != best.TrackId) { _challengerId = best.TrackId; _challengerSince = now; }
                    if (now - _challengerSince >= s.SwitchAfter)
                    {
                        LinkTo(best.TrackId, tracks);
                        return;
                    }
                }
                else
                {
                    _challengerId = -1;
                }
                SetPosition(linked.X, linked.Z);
                LinkedHeight = linked.Height;
                Reason = LinkedReason(linked, current);
                return;
            }

            // Not linked: link when one candidate is clearly the best
            if (best != null && best.Score >= s.MinScore && (second == null || best.Score >= s.ClearlyAhead * second.Score))
            {
                LinkTo(best.TrackId, tracks);
                return;
            }

            if (best != null && second != null && best.Score >= s.MinScore)
            {
                State = LinkState.Unclear;
                Reason = $"{_candidates.Count} people fit about equally: 🎯 Re-Attach to choose";
            }
            else
            {
                State = LinkState.BleOnly;
                Reason = lostNote ?? (!hasBle ? "no wristband position yet"
                       : _candidates.Count == 0 ? $"nobody within {s.LinkDistance:0.0} m of the wristband: Bluetooth position"
                       : best != null && patientHeightM > 0f && best.HeightFactor < 0.5f
                           ? $"the person near the wristband is {best.Height:0.00} m, taller than the patient ({patientHeightM:0.00} m): Bluetooth position"
                       : "no person fits well enough: Bluetooth position");
            }
            LinkedHeight = 0f;
            if (hasBle) SetPosition(bleX, bleZ);
            else HasPosition = false;
        }

        private void LinkTo(int trackId, IReadOnlyList<Track> tracks)
        {
            LinkedTrackId = trackId;
            State = LinkState.Linked;
            _challengerId = -1;
            _farSince = -1f;
            foreach (var t in tracks)
            {
                if (t.Id != trackId) continue;
                SetPosition(t.X, t.Z);
                LinkedHeight = t.Height;
                Reason = LinkedReason(t, _candidates.Find(c => c.TrackId == trackId));
            }
        }

        private static string LinkedReason(Track t, LinkCandidate c)
        {
            string dist = c != null ? $", {c.Distance:0.0} m from the wristband" : "";
            return $"linked: person {t.Height:0.00} m{dist}";
        }

        private float HeightFactor(Track t, float patientHeightM)
        {
            var s = Settings;
            if (patientHeightM <= 0f) return 1f;                // not recorded: neutral
            if (t.HeightMaybeCut) return t.Height <= patientHeightM + s.HeightTolerance ? 1f : 0.3f;
            bool shorter = t.Height < patientHeightM;
            float diff = Math.Abs(t.Height - patientHeightM) - s.HeightTolerance;
            if (diff <= 0f) return 1f;
            float f = (float)Math.Exp(-diff * diff / (2 * s.HeightSigma * s.HeightSigma));
            // Nobody stands taller than their recorded height, but a patient sitting in a chair,
            // bending, or with the top of the head measured low looks shorter: shorter only
            // lowers the score (the matching height still wins), taller rules the person out.
            return Math.Max(shorter ? s.ShorterFloor : 0.1f, f);
        }

        private float MotionFactor(Track t, WristMotion motion)
        {
            var s = Settings;
            if (motion == WristMotion.Unknown) return 1f;
            bool personMoving = t.Speed > s.MovingSpeed;
            bool wristMoving = motion == WristMotion.Moving;
            return personMoving == wristMoving ? 1f : s.MotionMismatch;
        }

        private void SetPosition(float x, float z)
        {
            X = x;
            Z = z;
            HasPosition = true;
        }

        private static float Dist(float ax, float az, float bx, float bz)
        {
            float dx = ax - bx, dz = az - bz;
            return (float)Math.Sqrt(dx * dx + dz * dz);
        }
    }

    /// <summary>
    /// The detected person a pointing ray aims at, for choosing a person by hand. Each
    /// person-sized object (a person candidate, or a still one: a patient who has not moved
    /// since the headset came on is still a person) is a vertical line from the floor to its
    /// height; the ray picks the one it passes closest to, within MaxMiss.
    /// </summary>
    public static class PersonPicker
    {
        public const float MaxMiss = 0.35f; // m: about a body's half-width plus the aim's wobble

        /// <returns>The track id, or -1 when the ray passes no person within MaxMiss.</returns>
        public static int Pick(IReadOnlyList<Track> tracks, float floorY,
                               float ox, float oy, float oz, float dx, float dy, float dz,
                               float maxMiss = MaxMiss)
        {
            float len = (float)Math.Sqrt(dx * dx + dy * dy + dz * dz);
            if (len < 1e-6f) return -1;
            dx /= len; dy /= len; dz /= len;
            float h2 = dx * dx + dz * dz;

            int best = -1;
            float bestMiss = maxMiss;
            foreach (var t in tracks)
            {
                if (t.Kind == TrackKind.NotPerson) continue;
                float miss;
                if (h2 < 1e-4f)
                {
                    // Pointing straight down (or up): the horizontal distance only
                    float ex = ox - t.X, ez = oz - t.Z;
                    miss = (float)Math.Sqrt(ex * ex + ez * ez);
                }
                else
                {
                    // Where the ray passes closest to the person's vertical line
                    float s = ((t.X - ox) * dx + (t.Z - oz) * dz) / h2;
                    if (s <= 0f) continue;                      // behind the wearer
                    float px = ox + dx * s - t.X, pz = oz + dz * s - t.Z;
                    float y = oy + dy * s;
                    float top = floorY + t.Height + 0.1f;      // a little above the head
                    float above = y > top ? y - top : y < floorY ? floorY - y : 0f;
                    miss = (float)Math.Sqrt(px * px + pz * pz + above * above);
                }
                if (miss < bestMiss)
                {
                    bestMiss = miss;
                    best = t.Id;
                }
            }
            return best;
        }
    }
}
