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

  function runActions(eventName, event) {
    let el = event.target instanceof Element ? event.target : null;
    const nameAttr = `data-${eventName}-action`;
    while (el) {
      el = el.closest(`[${nameAttr}]`);
      if (!el) return;
      const fn = resolveFunction(el.getAttribute(nameAttr));
      let args = [];
      try {
        args = JSON.parse(el.getAttribute(`data-${eventName}-args`) || '[]');
      } catch (err) {
        console.error('[html_safety] Unreadable action arguments', err);
      }
      if (el.hasAttribute(`data-${eventName}-value`)) args.push(el.value);
      if (el.hasAttribute(`data-${eventName}-element`)) args.push(el);
      if (fn) fn.apply(el, args);
      else console.error(`[html_safety] Action "${el.getAttribute(nameAttr)}" is not a function`);
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
