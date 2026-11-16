// Unit tests: the dashboard shows server values as text and never runs them.
// 1. public/js/html_safety.js, loaded in a sandbox with a minimal DOM stand-in.
// 2. A static check of every dashboard script: a value placed into HTML must go
//    through escapeHtml(), actionAttrs() or imgFallbackAttrs(), unless it is a
//    number or HTML built in code (listed below). A new unescaped value fails here.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC_JS = path.resolve(__dirname, '..', '..', 'public', 'js');

const HOSTILE = [
  '<img src=x onerror=alert(1)>',
  '"><script>alert(1)</script>',
  "'); alert(1); ('",
  "O'Brien \"Ah\" Kow & Sons",
  '`${alert(1)}`',
  '</textarea><svg onload=alert(1)>'
];

// ----- a sandbox with just enough DOM for html_safety.js -----
class FakeElement {
  constructor(attrs = {}, parent = null) { this.attrs = { ...attrs }; this.parentElement = parent; }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
  closest(selector) {
    const name = selector.slice(1, -1); // "[data-click-action]"
    for (let el = this; el; el = el.parentElement) if (el.hasAttribute(name)) return el;
    return null;
  }
}

function loadHelper() {
  const listeners = {};
  const window = {};
  const document = { addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); } };
  const context = vm.createContext({ window, document, Element: FakeElement, HTMLImageElement: class {}, console, JSON, String, Object, Error });
  vm.runInContext(fs.readFileSync(path.join(PUBLIC_JS, 'html_safety.js'), 'utf8'), context);
  return { window, listeners };
}

