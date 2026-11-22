// =============================================================================
// Project SHIRO - headset app version 2: "Show me" from the ward panel
//
// A blue arrow at the edge of the view that points toward a place in the room
// (a patient's tag, or their bed) for a few seconds; it hides while the place
// is in front of the clinician. The alert card has its own red arrow for alerts.
// Creates itself when first used.
// =============================================================================
using System;
using UnityEngine;
using UnityEngine.UI;

namespace ShiroMR.UI
{
    public class ShiroGuideArrow : MonoBehaviour
    {
        private const float LookedAtAngle = 15f;     // the place is in view: no arrow

        private static ShiroGuideArrow _instance;
        private Canvas _arrow;
        private Image _image;
        private Func<Vector3?> _target;
        private float _until;
        private Transform _head;

        /// <summary>Points toward target (null from it: nowhere to point) for some seconds.</summary>
        public static void Show(Func<Vector3?> target, float seconds)
        {
            if (_instance == null) _instance = new GameObject("ShiroGuideArrow").AddComponent<ShiroGuideArrow>();
            _instance._target = target;
            _instance._until = Time.time + seconds;
        }

        public static void Hide()
        {
            if (_instance != null) _instance._until = -1f;
        }

        private void Awake()
        {
            _arrow = ShiroUIKit.WorldCanvas("GuideArrow", transform, new Vector2(34f, 34f));
            _image = ShiroUIKit.Panel(_arrow.transform, "Arrow", ShiroTheme.PrimaryHover, 0f);
            _image.sprite = ShiroUIKit.TriangleSprite;
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
            Vector3 pos = _head.position + _head.forward * 0.6f + worldDir * 0.13f;
            _arrow.gameObject.SetActive(true);
            _arrow.transform.SetPositionAndRotation(pos, Quaternion.LookRotation(_head.forward, worldDir));
            float pulse = 0.85f + 0.15f * Mathf.Sin(Time.time * 6f);
            _arrow.transform.localScale = Vector3.one * 0.001f * pulse;
        }
    }
}
