// =============================================================================
// SHIRO Dashboard - Safe HTML building
// Loaded before every other script. Every value that comes from the server
// (names, IDs, notes, device details, messages) is shown as text, never run
// as markup or script.
//
//   escapeHtml(value)          text for HTML content and quoted attributes
//   actionAttrs(fn, args, o)   replaces onclick="fn('${value}')": the values
//                              travel in a data attribute, never as code
//   imgFallbackAttrs(text, o)  replaces onerror="...${initials}...": a broken
//                              photo is replaced by the patient's initials
// =============================================================================
(function () {
  'use strict';

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

  /** Text for HTML content or a quoted attribute value. null and undefined give ''. */
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]);
  }

  /**
   * Attributes that call window[fn](...args) on a click (or another event).
   * The arguments are stored as JSON in a data attribute.
   *   options.event: 'click' (default), 'change' or 'input'
   *   options.stop:  true stops the event here, like event.stopPropagation()
   *   options.value: true appends the element's current value as a last argument
   *   options.element: true appends the element itself as a last argument
   */
  function actionAttrs(fn, args = [], options = {}) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(fn)) throw new Error(`Invalid action name: ${fn}`);
    const event = options.event || 'click';
    let attrs = ` data-${event}-action="${escapeHtml(fn)}" data-${event}-args="${escapeHtml(JSON.stringify(args))}"`;
    if (options.stop) attrs += ` data-${event}-stop="1"`;
    if (options.value) attrs += ` data-${event}-value="1"`;
    if (options.element) attrs += ` data-${event}-element="1"`;
    return attrs;
  }

  function resolveFunction(path) {
    let target = window;
    for (const part of path.split('.')) {
      if (target === null || target === undefined) return null;
      target = target[part];
    }
    return typeof target === 'function' ? target : null;
  }

  // A click action still working (it returned a promise, e.g. waiting for the server)
  // is not started again by more clicks on the same thing: a slow answer made people
  // click again, and the dialog then opened once per click (Phase 11 review 3).
  // Forgotten after 15 s at the latest, should an action never finish.
  const pendingActions = new Map();
  const PENDING_FORGET_MS = 15000;

  function runActions(eventName, event) {
    let el = event.target instanceof Element ? event.target : null;
    const nameAttr = `data-${eventName}-action`;
    while (el) {
      el = el.closest(`[${nameAttr}]`);
      if (!el) return;
      const name = el.getAttribute(nameAttr);
      const argsText = el.getAttribute(`data-${eventName}-args`) || '[]';
      const fn = resolveFunction(name);
      let args = [];
      try {
        args = JSON.parse(argsText);
      } catch (err) {
        console.error('[html_safety] Unreadable action arguments', err);
      }
      if (el.hasAttribute(`data-${eventName}-value`)) args.push(el.value);
      if (el.hasAttribute(`data-${eventName}-element`)) args.push(el);
      const key = eventName === 'click' ? `${name}|${argsText}` : null;
      const since = key ? pendingActions.get(key) : undefined;
      if (since !== undefined && performance.now() - since < PENDING_FORGET_MS) {
        // Still working on the same action: this click is not a new request
      } else if (fn) {
        const result = fn.apply(el, args);
        if (key && result && typeof result.then === 'function') {
          pendingActions.set(key, performance.now());
          const done = () => pendingActions.delete(key);
          result.then(done, done);
        }
      } else {
        console.error(`[html_safety] Action "${name}" is not a function`);
      }
      if (el.hasAttribute(`data-${eventName}-stop`)) {
        event.stopPropagation();
        return;
      }
      el = el.parentElement;
    }
  }

  for (const eventName of ['click', 'change', 'input']) {
    document.addEventListener(eventName, (event) => runActions(eventName, event));
  }

  // Clicks that pile up: while the page is busy, the clicks made meanwhile all arrive
  // together afterwards. A second click on the same button (or other clickable thing)
  // within 350 ms of the first is ignored, before any handler sees it. Page buttons of
  // a pager and elements marked data-allow-repeat may be clicked quickly.
  const REPEAT_CLICK_MS = 350;
  let lastClick = { el: null, at: 0 };
  document.addEventListener('click', (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const el = event.target.closest('button, summary, [data-click-action], [onclick], [role="button"]');
    if (!el || el.matches('.pager-btn, [data-allow-repeat]')) return;
    const now = performance.now();
    if (lastClick.el === el && now - lastClick.at < REPEAT_CLICK_MS) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    lastClick = { el, at: now };
  }, true);

  /**
   * Attributes for an <img> that shows the given text when the image cannot load.
   *   options.replaceClass, options.replaceStyle: the image is replaced by a
   *     <div> with this class and style that holds the text
   *   without them, the text replaces the content of the image's parent
   */
  function imgFallbackAttrs(text, options = {}) {
    let attrs = ` data-fallback-text="${escapeHtml(text)}"`;
    if (options.replaceClass) attrs += ` data-fallback-class="${escapeHtml(options.replaceClass)}"`;
    if (options.replaceStyle) attrs += ` data-fallback-style="${escapeHtml(options.replaceStyle)}"`;
    return attrs;
  }

  // Image errors do not bubble: listened for in the capture phase
  document.addEventListener('error', (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.hasAttribute('data-fallback-text')) return;
    const text = img.getAttribute('data-fallback-text');
    if (img.hasAttribute('data-fallback-class')) {
      const div = document.createElement('div');
      div.className = img.getAttribute('data-fallback-class');
      const style = img.getAttribute('data-fallback-style');
      if (style) div.setAttribute('style', style);
      div.textContent = text;
      img.replaceWith(div);
    } else if (img.parentElement) {
      img.parentElement.textContent = text;
    }
  }, true);

  window.escapeHtml = escapeHtml;
  window.actionAttrs = actionAttrs;
  window.imgFallbackAttrs = imgFallbackAttrs;
})();
