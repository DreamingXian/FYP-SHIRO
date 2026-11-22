// =============================================================================
// Project SHIRO - headset app version 2: pressing buttons with a fingertip
//
// Version 1 clicked when a fingertip came within 2.4 cm of a button's centre,
// and clicked again every 0.35 s while it stayed there. Here a button is
// pressed like a real one:
//   - the fingertip must be over the button's area (not near its centre);
//   - the click happens once, when the fingertip reaches the surface;
//   - the next click needs the finger to come back out (1.5 cm) or leave the button.
// Nested buttons (a button on a card that can itself be tapped): the smaller one wins.
// Either hand's index finger works; with controllers, the controller's tip.
// Creates itself when the scene loads.
// =============================================================================
using UnityEngine;

namespace ShiroMR.UI
{
    public class ShiroPokeInteractor : MonoBehaviour
    {
        public static ShiroPokeInteractor Instance { get; private set; }

        /// <summary>The right fingertip is close in front of a button: the pointer ray is hidden.</summary>
        public static bool IsRightFingerNearUi { get; private set; }

        private const float HoverInFront = 0.05f;    // m in front of the surface: hover starts
        private const float PressAt = -0.003f;       // m: the fingertip reaches the surface (3 mm before it)
        private const float ReleaseInFront = 0.015f; // m: the finger is back out, the button can be pressed again
        private const float EdgeMargin = 0.004f;     // m around the button that still counts
        private const float NearUi = 0.15f;          // m in front of a button: the ray is hidden
        private const float MinInterval = 0.25f;     // s between two presses of one finger

        private class Finger
        {
            public Vector3 Pos;
            public bool Valid;
            public ShiroButton Hovered;
            public ShiroButton Blocked;   // pressed: no new press until the finger comes back out
            public float LastPress = -10f;
            public bool NearUi;
        }

        private readonly Finger _right = new Finger();
        private readonly Finger _left = new Finger();
        private Transform _rightController;
        private Transform _leftController;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Bootstrap()
        {
            if (Instance == null && FindAnyObjectByType<ShiroPokeInteractor>() == null)
                new GameObject("ShiroPokeInteractor").AddComponent<ShiroPokeInteractor>();
        }

        private void Awake()
        {
            if (Instance != null && Instance != this) { Destroy(gameObject); return; }
            Instance = this;
        }

        private void Update()
        {
            ReadFingers();
            Process(_right);
            Process(_left);
            IsRightFingerNearUi = _right.Valid && _right.NearUi;
        }

        private void ReadFingers()
        {
            var hands = ShiroHandVisualizer.Instance;
            _right.Valid = false;
            _left.Valid = false;
            if (hands != null && hands.IsRightHandTracked && hands.RightIndexTipPosition != Vector3.zero)
            {
                _right.Pos = hands.RightIndexTipPosition;
                _right.Valid = true;
            }
            if (hands != null && hands.IsLeftHandTracked && hands.LeftIndexTipPosition != Vector3.zero)
            {
                _left.Pos = hands.LeftIndexTipPosition;
                _left.Valid = true;
            }
            // Controllers: their tip, 8.5 cm ahead of the grip
            if (!_right.Valid)
            {
                if (_rightController == null) { var go = GameObject.Find("RightControllerAnchor"); if (go != null) _rightController = go.transform; }
                if (_rightController != null && _rightController.gameObject.activeInHierarchy && ControllerConnected(OVRInput.Controller.RTouch))
                {
                    _right.Pos = _rightController.position + _rightController.forward * 0.085f;
                    _right.Valid = true;
                }
            }
            if (!_left.Valid)
            {
                if (_leftController == null) { var go = GameObject.Find("LeftControllerAnchor"); if (go != null) _leftController = go.transform; }
                if (_leftController != null && _leftController.gameObject.activeInHierarchy && ControllerConnected(OVRInput.Controller.LTouch))
                {
                    _left.Pos = _leftController.position + _leftController.forward * 0.085f;
                    _left.Valid = true;
                }
            }
        }

        private static bool ControllerConnected(OVRInput.Controller c)
        {
            try { return OVRInput.IsControllerConnected(c); }
            catch { return false; }
        }

        private void Process(Finger f)
        {
            if (!f.Valid)
            {
                SetHover(f, null);
                f.Blocked = null;
                f.NearUi = false;
                return;
            }

            ShiroButton best = null;
            float bestArea = float.MaxValue;
            float bestDepth = 0f;
            bool near = false;

            var all = ShiroButton.All;
            for (int i = 0; i < all.Count; i++)
            {
                var b = all[i];
                if (b == null || !b.Pokeable || !b.Interactable || !b.isActiveAndEnabled) continue;
                if (!Measure(b, f.Pos, out bool inside, out float depth, out float area)) continue;
                if (inside && depth > -NearUi && depth < 0.05f) near = true;
                if (!inside || depth < -HoverInFront || depth > 0.04f) continue;
                if (area < bestArea) { best = b; bestArea = area; bestDepth = depth; }
            }
            f.NearUi = near;
            SetHover(f, best);

            // After a press: wait until the finger comes back out or leaves that button
            if (f.Blocked != null)
            {
                bool stillOn = f.Blocked.isActiveAndEnabled && Measure(f.Blocked, f.Pos, out bool inBlocked, out float dBlocked, out _) && inBlocked && dBlocked > -ReleaseInFront;
                if (stillOn) return;
                f.Blocked = null;
            }

            if (best != null && bestDepth >= PressAt && Time.unscaledTime - f.LastPress >= MinInterval)
            {
                f.LastPress = Time.unscaledTime;
                f.Blocked = best;
                best.PokeClick();
            }
        }

        /// <summary>
        /// Where a fingertip is relative to a button: over its area or not, and its depth
        /// (m along the button's forward: negative in front of the surface, positive pushed through).
        /// </summary>
        private static bool Measure(ShiroButton b, Vector3 tip, out bool inside, out float depth, out float area)
        {
            inside = false; depth = 0f; area = 0f;
            var rt = b.transform as RectTransform;
            if (rt == null) return false;
            Vector3 local = rt.InverseTransformPoint(tip);
            Rect r = rt.rect;
            float scale = Mathf.Max(1e-6f, rt.lossyScale.x);
            float m = EdgeMargin / scale;
            inside = local.x >= r.xMin - m && local.x <= r.xMax + m && local.y >= r.yMin - m && local.y <= r.yMax + m;
            depth = Vector3.Dot(tip - rt.position, rt.forward);
            area = r.width * r.height * scale * scale;
            return true;
        }

        private static void SetHover(Finger f, ShiroButton b)
        {
            if (f.Hovered == b) return;
            if (f.Hovered != null) f.Hovered.SetPokeHover(false);
            f.Hovered = b;
            if (b != null) b.SetPokeHover(true);
        }
    }
}
