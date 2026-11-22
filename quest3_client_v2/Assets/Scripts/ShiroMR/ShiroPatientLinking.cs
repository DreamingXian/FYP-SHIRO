// =============================================================================
// Project SHIRO - Meta Quest 3 Mixed Reality Client
// Person linking on the headset (8D-4) and a fake wristband for testing.
//
// Person linking (System tab "Linking"): after every depth update, each patient
// panel that is not at its bed gets a PersonLinker (ShiroPersonLinking.cs): the
// detected people, the wristband's Bluetooth position, its motion state and the
// patient's recorded height decide whether the panel follows a detected person
// or stays at the Bluetooth position. The bed rule comes first: a panel at its
// bed is not linked. A panel pinned to a spot by hand is left alone.
// Linking is on by default (it can be switched off on the System tab).
//
// Choosing a person by hand (8D-5): "🎯 Re-Attach" on the panel, then aim at a
// person. The person aimed at is marked (an amber column) and the pointer says
// "LINK TO THIS PERSON"; a pinch links the panel to that person (LinkedManual),
// whatever the Bluetooth position says, until the person is lost from view. Aiming
// where nobody is detected pins the panel to that spot instead, as before. "🔄 Auto"
// on the panel ends either choice and goes back to automatic linking.
//
// While a real wristband is linked to a detected person (automatically or chosen by
// hand) and the room is aligned, the person's position is sent to the edge server
// in ward coordinates after every depth update (PATIENT_SEEN): the web and headset
// maps then show the patient where the headset sees them instead of at the
// Bluetooth position, with the Bluetooth estimate alongside. When the link ends,
// "no longer seen" is sent; if nothing more arrives (headset off, connection lost),
// the edge server goes back to Bluetooth after 1.5 s. The panels themselves keep
// deciding with the Bluetooth position (see ShiroMRManager).
//
// Fake wristband (System tab "Fake band", for testing alone): a test panel whose
// "Bluetooth position" wanders smoothly at random (0.3 m/s) within 1.2 m of a
// spot 2 m in front of the wearer, shown as a cyan disc on the floor. With a
// person candidate near it (for example the clothes rack after it was moved),
// the panel should link to that person and stay there while the fake position
// keeps wandering. The fake panel uses the recorded height of the first patient
// of the ward that has one (or none), and no motion state (neutral). It is not
// a real wristband and is never sent to the edge server.
// Creates itself when the scene loads: nothing has to be added to the scene.
// =============================================================================
using System.Collections.Generic;
using ShiroMR.Detection;
using ShiroMR.Linking;
using UnityEngine;

namespace ShiroMR
{
    public class ShiroPatientLinking : MonoBehaviour
    {
        public static ShiroPatientLinking Instance { get; private set; }

        private const string PrefLinking = "Shiro_PersonLinking";
        public const string FakeTag = "FAKE-1";
        private const float FakeRadius = 1.2f;     // m around the fake centre
        private const float FakeSpeed = 0.3f;      // m/s
        private const float FakeAhead = 2.0f;      // m in front of the wearer
        private const float FakeInterval = 0.2f;   // s between fake position reports

        public bool LinkingEnabled { get; private set; }
        public bool FakeEnabled { get; private set; }
        /// <summary>While choosing a person by hand: the detected person aimed at, or -1.</summary>
        public int AimedTrackId { get; private set; } = -1;
        /// <summary>Measured height of the person aimed at (m).</summary>
        public float AimedHeight { get; private set; }

        private readonly Dictionary<string, PersonLinker> _linkers = new Dictionary<string, PersonLinker>();
        private readonly HashSet<string> _reported = new HashSet<string>(); // tags whose position the edge server has from here
        private bool _subscribed;

        // Fake wristband
        private Vector3 _fakeCentre, _fakePos, _fakeTarget;
        private float _fakeTimer;
        private float _fakeHeightM;
        private GameObject _fakeMarker;
        private TextMesh _fakeLabel;

        // Choosing by hand: the column on the person aimed at
        private GameObject _aimMarker;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Bootstrap()
        {
            if (Instance == null && FindAnyObjectByType<ShiroPatientLinking>() == null)
            {
                new GameObject("ShiroPatientLinking").AddComponent<ShiroPatientLinking>();
            }
        }

        private void Awake()
        {
            if (Instance != null && Instance != this) { Destroy(gameObject); return; }
            Instance = this;
            DontDestroyOnLoad(gameObject);
            LinkingEnabled = PlayerPrefs.GetInt(PrefLinking, 1) == 1;
        }

        private void OnDestroy()
        {
            var probe = ShiroDepthProbe.Instance;
            if (_subscribed && probe != null)
            {
                probe.OnDetectionUpdated -= HandleDetection;
                probe.ExtraLabel = null;
            }
        }

