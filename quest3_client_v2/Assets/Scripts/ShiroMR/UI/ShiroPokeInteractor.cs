// =============================================================================
// Project SHIRO - headset app version 2: pressing buttons with a fingertip
//
// Version 1 clicked when a fingertip came within 2.4 cm of a button's centre,
// and clicked again every 0.35 s while it stayed there. Here a button is
// pressed like a real one:
//   - the fingertip must be over the button's area (not near its centre);
//   - it must come from in front: a button is "armed" while the fingertip is
//     at least 1.5 cm in front of it, and clicks once when the fingertip then
//     reaches its surface;
//   - after a click no button clicks again until the finger has come back out
//     1.5 cm. Holding the fingertip on a button clicks it once, however long,
//     and a moment of lost hand tracking does not count as coming back out.
// Nested buttons (a button on a card that can itself be tapped): the smaller one wins.
// Either hand's index finger works; with controllers, the controller's tip.
// Creates itself when the scene loads.
// =============================================================================
using System.Collections.Generic;
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
        private const float ArmInFront = 0.015f;     // m in front: the button can be pressed (again)
        private const float PushedThrough = 0.04f;   // m behind the surface: no longer on this button
        private const float EdgeMargin = 0.004f;     // m around the button that still counts for a press
        private const float ArmMargin = 0.010f;      // m around the button that counts for arming
        private const float NearUi = 0.15f;          // m in front of a button: the ray is hidden
        private const float MinInterval = 0.25f;     // s between two presses of one finger
        private const float LostTooLong = 0.5f;      // s without tracking: the finger starts afresh (unarmed)

        private class Finger
        {
            public Vector3 Pos;
            public bool Valid;
            public float LostSince = -1f;
            public ShiroButton Hovered;
            public readonly HashSet<ShiroButton> Armed = new HashSet<ShiroButton>();
            public float LastPress = -10f;
            public bool NearUi;
            public bool IsLeft;
        }

        private readonly Finger _right = new Finger();
        private readonly Finger _left = new Finger { IsLeft = true };
        private readonly List<ShiroButton> _scratch = new List<ShiroButton>();
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
                Feedback(f, 999f, false);
                f.NearUi = false;
                // A tracking blink keeps the finger's state (not armed after a press);
                // lost for longer, it starts afresh: it must come from in front again
                if (f.LostSince < 0f) f.LostSince = Time.unscaledTime;
                else if (Time.unscaledTime - f.LostSince > LostTooLong) f.Armed.Clear();
                return;
            }
            f.LostSince = -1f;

            ShiroButton best = null;
            float bestArea = float.MaxValue;
            float bestDepth = 0f;
            bool near = false;
            ShiroButton press = null;
            float pressArea = float.MaxValue;

            var all = ShiroButton.All;
            for (int i = 0; i < all.Count; i++)
            {
                var b = all[i];
                if (b == null || !b.Pokeable || !b.Interactable || !b.isActiveAndEnabled) continue;
                if (!Measure(b, f.Pos, out bool inside, out bool insideWide, out float depth, out float area)) continue;
                if (inside && depth > -NearUi && depth < 0.05f) near = true;

                // KEY LOGIC (pressing with a finger, like a real button): a button is "armed" when
                // the fingertip is clearly in front of it, and pressed once when the armed
                // fingertip reaches its surface. It cannot press again until the finger comes back
                // out, so a finger resting on a button, or tracking that blinks, never repeats.
                // Reached the surface of a button it was armed for: a press
                if (inside && depth >= PressAt && depth <= PushedThrough && f.Armed.Contains(b) && area < pressArea)
                {
                    press = b;
                    pressArea = area;
                }
                // Clearly in front of it: armed for it
                if (insideWide && depth < -ArmInFront) f.Armed.Add(b);

                if (!inside || depth < -HoverInFront || depth > PushedThrough) continue;
                if (area < bestArea) { best = b; bestArea = area; bestDepth = depth; }
            }
            f.NearUi = near;
            SetHover(f, best);
            // The fingertip's dot lights up over a button and grows at the press (both hands)
            Feedback(f, best != null ? Mathf.Max(0f, -bestDepth) : 999f, best != null && bestDepth >= PressAt);

            // Disarm the buttons the finger is no longer in front of (moved off the side,
            // pushed through, hidden). Pressing needs an arming from in front again.
            _scratch.Clear();
            foreach (var b in f.Armed)
            {
                if (b == null || !b.isActiveAndEnabled || !b.Interactable) { _scratch.Add(b); continue; }
                Measure(b, f.Pos, out _, out bool insideWide, out float depth, out _);
                if (!insideWide || depth > PushedThrough) _scratch.Add(b);
            }
            foreach (var b in _scratch) f.Armed.Remove(b);

            if (press != null && Time.unscaledTime - f.LastPress >= MinInterval)
            {
                f.LastPress = Time.unscaledTime;
                f.Armed.Clear();          // no other button either, until the finger comes back out
                press.PokeClick();
            }
        }

        /// <summary>
        /// Where a fingertip is relative to a button: over its area or not (inside: with the
        /// press margin; insideWide: with the arming margin), and its depth (m along the
        /// button's forward: negative in front of the surface, positive pushed through).
        /// </summary>
        private static bool Measure(ShiroButton b, Vector3 tip, out bool inside, out bool insideWide, out float depth, out float area)
        {
            inside = false; insideWide = false; depth = 0f; area = 0f;
            var rt = b.transform as RectTransform;
            if (rt == null) return false;
            Vector3 local = rt.InverseTransformPoint(tip);
            Rect r = rt.rect;
            float scale = Mathf.Max(1e-6f, rt.lossyScale.x);
            float m = EdgeMargin / scale;
            float mw = ArmMargin / scale;
            inside = local.x >= r.xMin - m && local.x <= r.xMax + m && local.y >= r.yMin - m && local.y <= r.yMax + m;
            insideWide = local.x >= r.xMin - mw && local.x <= r.xMax + mw && local.y >= r.yMin - mw && local.y <= r.yMax + mw;
            depth = Vector3.Dot(tip - rt.position, rt.forward);
            area = r.width * r.height * scale * scale;
            return true;
        }

        /// <summary>Hover distance (m in front of the button) and touching, for the fingertip's dot.</summary>
        private static void Feedback(Finger f, float distance, bool touching)
        {
            var hands = ShiroHandVisualizer.Instance;
            if (hands == null) return;
            if (f.IsLeft) { hands.PokeLeftHoverDistance = distance; hands.PokeLeftTouching = touching; }
            else { hands.PokeRightHoverDistance = distance; hands.PokeRightTouching = touching; }
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
