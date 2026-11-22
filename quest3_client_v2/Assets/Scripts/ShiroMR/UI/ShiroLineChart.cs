// =============================================================================
// Project SHIRO - headset app version 2: a line chart (the 24-hour history)
//
// One UI graphic draws the whole chart as a single mesh: a shaded band for the
// normal range, faint grid lines, the line, and dots on flagged points. A point
// with no value (NaN) breaks the line, so a time without readings (wristband
// off, out of range) shows as a gap instead of a line across it.
// Positions: x from 0 (start of the range) to 1 (now); y is the value.
// =============================================================================
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

namespace ShiroMR.UI
{
    [RequireComponent(typeof(CanvasRenderer))]
    public class ShiroLineChart : MaskableGraphic
    {
        public float YMin = 0f, YMax = 100f;
        public float BandLow = float.NaN, BandHigh = float.NaN;   // the normal range (shaded)
        public Color BandColour = new Color(1f, 1f, 1f, 0.06f);
        public Color GridColour = new Color(1f, 1f, 1f, 0.08f);
        public Color LineColour = Color.white;
        public Color FlagColour = ShiroTheme.WarnText;
        public float Thickness = 1.6f;    // mm
        public float FlagSize = 3.6f;     // mm

        private readonly List<Vector2> _points = new List<Vector2>();
        private readonly List<bool> _flags = new List<bool>();

        /// <summary>Points (x 0..1, y value or NaN for none) and which are flagged.</summary>
        public void SetPoints(List<Vector2> points, List<bool> flags)
        {
            _points.Clear();
            _flags.Clear();
            if (points != null) _points.AddRange(points);
            for (int i = 0; i < _points.Count; i++) _flags.Add(flags != null && i < flags.Count && flags[i]);
            SetVerticesDirty();
        }

        protected override void OnPopulateMesh(VertexHelper vh)
        {
            vh.Clear();
            Rect r = rectTransform.rect;
            if (r.width <= 0f || r.height <= 0f || YMax <= YMin) return;

            if (!float.IsNaN(BandLow) && !float.IsNaN(BandHigh))
            {
                float lo = Mathf.Clamp(Y(r, BandLow), r.yMin, r.yMax);
                float hi = Mathf.Clamp(Y(r, BandHigh), r.yMin, r.yMax);
                if (hi > lo) Quad(vh, new Vector2(r.xMin, lo), new Vector2(r.xMax, lo), new Vector2(r.xMax, hi), new Vector2(r.xMin, hi), BandColour);
            }
            // Grid: top, middle, bottom
            for (int i = 0; i <= 2; i++)
            {
                float y = Mathf.Lerp(r.yMin, r.yMax, i / 2f);
                Quad(vh, new Vector2(r.xMin, y - 0.25f), new Vector2(r.xMax, y - 0.25f), new Vector2(r.xMax, y + 0.25f), new Vector2(r.xMin, y + 0.25f), GridColour);
            }

            float half = Thickness / 2f;
            for (int i = 0; i < _points.Count; i++)
            {
                if (float.IsNaN(_points[i].y)) continue;
                Vector2 a = P(r, _points[i]);
                bool next = i + 1 < _points.Count && !float.IsNaN(_points[i + 1].y);
                bool prev = i > 0 && !float.IsNaN(_points[i - 1].y);
                if (next)
                {
                    Vector2 b = P(r, _points[i + 1]);
                    Vector2 d = b - a;
                    if (d.sqrMagnitude > 0.0001f)
                    {
                        Vector2 n = new Vector2(-d.y, d.x).normalized * half;
                        Quad(vh, a - n, b - n, b + n, a + n, LineColour);
                    }
                }
                // A joint (fills the corner between two segments), or a lone reading as a dot
                float s = next || prev ? half : Thickness;
                Quad(vh, a + new Vector2(-s, -s), a + new Vector2(s, -s), a + new Vector2(s, s), a + new Vector2(-s, s), LineColour);
            }

            for (int i = 0; i < _points.Count; i++)
                if (_flags[i] && !float.IsNaN(_points[i].y)) Disc(vh, P(r, _points[i]), FlagSize / 2f, FlagColour);
        }

        private float Y(Rect r, float value) => r.yMin + (value - YMin) / (YMax - YMin) * r.height;

        private Vector2 P(Rect r, Vector2 p)
        {
            float x = r.xMin + Mathf.Clamp01(p.x) * r.width;
            float y = Mathf.Clamp(Y(r, p.y), r.yMin, r.yMax);
            return new Vector2(x, y);
        }

        private static void Quad(VertexHelper vh, Vector2 a, Vector2 b, Vector2 c, Vector2 d, Color colour)
        {
            int i = vh.currentVertCount;
            vh.AddVert(a, colour, Vector2.zero);
            vh.AddVert(b, colour, Vector2.zero);
            vh.AddVert(c, colour, Vector2.zero);
            vh.AddVert(d, colour, Vector2.zero);
            vh.AddTriangle(i, i + 1, i + 2);
            vh.AddTriangle(i, i + 2, i + 3);
        }

        private static void Disc(VertexHelper vh, Vector2 centre, float radius, Color colour)
        {
            const int sides = 12;
            int c = vh.currentVertCount;
            vh.AddVert(centre, colour, Vector2.zero);
            for (int k = 0; k <= sides; k++)
            {
                float a = k * Mathf.PI * 2f / sides;
                vh.AddVert(centre + new Vector2(Mathf.Cos(a), Mathf.Sin(a)) * radius, colour, Vector2.zero);
                if (k > 0) vh.AddTriangle(c, c + k, c + k + 1);
            }
        }
    }
}