        public void SetLinkingEnabled(bool on)
        {
            LinkingEnabled = on;
            PlayerPrefs.SetInt(PrefLinking, on ? 1 : 0);
            PlayerPrefs.Save();
            if (!on)
            {
                if (FakeEnabled) SetFakeEnabled(false);
                foreach (var tag in new List<string>(_reported)) EndReport(tag);
                _linkers.Clear();
                var mr = ShiroMRManager.Instance;
                if (mr != null) foreach (var h in mr.Holograms.Values) if (h != null) h.ClearDepthLink();
            }
            ShiroDepthProbe.Instance?.SetSensingRequested(on);
        }

        public void SetFakeEnabled(bool on)
        {
            if (on == FakeEnabled) return;
            FakeEnabled = on;
            var mr = ShiroMRManager.Instance;
            if (on)
            {
                if (!LinkingEnabled) SetLinkingEnabled(true);
                StartFake();
            }
            else
            {
                if (mr != null) mr.RemoveHologram(FakeTag);
                _linkers.Remove(FakeTag);
                if (_fakeMarker != null) _fakeMarker.SetActive(false);
            }
        }

        private void Update()
        {
            var probe = ShiroDepthProbe.Instance;
            if (!_subscribed && probe != null)
            {
                probe.OnDetectionUpdated += HandleDetection;
                probe.ExtraLabel = LinkedNames;
                probe.SetSensingRequested(LinkingEnabled);
                _subscribed = true;
            }
            if (FakeEnabled) UpdateFake();
            UpdateAim();
        }

        // ----- Choosing a person by hand -----

        /// <summary>While a panel waits for "aim and pinch", finds and marks the person aimed at.</summary>
        private void UpdateAim()
        {
            var pointer = ShiroVRPointer.Instance;
            var probe = ShiroDepthProbe.Instance;
            int id = -1;
            Track aimed = null;
            if (LinkingEnabled && pointer != null && pointer.isReattaching && probe != null && probe.IsSensing)
            {
                Vector3 o = pointer.PointerOrigin, d = pointer.PointerForward;
                var tracks = probe.Detector.Tracks;
                id = PersonPicker.Pick(tracks, probe.FloorY, o.x, o.y, o.z, d.x, d.y, d.z);
                foreach (var t in tracks) if (t.Id == id) { aimed = t; break; }
                if (aimed == null) id = -1;
            }
            AimedTrackId = id;
            AimedHeight = aimed != null ? aimed.Height : 0f;

            if (aimed == null)
            {
                if (_aimMarker != null && _aimMarker.activeSelf) _aimMarker.SetActive(false);
                return;
            }
            EnsureAimMarker();
            float h = Mathf.Max(0.3f, aimed.Height);
            _aimMarker.transform.position = new Vector3(aimed.X, probe.FloorY + h * 0.5f, aimed.Z);
            _aimMarker.transform.localScale = new Vector3(0.5f, h * 0.5f, 0.5f); // a cylinder is 2 units tall
            if (!_aimMarker.activeSelf) _aimMarker.SetActive(true);
        }

        private void EnsureAimMarker()
        {
            if (_aimMarker != null) return;
            _aimMarker = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            _aimMarker.name = "ChoosePersonMarker";
            Destroy(_aimMarker.GetComponent<Collider>()); // never blocks the pointer
            _aimMarker.transform.SetParent(transform, true);
            var r = _aimMarker.GetComponent<Renderer>();
            r.material = new Material(Shader.Find("Sprites/Default")) { color = new Color(1f, 0.75f, 0.1f, 0.25f) };
        }

        /// <summary>
        /// The pinch while choosing: links the panel to the person aimed at. False when no
        /// person is aimed at (or linking is off); the panel is then pinned to the spot instead.
        /// </summary>
        public bool TryChoosePerson(PatientHologram holo)
        {
            if (!LinkingEnabled || holo == null || AimedTrackId < 0) return false;
            var probe = ShiroDepthProbe.Instance;
            if (probe == null) return false;
            Track chosen = null;
            foreach (var t in probe.Detector.Tracks) if (t.Id == AimedTrackId) { chosen = t; break; }
            if (chosen == null) return false;

            if (!_linkers.TryGetValue(holo.tagId, out var linker))
            {
                linker = new PersonLinker();
                _linkers[holo.tagId] = linker;
            }
            linker.ChooseManually(chosen.Id);
            holo.ChoosePerson(new Vector3(chosen.X, 0f, chosen.Z), chosen.Height, $"chosen by you: {chosen.Height:0.00} m");
            AimedTrackId = -1;
            if (_aimMarker != null) _aimMarker.SetActive(false);
            Debug.Log($"[SHIRO LINK] {holo.tagId}: person #{chosen.Id} ({chosen.Height:0.00} m) chosen by hand");
            return true;
        }

