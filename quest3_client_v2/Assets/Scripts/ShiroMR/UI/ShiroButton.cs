// =============================================================================
// Project SHIRO - headset app version 2: a button of the new interface
//
// Made by ShiroUIKit.Button. It reacts the same to a fingertip (ShiroPokeInteractor)
// and to the pointer ray (ShiroVRPointer): lighter under the finger or ray, a
// short flash and a click sound when pressed. The click itself is the Unity UI
// Button's onClick, which both the ray and the fingertip call, so an action runs
// the same way whichever was used.
// =============================================================================
using System;
using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace ShiroMR.UI
{
    public class ShiroButton : MonoBehaviour
    {
        /// <summary>Every button now enabled (the fingertip looks through these).</summary>
        public static readonly List<ShiroButton> All = new List<ShiroButton>();

        public UnityEngine.UI.Button UiButton { get; private set; }
        public Image Background { get; private set; }
        public TextMeshProUGUI Label { get; private set; }
        public BoxCollider Collider { get; private set; }
        public ButtonKind Kind { get; private set; }

        /// <summary>Can be pressed with a fingertip (false: only by the ray, e.g. a panel far away).</summary>
        public bool Pokeable = true;

        private Action _onClick;
        private bool _pokeHover;
        private bool _rayHover;
        private float _flashUntil;
        private Color? _override;          // e.g. a card flashing red while its patient's alert waits
        private RectTransform _rt;
        private Vector2 _lastSize;

        public bool Interactable => UiButton != null && UiButton.interactable;
        public bool IsHovered => _pokeHover || _rayHover;

        internal void Init(UnityEngine.UI.Button ui, Image bg, TextMeshProUGUI label, ButtonKind kind, Action onClick)
        {
            UiButton = ui;
            Background = bg;
            Label = label;
            Kind = kind;
            _onClick = onClick;
            _rt = (RectTransform)transform;
            Collider = gameObject.AddComponent<BoxCollider>();
            UiButton.onClick.AddListener(HandleClick);
            SyncCollider();
            ApplyLook();
        }

        private void OnEnable() { if (!All.Contains(this)) All.Add(this); }

        private void OnDisable()
        {
            All.Remove(this);
            _pokeHover = false;
            _rayHover = false;
        }

        private void OnDestroy() { All.Remove(this); }

        public void SetText(string text)
        {
            if (Label != null && Label.text != text) Label.text = text;
        }

        public void SetKind(ButtonKind kind)
        {
            if (Kind == kind) return;
            Kind = kind;
            if (Label != null) Label.color = kind == ButtonKind.Quiet ? ShiroTheme.OkText : ShiroTheme.TextOnColour;
        }

        public void SetInteractable(bool on)
        {
            if (UiButton != null) UiButton.interactable = on;
            if (Collider != null) Collider.enabled = on;
        }

        public void SetOnClick(Action onClick) { _onClick = onClick; }

        /// <summary>A colour that replaces the normal background (null: back to normal).</summary>
        public void SetColorOverride(Color? color) { _override = color; }

        internal void SetPokeHover(bool on) { _pokeHover = on; }

        /// <summary>Called by the pointer ray when it starts or stops pointing at this button.</summary>
        public void SetRayHover(bool on) { _rayHover = on; }

        /// <summary>Shows the button pressed for a moment (the ray calls this on pinch-down too).</summary>
        public void Flash() { _flashUntil = Time.unscaledTime + 0.12f; }

        /// <summary>A fingertip pressed the button.</summary>
        internal void PokeClick()
        {
            if (!Interactable) return;
            UiButton.onClick.Invoke();
        }

        private void HandleClick()
        {
            Flash();
            ShiroUISound.Click();
            try { _onClick?.Invoke(); }
            catch (Exception e) { ShiroLog.Caught($"ShiroButton {name}", e); }
        }

        private void LateUpdate()
        {
            SyncCollider();
            ApplyLook();
        }

        /// <summary>The collider covers the button (and a little depth for the ray), in front of its card.</summary>
        private void SyncCollider()
        {
            if (Collider == null || _rt == null) return;
            Vector2 size = _rt.rect.size;
            if (size == _lastSize) return;
            _lastSize = size;
            Vector2 centre = _rt.rect.center;
            // Cards sit behind their own buttons: a button's collider is 3 mm in front (toward the
            // reader, -z), so the ray hits the button and not the card it is on
            bool card = Kind == ButtonKind.Surface;
            Collider.center = new Vector3(centre.x, centre.y, card ? 0f : -3f);
            Collider.size = new Vector3(size.x, size.y, card ? 2f : 4f);
        }

        private void ApplyLook()
        {
            if (Background == null) return;
            bool hover = IsHovered && Interactable;
            bool flash = Time.unscaledTime < _flashUntil;
            Color c;
            if (_override.HasValue)
            {
                c = _override.Value;
                if (hover) c = Color.Lerp(c, Color.white, 0.12f);
            }
            else
            {
                switch (Kind)
                {
                    case ButtonKind.Primary: c = hover ? ShiroTheme.PrimaryHover : ShiroTheme.Primary; break;
                    case ButtonKind.Danger: c = hover ? ShiroTheme.DangerHover : ShiroTheme.Danger; break;
                    case ButtonKind.Secondary: c = hover ? ShiroTheme.SecondaryHover : ShiroTheme.Secondary; break;
                    case ButtonKind.Quiet: c = hover ? ShiroTheme.QuietHover : ShiroTheme.Quiet; break;
                    default: c = hover ? ShiroTheme.GlassHover : ShiroTheme.GlassRaised; break;
                }
            }
            if (flash) c = Color.Lerp(c, Color.white, 0.35f);
            if (!Interactable) c.a *= 0.4f;
            if (Background.color != c) Background.color = c;
            if (Label != null)
            {
                float a = Interactable ? 1f : 0.45f;
                if (!Mathf.Approximately(Label.alpha, a)) Label.alpha = a;
            }
            // Pressed: the button sinks 2 mm, as if pushed
            var p = _rt.localPosition;
            float z = flash ? 2f : 0f;
            if (!Mathf.Approximately(p.z, z)) _rt.localPosition = new Vector3(p.x, p.y, z);
        }
    }
}
