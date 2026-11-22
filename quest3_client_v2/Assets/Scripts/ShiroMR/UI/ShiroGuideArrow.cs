// =============================================================================
// Project SHIRO - headset app version 2: "Show me"
//
// An arrow at the edge of the view that points toward a place in the room (a
// patient's tag, or their bed) for some seconds: blue from the ward panel, red
// for an alert. A real arrow (a head on a shaft) with a dark rim, so it reads
// against any wall, that nudges toward the place again and again. It hides
// while the place is in front of the clinician and comes back if they turn
// away before the time is up. Creates itself when first used.
// =============================================================================
using System;
using UnityEngine;
using UnityEngine.UI;

namespace ShiroMR.UI
{
    public class ShiroGuideArrow : MonoBehaviour
    {
        private const float LookedAtAngle = 15f;     // the place is in view: no arrow
        private const float Ahead = 0.35f;           // m: in front of the ward panel and the alert card
        private const float OffCentre = 0.085f;      // m from the middle of the view, toward the place
        private const float Nudge = 0.014f;          // m it moves toward the place, twice a second
        private const float Size = 44f;              // mm as drawn (scale 0.6: about 26 mm at 0.35 m)

        private static ShiroGuideArrow _instance;
        private Canvas _arrow;
        private Image _image, _rim;
        private Func<Vector3?> _target;
        private float _until;
        private Transform _head;

        /// <summary>The arrow is on view now (the preview tool and tests).</summary>
        public static bool IsShowing => _instance != null && _instance._arrow != null && _instance._arrow.gameObject.activeSelf;

        /// <summary>Points toward target (null from it: nowhere to point) for some seconds; blue unless a colour is given.</summary>
        public static void Show(Func<Vector3?> target, float seconds, Color? colour = null)
        {
            if (_instance == null) _instance = new GameObject("ShiroGuideArrow").AddComponent<ShiroGuideArrow>();
            if (_instance._image == null) _instance.Awake();   // outside Play mode Awake does not run by itself
            _instance._target = target;
            _instance._until = Time.time + seconds;
            _instance._image.color = colour ?? ShiroTheme.PrimaryHover;
        }

        public static void Hide()
        {
            if (_instance != null) _instance._until = -1f;
        }

        private void Awake()
        {
            _arrow = ShiroUIKit.WorldCanvas("GuideArrow", transform, new Vector2(Size, Size));
            // A dark rim: the same arrow a little larger behind it
            _rim = ShiroUIKit.Panel(_arrow.transform, "Rim", new Color(0.02f, 0.03f, 0.06f, 0.85f), 0f);
            _rim.sprite = ShiroUIKit.ArrowSprite;
            _rim.type = Image.Type.Simple;
            ShiroUIKit.Fill(_rim, -4f);
            _image = ShiroUIKit.Panel(_arrow.transform, "Arrow", ShiroTheme.PrimaryHover, 0f);
            _image.sprite = ShiroUIKit.ArrowSprite;
            _image.type = Image.Type.Simple;
            ShiroUIKit.Fill(_image);
            _arrow.gameObject.SetActive(false);
        }

        private void Update()
        {
            if (_head == null && Camera.main != null) _head = Camera.main.transform;
            Vector3? t = null;
            if (_head != null && Time.time < _until && _target != null)
            {
                try { t = _target(); }
                catch (Exception e) { ShiroLog.Caught("ShiroGuideArrow target", e); }
            }
            if (!t.HasValue) { if (_arrow.gameObject.activeSelf) _arrow.gameObject.SetActive(false); return; }

            Vector3 toTarget = t.Value - _head.position;
            if (Vector3.Angle(_head.forward, toTarget) < LookedAtAngle) { _arrow.gameObject.SetActive(false); return; }

            Vector3 local = _head.InverseTransformDirection(toTarget);
            Vector2 dir = new Vector2(local.x, local.y);
            if (local.z < 0f && dir.sqrMagnitude < 0.01f) dir = Vector2.right;   // right behind: turn right
            dir.Normalize();
            Vector3 worldDir = _head.right * dir.x + _head.up * dir.y;
            // Toward the place, nudging on: a quick push out, a slow return
            float phase = Mathf.Repeat(Time.time * 2f, 1f);
            float push = phase < 0.3f ? phase / 0.3f : 1f - (phase - 0.3f) / 0.7f;
            Vector3 pos = _head.position + _head.forward * Ahead + worldDir * (OffCentre + Nudge * push);
            _arrow.gameObject.SetActive(true);
            _arrow.transform.SetPositionAndRotation(pos, Quaternion.LookRotation(_head.forward, worldDir));
            _arrow.transform.localScale = Vector3.one * 0.001f * 0.6f;
        }
    }
}
