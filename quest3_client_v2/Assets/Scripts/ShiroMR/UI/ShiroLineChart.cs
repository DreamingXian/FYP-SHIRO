// =============================================================================
// Project SHIRO - headset app version 2: a line chart (the vitals history)
//
// One UI graphic draws the whole chart as a single mesh, in the web dashboard's
// style: a shaded band for the normal range, faint grid lines at given values,
// one thin line through every reading, and dots. Consecutive readings are
// always joined; a stretch with no readings for a long time (wristband off or
// out of range) is joined by a faint line, so it reads as "nothing measured
// here" without breaking the line into loose dots. Small dots mark the readings
// when there are few of them; flagged readings get a red dot.
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
        public float[] GridValues;                                // faint lines at these values
        public Color BandColour = new Color(1f, 1f, 1f, 0.06f);
        public Color GridColour = new Color(1f, 1f, 1f, 0.10f);
        public Color LineColour = Color.white;
        public Color FlagColour = new Color32(239, 68, 68, 255);
        public float Thickness = 1.2f;    // mm
        public float DotSize = 2.4f;      // mm, a reading's dot (few readings)
        public float FlagSize = 3.4f;     // mm, a flagged reading's dot
        public int DotsUpTo = 60;         // dots on every reading up to this many readings
        public float GapAlpha = 0.35f;    // a long stretch without readings: a faint line

        private readonly List<Vector2> _points = new List<Vector2>();
        private readonly List<bool> _flags = new List<bool>();
        private readonly List<bool> _gapBefore = new List<bool>();

        /// <summary>
        /// Readings in time order (x 0..1, y value), which are flagged, and which come after a
        /// long stretch without readings (that join is drawn faint).
        /// </summary>
        public void SetPoints(List<Vector2> points, List<bool> flags, List<bool> gapBefore)
        {
            _points.Clear();
            _flags.Clear();
            _gapBefore.Clear();
            if (points != null) _points.AddRange(points);
            for (int i = 0; i < _points.Count; i++)
            {
                _flags.Add(flags != null && i < flags.Count && flags[i]);
                _gapBefore.Add(gapBefore != null && i < gapBefore.Count && gapBefore[i]);
            }
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
            if (GridValues != null)
                foreach (float v in GridValues)
                {
                    if (v < YMin || v > YMax) continue;
                    float y = Y(r, v);
                    Quad(vh, new Vector2(r.xMin, y - 0.2f), new Vector2(r.xMax, y - 0.2f), new Vector2(r.xMax, y + 0.2f), new Vector2(r.xMin, y + 0.2f), GridColour);
                }

            float half = Thickness / 2f;
            Color faint = LineColour;
            faint.a *= GapAlpha;
            for (int i = 0; i + 1 < _points.Count; i++)
            {
                Vector2 a = P(r, _points[i]), b = P(r, _points[i + 1]);
                Vector2 d = b - a;
                if (d.sqrMagnitude < 0.0001f) continue;
                Vector2 n = new Vector2(-d.y, d.x).normalized * half;
                Quad(vh, a - n, b - n, b + n, a + n, _gapBefore[i + 1] ? faint : LineColour);
            }
            // Round joins (no corners sticking out), or every reading's dot when there are few
            bool dots = _points.Count <= DotsUpTo;
            for (int i = 0; i < _points.Count; i++)
                Disc(vh, P(r, _points[i]), dots ? DotSize / 2f : half, LineColour, dots ? 10 : 6);
            for (int i = 0; i < _points.Count; i++)
                if (_flags[i]) Disc(vh, P(r, _points[i]), FlagSize / 2f, FlagColour, 12);
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

        private static void Disc(VertexHelper vh, Vector2 centre, float radius, Color colour, int sides)
        {
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
