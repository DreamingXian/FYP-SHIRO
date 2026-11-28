// =============================================================================
// Project SHIRO - headset app version 2: building blocks of the new interface
//
// Everything is made in code (like version 1), from a few parts that look the
// same everywhere: a world-space canvas, a rounded glass panel, text
// (TextMeshPro: sharp at any distance), a button in one of four kinds, and a
// status dot. Positions are given from the top-left corner of the parent, in
// mm, so a layout reads like a drawing: Place(x, y, width, height).
// =============================================================================
using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace ShiroMR.UI
{
    public enum ButtonKind
    {
        Primary,    // the main action of a panel (blue)
        Secondary,  // other actions (light glass)
        Danger,     // needs help / cannot be undone (red)
        Quiet,      // text only until pointed at
        Surface     // a whole card that can be tapped (glass)
    }

    public static class ShiroUIKit
    {
        // ----- Sprites made once at start (no image files needed) -----
        private const int RoundSize = 64;
        private const int RoundRadius = 30;
        private static Sprite _rounded;
        private static Sprite _circle;
        private static Sprite _triangle;

        /// <summary>A white rounded rectangle, 9-sliced: any size, any corner radius.</summary>
        public static Sprite RoundedSprite => _rounded != null ? _rounded : (_rounded = MakeRounded());

        /// <summary>A white disc.</summary>
        public static Sprite CircleSprite => _circle != null ? _circle : (_circle = MakeCircle());

        /// <summary>A white triangle pointing up (arrows).</summary>
        public static Sprite TriangleSprite => _triangle != null ? _triangle : (_triangle = MakeTriangle());

        private static Sprite _arrow;

        /// <summary>A white arrow pointing up: a wide head on a shaft, so its direction is plain.</summary>
        public static Sprite ArrowSprite => _arrow != null ? _arrow : (_arrow = MakeArrow());

        private static Sprite MakeArrow()
        {
            const int n = 64;
            const float mid = 32f, top = 62f, headBase = 30f, headHalf = 29f, shaftHalf = 9f, bottom = 2f;
            var tex = NewTexture(n);
            var px = new Color32[n * n];
            for (int y = 0; y < n; y++)
                for (int x = 0; x < n; x++)
                {
                    float cx = x + 0.5f, cy = y + 0.5f;   // texture row 0 is the bottom
                    float dx = Mathf.Abs(cx - mid);
                    // Head: from its base (headBase) up to the point (top)
                    float halfW = headHalf * (top - cy) / (top - headBase);
                    float head = cy > headBase - 0.5f && cy < top + 0.5f
                        ? Mathf.Clamp01(halfW - dx + 0.5f) * Mathf.Clamp01(cy - headBase + 0.5f) : 0f;
                    // Shaft: from the bottom up into the head
                    float shaft = cy < headBase + 1f
                        ? Mathf.Clamp01(shaftHalf - dx + 0.5f) * Mathf.Clamp01(cy - bottom + 0.5f) : 0f;
                    float a = Mathf.Max(head, shaft);
                    px[y * n + x] = new Color32(255, 255, 255, (byte)(a * 255));
                }
            tex.SetPixels32(px);
            tex.Apply(false, true);
            return Sprite.Create(tex, new Rect(0, 0, n, n), new Vector2(0.5f, 0.5f), 100f);
        }

        private static Sprite MakeRounded()
        {
            var tex = NewTexture(RoundSize);
            var px = new Color32[RoundSize * RoundSize];
            float r = RoundRadius;
            for (int y = 0; y < RoundSize; y++)
            {
                for (int x = 0; x < RoundSize; x++)
                {
                    // Distance into the nearest corner circle (0 outside the corner squares)
                    float cx = x + 0.5f, cy = y + 0.5f;
                    float dx = Mathf.Max(0f, Mathf.Max(r - cx, cx - (RoundSize - r)));
                    float dy = Mathf.Max(0f, Mathf.Max(r - cy, cy - (RoundSize - r)));
                    float d = Mathf.Sqrt(dx * dx + dy * dy);
                    float a = Mathf.Clamp01(r - d + 0.5f);
                    px[y * RoundSize + x] = new Color32(255, 255, 255, (byte)(a * 255));
                }
            }
            tex.SetPixels32(px);
            tex.Apply(false, true);
            return Sprite.Create(tex, new Rect(0, 0, RoundSize, RoundSize), new Vector2(0.5f, 0.5f), 100f, 0,
                SpriteMeshType.FullRect, new Vector4(RoundRadius, RoundRadius, RoundRadius, RoundRadius));
        }

        private static Sprite MakeCircle()
        {
            const int n = 64;
            var tex = NewTexture(n);
            var px = new Color32[n * n];
            float c = n / 2f;
            for (int y = 0; y < n; y++)
                for (int x = 0; x < n; x++)
                {
                    float d = Mathf.Sqrt((x + 0.5f - c) * (x + 0.5f - c) + (y + 0.5f - c) * (y + 0.5f - c));
                    px[y * n + x] = new Color32(255, 255, 255, (byte)(Mathf.Clamp01(c - d) * 255));
                }
            tex.SetPixels32(px);
            tex.Apply(false, true);
            return Sprite.Create(tex, new Rect(0, 0, n, n), new Vector2(0.5f, 0.5f), 100f);
        }

        private static Sprite MakeTriangle()
        {
            const int n = 64;
            var tex = NewTexture(n);
            var px = new Color32[n * n];
            for (int y = 0; y < n; y++)
                for (int x = 0; x < n; x++)
                {
                    // Apex at the top centre, base along the bottom (texture row 0 is the bottom)
                    float w = (n - (y + 0.5f)) / n;              // 1 at the bottom, 0 at the top
                    float edge = Mathf.Abs(x + 0.5f - n / 2f) - w * n / 2f;
                    float a = Mathf.Clamp01(0.5f - edge);
                    px[y * n + x] = new Color32(255, 255, 255, (byte)(a * 255));
                }
            tex.SetPixels32(px);
            tex.Apply(false, true);
            return Sprite.Create(tex, new Rect(0, 0, n, n), new Vector2(0.5f, 0.5f), 100f);
        }

        private static Texture2D NewTexture(int n)
        {
            return new Texture2D(n, n, TextureFormat.RGBA32, false)
            {
                wrapMode = TextureWrapMode.Clamp,
                filterMode = FilterMode.Bilinear,
                name = "ShiroUI"
            };
        }

        // ----- Canvas -----

        /// <summary>
        /// A world-space canvas of size (mm), its pivot at pivot (0.5, 0.5 = centre).
        /// One canvas unit is 1 mm (scale 0.001); change the scale to read it from further away.
        /// </summary>
        public static Canvas WorldCanvas(string name, Transform parent, Vector2 size, Vector2? pivot = null)
        {
            var go = new GameObject(name, typeof(RectTransform));
            if (parent != null) go.transform.SetParent(parent, false);
            var canvas = go.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.WorldSpace;
            canvas.additionalShaderChannels |= AdditionalCanvasShaderChannels.TexCoord1
                                              | AdditionalCanvasShaderChannels.Normal
                                              | AdditionalCanvasShaderChannels.Tangent;
            var scaler = go.AddComponent<CanvasScaler>();
            scaler.dynamicPixelsPerUnit = 3f;
            scaler.referencePixelsPerUnit = 100f;
            var rt = (RectTransform)go.transform;
            rt.sizeDelta = size;
            rt.pivot = pivot ?? new Vector2(0.5f, 0.5f);
            go.transform.localScale = Vector3.one * 0.001f;
            return canvas;
        }

        // ----- Layout -----

        /// <summary>Places a child: x, y from the parent's top-left corner, size w × h (mm).</summary>
        public static RectTransform Place(Component c, float x, float y, float w, float h)
        {
            var rt = (RectTransform)c.transform;
            rt.anchorMin = rt.anchorMax = new Vector2(0f, 1f);
            rt.pivot = new Vector2(0f, 1f);
            rt.anchoredPosition = new Vector2(x, -y);
            rt.sizeDelta = new Vector2(w, h);
            return rt;
        }

        /// <summary>Makes a child fill its parent (with an inset in mm).</summary>
        public static RectTransform Fill(Component c, float inset = 0f)
        {
            var rt = (RectTransform)c.transform;
            rt.anchorMin = Vector2.zero;
            rt.anchorMax = Vector2.one;
            rt.pivot = new Vector2(0.5f, 0.5f);
            rt.offsetMin = new Vector2(inset, inset);
            rt.offsetMax = new Vector2(-inset, -inset);
            return rt;
        }

        // ----- Parts -----

        /// <summary>A rounded panel (radius in mm; 0 = square corners).</summary>
        public static Image Panel(Transform parent, string name, Color color, float radius = ShiroTheme.Radius)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var img = go.AddComponent<Image>();
            img.color = color;
            img.raycastTarget = false;
            SetRadius(img, radius);
            return img;
        }

        /// <summary>Gives an image rounded corners of radius (mm).</summary>
        public static void SetRadius(Image img, float radius)
        {
            if (radius <= 0f) { img.sprite = null; img.type = Image.Type.Simple; return; }
            img.sprite = RoundedSprite;
            img.type = Image.Type.Sliced;
            img.pixelsPerUnitMultiplier = RoundRadius / radius;
        }

        /// <summary>Text (TextMeshPro). Size in mm (the height of the font's em).</summary>
        public static TextMeshProUGUI Label(Transform parent, string name, string text, float size, Color color,
            FontStyles style = FontStyles.Normal, TextAlignmentOptions align = TextAlignmentOptions.Left, bool wrap = false)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var t = go.AddComponent<TextMeshProUGUI>();
            t.text = text ?? "";
            t.fontSize = size;
            t.color = color;
            t.fontStyle = style;
            t.alignment = align;
            t.textWrappingMode = wrap ? TextWrappingModes.Normal : TextWrappingModes.NoWrap;
            t.overflowMode = TextOverflowModes.Ellipsis;
            t.raycastTarget = false;
            t.margin = Vector4.zero;
            return t;
        }

        /// <summary>
        /// Lets a label shrink (down to minSize) when its text does not fit, before anything
        /// is cut ("…" only below minSize). For labels whose text is not known in advance:
        /// names, titles, button labels.
        /// </summary>
        public static TextMeshProUGUI Fit(this TextMeshProUGUI t, float minSize)
        {
            t.enableAutoSizing = true;
            t.fontSizeMax = t.fontSize;
            t.fontSizeMin = Mathf.Min(minSize, t.fontSize);
            return t;
        }

        /// <summary>A filled disc of diameter d (mm), e.g. a status dot.</summary>
        public static Image Dot(Transform parent, string name, Color color)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var img = go.AddComponent<Image>();
            img.sprite = CircleSprite;
            img.color = color;
            img.raycastTarget = false;
            return img;
        }

        /// <summary>
        /// A button: rounded background, centred label, a collider for the pointer ray and
        /// fingertip touch (click on push, see ShiroPokeInteractor). Size it with Place().
        /// </summary>
        public static ShiroButton Button(Transform parent, string name, string label, ButtonKind kind, Action onClick,
            float textSize = ShiroTheme.TextBody)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var img = go.AddComponent<Image>();
            img.raycastTarget = false;
            SetRadius(img, kind == ButtonKind.Surface ? ShiroTheme.Radius : ShiroTheme.ButtonRadius);

            var ui = go.AddComponent<UnityEngine.UI.Button>();
            ui.transition = Selectable.Transition.None;   // ShiroButton draws its own states
            ui.targetGraphic = null;
            var nav = ui.navigation;
            nav.mode = Navigation.Mode.None;
            ui.navigation = nav;

            TextMeshProUGUI text = null;
            if (!string.IsNullOrEmpty(label) || kind != ButtonKind.Surface)
            {
                text = Label(go.transform, "Label", label, textSize, kind == ButtonKind.Quiet ? ShiroTheme.OkText : ShiroTheme.TextOnColour,
                    FontStyles.Bold, TextAlignmentOptions.Center).Fit(textSize * 0.75f);
                Fill(text, 4f);
            }

            var b = go.AddComponent<ShiroButton>();
            b.Init(ui, img, text, kind, onClick);
            return b;
        }
    }
}
