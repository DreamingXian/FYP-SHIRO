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
// Every candidate gets a score from four factors:
//   - distance to the Bluetooth position (wide: Bluetooth is inaccurate),
//   - height compared with the patient's height (neutral when not recorded,
//     or when the measured height may be cut off at the top of the view),
//   - movement compared with the wristband's motion sensor (neutral when
//     unknown),
//   - a bonus for the person linked a moment ago (hysteresis).
// A link starts only when the best candidate is clearly ahead of the second;
// another person takes over only when clearly better for 2 s; a link ends when
// the person is lost, or the Bluetooth position stays far away for 5 s.
// The bed rule (patient in their own bed) is applied before this, by the panel.
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
        public float MaxDistance = 3.0f;       // m from the Bluetooth position to be considered
        public float BreakDistance = 4.0f;     // m: a linked person this far away ...
        public float BreakAfter = 5.0f;        // s ... for this long ends the link
        public float MinScore = 0.15f;         // a weaker best candidate is not linked
        public float ClearlyAhead = 1.5f;      // best / second needed to decide
        public float SwitchAfter = 2.0f;       // s another person must be clearly better
        public float CurrentBonus = 1.5f;      // hysteresis for the linked person
        public float HeightTolerance = 0.08f;  // m: within this the height matches fully
        public float HeightSigma = 0.10f;      // m: fall-off beyond the tolerance
        public float MovingSpeed = 0.15f;      // m/s: a person faster than this is moving
        public float MotionMismatch = 0.5f;    // factor when wristband and person disagree
    }

    public sealed class LinkCandidate
    {
        public int TrackId;
        public float Score;
        public float Distance;
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
                if (hasBle && d > s.MaxDistance && t.Id != LinkedTrackId) continue;
                var c = new LinkCandidate
                {
                    TrackId = t.Id,
                    Distance = d,
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
                Reason = $"{_candidates.Count} people fit about equally: choose one";
            }
            else
            {
                State = LinkState.BleOnly;
                Reason = lostNote ?? (!hasBle ? "no wristband position yet"
                       : _candidates.Count == 0 ? "no person seen near the wristband: Bluetooth position"
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
            float diff = Math.Abs(t.Height - patientHeightM) - s.HeightTolerance;
            if (diff <= 0f) return 1f;
            return Math.Max(0.1f, (float)Math.Exp(-diff * diff / (2 * s.HeightSigma * s.HeightSigma)));
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
}
