// =============================================================================
// SHIRO Dashboard - shared interface pieces (Phase 11)
//   ShiroUI.pageNumbers(page, pages)   which page buttons a pager shows
//   ShiroUI.paginate(items, page, size) one page of a list
//   ShiroUI.renderPager(el, options)    "Showing 9-16 of 42" and the page buttons
//   ShiroUI.busy(button, text)          a button that shows it is working
//   ShiroUI.ago(time)                   "just now", "5 min ago", "2 h ago"
// Every table shows 8 rows a page. Page buttons: always the first two and the
// last two, and the current page with its neighbours; "…" for every gap, e.g.
// page 5 of 10: Previous 1 2 … 4 5 6 … 9 10 Next (the user's rule, 22 Nov 2026).
// =============================================================================
(function (root) {
  const PAGE_SIZE = 8;

  // Text placed into the pager's markup (the dashboard's escapeHtml, also in node tests)
  const escapeHtml = (value) => String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;');

  /** The page buttons to show: numbers, and '…' for each gap. */
  function pageNumbers(page, pages) {
    const total = Math.max(1, Math.floor(pages) || 1);
    const current = Math.min(Math.max(1, Math.floor(page) || 1), total);
    const wanted = new Set([1, 2, total - 1, total, current - 1, current, current + 1]);
    const list = [...wanted].filter(n => n >= 1 && n <= total).sort((a, b) => a - b);
    const out = [];
    for (const n of list) {
      const prev = out.length ? out[out.length - 1] : null;
      if (typeof prev === 'number' && n - prev > 1) out.push('…');
      out.push(n);
    }
    return out;
  }

  /** One page of a list: { items, page, pages, from, to, total } (from/to 1-based, 0 when empty). */
  function paginate(items, page, size = PAGE_SIZE) {
    const list = Array.isArray(items) ? items : [];
    const pages = Math.max(1, Math.ceil(list.length / size));
    const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
    const start = (current - 1) * size;
    const slice = list.slice(start, start + size);
    return {
      items: slice,
      page: current,
      pages,
      total: list.length,
      from: list.length ? start + 1 : 0,
      to: start + slice.length
    };
  }

  /**
   * Draws the pager into el. options: { total, page, size?, onPage(page), noun? }
   * Nothing but the count is shown when everything fits on one page.
   */
  function renderPager(el, { total, page, size = PAGE_SIZE, onPage, noun = 'records' }) {
    if (!el) return;
    const pages = Math.max(1, Math.ceil(total / size));
    const current = Math.min(Math.max(1, page || 1), pages);
    const from = total ? (current - 1) * size + 1 : 0;
    const to = Math.min(total, current * size);
    // An empty table says so itself: no pager then
    el.classList.add('pager');
    if (!total) { el.innerHTML = ''; return; }
    const info = `Showing ${from}–${to} of ${total} ${noun}`;
    let html = `<div class="pager-info">${escapeHtml(info)}</div>`;
    if (pages > 1) {
      html += '<div class="pager-buttons">';
      html += `<button type="button" class="pager-btn pager-step" data-page="${Number(current - 1)}"${current === 1 ? ' disabled' : ''}>‹ Previous</button>`;
      for (const n of pageNumbers(current, pages)) {
        if (n === '…') html += '<span class="pager-gap">…</span>';
        else html += `<button type="button" class="pager-btn${n === current ? ' current' : ''}" data-page="${Number(n)}"${n === current ? ' aria-current="page"' : ''}>${Number(n)}</button>`;
      }
      html += `<button type="button" class="pager-btn pager-step" data-page="${Number(current + 1)}"${current === pages ? ' disabled' : ''}>Next ›</button>`;
      html += '</div>';
    }
    el.classList.add('pager');
    el.innerHTML = html;
    el.querySelectorAll('button[data-page]').forEach(b => {
      b.addEventListener('click', () => {
        const n = parseInt(b.getAttribute('data-page'), 10);
        if (Number.isFinite(n) && n >= 1 && n <= pages && n !== current && typeof onPage === 'function') onPage(n);
      });
    });
  }

  /**
   * Marks a button as working: spinner, disabled, optional text. Returns done(),
   * which puts it back. Safe to call with no button.
   */
  function busy(button, text) {
    if (!button) return () => {};
    const before = button.innerHTML;
    const wasDisabled = button.disabled;
    button.disabled = true;
    button.classList.add('is-busy');
    button.setAttribute('aria-busy', 'true');
    const labelHtml = text ? `<span>${escapeHtml(text)}</span>` : before;
    button.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + labelHtml;
    return () => {
      button.disabled = wasDisabled;
      button.classList.remove('is-busy');
      button.removeAttribute('aria-busy');
      button.innerHTML = before;
    };
  }

  /** "just now", "40 s ago", "5 min ago", "2 h ago", "3 days ago"; '' for no time. */
  function ago(time, now = Date.now()) {
    if (time === null || time === undefined || time === '') return '';
    const t = time instanceof Date ? time.getTime() : (typeof time === 'number' ? time : Date.parse(time));
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return `${s} s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} days ago`;
  }

  const api = { PAGE_SIZE, pageNumbers, paginate, renderPager, busy, ago };
  // eslint-disable-next-line no-undef
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ShiroUI = api;
})(typeof window !== 'undefined' ? window : null);