/** What a browser hands back from getAttribute() for a value written into a quoted attribute. */
function decodeAttribute(text) {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#96;/g, '`').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Turns ' data-a="x" data-b="y"' into { 'data-a': 'x', ... } as a browser would. */
function parseAttributes(html) {
  const attrs = {};
  for (const m of html.matchAll(/\s([a-z-]+)="([^"]*)"/g)) attrs[m[1]] = decodeAttribute(m[2]);
  return { attrs, rest: html.replace(/\s([a-z-]+)="([^"]*)"/g, '') };
}

describe('escapeHtml', () => {
  const { window } = loadHelper();

  test('markup characters become text', () => {
    assert.equal(window.escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(window.escapeHtml(`"'&\``), '&quot;&#39;&amp;&#96;');
  });

  test('nothing that could open a tag or leave an attribute survives', () => {
    for (const value of HOSTILE) assert.doesNotMatch(window.escapeHtml(value), /[<>"'`]/, value);
  });

  test('ordinary text, numbers and missing values', () => {
    assert.equal(window.escapeHtml('Tan Ah Kow'), 'Tan Ah Kow');
    assert.equal(window.escapeHtml(72), '72');
    assert.equal(window.escapeHtml(0), '0');
    assert.equal(window.escapeHtml(null), '');
    assert.equal(window.escapeHtml(undefined), '');
  });
});

describe('actionAttrs', () => {
  test('hostile names reach the function unchanged and are never code', () => {
    const { window, listeners } = loadHelper();
    const calls = [];
    window.confirmDeletePatient = (...args) => calls.push(args);

    for (const name of HOSTILE) {
      const html = window.actionAttrs('confirmDeletePatient', ['P-001', name]);
      const { attrs, rest } = parseAttributes(html);
      assert.equal(rest.trim(), '', `nothing outside the attributes: ${html}`);
      assert.deepEqual(Object.keys(attrs).sort(), ['data-click-action', 'data-click-args']);

      const button = new FakeElement(attrs);
      listeners.click.forEach(fn => fn({ target: button, stopPropagation() {} }));
    }
    assert.deepEqual(calls, HOSTILE.map(name => ['P-001', name]));
  });

  test('a stopping action does not reach the row it sits in; without stop both run', () => {
    const { window, listeners } = loadHelper();
    const calls = [];
    window.viewPatientProfileReadOnly = (id) => calls.push(['row', id]);
    window.editPatientInfo = (id) => calls.push(['button', id]);

    const row = new FakeElement(parseAttributes(window.actionAttrs('viewPatientProfileReadOnly', ['P-002'])).attrs);
    const stopping = new FakeElement(parseAttributes(window.actionAttrs('editPatientInfo', ['P-002'], { stop: true })).attrs, row);
    let stopped = false;
    listeners.click.forEach(fn => fn({ target: stopping, stopPropagation() { stopped = true; } }));
    assert.deepEqual(calls, [['button', 'P-002']]);
    assert.equal(stopped, true);

    calls.length = 0;
    const plain = new FakeElement(parseAttributes(window.actionAttrs('editPatientInfo', ['P-002'])).attrs, row);
    listeners.click.forEach(fn => fn({ target: plain, stopPropagation() {} }));
    assert.deepEqual(calls, [['button', 'P-002'], ['row', 'P-002']]);
  });

  test('the clicked element can be passed as the last argument', () => {
    const { window, listeners } = loadHelper();
    let received;
    window.switchVitalsHistoryRange = (...args) => { received = args; };
    const button = new FakeElement(parseAttributes(window.actionAttrs('switchVitalsHistoryRange', ['P-001', 'Name', '-1h'], { element: true })).attrs);
    listeners.click.forEach(fn => fn({ target: button, stopPropagation() {} }));
    assert.deepEqual(received.slice(0, 3), ['P-001', 'Name', '-1h']);
    assert.equal(received[3], button);
  });

  test('an action name that is not a plain function name is refused', () => {
    const { window } = loadHelper();
    for (const name of ['alert(1)', 'a b', 'x"', '']) assert.throws(() => window.actionAttrs(name, []), /Invalid action name/);
  });
});

describe('imgFallbackAttrs', () => {
  test('the fallback text is stored as an attribute value only', () => {
    const { window } = loadHelper();
    for (const text of HOSTILE) {
      const { attrs, rest } = parseAttributes(window.imgFallbackAttrs(text, { replaceClass: 'patient-thumb', replaceStyle: 'width:34px;' }));
      assert.equal(rest.trim(), '');
      assert.equal(attrs['data-fallback-text'], text);
    }
  });
});

// ----- static check of the dashboard scripts -----

// Values that cannot carry markup: numbers, text chosen in code, or HTML built in code
// from escaped parts. Anything else placed into markup must be escaped.
const SAFE_EXPRESSIONS = [
  /^escapeHtml\(/, /^actionAttrs\(/, /^imgFallbackAttrs\(/, /^CSS\.escape\(/, /^encodeURIComponent\(/,
  /toFixed\(\d\)$/, /^Math\./, /^Number\(/, /^parseInt\(/,
  /^(index|idx|p|totalPages|startItem|endItem|totalItems|w|h|padLeft|padRight|plotW|bat|batVal|dTrue|curA|field|val|delta)$/,
  /^idx \+ 1$/, /^currentBindingPage [-+] 1$/, /^w - padRight$/, /^h - 4$/, /^padLeft - 6$/, /^\(y \+ 3\.5\)\.toFixed\(1\)$/,
  /\.length$/, /^w\.(beds|anchors|obstacles) \? w\.\1\.length : 0$/, /^validPoints\.length > 50 \? 2 : 3\.5$/,
  /^[\w.]+ \? '[^'`$]*' : '[^'`$]*'$/, /^[\w.]+ === '[A-Z]+' \? '[^']*' : '[^']*'$/,
  /^(a|activePat)\.(clearBeds|totalBeds|compositeScore|areaRatio|grid3Pct|jointBedClear|jointBedPct)$/, // geometry results
  /^(textColor|barColor|batColor|deltaColor|dotColor|strokeColor|normalBgColor|badgeClass|icon|typePill|typeBadge|statusBadge|availBadge|riskBadge|powerDisplay|avatarHtml|photoImg|bedInfo|secondaryActionBtn|liveMapBtn|nodeDisplay|boundText|losText|statusBadgeHtml|optionsHtml|wardOptions|bedsList|anchorsList|obstaclesList|patternOptionsHtml|anchorCardsHtml|hrSvg|spo2Svg|gridLines|inUseDetail|inUseNote|genderLabel|isBest|pathD|startTimeStr|endTimeStr|timeStr|rotLabel|uuidShort|hVal|xVal|yVal|zVal|wVal|lVal|avgHR|minHR|maxHR|avgSpO2|minSpO2|maxSpO2|unit)$/,
  // incident_history.js: markup built in code from escaped parts
  /^(patientCell|summaryHtml|incidentRowsHtml|pillsHtml|idTag)$/,
  /^getRadar(Signal|Battery)Html\(d\)$/,
  /^statusBadge\(d\.status\)$/, // health_monitor.js: fixed class name, escaped text
  /^isBound \|\| isAssignedWard \? `<option value="IN_USE" selected>In Use \(Currently Deployed\)<\/option>` : ''$/,
  /^r\.median_rssi !== null \? `<span class="mono">\$\{escapeHtml\(r\.median_rssi\)\}/
];

/**
 * True for a condition whose every result is a fixed text, for example
 *   p.status === 'HIGH' ? 'var(--danger)' : p.status === 'MEDIUM' ? 'var(--warning)' : ''
 * Whatever the data, only one of the written texts can appear.
 */
function onlyFixedResults(expr) {
  if (/[`$]/.test(expr) || !expr.includes('?')) return false;
  const tokens = expr.replace(/'[^'\\]*'/g, ' L ').split(/([?:])/).map(t => t.trim());
  // tokens: condition, '?', result, ':', (condition '?' result ':')*, result
  for (let i = 1; i < tokens.length; i += 2) {
    const next = tokens[i + 1];
    if (tokens[i] === '?' && next !== 'L') return false;
    if (tokens[i] === ':' && next !== 'L' && tokens[i + 2] !== '?') return false;
  }
  return tokens[tokens.length - 1] === 'L';
}

function dashboardScripts(dir = PUBLIC_JS) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? dashboardScripts(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []);
}

/** Every top-level ${...} on a line that contains markup. */
function interpolationsInMarkup(source) {
  const found = [];
  source.split(/\r?\n/).forEach((line, n) => {
    if (!/<[a-zA-Z/!]/.test(line) || /^\s*\/\//.test(line)) return;
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '$' || line[i + 1] !== '{') continue;
      let depth = 1;
      let j = i + 2;
      while (j < line.length && depth > 0) {
        if (line[j] === '{') depth++;
        else if (line[j] === '}') depth--;
        j++;
      }
      found.push({ line: n + 1, expr: line.slice(i + 2, j - 1).trim() });
      i = j - 1;
    }
  });
  return found;
}

describe('dashboard scripts', () => {
  const files = dashboardScripts().filter(f => !f.endsWith('html_safety.js'));

  test('the check itself: a condition with fixed results passes, one that can return data does not', () => {
    assert.equal(onlyFixedResults("p.risk === 'HIGH' ? 'var(--danger)' : p.risk === 'MEDIUM' ? 'var(--warning)' : 'var(--success)'"), true);
    assert.equal(onlyFixedResults("rot === 0 ? 'selected' : ''"), true);
    assert.equal(onlyFixedResults("p.name ? p.name : 'Unknown'"), false);
    assert.equal(onlyFixedResults("ok ? 'x' : p.name"), false);
    assert.equal(onlyFixedResults('p.full_name'), false);
  });

  test('every value placed into markup is escaped or known to be safe', () => {
    const unsafe = [];
    for (const file of files) {
      for (const { line, expr } of interpolationsInMarkup(fs.readFileSync(file, 'utf8'))) {
        if (!SAFE_EXPRESSIONS.some(re => re.test(expr)) && !onlyFixedResults(expr)) unsafe.push(`${path.relative(PUBLIC_JS, file)}:${line}  \${${expr}}`);
      }
    }
    assert.deepEqual(unsafe, [], `Escape these values with escapeHtml():\n${unsafe.join('\n')}`);
  });

  test('no inline event handler carries a value: only row and page numbers built in code', () => {
    const offending = [];
    for (const file of files) {
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, n) => {
        for (const m of line.matchAll(/\son[a-z]+="([^"]*)"/g)) {
          const values = [...m[1].matchAll(/\$\{([^}]*)\}/g)].map(v => v[1].trim());
          if (values.some(v => !/^(index|p|currentBindingPage [-+] 1)$/.test(v))) offending.push(`${path.relative(PUBLIC_JS, file)}:${n + 1}`);
        }
      });
    }
    assert.deepEqual(offending, [], 'Use actionAttrs() in place of an inline handler with a value');
  });

  test('toasts show their message as text', () => {
    const modal = fs.readFileSync(path.join(PUBLIC_JS, 'modal.js'), 'utf8');
    assert.match(modal, /textSpan\.textContent = message;/);
    assert.doesNotMatch(modal, /toast\.innerHTML/);
  });

  test('the helper is loaded before every other dashboard script', () => {
    const index = fs.readFileSync(path.join(PUBLIC_JS, '..', 'index.html'), 'utf8');
    const scripts = [...index.matchAll(/<script src="([^"?]+)/g)].map(m => m[1]);
    assert.equal(scripts[0], '/js/html_safety.js');
  });
});