        /// <summary>"Auto" on the panel: a person chosen by hand is let go; automatic linking resumes.</summary>
        public void ReleaseChoice(string tag)
        {
            if (tag != null && _linkers.TryGetValue(tag, out var linker) && linker.State == LinkState.LinkedManual)
                linker.Release();
        }

        // ----- Linking after every depth update -----

        private void HandleDetection()
        {
            if (!LinkingEnabled) return;
            var mr = ShiroMRManager.Instance;
            var probe = ShiroDepthProbe.Instance;
            if (mr == null || probe == null) return;

            var tracks = probe.Detector.Tracks;
            float now = Time.realtimeSinceStartup;
            var seen = new HashSet<string>();
            foreach (var kv in mr.Holograms)
            {
                string tag = kv.Key;
                PatientHologram holo = kv.Value;
                if (holo == null) continue;
                seen.Add(tag);

                // Bed rule first, and a panel placed by hand is left alone
                if (holo.trackingState != PatientTrackingState.InTransit || holo.IsManuallyLocked)
                {
                    if (_linkers.TryGetValue(tag, out var idle)) idle.Release();
                    holo.ClearDepthLink();
                    EndReport(tag);
                    continue;
                }

                if (!_linkers.TryGetValue(tag, out var linker))
                {
                    linker = new PersonLinker();
                    _linkers[tag] = linker;
                }

                bool fake = tag == FakeTag;
                Vector3 ble = holo.IpsWorldPosition;
                WristMotion motion = fake ? WristMotion.Unknown : ToMotion(holo.motionState);
                float heightM = fake ? _fakeHeightM : HeightOf(mr.FindSubject(tag));
                linker.Update(tracks, holo.HasIpsPosition, ble.x, ble.z, motion, heightM, now);
                holo.SetDepthLink(linker.State, new Vector3(linker.X, 0f, linker.Z), linker.Reason, linker.LinkedHeight);
                if (!fake) Report(tag, linker);
            }

            // Linkers of panels that are gone
            var stale = new List<string>();
            foreach (var tag in _linkers.Keys) if (!seen.Contains(tag)) stale.Add(tag);
            foreach (var tag in stale) { _linkers.Remove(tag); EndReport(tag); }
        }

        /// <summary>
        /// While linked to a detected person (and the room is aligned), tells the edge server
        /// where the patient is seen, in ward coordinates; when no longer, says so once.
        /// </summary>
        private void Report(string tag, PersonLinker linker)
        {
            var net = ShiroNetworkManager.Instance;
            var spatial = WardSpatialManager.Instance;
            bool linked = (linker.State == LinkState.Linked || linker.State == LinkState.LinkedManual) && linker.HasPosition;
            if (!linked || net == null || !net.IsConnected || spatial == null || !spatial.IsAligned)
            {
                EndReport(tag);
                return;
            }
            Vector3 ward = spatial.wardOrigin.InverseTransformPoint(new Vector3(linker.X, spatial.wardOrigin.position.y, linker.Z));
            if (net.SendPatientSeen(tag, true, ward.x, ward.z, linker.LinkedHeight, linker.State == LinkState.LinkedManual))
                _reported.Add(tag);
        }

        private void EndReport(string tag)
        {
            if (!_reported.Remove(tag)) return;
            ShiroNetworkManager.Instance?.SendPatientSeen(tag, false, 0f, 0f, 0f, false);
        }

        /// <summary>Linked patients of a detected person, for the depth view's label.</summary>
        private string LinkedNames(int trackId)
        {
            var mr = ShiroMRManager.Instance;
            if (mr == null) return null;
            string names = null;
            foreach (var kv in _linkers)
            {
                if (kv.Value.LinkedTrackId != trackId) continue;
                string name = mr.Holograms.TryGetValue(kv.Key, out var h) && h != null ? h.fullName : kv.Key;
                if (kv.Value.State == LinkState.LinkedManual) name += " (chosen by you)";
                names = names == null ? $"🔗 {name}" : $"{names}, {name}";
            }
            return names;
        }

        private static WristMotion ToMotion(string state)
        {
            switch (state)
            {
                case "WALKING": return WristMotion.Moving;
                case "STATIONARY":
                case "HAND_MOVEMENT":   // the arm moves; the person stays where they are
                case "SETTLING": return WristMotion.Still;
                default: return WristMotion.Unknown;
            }
        }

        private static float HeightOf(TrackedSubject s) => s != null && s.HasHeight ? s.height_cm / 100f : 0f;

        /// <summary>The linking state of a panel (for the hand slate), or null.</summary>
        public PersonLinker LinkerOf(string tag) => tag != null && _linkers.TryGetValue(tag, out var l) ? l : null;

        // ----- Fake wristband -----

