// =============================================================================
// Project SHIRO - headset app version 2: the pager (as on the web dashboard)
//
// "Showing 1–4 of 6 patients" on the left; ‹ Previous, the page numbers (the
// current one blue; the first, the last and the neighbours of the current one,
// "…" between) and Next › on the right. Used by the ward panel's patient list
// and the patient view's alerts. The buttons are made once and kept between
// refreshes, so a press is never lost to a rebuild.
// =============================================================================
using System;
using System.Collections.Generic;
using TMPro;
using UnityEngine;

namespace ShiroMR.UI
{
    internal class ShiroPager
    {
        private const int MaxPageButtons = 5;
        private const float Gap = 8f;
        private const float PrevW = 80f, NextW = 56f, GapW = 14f;

        private TextMeshProUGUI _info;
        private ShiroButton _prev, _next;
        private readonly List<ShiroButton> _pageBtns = new List<ShiroButton>();
        private readonly List<TextMeshProUGUI> _gaps = new List<TextMeshProUGUI>();
        private readonly int[] _pageOfBtn = new int[MaxPageButtons];
        private float _left, _right, _y, _h;
        private string _noun;
        private Action<int> _goTo;
        private int _current = 1;

        /// <summary>
        /// Builds the pager on a line from left to right (mm) at y, h high. noun: what is
        /// counted ("patient" → "patients"). goTo(page): page from 1.
        /// </summary>
        public void Build(Transform parent, float left, float right, float y, float h, string noun, Action<int> goTo)
        {
            _left = left; _right = right; _y = y; _h = h; _noun = noun; _goTo = goTo;
            _info = ShiroUIKit.Label(parent, "PagerInfo", "", 12f, ShiroTheme.TextDim).Fit(8f);
            _prev = ShiroUIKit.Button(parent, "Previous", "‹ Previous", ButtonKind.Secondary, () => _goTo?.Invoke(_current - 1), 12f);
            _next = ShiroUIKit.Button(parent, "Next", "Next ›", ButtonKind.Secondary, () => _goTo?.Invoke(_current + 1), 12f);
            for (int i = 0; i < MaxPageButtons; i++)
            {
                int index = i;
                var b = ShiroUIKit.Button(parent, $"Page_{i}", "", ButtonKind.Secondary, () => _goTo?.Invoke(_pageOfBtn[index]), 12f);
                b.gameObject.SetActive(false);
                _pageBtns.Add(b);
            }
            for (int i = 0; i < 2; i++)
            {
                var g = ShiroUIKit.Label(parent, $"PageGap_{i}", "…", 12f, ShiroTheme.TextDim, FontStyles.Normal, TextAlignmentOptions.Center);
                g.gameObject.SetActive(false);
                _gaps.Add(g);
            }
            _prev.gameObject.SetActive(false);
            _next.gameObject.SetActive(false);
            _info.gameObject.SetActive(false);
        }

        /// <summary>Number of pages for total items, perPage on each (at least 1).</summary>
        public static int Pages(int total, int perPage) => Mathf.Max(1, Mathf.CeilToInt(total / (float)perPage));

        /// <summary>Lays the pager out for page pageIndex (from 0) of total items, perPage on each.</summary>
        public void Layout(int pageIndex, int perPage, int total)
        {
            int pages = Pages(total, perPage);
            int current = Mathf.Clamp(pageIndex + 1, 1, pages);
            _current = current;
            int from = total == 0 ? 0 : (current - 1) * perPage + 1;
            int to = Mathf.Min(total, current * perPage);
            bool paged = pages > 1;

            float right = _right;
            if (paged)
            {
                ShiroUIKit.Place(_next, right - NextW, _y, NextW, _h);
                right -= NextW + Gap;
                var items = PageItems(current, pages);
                int b = 0, g = 0;
                for (int i = items.Count - 1; i >= 0; i--)
                {
                    if (items[i] == 0)
                    {
                        var label = _gaps[g++];
                        ShiroUIKit.Place(label, right - GapW, _y, GapW, _h);
                        label.gameObject.SetActive(true);
                        right -= GapW + Gap;
                        continue;
                    }
                    var btn = _pageBtns[b];
                    _pageOfBtn[b] = items[i];
                    b++;
                    btn.SetText(items[i].ToString());
                    btn.SetKind(items[i] == current ? ButtonKind.Primary : ButtonKind.Secondary);
                    ShiroUIKit.Place(btn, right - _h, _y, _h, _h);
                    if (!btn.gameObject.activeSelf) btn.gameObject.SetActive(true);
                    right -= _h + Gap;
                }
                for (; b < _pageBtns.Count; b++) if (_pageBtns[b].gameObject.activeSelf) _pageBtns[b].gameObject.SetActive(false);
                for (; g < _gaps.Count; g++) _gaps[g].gameObject.SetActive(false);
                ShiroUIKit.Place(_prev, right - PrevW, _y, PrevW, _h);
                right -= PrevW + Gap;
                _prev.SetInteractable(current > 1);
                _next.SetInteractable(current < pages);
            }
            else
            {
                foreach (var btn in _pageBtns) if (btn.gameObject.activeSelf) btn.gameObject.SetActive(false);
                foreach (var label in _gaps) label.gameObject.SetActive(false);
            }
            if (_prev.gameObject.activeSelf != paged) _prev.gameObject.SetActive(paged);
            if (_next.gameObject.activeSelf != paged) _next.gameObject.SetActive(paged);

            float infoW = right - _left;
            bool info = total > 0 && infoW >= 60f;
            _info.gameObject.SetActive(info);
            if (info)
            {
                ShiroUIKit.Place(_info, _left, _y, infoW, _h);
                // Short when many page numbers leave little room ("1–4 of 14")
                _info.text = infoW >= 120f
                    ? $"Showing {from}–{to} of {total} {_noun}{(total == 1 ? "" : "s")}"
                    : $"{from}–{to} of {total}";
            }
        }

        /// <summary>Page numbers to show (0 = "…"): the first, the last, the current and its neighbours.</summary>
        internal static List<int> PageItems(int current, int pages)
        {
            var wanted = new SortedSet<int> { 1, pages, current - 1, current, current + 1 };
            var list = new List<int>();
            int prev = 0;
            foreach (int n in wanted)
            {
                if (n < 1 || n > pages) continue;
                if (prev > 0 && n - prev > 1) list.Add(0);
                list.Add(n);
                prev = n;
            }
            return list;
        }
    }
}