        private void StartFake()
        {
            Camera cam = Camera.main;
            Vector3 head = cam != null ? cam.transform.position : Vector3.zero;
            Vector3 fwd = cam != null ? Vector3.ProjectOnPlane(cam.transform.forward, Vector3.up).normalized : Vector3.forward;
            if (fwd.sqrMagnitude < 0.01f) fwd = Vector3.forward;
            _fakeCentre = new Vector3(head.x, 0f, head.z) + fwd * FakeAhead;
            _fakePos = _fakeCentre;
            _fakeTarget = _fakeCentre;
            _fakeTimer = 0f;

            // The fake panel takes the name and recorded height of a patient of this ward, if any
            TrackedSubject subject = null;
            var subjects = ShiroNetworkManager.Instance != null ? ShiroNetworkManager.Instance.LastLoadedSubjects : null;
            if (subjects != null)
            {
                foreach (var s in subjects) if (s != null && s.HasHeight) { subject = s; break; }
                if (subject == null && subjects.Count > 0) subject = subjects[0];
            }
            _fakeHeightM = HeightOf(subject);
            string label = subject != null ? $"{subject.full_name} (FAKE LOCATION)" : "Test patient (FAKE LOCATION)";
            ShiroMRManager.Instance?.SpawnTestHologram(FakeTag, subject != null ? subject.patient_id : "TEST", label);

            EnsureFakeMarker();
            _fakeMarker.SetActive(true);
            _fakeLabel.text = _fakeHeightM > 0f ? $"fake wristband · patient {_fakeHeightM:0.00} m" : "fake wristband · height not recorded";
            ReportFake();
        }

        private void UpdateFake()
        {
            var mr = ShiroMRManager.Instance;
            // The panel is cleared when the ward changes: make it again
            if (mr != null && !mr.Holograms.ContainsKey(FakeTag)) StartFake();

            // Smooth random walk within FakeRadius of the centre
            if ((_fakeTarget - _fakePos).sqrMagnitude < 0.0025f)
            {
                Vector2 r = Random.insideUnitCircle * FakeRadius;
                _fakeTarget = _fakeCentre + new Vector3(r.x, 0f, r.y);
            }
            _fakePos = Vector3.MoveTowards(_fakePos, _fakeTarget, FakeSpeed * Time.deltaTime);

            if (_fakeMarker != null)
            {
                _fakeMarker.transform.position = _fakePos + Vector3.up * 0.01f;
                Camera cam = Camera.main;
                if (cam != null)
                {
                    Vector3 look = _fakeLabel.transform.position - cam.transform.position;
                    look.y = 0f;
                    if (look.sqrMagnitude > 0.001f) _fakeLabel.transform.rotation = Quaternion.LookRotation(look);
                }
            }

            _fakeTimer += Time.deltaTime;
            if (_fakeTimer >= FakeInterval)
            {
                _fakeTimer = 0f;
                ReportFake();
            }
        }

        /// <summary>Gives the fake position to the test panel, as a Bluetooth position in ward coordinates.</summary>
        private void ReportFake()
        {
            var mr = ShiroMRManager.Instance;
            if (mr == null || !mr.Holograms.TryGetValue(FakeTag, out var holo) || holo == null) return;
            var spatial = WardSpatialManager.Instance;
            Vector3 ward = spatial != null && spatial.wardOrigin != null
                ? spatial.wardOrigin.InverseTransformPoint(_fakePos)
                : _fakePos;
            holo.UpdatePosition(ward.x, ward.z, "STATIONARY");
        }

        private void EnsureFakeMarker()
        {
            if (_fakeMarker != null) return;
            _fakeMarker = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            _fakeMarker.name = "FakeWristbandMarker";
            Destroy(_fakeMarker.GetComponent<Collider>()); // never blocks the pointer
            _fakeMarker.transform.SetParent(transform, false);
            _fakeMarker.transform.localScale = new Vector3(0.25f, 0.005f, 0.25f);
            var r = _fakeMarker.GetComponent<Renderer>();
            r.material = new Material(Shader.Find("Sprites/Default")) { color = new Color(0.1f, 0.8f, 1f, 0.8f) };

            var labelObj = new GameObject("FakeWristbandLabel");
            labelObj.transform.SetParent(_fakeMarker.transform, false);
            labelObj.transform.localScale = new Vector3(4f, 200f, 4f); // undo the disc's scale
            labelObj.transform.localPosition = new Vector3(0f, 30f, 0f); // 0.15 m above the floor
            _fakeLabel = labelObj.AddComponent<TextMesh>();
            _fakeLabel.fontSize = 40;
            _fakeLabel.characterSize = 0.004f;
            _fakeLabel.anchor = TextAnchor.LowerCenter;
            _fakeLabel.alignment = TextAlignment.Center;
            _fakeLabel.color = new Color(0.4f, 0.9f, 1f);
        }
    }
}
