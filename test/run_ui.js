// The settings menu, driven in headless Chrome.
//
//   node test/serve.js &
//   node test/run_ui.js
//
// The settings model itself is unit-tested (test/settings.test.js). What can
// only be checked in a browser is the half that model cannot see: that the
// custom properties it writes are actually consumed by the stylesheet, that the
// menu reflects and changes real values, and that a chosen setting survives a
// reload. A setting that persists but never reaches the page looks identical to
// a working one in unit tests.

const { launch, sleep } = require('./cdp.js');

const BASE = process.env.APP_URL || 'http://localhost:8777/www/index.html';
const CDP_PORT = Number(process.env.CDP_PORT) || 9339;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

/**
 * A real press-and-release at an element's centre.
 *
 * `el.click()` dispatches a lone `click` event — no `mousedown`, no `mouseup`.
 * Anything that listens for `mousedown` therefore never runs, which is not a
 * detail: menu dismissal is built on exactly that listener, and a submenu whose
 * rows were removed on mousedown passed every `.click()` test in this file
 * while being completely unusable with a mouse.
 *
 * @param {string} expr  JS evaluating to the element, e.g. `document.querySelector('…')`
 */
async function realClick(cdp, expr) {
  const at = await cdp.evaluate(`(() => {
    const el = ${expr};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`, true);
  if (!at) return false;
  // A move first: hover intent opens submenus, and a press with no preceding
  // move is not a sequence any real pointer produces.
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, buttons: 0 });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent',
      { type, x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
  }
  return true;
}

/**
 * A real press, move and release, starting at an element's centre.
 *
 * The same lesson as `realClick`, one layer down. A divider drag is three
 * events, and every failure this has actually produced lives in the gaps
 * between them: a hit target too small to receive the press, a pane painted on
 * top of it, a release that arrives somewhere else. Dispatching them separately
 * is the only way any of that is visible to a test.
 *
 * Two moves, not one: the first leaves the divider, which is where a handler
 * without pointer capture loses the stream.
 *
 * @param {string} expr  JS evaluating to the element to grab
 * @param {number} dx @param {number} dy  total movement, in CSS pixels
 */
async function realDrag(cdp, expr, dx, dy) {
  const at = await cdp.evaluate(`(() => {
    const el = ${expr};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    // Not r.width/r.height: a 1px divider's grab area is a ::after that
    // overhangs it, and the centre is what a person aims at either way.
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`, true);
  if (!at) return false;

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
  for (const f of [0.5, 1]) {
    await cdp.send('Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: at.x + dx * f, y: at.y + dy * f, button: 'left', buttons: 1 });
  }
  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: at.x + dx, y: at.y + dy, button: 'left', buttons: 0 });
  await sleep(80);
  return true;
}

/**
 * A real chord, dispatched at the browser rather than at an element.
 *
 * `new KeyboardEvent(...)` does not reach CodeMirror's keymap the way a real
 * key does — and a keymap defect is exactly the kind that a synthetic event
 * hides, because the synthetic one never has to survive the precedence contest
 * the real one loses. `modifiers: 2` is Ctrl, which is what Mod- means here;
 * the harness runs Chrome on Linux.
 */
async function pressChord(cdp, key, code) {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type, key, code,
      windowsVirtualKeyCode: key === 'Enter' ? 13 : key.toUpperCase().charCodeAt(0),
      modifiers: 2
    });
  }
  await sleep(150);
}

/**
 * Escape, as a bare key.
 *
 * Not pressChord: that one holds Ctrl and derives its keycode from the first
 * letter of the name, which is right for "Ctrl+S" and nonsense for "Escape".
 * Dialogs listen for Escape in the capture phase, so the keycode has to be the
 * real one or CodeMirror sees the event first.
 */
async function pressEscape(cdp) {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent',
      { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
  await sleep(150);
}

/** A missing dev server otherwise reads as "the app failed to boot". */
async function requireServer() {
  const ok = await fetch(BASE, { signal: AbortSignal.timeout(2000) })
    .then(r => r.ok).catch(() => false);
  if (!ok) {
    console.error(`No server at ${BASE} — start the fixture server (npm run serve) first.\n` +
                  `Note that \`npm run check\` stops its own servers when it finishes.`);
    process.exit(2);
  }
}

async function main() {
  await requireServer();
  const { cdp, cleanup, pageErrors } = await launch({ url: BASE, port: CDP_PORT });
  try {
    // Answered, and also *recorded*. A confirm() that stops a destructive
    // action is a feature, and the only way to assert one fired is to keep
    // what it said — accepting it silently makes it invisible to every test.
    const dialogs = [];
    cdp.on((msg) => {
      if (msg.method === 'Page.javascriptDialogOpening') {
        dialogs.push(msg.params.message || '');
        cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });
    // A fixed viewport. Real mouse events are dispatched at coordinates, so
    // "wherever the headless window happened to open" is not good enough — an
    // element scrolled out of view would be clicked at a point that is not on
    // it, and the failure would look like the feature being broken.
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
    await cdp.waitFor('!!window.__reveryTexApp', { what: 'app boot', timeoutMs: 60000 });

    // The app draws its own confirm now (see ask() in dialog.js), so the CDP
    // auto-accept above no longer covers it. Same policy for the in-page one:
    // answer OK, and keep what it said so a check can assert on it. Without it
    // every flow that asks — switching project, discarding edits, deleting —
    // hangs on a modal nobody clicks, and the run looks like a timeout rather
    // than an unanswered question.
    //
    // Installed for *every* document, not just this one: the suite reloads the
    // page to check that settings persist, and an observer evaluated once is
    // gone the moment it does.
    const ANSWER_ASKS = `(() => {
      window.__askLog = [];
      const answer = () => {
        const p = document.querySelector('.dlg-ask');
        if (!p) return;
        window.__askLog.push(p.textContent);
        const ok = [...document.querySelectorAll('.dlg-foot button')]
          .find(b => /^OK$/.test(b.textContent.trim()));
        if (ok) ok.click();
      };
      new MutationObserver(answer).observe(document, { childList: true, subtree: true });
      answer();
    })()`;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: ANSWER_ASKS });
    await cdp.evaluate(ANSWER_ASKS);

    /* ── the menu opens and reflects real state ─────────────────────── */
    const opened = await cdp.evaluate(`(() => {
      document.getElementById('settings').click();
      const menu = document.querySelector('.menu-container:not([hidden])');
      if (!menu) return { open: false };
      const heads = [...menu.querySelectorAll('.menu-head')].map(h => h.textContent);
      // Top level only — submenu rows live inside .submenu and are counted
      // separately, or the theme choices would inflate every tally here.
      const items = [...menu.querySelectorAll('.menu-item')].map(b => b.textContent.trim());
      return {
        open: true, heads, items,
        checked: items.filter(t => t.startsWith('■')),
        expanded: document.getElementById('settings').getAttribute('aria-expanded'),
        role: menu.getAttribute('role'),
        steppers: menu.querySelectorAll('.menu-stepper').length,
        submenus: document.querySelectorAll('.submenu').length,
        subTriggers: menu.querySelectorAll('.menu-item.has-submenu').length,
        toggles: menu.querySelectorAll('.menu-item.menu-toggle').length,
        dividers: menu.querySelectorAll('.menu-divider').length,
        themeButton: !!document.getElementById('theme'),
        autoButton: !!document.getElementById('autocompile'),
        selects: document.querySelectorAll('select').length
      };
    })()`);

    // Derived from the schema rather than hardcoded: the invariant is "a row
    // per setting", and a count that has to be bumped by hand is a count that
    // gets bumped without anyone checking what it now means.
    const schema = await cdp.evaluate(`(async () => {
      const s = await import('./jvscrpt_and_css_extra/settings.js');
      // Both exclusions mirror settingsMenuSpec: engineSource is hidden where no
      // process can be started, and \`hidden\` rows record an answer rather than
      // express a preference, so they are in the schema but have no control.
      const shown = s.SCHEMA.filter(e => e.key !== 'engineSource' && !e.hidden);
      return {
        // Only radios and steppers carry a .menu-head; submenus and toggles are
        // a single row that names itself.
        headed: shown.filter(e => e.ui !== 'submenu' && e.ui !== 'toggle').length,
        radios: shown.filter(e => !e.ui).length,
        steppers: shown.filter(e => e.ui === 'stepper').length,
        submenus: shown.filter(e => e.ui === 'submenu').length,
        toggles: shown.filter(e => e.ui === 'toggle').length,
        // A toggle shows ■ only when it is currently on, so the expected mark
        // count depends on the live values, not on the shape of the schema.
        checkedToggles: shown.filter(e => e.ui === 'toggle' && s.settings[e.key] === e.on).length,
        // One divider between clusters, plus the one before the closing notes.
        groups: new Set(shown.map(e => e.group)).size
      };
    })()`, true);

    check('menu opens', opened.open);
    // One head per setting that is neither a submenu nor a toggle — those name
    // themselves in their single row. engineSource is hidden where no process
    // can be started, which is every browser — see settingsMenuSpec.
    check('has a row per setting',
      opened.heads.length === schema.headed,
      `${opened.heads.length} of ${schema.headed}: ${opened.heads.join(' · ')}`);
    // Everything with a ■ at the top level is now a toggle that happens to be
    // on: the list-style settings are all behind submenus, and engineSource —
    // the one that is still a flat list — is hidden in the browser.
    check('marks every toggle that is on',
      opened.checked.length === schema.radios + schema.checkedToggles,
      `${opened.checked.length} marked: ${opened.checked.join(' | ')}`);
    check('scales render as steppers', opened.steppers === schema.steppers,
      `${opened.steppers} of ${schema.steppers}`);
    // Theme, background, editor font, line height and PDF preview: the settings
    // with enough choices to crowd the menu as a flat list.
    check('the long lists are submenus', opened.subTriggers === schema.submenus,
      `${opened.subTriggers} of ${schema.submenus} triggers`);
    // The two-option settings, each one row instead of a head plus two choices.
    check('two-option settings are single toggle rows',
      opened.toggles === schema.toggles,
      `${opened.toggles} of ${schema.toggles}`);
    // Dividers fence off clusters, not individual settings — the whole point of
    // the compaction. One per boundary between groups (so groups − 1), plus the
    // two that close the menu off: one before the notes, one before Reset.
    check('dividers separate clusters, not every row',
      opened.dividers === schema.groups - 1 + 2,
      `${opened.dividers} dividers for ${schema.groups} groups`);
    check('the standalone Theme button is gone', !opened.themeButton);
    // Same reason, and the same failure it prevents: autoCompile is a toggle in
    // this menu, and a topbar button for it was a second control for one value.
    check('the standalone Auto button is gone', !opened.autoButton);
    check('no native <select> in the topbar', opened.selects === 0, `${opened.selects} selects`);
    check('button reports expanded', opened.expanded === 'true');
    check('menu is announced as a menu', opened.role === 'menu');

    /* ── choosing a value changes the page, not just the store ──────── */
    const applied = await cdp.evaluate(`(() => {
      const pick = (label) => {
        const b = [...document.querySelectorAll('.menu-container .menu-item, .submenu .menu-item')]
          .find(x => x.textContent.includes(label));
        if (b) b.click();
        return !!b;
      };
      // By label, not "the first submenu trigger": five settings are submenus
      // now, and a reorder of the schema would silently point this at another
      // one — which still opens a panel, so it would pass while testing nothing.
      const openSub = (label) => {
        const t = [...document.querySelectorAll('.menu-item.has-submenu')]
          .find(x => x.firstElementChild?.textContent.trim() === label);
        t?.click();
        return !!t;
      };
      const before = getComputedStyle(document.documentElement).fontSize;
      // Theme lives behind a submenu now: open it, then pick.
      const okTheme = openSub('Theme') && pick('Forest');
      // By label, not by position: the schema's order is not this test's
      // business, and a stepper added above UI size would silently retarget it.
      const stepperFor = (label) => {
        const head = [...document.querySelectorAll('.menu-head')]
          .find(h => h.textContent.trim() === label);
        return head && head.nextElementSibling?.classList.contains('menu-stepper')
          ? head.nextElementSibling : null;
      };
      // Re-found each time: the menu re-renders after every step, so a handle
      // taken once is detached by the second click.
      const okSize = !!stepperFor('UI size');
      for (let i = 0; i < 3; i++) stepperFor('UI size')?.querySelector('[data-step="1"]').click();
      const cs = getComputedStyle(document.documentElement);
      return {
        okTheme, okSize,
        theme: document.documentElement.getAttribute('data-theme'),
        beforeFont: before,
        afterFont: cs.fontSize,
        uiScale: cs.getPropertyValue('--ui-scale').trim(),
        bg: getComputedStyle(document.body).backgroundColor
      };
    })()`);

    check('picked a theme and a size', applied.okTheme && applied.okSize);
    check('theme attribute changed', applied.theme === 'forest', applied.theme);
    check('theme actually repaints the page', applied.bg === 'rgb(14, 26, 17)', applied.bg);
    // The real assertion: the custom property is consumed by the stylesheet.
    check('UI size changes the root font size',
      applied.beforeFont === '19.2px' && applied.afterFont === '24px',
      `${applied.beforeFont} → ${applied.afterFont} (--ui-scale ${applied.uiScale})`);

    /* ── the editor font and size reach CodeMirror ──────────────────── */
    const editor = await cdp.evaluate(`(() => {
      const pick = (label) => {
        const b = [...document.querySelectorAll('.menu-container .menu-item, .submenu .menu-item')]
          .find(x => x.textContent.includes(label));
        if (b) b.click();
      };
      // Both live behind submenus now. Re-found each time: choosing an option
      // re-renders the menu, which tears every panel down and rebuilds it.
      const openSub = (label) => {
        [...document.querySelectorAll('.menu-item.has-submenu')]
          .find(x => x.firstElementChild?.textContent.trim() === label)?.click();
      };
      openSub('Editor font');
      pick('Harald Text');
      openSub('Editor line height');
      pick('Relaxed');
      const sc = document.querySelector('.cm-scroller');
      const cs = sc ? getComputedStyle(sc) : null;
      return cs ? { family: cs.fontFamily, lineHeight: cs.lineHeight, size: cs.fontSize } : null;
    })()`);
    check('editor font follows the setting', /HaraldText/.test(editor?.family || ''), editor?.family);
    check('line height follows the setting', editor && parseFloat(editor.lineHeight) > 0, editor?.lineHeight);

    /* ── keyboard and dismissal ─────────────────────────────────────── */
    const keys = await cdp.evaluate(`(() => {
      const menu = document.querySelector('.menu-container:not([hidden])');
      const focusedIsItem = document.activeElement?.classList.contains('menu-item');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return {
        focusedIsItem,
        closed: !document.querySelector('.menu-container:not([hidden])'),
        expanded: document.getElementById('settings').getAttribute('aria-expanded')
      };
    })()`);
    check('focus lands inside the menu', keys.focusedIsItem);
    check('Escape closes it', keys.closed);
    check('button reports collapsed again', keys.expanded === 'false');

    /* ── the theme submenu ──────────────────────────────────────────── */
    const sub = await cdp.evaluate(`(() => {
      document.getElementById('settings').click();
      // Named, not positional — see openSub above.
      const trigger = [...document.querySelectorAll('.menu-item.has-submenu')]
        .find(x => x.firstElementChild?.textContent.trim() === 'Theme');
      const label = trigger.textContent;
      trigger.click();
      const panel = document.querySelector('.submenu:not([hidden])');
      const choices = panel ? [...panel.querySelectorAll('.menu-item')].map(b => b.textContent.trim()) : [];
      return { label, choices, marked: choices.filter(t => t.startsWith('■')), opened: !!panel };
    })()`);
    // Chosen with a real mouse. A submenu panel is mounted on <body>, so it is
    // outside the parent menu that the global mousedown handler dismisses on —
    // and a synthetic .click() never fires mousedown, so it cannot see that.
    await realClick(cdp, `document.querySelector('.submenu:not([hidden]) .menu-item')`);
    sub.after = await cdp.evaluate(`(() => {
      const t = document.documentElement.getAttribute('data-theme');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return t;
    })()`);
    check('the submenu opens', sub.opened);
    check('it holds all four themes', sub.choices.length === 4, sub.choices.join(' | '));
    check('the trigger shows the current theme', /forest/i.test(sub.label), sub.label.trim());
    check('exactly one theme is marked', sub.marked.length === 1, sub.marked.join(' | '));
    check('choosing from it changes the theme', sub.after === 'dark', sub.after);

    /* ── survives a reload, applied before paint ────────────────────── */
    await cdp.evaluate(`(() => {
      const pick = (l) => [...document.querySelectorAll('.menu-container .menu-item, .submenu .menu-item')]
        .find(x => x.textContent.includes(l))?.click();
      document.getElementById('settings').click();
      [...document.querySelectorAll('.menu-item.has-submenu')]
        .find(x => x.firstElementChild?.textContent.trim() === 'Theme')?.click();
      pick('Paper');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    })()`);
    await cdp.send('Page.reload');
    await sleep(2500);
    await cdp.waitFor('!!document.documentElement.getAttribute("data-theme")',
      { what: 'reload', timeoutMs: 30000 });

    const reloaded = await cdp.evaluate(`(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      uiScale: getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim(),
      font: document.documentElement.getAttribute('data-editor-font'),
      // settings_boot.js runs in <head>, so this is already right before the
      // app module has executed at all.
      bootRan: !!document.querySelector('script[src*="settings_boot"]')
    }))()`);
    check('theme survives a reload', reloaded.theme === 'paper', reloaded.theme);
    check('sizes survive a reload', reloaded.uiScale === '1.5', reloaded.uiScale);
    check('editor font survives a reload', reloaded.font === 'brand', reloaded.font);
    check('pre-paint script is present', reloaded.bootRan);

    /* ── reset ──────────────────────────────────────────────────────── */
    const reset = await cdp.evaluate(`(() => {
      document.getElementById('settings').click();
      [...document.querySelectorAll('.menu-container .menu-item')]
        .find(b => /Reset to defaults/i.test(b.textContent))?.click();
      const cs = getComputedStyle(document.documentElement);
      return {
        theme: document.documentElement.getAttribute('data-theme'),
        scale: cs.getPropertyValue('--ui-scale').trim(),
        font: document.documentElement.getAttribute('data-editor-font'),
        closed: !document.querySelector('.menu-container:not([hidden])')
      };
    })()`);
    check('reset restores the defaults',
      reset.theme === 'dark' && reset.scale === '1.2' && reset.font === 'mono',
      `${reset.theme} / ${reset.scale} / ${reset.font}`);
    check('reset closes the menu', reset.closed);

    /* ── legibility: contrast and the type floor ────────────────────── */
    // The reported bug: "the muted colour is too muted, can't read it, in both
    // light and dark themes". It was measurable and nothing measured it —
    // --text-dim sat at 1.5-1.8:1 in every theme while colouring folder names,
    // gutter line numbers, log tab labels and every .menu-note.
    //
    // Computed from the live stylesheet rather than from a copy of the values,
    // so lowering an alpha in theme.css fails here rather than in a bug report.
    const legible = await cdp.evaluate(`(() => {
      const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const ratio = (a, b) => {
        const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (hi + 0.05) / (lo + 0.05);
      };
      // Resolve any CSS colour, including rgba(), to composited RGB over a
      // known backdrop — the browser's own parser, so no colour maths here has
      // to agree with theme.css about syntax.
      const probe = document.createElement('span');
      document.body.appendChild(probe);
      const rgba = (value) => {
        probe.style.color = '';
        probe.style.color = value;
        const m = getComputedStyle(probe).color.match(/[\\d.]+/g).map(Number);
        return { rgb: m.slice(0, 3), a: m.length > 3 ? m[3] : 1 };
      };
      const over = (fg, bg) => fg.rgb.map((c, i) => c * fg.a + bg.rgb[i] * (1 - fg.a));

      const out = {};
      const root = document.documentElement;
      const was = root.getAttribute('data-theme');
      for (const theme of ['dark', 'light', 'paper', 'forest']) {
        root.setAttribute('data-theme', theme);
        const cs = getComputedStyle(root);
        const v = (n) => rgba(cs.getPropertyValue(n).trim());
        const panel = v('--bg-panel'), menu = v('--menu-bg'), bg = v('--bg');
        const worst = (tok) => Math.min(...[panel, menu, bg].map(
          (b) => ratio(over(v(tok), b), b.rgb)));
        out[theme] = { muted: worst('--text-muted'), dim: worst('--text-dim') };
      }
      root.setAttribute('data-theme', was);
      probe.remove();
      return out;
    })()`, true);

    for (const [theme, r] of Object.entries(legible)) {
      // AA is 4.5:1 for normal text. --text-dim is held to exactly that because
      // it carries real content; --text-muted is the primary secondary colour
      // and is held higher.
      check(`${theme}: muted text stays readable`, r.muted >= 6.9, `${r.muted.toFixed(2)}:1`);
      check(`${theme}: dim text meets AA`, r.dim >= 4.45, `${r.dim.toFixed(2)}:1`);
    }

    // The other half of the report: "some UI text elements are too small",
    // naming two .menu-note sentences. They were .58rem — 11.1px at the default
    // UI size. Nothing a reader takes in as a word now sits below --fs-xs.
    const sizes = await cdp.evaluate(`(() => {
      document.getElementById('toolbox').click();
      const note = document.querySelector('.menu-container:not([hidden]) .menu-note');
      const item = document.querySelector('.menu-container:not([hidden]) .menu-item');
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      // Rounded: .68rem of a 19.2px root is 13.056px, which divides back to
      // 0.6799999999999999 and loses a >= comparison against its own value.
      const at = (el) => el ? Math.round(parseFloat(getComputedStyle(el).fontSize) / rem * 1000) / 1000 : 0;
      const r = { note: at(note), item: at(item), noteText: note?.textContent.trim() };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      // Every size the stylesheet actually paints, so a rule that quietly
      // reintroduces a .58rem is caught wherever it is.
      const painted = [...document.querySelectorAll('body *')]
        .filter(el => el.offsetParent !== null && el.textContent.trim());
      r.floor = Math.min(...painted.map(at));
      // Name the offender, or a failure here is a number with nowhere to go.
      const worst = painted.find(el => at(el) === r.floor);
      r.worstSel = worst && (worst.id ? '#' + worst.id : '.' + [...worst.classList].join('.'));
      return r;
    })()`, true);

    check('menu prose is at the prose size', sizes.note >= 0.72,
      `${sizes.note}rem — "${(sizes.noteText || '').slice(0, 40)}…"`);
    check('menu rows are no smaller', sizes.item >= 0.68, `${sizes.item}rem`);
    check('nothing visible falls below the type floor', sizes.floor >= 0.68,
      `smallest painted: ${sizes.floor}rem on ${sizes.worstSel}`);

    /* ── the search panel follows the theme ─────────────────────────── */
    // Ctrl+F came up white-on-black-text with Arial inputs inside a dark app:
    // CodeMirror ships a light/dark pair for its panels and picks the light one,
    // because nothing here calls EditorView.theme with `dark: true`. It was the
    // one piece of chrome that ignored the theme entirely.
    //
    // Compared against each theme's own tokens rather than against fixed
    // colours, so this keeps holding if a palette is retuned.
    await cdp.evaluate(`window.__reveryTexTest.view().focus()`, true);
    await pressChord(cdp, 'f', 'KeyF');
    const find = {};
    for (const theme of ['dark', 'light', 'paper', 'forest']) {
      // Through the same call settings.js makes: `color-scheme` rides along with
      // `data-theme`, and it is what decides how the browser paints a native
      // checkbox. Setting the attribute alone leaves form controls in the old
      // scheme — which looks exactly like a styling bug, and cost a detour here.
      await cdp.evaluate(`(() => {
        const r = document.documentElement;
        r.setAttribute('data-theme', '${theme}');
        r.style.colorScheme = ('${theme}' === 'dark' || '${theme}' === 'forest') ? 'dark' : 'light';
      })()`, true);
      await sleep(120);
      find[theme] = await cdp.evaluate(`(() => {
        const panel = document.querySelector('.cm-panels');
        if (!panel) return null;
        const probe = document.createElement('span');
        document.body.appendChild(probe);
        const token = (n) => {
          probe.style.color = '';
          probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
          return getComputedStyle(probe).color;
        };
        const field = document.querySelector('.cm-textfield');
        const r = {
          panelBg: getComputedStyle(panel).backgroundColor,
          menuBg: token('--menu-bg'),
          fieldFont: getComputedStyle(field).fontFamily.split(',')[0].replace(/["']/g, ''),
          fieldColor: getComputedStyle(field).color,
          text: token('--text')
        };
        probe.remove();
        return r;
      })()`, true);
    }
    await cdp.evaluate(`document.querySelector('.cm-panel [name=close]')?.click()`, true);

    for (const [theme, f] of Object.entries(find)) {
      check(`${theme}: the search panel uses the theme's surface`,
        !!f && f.panelBg === f.menuBg, f && `${f.panelBg} vs --menu-bg ${f.menuBg}`);
      check(`${theme}: and the theme's text colour`,
        !!f && f.fieldColor === f.text, f && `${f.fieldColor} vs --text ${f.text}`);
    }
    // Arial is what it was, and the giveaway that nothing had touched it.
    check('the search field is in the app font, not the browser default',
      Object.values(find).every(f => f && /Harald/.test(f.fieldFont)),
      Object.values(find)[0]?.fieldFont);

    /* ── the PDF preview refits when the divider moves ──────────────── */
    // The reported bug: dragging the divider narrower than the width the PDF
    // was rendered at squashed the page — max-width:100% shrank the width while
    // an explicit pixel height stayed put — and nothing re-rendered, because the
    // listener was on window resize and a divider drag does not resize the
    // window.
    await cdp.evaluate(`window.__reveryTexApp.compile('cv')`, true);
    await sleep(500);

    /** Drive the pane exactly the way the divider handler in the app does. */
    const setSplit = (frac) => `(() => {
      document.getElementById('editorpane').style.flex = '1 1 ${frac * 100}%';
      document.getElementById('pdfpane').style.flex = '1 1 ${(1 - frac) * 100}%';
      const c = document.querySelector('canvas.pdfpage');
      const r = c.getBoundingClientRect();
      return { w: r.width, h: r.height, ratio: r.width / r.height,
               bitmapW: c.width, bitmapH: c.height,
               natural: Number(c.dataset.natural) };
    })()`;

    const before = await cdp.evaluate(setSplit(0.55));
    check('a page is rendered', before.w > 0 && before.bitmapW > 0,
      `${before.w.toFixed(0)}×${before.h.toFixed(0)} css, ${before.bitmapW}×${before.bitmapH} bitmap`);
    check('the page reports its natural width', before.natural > 0, String(before.natural));

    // Immediately after the layout change, before any debounce can fire: this
    // is the frame the user sees mid-drag, and it is where the squash showed.
    const during = await cdp.evaluate(setSplit(0.72));
    check('narrowing the pane actually shrinks the page',
      during.w < before.w - 20, `${before.w.toFixed(0)} → ${during.w.toFixed(0)} px`);
    check('aspect ratio holds during the drag',
      Math.abs(during.ratio - before.ratio) / before.ratio < 0.01,
      `${before.ratio.toFixed(4)} → ${during.ratio.toFixed(4)}`);
    check('not yet re-rasterised — CSS is doing the scaling',
      during.bitmapW === before.bitmapW, `${before.bitmapW} → ${during.bitmapW}`);

    // Past the 150ms debounce it should have re-rendered at the new width.
    await sleep(1800);
    const after = await cdp.evaluate(`(() => {
      const c = document.querySelector('canvas.pdfpage');
      const r = c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      return { w: r.width, h: r.height, ratio: r.width / r.height,
               bitmapW: c.width, expected: Math.round(r.width * dpr) };
    })()`);
    check('re-rasterised at the new width',
      Math.abs(after.bitmapW - after.expected) <= 2,
      `bitmap ${after.bitmapW}, expected ~${after.expected}`);
    check('aspect ratio still right after the re-render',
      Math.abs(after.ratio - before.ratio) / before.ratio < 0.01,
      `${before.ratio.toFixed(4)} → ${after.ratio.toFixed(4)}`);

    // And widening again, since the first fix only covered one direction.
    await cdp.evaluate(setSplit(0.3));
    await sleep(1800);
    const wide = await cdp.evaluate(`(() => {
      const c = document.querySelector('canvas.pdfpage');
      const r = c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      return { w: r.width, ratio: r.width / r.height, bitmapW: c.width,
               expected: Math.round(r.width * dpr) };
    })()`);
    check('widening refits too', wide.w > after.w + 20, `${after.w.toFixed(0)} → ${wide.w.toFixed(0)} px`);
    check('re-rasterised when widened', Math.abs(wide.bitmapW - wide.expected) <= 2,
      `bitmap ${wide.bitmapW}, expected ~${wide.expected}`);
    check('aspect ratio held throughout',
      Math.abs(wide.ratio - before.ratio) / before.ratio < 0.01,
      `${before.ratio.toFixed(4)} → ${wide.ratio.toFixed(4)}`);

    // The SyncTeX coupling: a point on the page must map to the same PDF
    // coordinate whatever the pane width, or clicks land on the wrong line.
    const mapping = await cdp.evaluate(`(() => {
      const at = (frac) => {
        document.getElementById('editorpane').style.flex = '1 1 ' + (frac * 100) + '%';
        document.getElementById('pdfpane').style.flex = '1 1 ' + ((1 - frac) * 100) + '%';
        const c = document.querySelector('canvas.pdfpage');
        const r = c.getBoundingClientRect();
        // The same computation PdfPreview.effectiveScale does, from the same
        // data — done here rather than reaching into the instance, so this
        // needs no test-only hook in the shipped app.
        const s = r.width / Number(c.dataset.natural);
        // A point a third of the way across and down, in PDF points.
        return { x: (r.width / 3) / s, y: (r.height / 3) / s };
      };
      return { narrow: at(0.72), wide: at(0.3) };
    })()`);
    check('a screen point maps to the same PDF point at any width',
      Math.abs(mapping.narrow.x - mapping.wide.x) < 1 &&
      Math.abs(mapping.narrow.y - mapping.wide.y) < 1,
      `narrow (${mapping.narrow.x.toFixed(1)}, ${mapping.narrow.y.toFixed(1)}) · ` +
      `wide (${mapping.wide.x.toFixed(1)}, ${mapping.wide.y.toFixed(1)})`);

    /* ── the dividers themselves ────────────────────────────────────── */
    // Everything above drives the panes by assigning `style.flex` directly,
    // which is the handler's *effect* and never touches the divider. Reported
    // from the desktop build: three of the four dividers could not be grabbed
    // at all. A 1px target with a pane painted over it fails exactly here, and
    // nothing in this file could see it.
    await cdp.evaluate(`(() => {
      document.getElementById('editorpane').style.flex = '';
      document.getElementById('pdfpane').style.flex = '';
    })()`, true);

    for (const [name, sel, axis] of [
      ['sidebar', `document.querySelector('.vdiv[data-resize="sidebar"]')`, 'x'],
      ['editor/PDF', `document.querySelector('.vdiv[data-resize="editor"]')`, 'x'],
      ['outline', `document.querySelector('.vdiv[data-resize="outline"]')`, 'x']
    ]) {
      const measure = `(() => {
        const p = document.getElementById('editorpane').getBoundingClientRect();
        const s = document.getElementById('sidebar').getBoundingClientRect();
        const o = document.getElementById('outlinepane').getBoundingClientRect();
        return { editor: p.width, sidebar: s.width, outline: o.width };
      })()`;
      const was = await cdp.evaluate(measure, true);
      const delta = name === 'outline' ? -60 : 60;
      await realDrag(cdp, sel, axis === 'x' ? delta : 0, axis === 'x' ? 0 : delta);
      const now = await cdp.evaluate(measure, true);
      const moved = Math.abs(now.editor - was.editor) > 8 ||
                    Math.abs(now.sidebar - was.sidebar) > 8 ||
                    Math.abs(now.outline - was.outline) > 8;
      check(`the ${name} divider can actually be dragged`, moved,
        `sidebar ${was.sidebar.toFixed(0)}→${now.sidebar.toFixed(0)}, ` +
        `editor ${was.editor.toFixed(0)}→${now.editor.toFixed(0)}, ` +
        `outline ${was.outline.toFixed(0)}→${now.outline.toFixed(0)}`);
    }

    // The bug this is really guarding: the drag writes an inline height on
    // #panel, and an inline style beats `#panel.collapsed { height:2rem }`. Once
    // the panel had been dragged, Hide could never collapse it again — it
    // emptied the tab body and left the box full height, which reads as a dead
    // button. A `.click()` test would have missed the drag half entirely.
    const panelHeights = await cdp.evaluate(`(() => {
      const p = document.getElementById('panel');
      p.classList.remove('collapsed');
      p.style.height = '';
      return { start: p.getBoundingClientRect().height };
    })()`, true);
    await realDrag(cdp, `document.getElementById('paneldiv')`, 0, -70);
    panelHeights.dragged = await cdp.evaluate(
      `document.getElementById('panel').getBoundingClientRect().height`, true);
    await realClick(cdp, `document.getElementById('togglepanel')`);
    await sleep(120);
    panelHeights.hidden = await cdp.evaluate(
      `document.getElementById('panel').getBoundingClientRect().height`, true);
    await realClick(cdp, `document.getElementById('togglepanel')`);
    await sleep(120);
    panelHeights.shown = await cdp.evaluate(
      `document.getElementById('panel').getBoundingClientRect().height`, true);

    check('the log panel divider can be dragged',
      panelHeights.dragged > panelHeights.start + 20,
      `${panelHeights.start.toFixed(0)} → ${panelHeights.dragged.toFixed(0)}`);
    check('Hide collapses the panel even after a drag',
      panelHeights.hidden < panelHeights.dragged / 2,
      `${panelHeights.dragged.toFixed(0)} → ${panelHeights.hidden.toFixed(0)}`);
    check('and Show returns it to the dragged height',
      Math.abs(panelHeights.shown - panelHeights.dragged) < 4,
      `${panelHeights.hidden.toFixed(0)} → ${panelHeights.shown.toFixed(0)}`);

    check('a drag leaves no selection painted across the panes',
      await cdp.evaluate(`!document.body.classList.contains('dragging') &&
                          document.body.style.cursor === ''`, true));

    /* ── undo cannot leave the file it belongs to ───────────────────── */
    //
    // This was a data-loss bug, not a cosmetic one. There used to be a single
    // EditorState created with an empty document, and openFile() replaced its
    // text with an ordinary dispatch — so every file open pushed a "replace
    // everything" change onto one shared undo stack. Holding Ctrl+Z walked back
    // through it into the *previous* file's text and finally into the original
    // empty document, all under the current file's name, while the update
    // listener wrote each step into project.files and marked the file modified.
    // Ctrl+S then saved an empty file over the user's document.
    //
    // Undo is the one key people press without looking, so this is asserted
    // rather than left to a comment: each file gets its own state, and undo can
    // only reach that file's own oldest edit.
    const undoWalk = await cdp.evaluate(`(async () => {
      const T = window.__reveryTexTest;
      const rows = () => [...document.querySelectorAll('#filetree .node[data-path]')];
      const open = (frag) => {
        const r = rows().find(n => n.dataset.path.includes(frag));
        r.click();
        return r.dataset.path;
      };
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      const a = open('cv_teknisk_fysik_en');
      await sleep(60);
      const aFirst = T.view().state.doc.line(1).text;
      T.view().dispatch({ changes: { from: 0, insert: '%% MARKER-A\\n' } });
      await sleep(600);                       // past CodeMirror's grouping window

      const b = open('personligt_brev_sv');
      await sleep(60);
      const bFirst = T.view().state.doc.line(1).text;
      T.view().dispatch({ changes: { from: 0, insert: '%% MARKER-B\\n' } });
      await sleep(600);

      // Hold Ctrl+Z well past the point that used to empty the document.
      for (let i = 0; i < 15; i++) window.CM.undo(T.view());

      const doc = T.view().state.doc.toString();
      return {
        a, b, aFirst, bFirst,
        empty: doc.length === 0,
        first: T.view().state.doc.line(1).text,
        sawOtherFile: doc.includes('MARKER-A'),
        stillHasOwnEdit: doc.includes('MARKER-B'),
        title: document.getElementById('editortitle').textContent,
        dirty: rows().filter(n => n.classList.contains('dirty')).map(n => n.dataset.path)
      };
    })()`, true);

    check('undo never empties the document', !undoWalk.empty);
    check('undo stops at the open file’s own oldest edit',
      undoWalk.first === undoWalk.bFirst,
      `first line ${JSON.stringify(undoWalk.first)} vs ${JSON.stringify(undoWalk.bFirst)}`);
    check('undo cannot pull another file’s text into this one',
      !undoWalk.sawOtherFile);
    check('and it did undo this file’s own edit', !undoWalk.stillHasOwnEdit);
    check('the title still names the file that is shown',
      undoWalk.title === undoWalk.b, `${undoWalk.title} vs ${undoWalk.b}`);
    // The consequence that made this data loss: a file nobody typed in must not
    // come back modified, because Save writes every file that is.
    check('no file is left modified that was not edited',
      undoWalk.dirty.every(p => p === undoWalk.a || p === undoWalk.b),
      `dirty: ${undoWalk.dirty.join(', ') || 'none'}`);

    // Per-file history is the other half: coming back must not have lost it.
    const undoReturn = await cdp.evaluate(`(async () => {
      const T = window.__reveryTexTest;
      const open = (frag) => [...document.querySelectorAll('#filetree .node[data-path]')]
        .find(n => n.dataset.path.includes(frag)).click();
      open('cv_teknisk_fysik_en');
      await new Promise(r => setTimeout(r, 60));
      const before = T.view().state.doc.toString().includes('MARKER-A');
      window.CM.undo(T.view());
      const after = T.view().state.doc.toString().includes('MARKER-A');
      // Put the main document back in the editor: everything below this point
      // works on whatever file is open, starting with the table builder.
      open('cv_harald_thirslund_sv');
      await new Promise(r => setTimeout(r, 60));
      return { before, after,
               restored: document.getElementById('editortitle').textContent };
    })()`, true);
    check('switching away and back keeps that file’s undo history',
      undoReturn.before && !undoReturn.after,
      `marker present ${undoReturn.before}, undone ${!undoReturn.after}`);
    check('and the main document is back in the editor for what follows',
      /cv_harald_thirslund_sv/.test(undoReturn.restored), undoReturn.restored);

    /* ── the table builder ──────────────────────────────────────────── */
    // Before the formatting block, which replaces the whole cv document with a
    // test sentence — the compile below needs a real document.
    const dlg = await cdp.evaluate(`(() => {
      const view = window.__reveryTexTest.view();
      // Into the body. A table float in the preamble is a compile error, and
      // "wherever the cursor happened to be" is not a test.
      const text = view.state.doc.toString();
      const at = text.indexOf('\\\\begin{document}') + '\\\\begin{document}'.length;
      view.dispatch({ selection: { anchor: at } });

      document.getElementById('toolbox').click();
      const menu = document.querySelector('.menu-container:not([hidden])');
      const rows = [...menu.querySelectorAll('.menu-item')].map(b => b.textContent.trim());
      const notes = [...menu.querySelectorAll('.menu-note')].map(n => n.textContent.trim());
      [...menu.querySelectorAll('.menu-item')]
        .find(b => /insert table/i.test(b.textContent)).click();

      const panel = document.querySelector('.dlg');
      if (!panel) return { opened: false, rows, notes };
      const field = (name) => [...panel.querySelectorAll('.dlg-row')]
        .find(r => new RegExp(name, 'i').test(r.querySelector('.dlg-label').textContent))
        .querySelector('input');
      const type = (input, v) => {
        input.value = v;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const preview = () => panel.querySelector('.dlg-preview').textContent;

      const first = preview();
      type(field('columns'), '4');
      const wider = preview();
      type(field('caption'), 'Measured results & 10% error');
      const captioned = preview();
      const derivedLabel = field('label').value;
      // Typing in the label box stops the caption from overwriting it.
      type(field('label'), 'tab:mine');
      type(field('caption'), 'Measured results again');
      const keptLabel = field('label').value;

      return {
        opened: true, rows, notes, first, wider, captioned, derivedLabel, keptLabel,
        rules: [...panel.querySelectorAll('.dlg-choice button')].map(b => b.textContent.trim())
      };
    })()`, true);

    check('the toolbox offers the insert actions',
      dlg.rows.some(r => /insert table/i.test(r)), dlg.rows.join(' | '));
    // The cv fixture has no tables, so the reference row must say so rather
    // than offering an empty submenu.
    check('with no tables, the menu says so instead of offering an empty list',
      dlg.notes.some(n => /no tables/i.test(n)), dlg.notes.join(' | '));
    check('the insert-table dialog opens with a preview',
      dlg.opened && /\\begin\{table\}/.test(dlg.first || ''), (dlg.first || '').split('\n')[0]);
    check('the preview follows the column count',
      (dlg.wider.match(/&/g) || []).length > (dlg.first.match(/&/g) || []).length,
      `${(dlg.first.match(/&/g) || []).length} → ${(dlg.wider.match(/&/g) || []).length} ampersands`);
    // A % in a caption comments away the rest of the line and still compiles.
    check('the caption is escaped in the preview',
      dlg.captioned.includes('Measured results \\& 10\\% error'),
      (dlg.captioned.match(/\\caption\{.*\}/) || [''])[0]);
    check('the label is derived from the caption',
      dlg.derivedLabel === 'tab:measured-results-10-error', dlg.derivedLabel);
    check('editing the label stops the caption overwriting it', dlg.keptLabel === 'tab:mine');
    // booktabs is not in the cv preamble, so it must not be on offer.
    check('booktabs is not offered to a document that does not load it',
      !dlg.rules.some(r => /booktabs/i.test(r)), dlg.rules.join(' | '));

    const put = await cdp.evaluate(`(() => {
      const panel = document.querySelector('.dlg');
      [...panel.querySelectorAll('.dlg-foot button')]
        .find(b => /insert/i.test(b.textContent)).click();
      const view = window.__reveryTexTest.view();
      const text = view.state.doc.toString();
      const at = text.indexOf('\\\\begin{table}');
      return {
        closed: !document.querySelector('.dlg'),
        inserted: at >= 0,
        // A block pasted mid-line produces "text\\begin{table}" and a compile
        // error, so it must start its own line.
        ownLine: at > 0 && text[at - 1] === '\\n',
        label: /\\\\label\\{tab:mine\\}/.test(text)
      };
    })()`, true);
    check('inserting closes the dialog', put.closed);
    check('the table lands in the document, on its own line',
      put.inserted && put.ownLine && put.label, JSON.stringify(put));

    const built = await cdp.evaluate(`window.__reveryTexApp.compile()`, true);
    // The point of this check: the generated LaTeX has to compile. The page
    // count is reported rather than asserted — adding a table may legitimately
    // add a page, and pinning it would make the test wrong for the right reason.
    check('a generated table compiles', built.ok === true,
      `${built.status} · ${built.pages} pages · ${built.issues} issues`);

    const escaped = await cdp.evaluate(`(() => {
      document.getElementById('toolbox').click();
      [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /insert table/i.test(b.textContent)).click();
      const before = window.__reveryTexTest.view().state.doc.length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return {
        closed: !document.querySelector('.dlg'),
        unchanged: window.__reveryTexTest.view().state.doc.length === before
      };
    })()`, true);
    check('Escape closes the dialog and inserts nothing',
      escaped.closed && escaped.unchanged, JSON.stringify(escaped));

    /* ── toolbox and right-click formatting ─────────────────────────── */
    // Off by default: the browser's own menu, which carries spellcheck and
    // clipboard, must survive until someone turns the Toolbox on.
    const offByDefault = await cdp.evaluate(`(() => {
      const view = window.__reveryTexTest.view();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'select me' } });
      view.dispatch({ selection: { anchor: 0, head: 6 } });
      const target = document.querySelector('.cm-content');
      const r = target.getBoundingClientRect();
      const ev = new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 });
      target.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented,
               stored: JSON.parse(localStorage.getItem('revery_tex_settings') || '{}').contextToolbox };
    })()`, true);
    check('right-click gives the browser its menu by default',
      !offByDefault.prevented, `setting: ${offByDefault.stored ?? '(default)'}`);

    // Turn it on through the settings menu, the way a user would.
    await cdp.evaluate(`(() => {
      document.getElementById('settings').click();
      // One ■/□ row now, not a "Browser menu / Toolbox" pair — and it is off, so
      // clicking it turns it on.
      const row = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-toggle')]
        .find(b => /Toolbox on right-click/i.test(b.textContent));
      row.click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return !!row;
    })()`);

    const fmt = await cdp.evaluate(`(async () => {
      const app = window.__reveryTexApp;
      const view = window.__reveryTexTest.view();
      const set = (text) => view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text } });
      const select = (a, b) => view.dispatch({ selection: { anchor: a, head: b } });
      const doc = () => view.state.doc.toString();

      set('make this bold please');
      select(10, 14);

      // Right-click over the editor with a selection.
      const target = document.querySelector('.cm-content');
      const r = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 }));
      const menu = document.querySelector('.menu-container:not([hidden])');
      const labels = menu ? [...menu.querySelectorAll('.menu-item')].map(b => b.textContent.trim()) : [];

      // Bold it, then bold it again — the second must undo the first.
      const bold = () => [...document.querySelectorAll('.menu-container .menu-item')]
        .find(b => /^Bold$/i.test(b.textContent.trim()));
      bold()?.click();
      const once = doc();

      const at = once.indexOf('bold');
      select(at, at + 4);
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 }));
      bold()?.click();
      const twice = doc();

      // Turned on it opens with nothing selected too: the formatting rows
      // insert an empty \\textbf{} with the cursor inside, which is what
      // "make the next thing bold" means.
      select(3, 3);
      const ev = new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 });
      target.dispatchEvent(ev);
      const openedWithNoSelection = ev.defaultPrevented
        && !!document.querySelector('.menu-container:not([hidden])');

      // …and so must it outside the editor entirely.
      const outside = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      document.getElementById('status').dispatchEvent(outside);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      // Accumulation is a delta, not an absolute: the permanent menus (settings,
      // toolbox, and the two topbar drop-downs) are always attached.
      const baseline = document.querySelectorAll('.menu-container').length;
      for (let i = 0; i < 5; i++) {
        select(0, 4);
        target.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
      const after = document.querySelectorAll('.menu-container').length;

      return {
        opened: !!menu, labels, once, twice,
        openedWithNoSelection, suppressedOutside: outside.defaultPrevented,
        baseline, after
      };
    })()`, true);

    check('right-click opens a menu over a selection', fmt.opened, fmt.labels.join(' | '));
    check('it offers the four formats',
      ['Bold', 'Italic', 'Underline', 'Code'].every(l => fmt.labels.includes(l)),
      fmt.labels.join(' | '));
    check('Bold wraps the selection',
      fmt.once === 'make this \\textbf{bold} please', JSON.stringify(fmt.once));
    check('Bold again unwraps it',
      fmt.twice === 'make this bold please', JSON.stringify(fmt.twice));
    // The native menu carries spellcheck, clipboard and Look Up; replacing it
    // with four items nobody asked for is a downgrade.
    check('turned on, it opens with no selection too', fmt.openedWithNoSelection);
    // Outside the editor the browser's menu is never touched, either way.
    check('the native menu survives outside the editor', !fmt.suppressedOutside);
    // A transient menu that is not removed leaves a dead <div> per right-click.
    check('context menus do not accumulate', fmt.after === fmt.baseline,
      `${fmt.baseline} permanent → ${fmt.after} after five right-clicks`);

    /* ── clipboard rows ─────────────────────────────────────────────── */
    // The menu replaces the browser's own, which had Cut, Copy and Paste at the
    // top. Leaving them out did not remove a feature so much as move it
    // somewhere nobody would look.
    const clip = await cdp.evaluate(`(async () => {
      const view = window.__reveryTexTest.view();
      const target = document.querySelector('.cm-content');
      const r = target.getBoundingClientRect();
      const openMenu = () => {
        target.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 }));
        return document.querySelector('.menu-container:not([hidden])');
      };
      const rowsNow = (m) => [...m.querySelectorAll('.menu-item')]
        .map(b => ({ label: b.textContent.trim(), disabled: b.disabled }));

      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'copy this text' } });

      // With a selection.
      view.dispatch({ selection: { anchor: 5, head: 9 } });
      const withSel = rowsNow(openMenu());
      const copyRow = [...document.querySelectorAll('.menu-container .menu-item')]
        .find(b => /^Copy$/i.test(b.textContent.trim()));
      copyRow?.click();
      await new Promise(res => setTimeout(res, 120));
      let clipboardText = null;
      try { clipboardText = await navigator.clipboard.readText(); } catch { /* not granted */ }

      // Without one: Cut and Copy have nothing to act on.
      view.dispatch({ selection: { anchor: 3, head: 3 } });
      const noSel = rowsNow(openMenu());
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      // Cut, on a fresh selection.
      view.dispatch({ selection: { anchor: 0, head: 5 } });
      openMenu();
      [...document.querySelectorAll('.menu-container .menu-item')]
        .find(b => /^Cut$/i.test(b.textContent.trim()))?.click();
      await new Promise(res => setTimeout(res, 150));

      return {
        withSel, noSel, clipboardText,
        afterCut: view.state.doc.toString(),
        // The Toolbox button is "insert and format" — Copy there would be noise.
        toolboxLabels: (() => {
          document.getElementById('toolbox').click();
          const m = document.querySelector('.menu-container:not([hidden])');
          const l = m ? [...m.querySelectorAll('.menu-item')].map(b => b.textContent.trim()) : [];
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return l;
        })()
      };
    })()`, true);

    const labelsOf = (rows) => rows.map(r => r.label);
    check('the right-click menu offers Cut, Copy and Paste',
      ['Cut', 'Copy', 'Paste'].every(l => labelsOf(clip.withSel).includes(l)),
      labelsOf(clip.withSel).slice(0, 5).join(' | '));
    check('and puts them above the formatting rows',
      labelsOf(clip.withSel).indexOf('Cut') < labelsOf(clip.withSel).indexOf('Bold'));
    check('Cut and Copy are enabled with a selection',
      clip.withSel.filter(r => /^(Cut|Copy)$/.test(r.label)).every(r => !r.disabled));
    // Shown and dimmed rather than dropped, so the rows below do not move
    // between one opening of the menu and the next.
    check('and disabled — not hidden — without one',
      clip.noSel.filter(r => /^(Cut|Copy)$/.test(r.label)).every(r => r.disabled) &&
      labelsOf(clip.noSel).includes('Cut'),
      labelsOf(clip.noSel).slice(0, 3).join(' | '));
    // Chrome grants clipboard-read to the driven page; where it is refused this
    // reads null and the check is skipped rather than failing on a permission.
    if (clip.clipboardText !== null) {
      check('Copy puts the selection on the clipboard',
        clip.clipboardText === 'this', JSON.stringify(clip.clipboardText));
    }
    // 'copy this text' minus characters 0..5, which is 'copy '.
    check('Cut removes the selection from the document',
      clip.afterCut === 'this text', JSON.stringify(clip.afterCut));
    check('the Toolbox button does not carry clipboard rows',
      !['Cut', 'Copy', 'Paste'].some(l => clip.toolboxLabels.includes(l)),
      clip.toolboxLabels.slice(0, 4).join(' | '));

    const toolbox = await cdp.evaluate(`(() => {
      document.getElementById('toolbox').click();
      const m = document.querySelector('.menu-container:not([hidden])');
      const labels = m ? [...m.querySelectorAll('.menu-item')].map(b => b.textContent.trim()) : [];
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return labels;
    })()`);
    check('the toolbox offers the same formats',
      ['Bold', 'Italic', 'Underline', 'Code'].every(l => toolbox.includes(l)),
      toolbox.join(' | '));

    /* ── outline ────────────────────────────────────────────────────── */
    // The book fixture is the one that matters: chapters in separate files
    // pulled in by \include, plus a main_legacy.tex that is a second complete
    // main file nothing reads. Ordering by the file map instead of the include
    // graph would show the book twice, interleaved.
    const switched = await cdp.evaluate(`(() => {
      document.getElementById('project').click();
      const item = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => b.textContent.trim().replace(/^[■□]\\s*/, '') === 'book');
      if (item) item.click();
      return !!item;
    })()`);
    check('the book fixture can be selected', switched);

    // Again a file unique to this project: every fixture's main file is called
    // main.tex, so docname alone does not say the switch has finished.
    await cdp.waitFor(
      `!!document.querySelector('#filetree .node[data-path="chapters/introduction.tex"]') &&
       document.querySelectorAll('#outline .node.sec').length > 0`,
      { what: 'the book outline', timeoutMs: 30000 });

    const out = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('#outline .node')];
      const secs = rows.filter(r => r.classList.contains('sec'));
      const files = secs.map(r => r.title.replace(/:\\d+$/, ''));
      return {
        count: secs.length,
        titles: secs.slice(0, 4).map(r => r.textContent),
        files,
        orphanFiles: [...new Set(secs.filter(r => r.classList.contains('orphan'))
          .map((r, i) => r.title.replace(/:\\d+$/, '')))],
        firstOrphan: secs.findIndex(r => r.classList.contains('orphan')),
        lastIncluded: secs.map(r => r.classList.contains('orphan')).lastIndexOf(false),
        counter: document.getElementById('outlinecount').textContent,
        // Levels must indent: \\chapter shallower than the \\section under it.
        indents: [...new Set(secs.map(r => r.style.paddingLeft))].length
      };
    })()`, true);

    check('the outline lists the book headings', out.count > 10, `${out.count} headings`);
    check('the counter matches', out.counter === String(out.count), out.counter);
    check('reading order starts in the main file', out.files[0] === 'main.tex', out.files[0]);
    check('chapters appear in \\include order',
      ['chapters/introduction.tex', 'chapters/tables.tex', 'chapters/figures.tex']
        .every((f, i, arr) => {
          const at = out.files.indexOf(f);
          return at >= 0 && (i === 0 || at > out.files.indexOf(arr[i - 1]));
        }),
      [...new Set(out.files)].slice(0, 6).join(' → '));
    // main_legacy.tex is a complete alternative document. Its headings belong at
    // the end, marked — not merged into the book's own structure.
    check('the unreferenced main file is flagged, and last',
      out.orphanFiles.length > 0 && out.orphanFiles.every(f => f === 'main_legacy.tex') &&
      out.firstOrphan > out.lastIncluded,
      `${out.orphanFiles.join(',')} at ${out.firstOrphan} after ${out.lastIncluded}`);
    check('heading levels are indented', out.indents > 1, `${out.indents} distinct indents`);

    const jumped = await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('#outline .node.sec')]
        .find(r => r.title.startsWith('chapters/') && !r.classList.contains('orphan'));
      if (!row) return { ok: false };
      const [file, line] = row.title.split(':');
      row.click();
      const view = window.__reveryTexTest.view();
      const at = view.state.doc.lineAt(view.state.selection.main.head).number;
      return {
        ok: true, file, want: Number(line), at,
        opened: document.getElementById('editortitle').textContent,
        text: view.state.doc.line(at).text.trim(),
        marked: row.classList.contains('here')
      };
    })()`, true);

    check('clicking a heading opens its file and moves the cursor',
      jumped.ok && jumped.opened === jumped.file && jumped.at === jumped.want,
      `${jumped.opened}:${jumped.at} (wanted ${jumped.file}:${jumped.want})`);
    // The line it lands on must be the heading itself — an off-by-one here is
    // invisible in a screenshot and wrong on every jump.
    check('the cursor lands on the heading line',
      /^\\(chapter|section|subsection|part)\*?[[{]/.test(jumped.text || ''), jumped.text);
    check('the outline marks where the cursor is', jumped.marked === true);

    const place = await cdp.evaluate(`(() => {
      const pane = document.getElementById('outlinepane');
      const pdf = document.getElementById('pdfpane');
      const div = document.querySelector('.vdiv[data-resize="outline"]');
      const order = [...document.getElementById('workspace').children].map(n => n.id || n.dataset.resize);
      const at = (el) => el.getBoundingClientRect();

      const before = { pane: at(pane).left, pdf: at(pdf).right };
      // …and under the reversed panel order it must still be the rightmost
      // thing, not sorted to the front for having no explicit order.
      document.documentElement.setAttribute('data-panel-order', 'pdf-first');
      const flipped = { pane: at(pane).left, editor: at(document.getElementById('editorpane')).right };
      document.documentElement.setAttribute('data-panel-order', 'editor-first');
      return { order, before, flipped, dividerBeforePane: at(div).left <= at(pane).left };
    })()`, true);
    check('the outline sits right of the PDF',
      place.before.pane >= place.before.pdf - 2 && place.dividerBeforePane,
      place.order.join(' → '));
    check('and stays rightmost when the panes are reversed',
      place.flipped.pane >= place.flipped.editor - 2,
      `pane at ${place.flipped.pane.toFixed(0)}, editor ends ${place.flipped.editor.toFixed(0)}`);

    const toggled = await cdp.evaluate(`(() => {
      const pane = document.getElementById('outlinepane');
      const div = document.querySelector('.vdiv[data-resize="outline"]');
      const btn = document.getElementById('outlinetoggle');
      const read = () => ({ label: btn.textContent.trim(),
                            pressed: btn.getAttribute('aria-pressed') });
      btn.click();
      const off = { ...read(), pane: pane.hidden, divider: div.hidden,
                    stored: JSON.parse(localStorage.getItem('revery_tex_settings') || '{}').showOutline };
      btn.click();
      return { off, onAgain: !pane.hidden && !div.hidden, ...read() };
    })()`, true);
    check('the topbar button hides the pane and its divider',
      toggled.off.pane && toggled.off.divider, JSON.stringify(toggled.off));
    // A divider left behind is a drag handle for something that is not there.
    // The state is aria-pressed, which the stylesheet fills on, rather than a ✓
    // appended to the label: #topbar clips from the right, so the label has to
    // keep its width across both states.
    check('the button says which state it is in',
      toggled.off.pressed === 'false' && toggled.pressed === 'true',
      `pressed ${toggled.off.pressed} → ${toggled.pressed}`);
    check('and does so without changing the width of its label',
      toggled.off.label === 'Outline' && toggled.label === 'Outline',
      `${toggled.off.label} → ${toggled.label}`);
    check('the choice is persisted as a setting', toggled.off.stored === false,
      String(toggled.off.stored));
    check('turning it back on restores the pane', toggled.onAgain);

    // The PDF is right there, so a heading should move it too. The cv was
    // compiled earlier in this run, but this is the book — compile it so there
    // is SyncTeX data for the file the outline points into.
    await cdp.evaluate(`window.__reveryTexApp.compile()`, true);
    const synced = await cdp.evaluate(`(async () => {
      const box = document.getElementById('pdf');
      // Which page is under the point scrollToPosition aims for.
      const pageAtTop = () => {
        const cs = [...box.querySelectorAll('canvas.pdfpage')];
        const y = box.scrollTop + box.clientHeight / 3;
        let hit = cs[0];
        for (const c of cs) if (c.offsetTop <= y) hit = c;
        return hit ? Number(hit.dataset.page) : null;
      };
      const rows = [...document.querySelectorAll('#outline .node.sec')];
      const seen = [];
      let marked = false;
      for (const label of ['Introduction', 'Tables', 'Figures']) {
        const r = rows.find(x => x.textContent.trim() === label);
        if (!r) { seen.push({ label, page: null }); continue; }
        r.click();
        // The mark is dropped at the target and removed after 1.6s; catching it
        // proves the jump ran before the smooth scroll has even finished.
        marked = marked || !!box.querySelector('.pdf-syncmark');
        // Wait for the smooth scroll to settle rather than for a fixed delay:
        // how long it takes depends on how far it has to go, and a jump caught
        // mid-animation reports the page it was passing through.
        for (let last = -1, still = 0; still < 3; ) {
          await new Promise(res => setTimeout(res, 100));
          if (box.scrollTop === last) still++; else { still = 0; last = box.scrollTop; }
        }
        seen.push({ label, page: pageAtTop(), file: r.title });
      }
      return { seen, marked, pages: box.querySelectorAll('canvas').length };
    })()`, true);
    const pages = synced.seen.map(s => s.page);
    check('clicking a heading scrolls the PDF to it', synced.pages > 1 && synced.marked,
      `${synced.pages} pages rendered`);
    // Not just "it moved": each heading must land later than the one before it,
    // which is the difference between a working SyncTeX lookup and a scroll to
    // an arbitrary offset.
    check('each heading lands on its own page, in order',
      pages.every(p => p !== null) && pages[0] < pages[1] && pages[1] < pages[2],
      synced.seen.map(s => `${s.label}→p${s.page}`).join(' · '));

    /* ── referencing an existing table ──────────────────────────────── */
    // The book fixture has a chapter of them, which is why this runs here and
    // not on the cv.
    const ref = await cdp.evaluate(`(() => {
      const view = window.__reveryTexTest.view();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      const before = view.state.doc.toString();

      document.getElementById('toolbox').click();
      const trigger = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /reference a table/i.test(b.textContent));
      if (!trigger) return { found: false };
      trigger.click();
      const panel = [...document.querySelectorAll('.submenu')].find(p => !p.hidden);
      const rows = panel ? [...panel.querySelectorAll('.menu-item')] : [];
      window.__before = before;
      return {
        found: true, count: rows.length,
        labels: rows.map(b => b.textContent.trim()),
        tips: rows.map(b => b.title)
      };
    })()`, true);

    // With a real mouse, not el.click(). This is the check that the reported
    // "Reference a table doesn't work" is about: pressing the button used to
    // dismiss the parent menu, which removed the panel before the click could
    // land, so nothing was ever inserted.
    await realClick(cdp, `[...document.querySelectorAll('.submenu')].find(p => !p.hidden)?.querySelector('.menu-item')`);
    Object.assign(ref, await cdp.evaluate(`(() => {
      const after = window.__reveryTexTest.view().state.doc.toString();
      return {
        inserted: after.length - window.__before.length,
        tail: after.slice(-30),
        menusClosed: !document.querySelector('.menu-container:not([hidden])')
      };
    })()`, true));

    check('the toolbox lists the tables that can be referenced',
      ref.found && ref.count > 0, `${ref.count} table(s)`);
    // Captions, not \\label keys: "Simple Table" is what you are looking for in
    // the list; tab:simple is what goes in the document.
    check('rows are named by caption', ref.labels?.some(l => /table/i.test(l)),
      (ref.labels || []).slice(0, 3).join(' | '));
    check('each row shows its label and source on hover',
      (ref.tips || []).every(t => /tab:|:\d+/.test(t || '')), (ref.tips || [])[0]?.split('\n')[0]);
    check('picking one inserts a \\ref', /\\ref\{[^}]+\}$/.test(ref.tail || ''), ref.tail);
    check('and closes the menu', ref.menusClosed === true);

    /* ── citations ──────────────────────────────────────────────────── */
    // A list of full references, not the grid of cards it was and not the
    // submenu before that. The submenu showed a title cut at 40 characters; the
    // grid could fit either two readable cards or twelve truncated ones.
    const cite = await cdp.evaluate(`(() => {
      const view = window.__reveryTexTest.view();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      document.getElementById('toolbox').click();
      const trigger = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /insert citation/i.test(b.textContent));
      if (!trigger) return { found: false };
      trigger.click();
      const panel = document.querySelector('.dlg.picker');
      const cards = panel ? [...panel.querySelectorAll('.picker-card')] : [];
      return {
        found: true,
        count: cards.length,
        labels: cards.map(c => c.querySelector('.picker-caption').textContent.trim()),
        hasFilter: !!panel?.querySelector('.picker-filter'),
        isList: !!panel?.querySelector('.picker-strip.picker-list'),
        // The − XS + stepper sizes a grid card; in a list it would do nothing.
        hasSizer: !!panel?.querySelector('.picker-size'),
        // One column, so arrow-up/down move by one row.
        cols: panel
          ? getComputedStyle(panel.querySelector('.picker-strip'))
              .gridTemplateColumns.split(' ').filter(Boolean).length
          : 0
      };
    })()`, true);

    // The rows paint lazily, on an IntersectionObserver — give it a frame.
    await new Promise(r => setTimeout(r, 250));
    Object.assign(cite, await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.dlg.picker .picker-card')];
      const thumb = (c) => c.querySelector('.picker-thumb');
      const part = (c, sel) => (c.querySelector(sel)?.textContent || '').trim();
      const painted = cards.filter(c => thumb(c)?.textContent.trim());
      const first = painted[0];
      return {
        previews: cards.map(c => (thumb(c)?.textContent || '').trim()),
        parts: first && {
          authors: part(first, '.cite-authors'),
          title: part(first, '.cite-title'),
          source: part(first, '.cite-source')
        },
        // Normal body size, not the .58rem the card used. Compared against the
        // root rather than to a fixed px so this holds at any --ui-scale.
        sizeRatio: first
          ? parseFloat(getComputedStyle(thumb(first)).fontSize) /
            parseFloat(getComputedStyle(document.documentElement).fontSize)
          : 0
      };
    })()`, true));

    // Filtering is the point of the change: type an author's name and the list
    // should narrow to entries by that author, not just ones whose key matches.
    cite.filtered = await cdp.evaluate(`(() => {
      const panel = document.querySelector('.dlg.picker');
      const cards = [...panel.querySelectorAll('.picker-card')];
      const author = cards.map(c => c.querySelector('.cite-authors')?.textContent).find(Boolean);
      if (!author) return null;
      const word = author.split(/[,;\\s]+/).filter(w => w.length > 3)[0];
      const box = panel.querySelector('.picker-filter');
      box.value = word;
      box.dispatchEvent(new Event('input'));
      const shown = cards.filter(c => !c.hidden);
      box.value = '';
      box.dispatchEvent(new Event('input'));
      return { word, shown: shown.length, total: cards.length };
    })()`, true);

    await realClick(cdp, `document.querySelector('.dlg.picker .picker-card:not([hidden])')`);
    cite.tail = await cdp.evaluate(
      `window.__reveryTexTest.view().state.doc.toString().slice(-30)`, true);

    check('citations are listed from the bibliography',
      cite.found && cite.count > 0, `${cite.count} entr(ies)`);
    check('and open in a picker with a filter box', cite.hasFilter === true);
    check('as a single-column list, with no card-size stepper',
      cite.isList === true && cite.cols === 1 && cite.hasSizer === false,
      `list=${cite.isList} cols=${cite.cols} sizer=${cite.hasSizer}`);
    // The key is the caption, because the key is what gets inserted; the
    // reference beside it is what you actually recognise the work by.
    check('each row is labelled with its cite key',
      cite.labels?.every(l => l && !/\s/.test(l)), (cite.labels || []).slice(0, 3).join(' | '));
    check('and carries the reference in three parts',
      !!cite.parts?.authors && !!cite.parts?.title && !!cite.parts?.source,
      cite.parts && `${cite.parts.authors} | ${cite.parts.title} | ${cite.parts.source}`);
    // The complaint this answers: the card text was .58rem, under 12px at the
    // default UI size. Body is .75rem.
    check('at the body text size, not smaller',
      cite.sizeRatio >= 0.75, `${cite.sizeRatio?.toFixed(3)}rem`);
    check('filtering by an author narrows the list',
      cite.filtered && cite.filtered.shown > 0 && cite.filtered.shown < cite.filtered.total,
      cite.filtered && `"${cite.filtered.word}" → ${cite.filtered.shown}/${cite.filtered.total}`);
    check('picking one inserts a \\cite', /\\cite\{[^}]+\}$/.test(cite.tail || ''), cite.tail);

    /* ── the biblatex backend, and the way out of a stale .bbl ──────── */
    // The bundled engine has no biber and never can — biber is Perl. Its advice
    // on a stale .bbl is to set backend=bibtex, which bundled bibtex8 really can
    // build; but the option was ignored by detection, so a document that took
    // the advice still reported 'biber' and still got no bibliography. The
    // advice printed again next compile, unchanged.
    const bib = await cdp.evaluate(`(async () => {
      const { inferBibTool } = await import('./jvscrpt_and_css_extra/project_store.js');
      const { switchBiblatexBackend } = await import('./jvscrpt_and_css_extra/latex_snippets.js');
      const biber  = '\\\\usepackage[backend=biber]{biblatex}\\n\\\\addbibresource{r.bib}';
      const edit = switchBiblatexBackend(biber);
      const fixed = biber.slice(0, edit.from) + edit.insert + biber.slice(edit.to);
      return { before: inferBibTool(biber), after: inferBibTool(fixed), fixed };
    })()`, true);

    check('a biblatex document on biber reports biber', bib.before === 'biber', bib.before);
    check('and reports bibtex once the backend says so',
      bib.after === 'bibtex', `${bib.before} → ${bib.after}`);
    check('the one-click fix rewrites the package options',
      /backend=bibtex/.test(bib.fixed || '') && !/biber/.test(bib.fixed || ''), bib.fixed);

    const refFig = await cdp.evaluate(`(() => {
      const view = window.__reveryTexTest.view();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      document.getElementById('toolbox').click();
      [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /reference a figure/i.test(b.textContent)).click();
      const panel = document.querySelector('.dlg.picker');
      const cards = panel ? [...panel.querySelectorAll('.picker-card')] : [];
      const labels = cards.map(c => c.querySelector('.picker-caption').textContent);
      cards[0]?.click();
      return { count: cards.length, labels, tail: view.state.doc.toString().slice(-24) };
    })()`, true);
    check('labelled figures can be referenced',
      refFig.count > 0, `${refFig.count}: ${(refFig.labels || []).join(' | ').slice(0, 70)}`);
    check('picking one inserts a \\ref', /\\ref\{[^}]+\}$/.test(refFig.tail || ''), refFig.tail);

    /* ── the figure picker ──────────────────────────────────────────── */
    // On the homework fixture: it is the one with a folder of graphs. The book
    // has the bibliography but no images, which is why the two blocks run on
    // different projects.
    await cdp.evaluate(`(() => {
      document.getElementById('project').click();
      const it = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => b.textContent.trim().replace(/^[■□]\\s*/, '') === 'homework');
      it && it.click();
      return !!it;
    })()`);
    // Wait for a file only this project has. "the editor holds a document with
    // \\documentclass" is true of the project that was already open, so it
    // matches before the switch has happened and the checks below then run
    // against the wrong project — which is how a suite becomes flaky.
    await cdp.waitFor(
      `!!document.querySelector('#filetree .node[data-path="chapter/problem_1.tex"]')`,
      { what: 'the homework project', timeoutMs: 30000 });

    const pick = await cdp.evaluate(`(async () => {
      document.getElementById('toolbox').click();
      [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /^insert figure/i.test(b.textContent.trim())).click();
      const panel = document.querySelector('.dlg.picker');
      if (!panel) return { opened: false };

      const cards = [...panel.querySelectorAll('.picker-card')];
      const painted = () => cards.filter(c => c.querySelector('.picker-thumb').children.length
        || c.querySelector('.picker-thumb').textContent).length;
      // IntersectionObserver delivery is not tied to a frame, so wait for the
      // first card rather than for a fixed number of rAFs — the assertion is
      // that *not all* of them render, and a race on when the first one does
      // would make this pass or fail for reasons unrelated to laziness.
      for (let i = 0; i < 40 && painted() === 0; i++) {
        await new Promise(r => setTimeout(r, 25));
      }
      const paintedEarly = painted();

      const filterBox = panel.querySelector('.picker-filter');
      filterBox.value = 'zzz-nothing-matches';
      filterBox.dispatchEvent(new Event('input', { bubbles: true }));
      const afterFilter = cards.filter(c => !c.hidden).length;
      const countText = panel.querySelector('.picker-count').textContent;
      filterBox.value = '';
      filterBox.dispatchEvent(new Event('input', { bubbles: true }));

      // A grid that wraps, not a single row scrolled sideways.
      const strip = panel.querySelector('.picker-strip');
      const cs = getComputedStyle(strip);
      const grid = {
        display: cs.display,
        cols: cs.gridTemplateColumns.split(' ').filter(Boolean).length,
        // More cards than fit one row, and the overflow is below rather than
        // off to the right.
        rows: Math.ceil(cards.length / cs.gridTemplateColumns.split(' ').filter(Boolean).length),
        scrollsDown: strip.scrollHeight > strip.clientHeight + 1,
        scrollsSideways: strip.scrollWidth > strip.clientWidth + 1
      };

      // − / + resize the cards. Read off the card itself, not the property:
      // what matters is that the grid actually reflowed.
      const sizeBtns = [...panel.querySelectorAll('.picker-size button')];
      const cardW = () => cards[0].getBoundingClientRect().width;
      const atOpen = cardW();
      sizeBtns[1].click();
      const afterPlus = cardW();
      const colsAfterPlus = getComputedStyle(strip).gridTemplateColumns.split(' ').filter(Boolean).length;
      sizeBtns[0].click(); sizeBtns[0].click();
      const afterMinus = cardW();
      // Walk to each end and check the buttons stop rather than wrapping.
      for (let i = 0; i < 8; i++) sizeBtns[0].click();
      const atFloor = { w: cardW(), minusOff: sizeBtns[0].disabled, plusOn: !sizeBtns[1].disabled };
      for (let i = 0; i < 8; i++) sizeBtns[1].click();
      const atCeil = { w: cardW(), plusOff: sizeBtns[1].disabled, minusOn: !sizeBtns[0].disabled };
      // Back to the middle, and remember where, so the reopen check below knows
      // what it is looking for.
      sizeBtns[0].click(); sizeBtns[0].click();
      const chosen = { w: cardW(), label: panel.querySelector('.picker-size-value').textContent.trim() };
      const stored = JSON.parse(localStorage.getItem('revery_tex_settings') || '{}').pickerCardSize;

      // Every blob URL the picker made must be handed back on close.
      const live = new Set();
      const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
      URL.createObjectURL = (b) => { const u = realCreate.call(URL, b); live.add(u); return u; };
      URL.revokeObjectURL = (u) => { live.delete(u); return realRevoke.call(URL, u); };
      // Scroll to the end so more cards render, then close. Downwards: the grid
      // wraps, so scrollLeft would move nothing and this would quietly stop
      // testing anything at all.
      strip.scrollTop = strip.scrollHeight;
      await new Promise(r => setTimeout(r, 250));
      const madeMore = live.size;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const leaked = live.size;
      URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke;

      return {
        opened: true, total: cards.length, paintedEarly, afterFilter, countText,
        madeMore, leaked, closed: !document.querySelector('.dlg.picker'),
        grid, atOpen, afterPlus, colsAfterPlus, afterMinus, atFloor, atCeil, chosen, stored,
        labels: cards.slice(0, 3).map(c => c.querySelector('.picker-caption').textContent),
        tips: cards.slice(0, 3).map(c => c.title)
      };
    })()`, true);

    check('the figure picker opens with the project images',
      pick.opened && pick.total > 0, `${pick.total} image(s)`);
    // The whole point of the observer: a project with 25 images must not build
    // 25 thumbnails to show six.
    check('cards render lazily', pick.paintedEarly > 0 && pick.paintedEarly < pick.total,
      `${pick.paintedEarly} of ${pick.total} painted before scrolling`);
    check('cards are named by file, not by path',
      pick.labels?.every(l => !l.includes('/')), (pick.labels || []).join(' | '));
    check('the full path is still what the filter and tooltip see',
      pick.tips?.some(t => t.includes('/')), (pick.tips || [])[0]);
    check('filtering hides the cards that do not match',
      pick.afterFilter === 0 && /^0 of/.test(pick.countText || ''), pick.countText);
    // A leaked object URL pins the image bytes for the life of the page.
    check('blob URLs are revoked when the picker closes',
      pick.madeMore > 0 && pick.leaked === 0,
      `${pick.madeMore} created after scrolling, ${pick.leaked} left live`);
    check('Escape closes the picker', pick.closed);

    /* ── the grid, and sizing it ────────────────────────────────────── */
    // The point of the dialog is comparing previews, and a single row scrolled
    // sideways compares whatever four things happen to be in view.
    check('cards lay out as a grid, not a sideways strip',
      pick.grid?.display === 'grid' && pick.grid.cols > 1 && pick.grid.rows > 1,
      `${pick.grid?.display}, ${pick.grid?.cols} columns × ${pick.grid?.rows} rows`);
    check('the overflow is below, not off to the right',
      pick.grid?.scrollsDown && !pick.grid?.scrollsSideways,
      `down=${pick.grid?.scrollsDown} sideways=${pick.grid?.scrollsSideways}`);
    check('+ grows the cards and − shrinks them',
      pick.afterPlus > pick.atOpen && pick.afterMinus < pick.atOpen,
      `${pick.atOpen?.toFixed(0)} → +${pick.afterPlus?.toFixed(0)} → −${pick.afterMinus?.toFixed(0)}px`);
    // Bigger cards, fewer per row — the grid has to reflow, not just scale.
    check('growing a card reflows the grid to fewer columns',
      pick.colsAfterPlus < pick.grid?.cols, `${pick.grid?.cols} → ${pick.colsAfterPlus}`);
    // Without this the ladder wraps and one more click jumps from XL to XS.
    check('the steppers stop at both ends of the ladder',
      pick.atFloor?.minusOff && pick.atFloor?.plusOn
      && pick.atCeil?.plusOff && pick.atCeil?.minusOn
      && pick.atCeil?.w > pick.atFloor?.w,
      `${pick.atFloor?.w.toFixed(0)}px … ${pick.atCeil?.w.toFixed(0)}px`);
    // Remembered layout, so it rides along in the settings store without being
    // a SCHEMA entry — the same place the collapsed log panel is kept.
    check('the chosen size is persisted', Number.isInteger(pick.stored),
      `pickerCardSize=${pick.stored} (${pick.chosen?.label})`);

    // Reopening must come back at the size it was left at, not the default.
    const reopened = await cdp.evaluate(`(async () => {
      document.getElementById('toolbox').click();
      [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /^insert figure/i.test(b.textContent.trim())).click();
      const panel = document.querySelector('.dlg.picker');
      const w = panel.querySelector('.picker-card').getBoundingClientRect().width;
      const label = panel.querySelector('.picker-size-value').textContent.trim();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { w, label };
    })()`, true);
    check('and is still in force when the picker is reopened',
      Math.abs(reopened.w - pick.chosen.w) < 2 && reopened.label === pick.chosen.label,
      `${pick.chosen?.label} ${pick.chosen?.w.toFixed(0)}px → ${reopened.label} ${reopened.w.toFixed(0)}px`);

    const figure = await cdp.evaluate(`(() => {
      const view = window.__reveryTexTest.view();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      const before = view.state.doc.length;
      document.getElementById('toolbox').click();
      [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /^insert figure/i.test(b.textContent.trim())).click();
      document.querySelector('.dlg.picker .picker-card').click();
      const text = view.state.doc.toString();
      return {
        added: text.length > before,
        block: text.slice(text.lastIndexOf('\\\\begin{figure}')),
        closed: !document.querySelector('.dlg.picker')
      };
    })()`, true);
    check('picking an image inserts a figure block',
      figure.added && /\\begin\{figure\}/.test(figure.block || ''),
      (figure.block || '').split('\n').slice(0, 2).join(' ⏎ '));
    check('the block carries a caption, a label and a width',
      /\\caption\{.+\}/.test(figure.block || '') &&
      /\\label\{fig:[^}]+\}/.test(figure.block || '') &&
      /width=0\.8\\linewidth/.test(figure.block || ''),
      (figure.block || '').replace(/\n\s*/g, ' ').slice(0, 120));

    /* ── equations, with KaTeX ──────────────────────────────────────── */
    // Still on the homework fixture: 29 equations, eq: labels, and amsmath.
    const eq = await cdp.evaluate(`(async () => {
      const view = window.__reveryTexTest.view();
      view.dispatch({ selection: { anchor: view.state.doc.length } });

      const open = () => {
        document.getElementById('toolbox').click();
        [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
          .find(b => /^insert equation/i.test(b.textContent.trim())).click();
        return document.querySelector('.dlg');
      };
      const field = (panel, name) => [...panel.querySelectorAll('.dlg-row')]
        .find(r => new RegExp(name, 'i').test(r.querySelector('.dlg-label').textContent))
        .querySelector('input');
      const type = (i, v) => { i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
      const settle = () => new Promise(r => setTimeout(r, 400));

      const panel = open();
      if (!panel) return { opened: false };
      type(field(panel, 'equation'), 'E = mc^2');
      await settle();
      const box = panel.querySelector('.dlg-preview');
      const rendered = !!box.querySelector('.katex');
      const derivedLabel = field(panel, 'label').value;

      // A half-typed equation must show where it went wrong, not throw inside
      // the dialog it is being typed into.
      type(field(panel, 'equation'), 'E = \\\\frac{');
      await settle();
      const survivedGarbage = !!panel.querySelector('.dlg-preview').children.length;

      type(field(panel, 'equation'), 'E = mc^2');
      await settle();
      [...panel.querySelectorAll('.dlg-foot button')]
        .find(b => /insert/i.test(b.textContent)).click();
      const numbered = view.state.doc.toString().slice(-90);

      const panel2 = open();
      type(field(panel2, 'equation'), 'a + b');
      field(panel2, 'numbered').click();
      await settle();
      [...panel2.querySelectorAll('.dlg-foot button')]
        .find(b => /insert/i.test(b.textContent)).click();
      const starred = view.state.doc.toString().slice(-70);

      return { opened: true, rendered, derivedLabel, survivedGarbage, numbered, starred };
    })()`, true);

    check('the equation dialog renders with KaTeX', eq.opened && eq.rendered);
    check('the label is derived from the equation',
      /^eq:e-mc/.test(eq.derivedLabel || ''), eq.derivedLabel);
    check('a half-typed equation does not throw', eq.survivedGarbage);
    check('inserting writes a numbered equation with its label',
      /\\begin\{equation\}/.test(eq.numbered || '') && /\\label\{eq:[^}]+\}/.test(eq.numbered || ''),
      (eq.numbered || '').replace(/\n\s*/g, ' ').slice(-70));
    // \label inside equation* attaches to whatever counter last moved, so a
    // \ref to it points somewhere arbitrary — and it compiles without a word.
    check('an unnumbered equation gets no label',
      /\\begin\{equation\*\}/.test(eq.starred || '') && !/\\label/.test(eq.starred || ''),
      (eq.starred || '').replace(/\n\s*/g, ' ').slice(-60));

    const macro = await cdp.evaluate(`(async () => {
      const app = window.__reveryTexApp;
      const view = window.__reveryTexTest.view();
      const settle = () => new Promise(r => setTimeout(r, 400));
      const open = () => {
        document.getElementById('toolbox').click();
        [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
          .find(b => /^insert equation/i.test(b.textContent.trim())).click();
        return document.querySelector('.dlg');
      };
      const typeBody = (panel, v) => {
        const i = [...panel.querySelectorAll('.dlg-row')]
          .find(r => /equation/i.test(r.querySelector('.dlg-label').textContent))
          .querySelector('input');
        i.value = v; i.dispatchEvent(new Event('input', { bubbles: true }));
      };

      let panel = open();
      typeBody(panel, '\\\\myvec{x}');
      await settle();
      // KaTeX 0.18 does not mark an *undefined command* with .katex-error —
      // that class is for a parse failure of the whole expression. What it does
      // is render the command name in the configured errorColor, so that is
      // what "this macro is unknown" actually looks like in the DOM.
      const errorsBefore =
        panel.querySelector('.dlg-preview').innerHTML.includes('var(--err)') ? 1 : 0;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      // Teach the document the macro, then ask again.
      app.setBuffer('main.tex',
        view.state.doc.toString() + '\\n\\\\newcommand{\\\\myvec}[1]{\\\\mathbf{#1}}\\n');
      panel = open();
      typeBody(panel, '\\\\myvec{x}');
      await settle();
      const html = panel.querySelector('.dlg-preview').innerHTML;
      const errorsAfter = html.includes('var(--err)') ? 1 : 0;
      const bold = html.includes('mathvariant="bold"');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { errorsBefore, errorsAfter, bold, rendered: html.includes('katex') };
    })()`, true);

    // The mitigation for KaTeX not seeing the preamble: it is handed the
    // document's own \newcommand definitions. Without them a preview is wrong
    // in exactly the documents that define their own notation.
    check('an unknown macro is shown in the error colour, not silently dropped',
      macro.errorsBefore > 0);
    check('the document’s own macros are fed to the preview',
      macro.errorsAfter === 0 && macro.bold && macro.rendered,
      `error colour ${macro.errorsBefore} → ${macro.errorsAfter}, bold ${macro.bold}`);

    const refEq = await cdp.evaluate(`(async () => {
      const view = window.__reveryTexTest.view();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      document.getElementById('toolbox').click();
      [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /reference an equation/i.test(b.textContent)).click();
      const panel = document.querySelector('.dlg.picker');
      if (!panel) return { opened: false };
      await new Promise(r => setTimeout(r, 500));
      const cards = [...panel.querySelectorAll('.picker-card')];
      const withMath = cards.filter(c => c.querySelector('.picker-thumb .katex')).length;

      // The fit option bakes a scale into the .katex span, measured against the
      // card as it was. Grow the card and that number has to be recomputed, or
      // the equation stays small in a big box — which is the whole reason for
      // asking for a bigger box.
      const sizeBtns = [...panel.querySelectorAll('.picker-size button')];
      // An equation that actually needed shrinking: one already scaled below 1
      // has somewhere to grow to.
      const scaleOf = (el) => {
        const m = /scale\\(([\\d.]+)\\)/.exec(el?.style.transform || '');
        return m ? Number(m[1]) : 1;
      };
      const shrunk = cards.map(c => c.querySelector('.picker-thumb .katex'))
        .find(el => el && scaleOf(el) < 1);
      const before = scaleOf(shrunk);
      for (let i = 0; i < 3; i++) sizeBtns[1].click();
      await new Promise(r => setTimeout(r, 120));
      const after = scaleOf(shrunk);
      for (let i = 0; i < 3; i++) sizeBtns[0].click();

      cards[0]?.click();
      return {
        opened: true, count: cards.length, withMath,
        refit: { hadOne: !!shrunk, before, after },
        labels: cards.slice(0, 3).map(c => c.querySelector('.picker-caption').textContent),
        tail: view.state.doc.toString().slice(-24)
      };
    })()`, true);

    check('equations can be referenced', refEq.opened && refEq.count > 0,
      `${refEq.count}: ${(refEq.labels || []).join(' | ')}`);
    check('their cards are rendered maths', refEq.withMath > 0,
      `${refEq.withMath} of ${refEq.count} rendered`);
    // Without the re-fit hook this passes at the old scale forever: the card is
    // bigger and the equation inside it is exactly as small as before.
    check('growing a card re-fits the maths inside it',
      refEq.refit?.hadOne && refEq.refit.after > refEq.refit.before,
      `scale ${refEq.refit?.before} → ${refEq.refit?.after}`);
    // This document loads cleveref (main.tex, after hyperref), so \cref wins:
    // it numbers as \eqref does and supplies the "eq." the author would type.
    check('picking one inserts a \\cref on a cleveref document',
      /\\[cC]ref\{[^}]+\}$/.test(refEq.tail || ''), refEq.tail);

    // With the setting off, the same row must fall back to the command the
    // preamble actually justifies — \eqref here, because amsmath is loaded, and
    // \ref in a document without it. This is the gate that stops the menu
    // emitting a command the document cannot compile.
    const refEqPlain = await cdp.evaluate(`(async () => {
      const s = await import('./jvscrpt_and_css_extra/settings.js');
      s.set('crefReferences', false);
      const view = window.__reveryTexTest.view();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      document.getElementById('toolbox').click();
      [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /reference an equation/i.test(b.textContent)).click();
      await new Promise(r => setTimeout(r, 500));
      document.querySelector('.dlg.picker .picker-card')?.click();
      await new Promise(r => setTimeout(r, 100));
      s.set('crefReferences', true);
      return view.state.doc.toString().slice(-24);
    })()`, true);
    check('turning the setting off restores \\eqref',
      /\\eqref\{[^}]+\}$/.test(refEqPlain || ''), refEqPlain);

    /* ── the file tree, and changing it ─────────────────────────────── */
    // On the fixtures, which are read-only: the operations run in memory, and
    // that is the path every backend shares. Writing to disk is covered by the
    // Rust and Electron unit tests, which is where the containment rules live.
    const tree = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('#filetree .node')];
      const dirs = rows.filter(r => r.dataset.dir !== undefined);
      const files = rows.filter(r => r.dataset.path);
      const indents = new Set(rows.map(r => r.style.paddingLeft));
      const before = files.length;
      // Fold a directory: its files must go, the directory must stay.
      dirs[0]?.click();
      const folded = [...document.querySelectorAll('#filetree .node')];
      dirs[0].click();
      return {
        dirs: dirs.length, files: before, indents: indents.size,
        binaries: files.filter(f => f.classList.contains('binary')).length,
        foldedRows: folded.length, unfoldedRows: rows.length,
        firstDir: dirs[0]?.dataset.dir,
        stillThere: folded.some(r => r.dataset.dir === dirs[0]?.dataset.dir)
      };
    })()`, true);
    check('directories and files are separate rows', tree.dirs > 0 && tree.files > 0,
      `${tree.dirs} dir(s), ${tree.files} file(s)`);
    check('nesting is visible as indentation', tree.indents > 1, `${tree.indents} distinct indents`);
    // Hidden binaries were how a project's images became invisible in the one
    // place anyone would look for them.
    check('binary files are listed', tree.binaries > 0, `${tree.binaries} binaries`);
    check('a directory folds and stays visible',
      tree.foldedRows < tree.unfoldedRows && tree.stillThere,
      `${tree.unfoldedRows} → ${tree.foldedRows} rows, ${tree.firstDir} kept`);

    // The tree and the outline were divs with an onclick: the two panes this
    // app is navigated with could not be reached without a mouse, while every
    // menu and dialog could.
    const rowKeys = await cdp.evaluate(`(async () => {
      // A text file: .binary rows open a preview rather than a buffer, so they
      // would not put their path in #editortitle by way of the editor.
      const row = document.querySelector('#filetree .node[data-path]:not(.binary)');
      // This is the assertion that matters: a div without a tabindex cannot
      // become activeElement, so .focus() landing here is what proves the row
      // is reachable by keyboard at all. A synthetic KeyboardEvent would not
      // prove it — dispatchEvent never triggers a button's default action.
      row.focus();
      const focused = document.activeElement === row;
      const tag = row.tagName;
      row.click();
      await new Promise(r => setTimeout(r, 60));
      const opened = document.getElementById('editortitle').textContent === row.dataset.path;

      const dir = document.querySelector('#filetree .node[data-dir]');
      const expanded = dir && dir.getAttribute('aria-expanded');

      // A binary row is an ordinary row now: focusable, clickable, and it shows
      // the file in the editor's place. It carried aria-disabled — never the
      // disabled property, which gets no mouse events and would have taken
      // right-click Rename away from it — for as long as clicking one did
      // nothing at all. Announcing a working row as unavailable is the thing
      // being guarded against here.
      const binary = document.querySelector('#filetree .node.binary');
      const binaryFocusable = !!binary && !binary.disabled
        && !binary.hasAttribute('aria-disabled');

      binary.focus();
      const binaryTakesFocus = document.activeElement === binary;
      binary.click();
      await new Promise(r => setTimeout(r, 120));
      const media = document.getElementById('mediaview');
      const binaryPreviewed = document.getElementById('editortitle').textContent === binary.dataset.path
        && !media.hidden
        && document.getElementById('editor').hidden
        && media.childElementCount > 0
        && binary.classList.contains('active');

      // Back to a text file: the editor must come back, and it must be measured
      // rather than left at the zero height a display:none element reports.
      row.click();
      await new Promise(r => setTimeout(r, 120));
      const cm = document.querySelector('#editor .cm-scroller');
      const editorReturned = media.hidden
        && !document.getElementById('editor').hidden
        && media.childElementCount === 0
        && !!cm && cm.clientHeight > 0;

      const sec = document.querySelector('#outline .node.sec');
      return {
        tag, focused, opened, expanded, binaryFocusable,
        binaryTakesFocus, binaryPreviewed, editorReturned,
        outlineTag: sec ? sec.tagName : null,
        // A half-claimed ARIA tree owes the reader arrow keys and a roving
        // tabindex; this is a group of buttons and should say so.
        claimsTree: !!document.querySelector('[role="tree"], [role="treeitem"]')
      };
    })()`, true);
    check('file rows are focusable buttons',
      rowKeys.tag === 'BUTTON' && rowKeys.focused, rowKeys.tag);
    check('a focused row opens its file', rowKeys.opened);
    check('directory rows report their fold state',
      rowKeys.expanded === 'true' || rowKeys.expanded === 'false', String(rowKeys.expanded));
    check('binary rows are focusable and not announced as unavailable',
      rowKeys.binaryFocusable && rowKeys.binaryTakesFocus);
    // The whole point of the change: a figure used to be a dead row.
    check('clicking a binary previews it in the editor pane', rowKeys.binaryPreviewed);
    check('opening a text file brings the measured editor back', rowKeys.editorReturned);
    check('outline headings are focusable buttons too',
      rowKeys.outlineTag === 'BUTTON', rowKeys.outlineTag);
    check('no ARIA tree pattern is claimed without arrow keys', !rowKeys.claimsTree);

    const made = await cdp.evaluate(`(async () => {
      const rows = () => [...document.querySelectorAll('#filetree .node')];
      const open = (label) => {
        document.getElementById('newfile').click();
        [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
          .find(b => new RegExp(label, 'i').test(b.textContent)).click();
      };
      const type = (v) => {
        const i = document.querySelector('.dlg input[type="text"]');
        i.value = v; i.dispatchEvent(new Event('input', { bubbles: true }));
        [...document.querySelectorAll('.dlg-foot button')]
          .find(b => !/cancel/i.test(b.textContent)).click();
      };

      open('new file');
      type('notes/draft.tex');
      await new Promise(r => setTimeout(r, 60));
      const created = rows().some(r => r.dataset.path === 'notes/draft.tex');
      const opened = document.getElementById('editortitle').textContent;
      const nested = rows().some(r => r.dataset.dir === 'notes');

      // The same name twice must be refused, not silently overwrite.
      open('new file');
      type('notes/draft.tex');
      await new Promise(r => setTimeout(r, 60));
      const refused = document.getElementById('status').textContent;

      // …and so must anything that would climb out of the project.
      open('new file');
      type('../escape.tex');
      await new Promise(r => setTimeout(r, 60));
      return { created, opened, nested, refused,
               escape: document.getElementById('status').textContent,
               count: rows().filter(r => r.dataset.path === 'notes/draft.tex').length };
    })()`, true);
    check('a new file appears, nested under a folder that did not exist',
      made.created && made.nested && made.opened === 'notes/draft.tex',
      `${made.opened}${made.nested ? ' under notes/' : ''}`);
    check('a duplicate name is refused', /already exists/i.test(made.refused) && made.count === 1,
      made.refused);
    check('a path that climbs out of the project is refused',
      /not a usable/i.test(made.escape), made.escape);

    // Markdown is text, and it is not TeX. Both halves matter: it has to open
    // and edit like any source file, and it must not be handed the LaTeX layer
    // — stex colours prose as if every word were a command, and the completion
    // list opens on the way through.
    const md = await cdp.evaluate(`(async () => {
      const app = window.__reveryTexApp, T = window.__reveryTexTest;
      const open = (label) => {
        document.getElementById('newfile').click();
        [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
          .find(b => new RegExp(label, 'i').test(b.textContent)).click();
      };
      const type = (v) => {
        const i = document.querySelector('.dlg input[type="text"]');
        i.value = v; i.dispatchEvent(new Event('input', { bubbles: true }));
        [...document.querySelectorAll('.dlg-foot button')]
          .find(b => !/cancel/i.test(b.textContent)).click();
      };
      const spans = () => document.querySelector('#editor .cm-line').childElementCount;

      open('new file');
      type('notes/prose.md');
      await new Promise(r => setTimeout(r, 80));
      const opened = document.getElementById('editortitle').textContent === 'notes/prose.md';

      // The same text in both files. In a .tex it is a command and gets marked
      // up; in the .md it is one run of plain text and gets nothing.
      const SRC = '\\\\section{Hi} and \\\\emph{there}';
      app.setBuffer('notes/prose.md', SRC);
      await new Promise(r => setTimeout(r, 80));
      const mdSpans = spans();

      // Typed for real, through a transaction, so the buffer goes dirty the way
      // an edit does rather than the way setBuffer does.
      const v = T.view();
      v.dispatch({ changes: { from: v.state.doc.length, insert: '\\ntyped' } });
      await new Promise(r => setTimeout(r, 80));
      const dirtyAfterTyping = /modified/.test(document.getElementById('dirty').textContent);
      const kept = v.state.doc.toString().endsWith('typed');

      // …and the same text in a .tex, for the comparison to mean anything.
      open('new file');
      type('notes/compare.tex');
      await new Promise(r => setTimeout(r, 80));
      app.setBuffer('notes/compare.tex', SRC);
      await new Promise(r => setTimeout(r, 80));
      const texSpans = spans();

      // Put the editor back where the next block expects to find it. It renames
      // notes/draft.tex and asserts the title follows, which says nothing at
      // all if the title was never on that file to begin with.
      [...document.querySelectorAll('#filetree .node')]
        .find(r => r.dataset.path === 'notes/draft.tex').click();
      await new Promise(r => setTimeout(r, 80));

      return { opened, mdSpans, texSpans, dirtyAfterTyping, kept,
               restored: document.getElementById('editortitle').textContent };
    })()`, true);
    check('a markdown file opens in the editor', md.opened);
    check('markdown edits go dirty like any other source file',
      md.dirtyAfterTyping && md.kept);
    check('a .tex is marked up by the LaTeX layer', md.texSpans > 0,
      `${md.texSpans} spans`);
    // The bundle carries no markdown mode — see build_tools/cm_entry_tex.js —
    // so plain is the honest answer, not stex over prose.
    check('markdown is left as plain text', md.mdSpans === 0,
      `${md.mdSpans} spans vs ${md.texSpans} in the .tex`);
    check('the editor is back on notes/draft.tex for the rename below',
      md.restored === 'notes/draft.tex', md.restored);

    const renamed = await cdp.evaluate(`(async () => {
      const row = [...document.querySelectorAll('#filetree .node')]
        .find(r => r.dataset.path === 'notes/draft.tex');
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu',
        { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }));
      const labels = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .map(b => b.textContent.trim());
      [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /rename/i.test(b.textContent)).click();
      const i = document.querySelector('.dlg input[type="text"]');
      const prefilled = i.value;
      i.value = 'notes/renamed.tex'; i.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('.dlg-foot button')]
        .find(b => !/cancel/i.test(b.textContent)).click();
      await new Promise(res => setTimeout(res, 80));
      const paths = [...document.querySelectorAll('#filetree .node')].map(n => n.dataset.path);
      return { labels, prefilled, gone: !paths.includes('notes/draft.tex'),
               there: paths.includes('notes/renamed.tex'),
               title: document.getElementById('editortitle').textContent };
    })()`, true);
    check('right-clicking a file offers rename and delete',
      ['Rename…', 'Delete…'].every(l => renamed.labels.includes(l)), renamed.labels.join(' | '));
    check('rename moves the file and the editor follows it',
      renamed.gone && renamed.there && renamed.title === 'notes/renamed.tex',
      `${renamed.prefilled} → ${renamed.title}`);

    const mainGuard = await cdp.evaluate(`(async () => {
      const main = [...document.querySelectorAll('#filetree .node')]
        .find(r => r.classList.contains('main'));
      const r = main.getBoundingClientRect();
      main.dispatchEvent(new MouseEvent('contextmenu',
        { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }));
      [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /delete/i.test(b.textContent)).click();
      await new Promise(res => setTimeout(res, 80));
      return { status: document.getElementById('status').textContent,
               survived: [...document.querySelectorAll('#filetree .node')]
                 .some(n => n.classList.contains('main')) };
    })()`, true);
    // The compile targets the main file by name, so losing it breaks the
    // project in a way nothing in the UI would explain. The refusal now points
    // at the document selector rather than telling people to leave the app,
    // because re-pointing main is what makes this file ordinary again.
    check('the main file cannot be deleted',
      /main document/i.test(mainGuard.status) && mainGuard.survived,
      mainGuard.status);

    const deleted = await cdp.evaluate(`(async () => {
      const row = [...document.querySelectorAll('#filetree .node')]
        .find(r => r.dataset.path === 'notes/renamed.tex');
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu',
        { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }));
      [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /delete/i.test(b.textContent)).click();
      await new Promise(res => setTimeout(res, 120));
      return { paths: [...document.querySelectorAll('#filetree .node')].map(n => n.dataset.path),
               status: document.getElementById('status').textContent };
    })()`, true);
    // The harness answers confirm() with OK, so this is the confirmed path.
    check('delete removes the file', !deleted.paths.includes('notes/renamed.tex'), deleted.status);

    /* ── selecting more than one row ────────────────────────────────── */
    // The gesture this exists for: several files arrive at once and want
    // sorting into folders, which before meant dragging them one at a time.
    const multi = await cdp.evaluate(`(async () => {
      const rows = () => [...document.querySelectorAll('#filetree .node')];
      const rowFor = (p) => rows().find(r => r.dataset.path === p);
      const click = (el, mods = {}) =>
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...mods }));
      const picked = () => rows().filter(r => r.classList.contains('selected'))
                                 .map(r => r.dataset.path ?? r.dataset.dir);

      // Not the main file, and not a binary: a binary row is selectable but
      // never opens, so it cannot answer the "plain click still opens" check.
      const files = rows().filter(r => r.dataset.path && !r.classList.contains('main')
                                       && !r.classList.contains('binary'))
                          .map(r => r.dataset.path);
      const [a, b] = files;
      const titleBefore = document.getElementById('editortitle').textContent;

      // Ctrl+click selects without opening — the whole point of the modifier.
      click(rowFor(a), { ctrlKey: true });
      click(rowFor(b), { ctrlKey: true });
      const two = picked();
      const stillClosed = document.getElementById('editortitle').textContent === titleBefore;
      const counted = document.getElementById('filecount').textContent;

      // Ctrl+click again takes one back out.
      click(rowFor(b), { ctrlKey: true });
      const afterToggleOff = picked();

      // A plain click drops the selection and opens, exactly as it always did.
      click(rowFor(a));
      const afterPlain = picked();
      const opened = document.getElementById('editortitle').textContent;

      return { two, stillClosed, counted, afterToggleOff, afterPlain, opened, a, b };
    })()`, true);
    check('ctrl+click selects rows without opening them',
      multi.two.length === 2 && multi.stillClosed,
      `${multi.two.join(', ')}${multi.stillClosed ? '' : ' — but the editor moved'}`);
    check('the panel head says how many are selected',
      /2 of \d+ selected/.test(multi.counted), multi.counted);
    check('ctrl+click again deselects', multi.afterToggleOff.length === 1,
      multi.afterToggleOff.join(', '));
    // The guarantee the rest of the tree's behaviour rests on: with no
    // modifier held, nothing about the old single-selection behaviour moved.
    check('a plain click still clears the selection and opens the file',
      multi.afterPlain.length === 0 && multi.opened === multi.a,
      `${multi.opened} · ${multi.afterPlain.length} left selected`);

    const ranged = await cdp.evaluate(`(async () => {
      const rows = () => [...document.querySelectorAll('#filetree .node')];
      const click = (el, mods = {}) =>
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...mods }));
      const visible = rows().map(r => r.dataset.path ?? r.dataset.dir);
      // Anchor on the first row, extend to the fourth: four rows inclusive.
      click(rows()[0], { ctrlKey: true });
      click(rows()[3], { shiftKey: true });
      const got = rows().filter(r => r.classList.contains('selected'))
                        .map(r => r.dataset.path ?? r.dataset.dir);
      return { got, want: visible.slice(0, 4) };
    })()`, true);
    check('shift+click takes the range between the two rows',
      ranged.got.join('|') === ranged.want.join('|'),
      `${ranged.got.join(', ')} vs ${ranged.want.join(', ')}`);

    const bulk = await cdp.evaluate(`(async () => {
      const rows = () => [...document.querySelectorAll('#filetree .node')];
      const rowFor = (p) => rows().find(r => r.dataset.path === p);
      const click = (el, mods = {}) =>
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...mods }));

      // Files and a destination of our own, so nothing here depends on which
      // folders the fixture happens to ship.
      const make = (what, name) => {
        document.getElementById('newfile').click();
        [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
          .find(b => new RegExp('new ' + what, 'i').test(b.textContent)).click();
        const i = document.querySelector('.dlg input[type="text"]');
        i.value = name; i.dispatchEvent(new Event('input', { bubbles: true }));
        [...document.querySelectorAll('.dlg-foot button')]
          .find(b => !/cancel/i.test(b.textContent)).click();
      };
      make('file', 'sortme/one.tex');
      await new Promise(r => setTimeout(r, 60));
      make('file', 'sortme/two.tex');
      await new Promise(r => setTimeout(r, 60));
      make('folder', 'dest');
      await new Promise(r => setTimeout(r, 60));

      // A plain click first: the range test above left rows selected, and this
      // block is about a selection of exactly two.
      click(rows().find(r => r.classList.contains('main')));
      click(rowFor('sortme/one.tex'), { ctrlKey: true });
      click(rowFor('sortme/two.tex'), { ctrlKey: true });

      const r = rowFor('sortme/two.tex').getBoundingClientRect();
      rowFor('sortme/two.tex').dispatchEvent(new MouseEvent('contextmenu',
        { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }));
      const labels = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .map(b => b.textContent.trim());
      return { labels };
    })()`, true);
    check('right-clicking a multi-selection offers to move and delete all of it',
      bulk.labels.some(l => /Move 2 items to/.test(l))
        && bulk.labels.some(l => /Delete 2 items/.test(l)),
      bulk.labels.join(' | '));
    // Rename is about one path, so it is the one row that goes away.
    check('and does not offer to rename two things at once',
      !bulk.labels.some(l => /Rename/.test(l)), bulk.labels.join(' | '));

    // Opened with a synthetic click and *chosen* with a real one, the same way
    // the theme and table-reference submenus are driven above: el.click() fires
    // no mousedown, so it cannot dismiss the parent menu the panel belongs to,
    // and realClick on the trigger would toggle the panel back shut after its
    // own mouseMoved had already opened it on hover.
    const destinations = await cdp.evaluate(`(() => {
      const t = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /Move 2 items to/.test(b.textContent));
      if (!t) return null;
      t.click();
      const panel = document.querySelector('.submenu:not([hidden])');
      return panel ? [...panel.querySelectorAll('.menu-item')].map(b => b.textContent.trim()) : null;
    })()`, true);
    check('the move submenu lists the folders it could go to',
      !!destinations && destinations.includes('dest/')
        && destinations.includes('⌐ project root'),
      (destinations || []).join(' | '));
    await realClick(cdp, `[...document.querySelectorAll('.submenu:not([hidden]) .menu-item')]
      .find(b => b.textContent.trim() === 'dest/')`);
    const movedBoth = await cdp.evaluate(`(async () => {
      await new Promise(r => setTimeout(r, 150));
      const paths = [...document.querySelectorAll('#filetree .node')].map(n => n.dataset.path);
      return { paths, status: document.getElementById('status').textContent };
    })()`, true);
    check('the move-to-folder submenu relocates the whole selection',
      movedBoth.paths.includes('dest/one.tex') && movedBoth.paths.includes('dest/two.tex')
        && !movedBoth.paths.includes('sortme/one.tex'),
      movedBoth.status);

    const guarded = await cdp.evaluate(`(async () => {
      const rows = () => [...document.querySelectorAll('#filetree .node')];
      const click = (el, mods = {}) =>
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...mods }));
      // Re-queried before every use: each of these clicks re-renders the tree,
      // which replaces every row, and a reference held across one is detached —
      // its handlers still fire but it is no longer inside #filetree, so a
      // contextmenu dispatched on it never reaches the panel's listener.
      const mainRow = () => rows().find(r => r.classList.contains('main'));
      click(mainRow());                  // clear what the move above left selected
      click(rows().find(r => r.dataset.path === 'dest/one.tex'), { ctrlKey: true });
      click(mainRow(), { ctrlKey: true });
      const target = mainRow();
      const r = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('contextmenu',
        { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }));
      [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /Delete 2 items/.test(b.textContent))?.click();
      await new Promise(res => setTimeout(res, 120));
      return { status: document.getElementById('status').textContent,
               survived: [...document.querySelectorAll('#filetree .node')]
                 .map(n => n.dataset.path) };
    })()`, true);
    // Refused whole, not partly applied: the batch is checked before anything
    // moves, so the file that could have gone is still there too.
    check('a batch containing the main document is refused entirely',
      /main document/i.test(guarded.status)
        && guarded.survived.includes('dest/one.tex'),
      guarded.status);

    /* ── drag and drop in the tree ──────────────────────────────────── */
    // Real drag gestures cannot be synthesised over CDP without the OS drag
    // loop, so these dispatch the DragEvents the handlers actually listen for,
    // carrying a real DataTransfer. That exercises every line except the
    // browser's own drag rendering.
    const dnd = await cdp.evaluate(`(async () => {
      const rows = () => [...document.querySelectorAll('#filetree .node')];
      const paths = () => rows().filter(r => r.dataset.path).map(r => r.dataset.path);
      const rowFor = (p) => rows().find(r => r.dataset.path === p);
      const dirRow = (d) => rows().find(r => r.dataset.dir === d);

      const drag = (fromEl, toEl) => {
        const dt = new DataTransfer();
        fromEl.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        toEl.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        toEl.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        fromEl.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      };

      const mainPath = document.querySelector('#filetree .node.main')?.dataset.path;

      // 1. file → folder. Deliberately a file at the *root* and a folder that
      //    is not already its parent, or the move is correctly a no-op and the
      //    test would be measuring its own setup.
      const folder = rows().find(r => r.dataset.dir && !r.dataset.dir.includes('/'));
      const folderPath = folder ? folder.dataset.dir : null;
      const mover = rows().find(r => r.dataset.path
        && !r.dataset.path.includes('/')       // at the root
        && r.dataset.path !== mainPath);       // not the main file
      const movedFrom = mover ? mover.dataset.path : null;

      let landed = null;
      if (folder && mover) {
        drag(mover, folder);
        await new Promise(r => setTimeout(r, 80));
        // An earlier test folded this directory and the fold is persisted, so
        // the row that just arrived inside it is not rendered. Open it before
        // looking, or this measures the fold rather than the move.
        const reFolder = rows().find(r => r.dataset.dir === folderPath);
        if (reFolder && reFolder.classList.contains('folded')) {
          reFolder.click();
          await new Promise(r => setTimeout(r, 80));
        }
        landed = paths().find(p => p === folderPath + '/' + movedFrom);
      }

      // 2. the main file must not even offer to be dragged
      const mainRow = document.querySelector('#filetree .node.main');
      const mainDraggable = mainRow ? mainRow.draggable : null;

      // 3. a folder cannot be dropped into itself. Asserted on the tree, not on
      //    the status line — the refusal is silent by design (dragover never
      //    accepts, so drop never fires) and the status line still holds
      //    whatever the previous test left there.
      const selfDir = rows().find(r => r.dataset.dir);
      const beforeSelf = paths().join('|');
      if (selfDir) {
        drag(selfDir, selfDir);
        await new Promise(r => setTimeout(r, 60));
      }
      const selfUnchanged = paths().join('|') === beforeSelf;

      // 4. a file dropped on the window must not navigate away
      const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
      document.getElementById('editor').dispatchEvent(ev);
      const windowDropPrevented = ev.defaultPrevented;

      const now = paths();
      return {
        movedFrom, folderPath, landed,
        // Row counts are not the invariant here — folding changes them. These
        // are: the file is at its new path exactly once, and gone from the old.
        copiesAtNewPath: now.filter(p => p === folderPath + '/' + movedFrom).length,
        stillAtOldPath: now.includes(movedFrom),
        mainDraggable, selfUnchanged, windowDropPrevented,
        rowsAreDraggable: rows().filter(r => r.draggable).length
      };
    })()`, true);
    check('tree rows are draggable', dnd.rowsAreDraggable > 0, `${dnd.rowsAreDraggable} draggable rows`);
    check('dragging a file onto a folder moves it',
      !!dnd.landed, `${dnd.movedFrom} → ${dnd.landed || 'did not move'}`);
    check('the file is moved, not copied',
      dnd.copiesAtNewPath === 1 && !dnd.stillAtOldPath,
      `${dnd.copiesAtNewPath} at the new path, ${dnd.stillAtOldPath ? 'still' : 'gone'} from the old`);
    check('the main file cannot be dragged', dnd.mainDraggable === false, String(dnd.mainDraggable));
    check('a folder refuses to be dropped into itself', dnd.selfUnchanged);
    // Without a handler the browser navigates to the dropped file and the app
    // is simply gone, unsaved work with it.
    check('a file dropped outside the tree does not navigate away', dnd.windowDropPrevented);

    // The highlight must belong to a drag that is actually happening. It did
    // not: a row's drop calls stopPropagation, so the container's drop — the
    // only thing clearing the panel outline — never ran after a successful drop
    // onto a folder, and the panel stayed lit until a reload. A cancelled drag
    // left it the same way.
    const glow = await cdp.evaluate(`(async () => {
      const tree = document.getElementById('filetree');
      const rows = () => [...tree.querySelectorAll('.node')];
      const lit = () => ({
        rows: document.querySelectorAll('.node.dropinto').length,
        dragging: document.querySelectorAll('.node.dragging').length,
        panel: tree.classList.contains('droproot')
      });
      const ev = (el, t, dt) => el.dispatchEvent(
        new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
      const dir = () => rows().find(r => r.dataset.dir && !r.dataset.dir.includes('/'));
      // Any draggable file that is not already inside the folder it is about to
      // be dragged onto — dropping a file into its own parent is a no-op, and
      // the tree is right not to light up for it.
      //
      // This used to ask for a file at the top level, which the homework fixture
      // cannot supply by the time this runs: it has exactly two root files, and
      // the drag test above moves the one that is not the main file into
      // chapter/. What is under test here is whether the highlight clears, and
      // that does not care where the dragged file lives.
      const file = () => {
        const target = dir()?.dataset.dir;
        return rows().find(r => r.dataset.path && !r.classList.contains('main')
          && r.dataset.path.split('/')[0] !== target);
      };

      // Over the panel, then over a row: exactly one is ever lit.
      let dt = new DataTransfer();
      ev(file(), 'dragstart', dt);
      ev(tree, 'dragover', dt);
      const onPanel = lit();
      ev(dir(), 'dragover', dt);
      const onRow = lit();
      ev(dir(), 'drop', dt);
      await new Promise(r => setTimeout(r, 200));
      const afterDrop = lit();

      // A drag ended without a drop — Escape, or released over nothing.
      dt = new DataTransfer();
      const src = file();
      if (src) { ev(src, 'dragstart', dt); ev(tree, 'dragover', dt); ev(src, 'dragend', dt); }
      await new Promise(r => setTimeout(r, 80));
      const afterCancel = lit();

      return { onPanel, onRow, afterDrop, afterCancel };
    })()`, true);
    check('the panel lights up while a drag is over it',
      glow.onPanel.panel && glow.onPanel.rows === 0);
    check('a row and the panel are never lit at once',
      glow.onRow.rows === 1 && !glow.onRow.panel,
      `rows=${glow.onRow.rows} panel=${glow.onRow.panel}`);
    check('every highlight clears once the drop is done',
      !glow.afterDrop.panel && glow.afterDrop.rows === 0 && glow.afterDrop.dragging === 0,
      JSON.stringify(glow.afterDrop));
    check('and clears when a drag is cancelled instead',
      !glow.afterCancel.panel && glow.afterCancel.rows === 0 && glow.afterCancel.dragging === 0,
      JSON.stringify(glow.afterCancel));

    // Moving a file that something \include's breaks the reference, and LaTeX
    // only *warns* about a missing \include — so the document still compiles,
    // shorter, with nothing to say why. That is how the homework template
    // silently lost five pages.
    dialogs.length = 0;
    const inc = await cdp.evaluate(`(async () => {
      const tree = document.getElementById('filetree');
      const rows = () => [...tree.querySelectorAll('.node')];
      const ev = (el, t, dt) => el.dispatchEvent(
        new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
      const m = await import('./jvscrpt_and_css_extra/document_model.js');

      // A file the main document actually reads, found through the same index
      // the app warns from.
      const included = rows().find(r => r.dataset.path
        && /\\.tex$/.test(r.dataset.path)
        && !r.classList.contains('main'));
      if (!included) return { skipped: true };
      const dt = new DataTransfer();
      const dir = rows().find(r => r.dataset.dir
        && !r.dataset.dir.includes('/')
        && !included.dataset.path.startsWith(r.dataset.dir + '/'));
      if (!dir) return { skipped: true };
      ev(included, 'dragstart', dt);
      ev(dir, 'dragover', dt);
      ev(dir, 'drop', dt);
      await new Promise(r => setTimeout(r, 350));
      // The question is drawn by the app now, not by the browser, so it is read
      // from what the auto-answer above recorded rather than captured through
      // Page.javascriptDialogOpening.
      const text = window.__askLog[window.__askLog.length - 1] || null;
      return { skipped: false, moved: included.dataset.path, into: dir.dataset.dir, text };
    })()`, true);
    if (inc.skipped) {
      check('a move that breaks an \\include asks first', true, 'no suitable file in this fixture');
    } else {
      check('a move that breaks an \\include asks first',
        !!inc.text && /\\input\/\\include|will break/i.test(inc.text),
        inc.text ? inc.text.split('\n')[0] : 'no dialog was shown');
    }

    /* ── undo in the Files panel ────────────────────────────────────── */
    //
    // The stack mechanics are unit-tested (test/tree_history.test.js). What only
    // a browser can answer is whether the entries describe the *project*: that
    // an inverse puts a file back where it was rather than somewhere plausible,
    // that a delete leaves nothing to undo, and — the one that matters most —
    // that none of this took Ctrl+Z away from the editor.

    // A folder is the safest thing to undo: it exists only in `emptyDirs` and
    // never reaches the disk, so a failure here cannot cost anything.
    const folderUndo = await cdp.evaluate(`(async () => {
      const app = window.__reveryTexApp;
      const tree = document.getElementById('filetree');
      const drawn = (name) => [...tree.querySelectorAll('.node')]
        .some(r => r.dataset.dir === name);
      // Dispatched at whatever actually has focus, and nothing is focused here
      // on the test's behalf. Forcing focus onto a row first is what an earlier
      // version of this check did, and it hid the real defect completely: the
      // handler worked, and a user could not reach it, because dismissing the
      // menu removed the element focus was sitting on and dropped it to <body>.
      const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent(
        'keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true }));
      const inPanel = () =>
        document.getElementById('sidebar').contains(document.activeElement);
      const before = app.treeHistory();

      // Through the app's own path, not by poking emptyDirs: the question is
      // whether creating a folder records an entry, not whether a Set works.
      const name = '__undo_probe__';
      // The dialog is the only way in, so drive it as a person would. Same
      // selectors the "New file" checks above use.
      document.getElementById('newfile').click();
      const row = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /new folder/i.test(b.textContent));
      if (!row) return { skipped: 'no New folder row' };
      row.click();
      await new Promise(r => setTimeout(r, 80));
      const input = document.querySelector('.dlg input[type="text"]');
      if (!input) return { skipped: 'no dialog input' };
      input.value = name;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('.dlg-foot button')]
        .find(b => !/cancel/i.test(b.textContent)).click();
      await new Promise(r => setTimeout(r, 150));

      const created = { drawn: drawn(name), history: app.treeHistory(),
                        focused: inPanel(), at: document.activeElement.tagName };

      // Ctrl+Z with a tree row focused, exactly as a user would.
      key('z');
      await new Promise(r => setTimeout(r, 200));
      const undone = { drawn: drawn(name), history: app.treeHistory() };

      key('y');
      await new Promise(r => setTimeout(r, 200));
      const redone = { drawn: drawn(name), history: app.treeHistory() };

      // Leave the fixture as it was found.
      key('z');
      await new Promise(r => setTimeout(r, 200));
      return { before, created, undone, redone, cleaned: !drawn(name) };
    })()`, true);

    if (folderUndo.skipped) {
      check('a new folder can be undone', false, folderUndo.skipped);
    } else {
      // Relative to where the stack already stood: the checks above this one
      // have created and moved things of their own, and an absolute depth here
      // would only be asserting the order of this file.
      const base = folderUndo.before.depth;
      check('creating a folder records one undoable entry',
        folderUndo.created.drawn && folderUndo.created.history.depth === base + 1
          && /creating __undo_probe__/.test(folderUndo.created.history.undo || ''),
        JSON.stringify(folderUndo.created));
      // The one that matters: the shortcut is scoped to the panel, so if the
      // dialog left focus on <body> then Ctrl+Z is unreachable at exactly the
      // moment someone wants it, and says nothing when it declines.
      check('and leaves focus in the panel, so Ctrl+Z can be reached',
        folderUndo.created.focused,
        `focus was on ${folderUndo.created.at}`);
      check('Ctrl+Z in the panel removes it and makes it redoable',
        !folderUndo.undone.drawn && folderUndo.undone.history.depth === base
          && /creating __undo_probe__/.test(folderUndo.undone.history.redo || ''),
        JSON.stringify(folderUndo.undone));
      check('Ctrl+Y draws it again',
        folderUndo.redone.drawn && folderUndo.redone.history.depth === base + 1
          && folderUndo.redone.history.redoDepth === 0,
        JSON.stringify(folderUndo.redone));
      check('and the probe folder is gone again afterwards', folderUndo.cleaned);
    }

    // Undoing a *file* is the only thing here that deletes anything, so the
    // guard in front of it is the one worth proving: an empty file it made
    // itself goes, a file with anything in it does not.
    const fileUndo = await cdp.evaluate(`(async () => {
      const app = window.__reveryTexApp;
      const tree = document.getElementById('filetree');
      const has = (p) => [...tree.querySelectorAll('.node')].some(r => r.dataset.path === p);
      const key = (k) => {
        const row = tree.querySelector('.node');
        row.focus();
        row.dispatchEvent(new KeyboardEvent('keydown',
          { key: k, ctrlKey: true, bubbles: true, cancelable: true }));
      };
      const make = async (name) => {
        document.getElementById('newfile').click();
        [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
          .find(b => /new file/i.test(b.textContent)).click();
        await new Promise(r => setTimeout(r, 80));
        const i = document.querySelector('.dlg input[type="text"]');
        i.value = name;
        i.dispatchEvent(new Event('input', { bubbles: true }));
        [...document.querySelectorAll('.dlg-foot button')]
          .find(b => !/cancel/i.test(b.textContent)).click();
        await new Promise(r => setTimeout(r, 200));
      };

      // (a) made and left alone — undo should remove it.
      await make('__undo_empty__.tex');
      const madeEmpty = has('__undo_empty__.tex');
      key('z');
      await new Promise(r => setTimeout(r, 300));
      const emptyGone = !has('__undo_empty__.tex');

      // (b) made and then typed into — undo must refuse, and say so.
      await make('__undo_typed__.tex');
      app.setBuffer('__undo_typed__.tex', '\\\\section{work nobody wants deleted}');
      const armed = app.treeHistory();
      key('z');
      await new Promise(r => setTimeout(r, 300));
      const survived = has('__undo_typed__.tex');
      const status = document.getElementById('status').textContent;
      const after = app.treeHistory();
      return { madeEmpty, emptyGone, armed, survived, status, after };
    })()`, true);

    check('undo removes an empty file it created',
      fileUndo.madeEmpty && fileUndo.emptyGone,
      `made=${fileUndo.madeEmpty} gone=${fileUndo.emptyGone}`);
    check('undo refuses to delete a file that has been typed into',
      fileUndo.survived, `status: ${fileUndo.status}`);
    check('and clears the history rather than acting on a stale entry',
      fileUndo.armed.depth >= 1 && fileUndo.after.depth === 0
        && /changed since/.test(fileUndo.status),
      `${JSON.stringify(fileUndo.after)} — ${fileUndo.status}`);

    // A move is the operation people actually reach for Ctrl+Z after, and the
    // only one whose inverse touches the disk. The check is that the file is
    // back at the path it started from — not merely that something moved.
    dialogs.length = 0;
    const moveUndo = await cdp.evaluate(`(async () => {
      const app = window.__reveryTexApp;
      const tree = document.getElementById('filetree');
      const rows = () => [...tree.querySelectorAll('.node')];
      const ev = (el, t, dt) => el.dispatchEvent(
        new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
      const paths = () => rows().map(r => r.dataset.path).filter(Boolean);

      const before = paths();
      // Any non-main .tex sitting at the project root, and any folder to put it
      // in. Not hardcoded: the fixture this runs against is whatever loaded.
      const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
      const src = rows().find(r => r.dataset.path
        && /\\.tex$/.test(r.dataset.path)
        && !r.classList.contains('main'));
      if (!src) return { skipped: 'no movable .tex in this fixture' };
      const from = src.dataset.path;
      const base = from.split('/').pop();
      // Any folder that is not already holding it, and not inside it.
      const dir = rows().find(r => r.dataset.dir
        && r.dataset.dir !== dirOf(from)
        && !r.dataset.dir.startsWith(from + '/'));
      if (!dir) return { skipped: 'no other folder to move into' };
      const to = dir.dataset.dir + '/' + base;

      const dt = new DataTransfer();
      ev(src, 'dragstart', dt);
      ev(dir, 'dragover', dt);
      ev(dir, 'drop', dt);
      await new Promise(r => setTimeout(r, 300));
      const moved = { there: paths().includes(to), gone: !paths().includes(from),
                      history: app.treeHistory() };

      // Whatever a real drag left focused — no .focus() call here either. A
      // drag starts with a mousedown on the row, so focus should already be in
      // the panel; asserting it is part of the check.
      const focusedInPanel =
        document.getElementById('sidebar').contains(document.activeElement);
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 500));

      return {
        from, to, moved, focusedInPanel,
        back: paths().includes(from),
        cleared: !paths().includes(to),
        history: app.treeHistory(),
        // The strongest assertion available: the tree is exactly what it was.
        identical: JSON.stringify(paths().sort()) === JSON.stringify(before.sort())
      };
    })()`, true);

    if (moveUndo.skipped) {
      check('undo puts a moved file back', true, moveUndo.skipped);
    } else {
      check('a drag records one undoable move',
        moveUndo.moved.there && moveUndo.moved.gone && moveUndo.moved.history.depth >= 1,
        JSON.stringify(moveUndo.moved));
      check('a drag leaves focus in the panel too',
        moveUndo.focusedInPanel);
      check('undo puts a moved file back where it started',
        moveUndo.back && moveUndo.cleared,
        `${moveUndo.to} → ${moveUndo.from}: back=${moveUndo.back} cleared=${moveUndo.cleared}`);
      check('and leaves the tree exactly as it was',
        moveUndo.identical, JSON.stringify(moveUndo.history));
    }

    // The promise the delete dialog makes — "cannot be undone from inside the
    // app" — has to stay true. An entry recorded before the delete would let one
    // more Ctrl+Z step past it onto files that are no longer there.
    const afterDelete = await cdp.evaluate(`(async () => {
      const app = window.__reveryTexApp;
      const tree = document.getElementById('filetree');
      // Something undoable first, so an empty stack cannot pass this by default.
      document.getElementById('newfile').click();
      [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /new folder/i.test(b.textContent)).click();
      await new Promise(r => setTimeout(r, 80));
      const input = document.querySelector('.dlg input[type="text"]');
      if (!input) return { skipped: 'no dialog input' };
      input.value = '__barrier_probe__';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('.dlg-foot button')]
        .find(b => !/cancel/i.test(b.textContent)).click();
      await new Promise(r => setTimeout(r, 150));
      const armed = app.treeHistory().depth;

      // Delete that same folder. It holds nothing, so nothing is lost — but it
      // goes through deleteEntries, which is what arms the barrier.
      const target = [...tree.querySelectorAll('.node')]
        .find(r => r.dataset.dir === '__barrier_probe__');
      if (!target) return { skipped: 'probe folder not drawn' };
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 80));
      const del = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /^Delete/.test(b.textContent.trim()));
      if (!del) return { skipped: 'no Delete row' };
      del.click();
      await new Promise(r => setTimeout(r, 500));   // asked and auto-answered
      return { armed, after: app.treeHistory() };
    })()`, true);

    if (afterDelete.skipped) {
      check('a delete leaves nothing to undo', false, afterDelete.skipped);
    } else {
      check('a delete leaves nothing to undo or redo',
        afterDelete.armed >= 1 && afterDelete.after.depth === 0
          && afterDelete.after.redoDepth === 0,
        `armed=${afterDelete.armed} after=${JSON.stringify(afterDelete.after)}`);
    }

    // The regression that matters most. CodeMirror binds Ctrl+Z at Prec.high,
    // and a global handler that fired regardless of focus would take the
    // editor's own undo away — silently, since both are called "undo".
    const editorUndo = await cdp.evaluate(`(async () => {
      const t = window.__reveryTexTest;
      const app = window.__reveryTexApp;
      const view = t.view();
      const before = view.state.doc.toString();
      view.dispatch({ changes: { from: 0, insert: '% undo probe\\n' } });
      const typed = view.state.doc.toString();

      const treeBefore = JSON.stringify(app.treeHistory());
      view.contentDOM.focus();
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 200));

      return {
        inserted: typed !== before,
        // The editor's own history is what should have answered.
        restored: view.state.doc.toString() === before,
        treeUntouched: JSON.stringify(app.treeHistory()) === treeBefore
      };
    })()`, true);
    check('Ctrl+Z in the editor still undoes text, not the file tree',
      editorUndo.inserted && editorUndo.restored && editorUndo.treeUntouched,
      JSON.stringify(editorUndo));

    /* ── completion and snippets ────────────────────────────────────── */
    // The source itself is driven through __reveryTexTest.completeAt, which
    // runs it over a synthetic document: what the dropdown *would* show, with
    // no popup timing to race. Only the key handling needs real keystrokes,
    // because the whole question there is which of the three claimants on Tab
    // wins — and that is decided by extension precedence, which no unit test
    // can see.
    await cdp.evaluate('window.__reveryTexApp.compile("book")', true);

    const complete = (doc) =>
      cdp.evaluate(`window.__reveryTexTest.completeAt(${JSON.stringify(doc)})`, true);
    const suppressed = (doc) =>
      cdp.evaluate(`window.__reveryTexTest.suppressedAt(${JSON.stringify(doc)})`, true);

    const refs = await complete('\\ref{');
    check('\\ref{ offers the project\'s own labels', !!refs && refs.options.length > 0,
      refs ? `${refs.options.length} labels` : 'nothing offered');
    // A bare key is the thing that sends people back to the PDF to check which
    // equation `eq:3` was; the context is the feature, not decoration.
    check('every label says what it labels',
      !!refs && refs.options.every(o => o.detail) &&
      refs.options.some(o => o.detail !== 'label'),
      refs?.options[0] ? `${refs.options[0].label} → ${refs.options[0].detail}` : '');

    const eqrefs = await complete('\\eqref{');
    check('\\eqref floats equations to the top',
      !!eqrefs && eqrefs.options.some(o => /^equation/.test(o.detail || '')),
      eqrefs?.options.find(o => /^equation/.test(o.detail || ''))?.label);

    const cites = await complete('\\cite{');
    check('\\cite{ offers keys with their author and year',
      !!cites && cites.options.length > 0 && cites.options.some(o => o.detail !== 'citation'),
      cites?.options[0] ? `${cites.options[0].label} → ${cites.options[0].detail}` : '');
    // \cite takes a list. Anchoring at the brace — as this used to — means the
    // second key you type replaces every key already there.
    const cite2 = await complete('\\cite{foo,ba');
    check('a second citation key replaces only itself',
      cite2?.replacing === 'ba', `would replace ${JSON.stringify(cite2?.replacing)}`);

    const frac = await complete('\\fra');
    check('a command completes to a template, not bare text',
      !!frac && frac.options.some(o => o.label === '\\frac' && o.snippet));
    const beginFig = await complete('\\begin{fig');
    check('\\begin{ offers environments as templates',
      !!beginFig && beginFig.options.some(o => o.label === 'figure' && o.snippet));
    check('\\end{ offers names only — a template there would write a second \\end',
      (await complete('\\end{fig'))?.options.every(o => !o.snippet));

    check('completion keeps quiet in a comment', (await complete('% see \\se')) === null);
    check('completion keeps quiet inside verbatim',
      await suppressed('\\begin{verbatim}\n\\se'));
    check('and speaks again once the verbatim ends',
      !(await suppressed('\\begin{verbatim}\nx\n\\end{verbatim}\n\\se')));
    check('an escaped percent is not a comment', !(await suppressed('100\\% of \\se')));

    // ── the keys ──
    const KEY = {
      Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, text: '\t' },
      Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' }
    };
    const press = async (name) => {
      const k = KEY[name];
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
      await cdp.send('Input.dispatchKeyEvent', { type: 'char', ...k });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
      await sleep(140);
    };
    const typeText = async (s) => {
      for (const ch of s) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      }
      await sleep(280);
    };
    const setDoc = async (text) => {
      await cdp.evaluate(`(() => {
        const v = window.__reveryTexTest.view();
        const t = ${JSON.stringify(text)};
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t },
                     selection: { anchor: t.length } });
        v.focus();
      })()`, true);
      await sleep(120);
    };
    const docText = () => cdp.evaluate('window.__reveryTexTest.view().state.doc.toString()', true);
    const caret = () => cdp.evaluate('window.__reveryTexTest.view().state.selection.main.head', true);

    // The keystroke checks below replace the open buffer wholesale. That is
    // fine for them and ruinous for everything after: SyncTeX maps PDF
    // positions onto source lines, and a four-character document clamps every
    // lookup to the same place, so the next section's inverse-search checks
    // silently stop moving the cursor. Put the file back when done.
    const savedDoc = await cdp.evaluate('window.__reveryTexTest.view().state.doc.toString()', true);

    await setDoc('');
    await typeText('\\frac');
    check('typing a command opens the dropdown with an entry already selected',
      await cdp.evaluate('!!document.querySelector(".cm-tooltip-autocomplete li[aria-selected]")', true));
    await press('Tab');
    check('Tab accepts it and writes the braces', (await docText()) === '\\frac{}{}',
      JSON.stringify(await docText()));
    check('the cursor lands in the first field', (await caret()) === 6, String(await caret()));
    await press('Tab');
    check('Tab again moves to the next field', (await caret()) === 8, String(await caret()));

    // The binding that must survive all of the above.
    await setDoc('hello');
    await press('Tab');
    check('Tab with no completion and no snippet still indents',
      (await docText()) !== 'hello', JSON.stringify(await docText()));

    await setDoc('');
    await typeText('\\begin{figu');
    await press('Tab');
    const figBlock = await docText();
    check('an environment completes to its whole scaffold',
      figBlock.startsWith('\\begin{figure}[htbp]') && figBlock.trimEnd().endsWith('\\end{figure}'),
      JSON.stringify(figBlock.slice(0, 40)));
    // Templates indent with tabs, which CodeMirror expands to one indent unit
    // each. Spaces in the template would be copied literally on top of that.
    check('the scaffold is indented by one unit, not by stray spaces',
      /^\s\s\\centering$/m.test(figBlock), JSON.stringify(figBlock.split('\n')[1]));

    await setDoc('\\ref{');
    await typeText('s');
    if (!await cdp.evaluate('!!document.querySelector(".cm-tooltip-autocomplete li[aria-selected]")', true)) {
      check('Enter accepts a label', false, 'the label dropdown never opened');
    } else {
      await press('Enter');
      const afterRef = await docText();
      check('Enter accepts a label rather than breaking the line',
        !afterRef.includes('\n') && afterRef.length > '\\ref{s'.length, JSON.stringify(afterRef));
    }
    // …and stays a newline everywhere else, which is why the accept is gated on
    // what is selected rather than on the popup merely being open.
    await setDoc('');
    await typeText('\\se');
    await press('Enter');
    check('Enter over the command list still inserts a newline',
      (await docText()).includes('\n'), JSON.stringify(await docText()));

    await setDoc(savedDoc);
    check('the buffer is back as it was before the keystroke checks',
      (await docText()) === savedDoc, `${(await docText()).length} vs ${savedDoc.length} chars`);

    /* ── PDF hyperlinks ─────────────────────────────────────────────── */
    // The link layer is a hit test over annotation rectangles rather than DOM
    // (see pdf_links.js), so there is no element to query and nothing here can
    // be checked by looking at the page. The geometry is unit-tested in
    // test/pdf_links.test.js; what only a browser can answer is whether a real
    // press-and-release at a link's coordinates moves the PDF and leaves the
    // editor alone — the two halves of "a link beats SyncTeX".
    const SETTLE = `(async () => {
      const box = document.getElementById('pdf');
      for (let last = -1, still = 0; still < 3; ) {
        await new Promise(r => setTimeout(r, 100));
        if (box.scrollTop === last) still++; else { still = 0; last = box.scrollTop; }
      }
    })()`;
    const PAGE_AT_TOP = `(() => {
      const box = document.getElementById('pdf');
      const y = box.scrollTop + box.clientHeight / 3;
      let hit = null;
      for (const c of box.querySelectorAll('canvas.pdfpage')) if (c.offsetTop <= y) hit = c;
      return hit ? Number(hit.dataset.page) : null;
    })()`;
    const head = () => cdp.evaluate('window.__reveryTexTest.view().state.selection.main.head', true);

    const compiled = await cdp.evaluate('window.__reveryTexApp.compile("book")', true);
    const allLinks = await cdp.evaluate('window.__reveryTexApp.pdfLinks()', true);
    const internal = allLinks.filter(l => l.target);
    check('hyperref links are found in the compiled PDF', internal.length > 0,
      `${internal.length} internal, ${allLinks.length - internal.length} external`);
    check('every link rect and target is inside the document',
      allLinks.every(l => l.x1 >= 0 && l.y1 >= 0 && l.x2 > l.x1 && l.y2 > l.y1)
      && internal.every(l => l.target.page >= 1 && l.target.page <= compiled.pages));

    // Scroll the link's page into view first: a rect on page 9 is nowhere near
    // the viewport, and a synthetic click at its coordinates would hit nothing
    // while looking exactly like a broken feature.
    const spot = internal.length ? await cdp.evaluate(`(async () => {
      const l = (await window.__reveryTexApp.pdfLinks()).filter(x => x.target)[0];
      const box = document.getElementById('pdf');
      const c = box.querySelector('canvas.pdfpage[data-page="' + l.page + '"]');
      const s0 = c.getBoundingClientRect().width / Number(c.dataset.natural);
      box.scrollTo({ top: c.offsetTop + l.y1 * s0 - 100, behavior: 'instant' });
      await new Promise(r => setTimeout(r, 150));
      const rr = c.getBoundingClientRect();
      const s = rr.width / Number(c.dataset.natural);
      return { x: rr.left + ((l.x1 + l.x2) / 2) * s, y: rr.top + ((l.y1 + l.y2) / 2) * s,
               fromPage: l.page, toPage: l.target.page };
    })()`, true) : null;

    if (!spot) {
      check('a link can be clicked', false, 'the book fixture produced no internal links');
    } else {
      await cdp.send('Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: spot.x, y: spot.y, buttons: 0 });
      await sleep(200);
      check('hovering a link shows the pointer cursor',
        await cdp.evaluate('document.getElementById("pdf").classList.contains("pdf-overlink")', true));

      const before = await head();
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent',
          { type, x: spot.x, y: spot.y, button: 'left', buttons: 1, clickCount: 1 });
      }
      await cdp.evaluate(SETTLE, true);
      const landed = await cdp.evaluate(PAGE_AT_TOP, true);
      check('clicking a link scrolls the PDF to its destination',
        landed === spot.toPage, `landed on page ${landed}, expected ${spot.toPage}`);
      // The whole point of the branch: a reader clicking "Figure 3" wants the
      // figure, not the line where the \ref was typed. Both firing would move
      // two panes at once for one click.
      check('SyncTeX inverse search does not also fire', (await head()) === before);

      await realClick(cdp, `document.getElementById('pdfback')`);
      await cdp.evaluate(SETTLE, true);
      check('Back returns to where the link was followed from',
        (await cdp.evaluate(PAGE_AT_TOP, true)) === spot.fromPage);
      check('and disables itself with nothing left to go back to',
        await cdp.evaluate('document.getElementById("pdfback").disabled', true));

      // Alt is the escape hatch, so inverse search stays reachable on a page
      // that is nothing but cross-references.
      const beforeAlt = await head();
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent',
          { type, x: spot.x, y: spot.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 1 });
      }
      await sleep(500);
      check('alt+click on a link still does inverse search', (await head()) !== beforeAlt);

      // …and a click that is not on a link must be completely unaffected.
      const blank = await cdp.evaluate(`(async () => {
        const box = document.getElementById('pdf');
        const view = box.getBoundingClientRect();
        const ls = await window.__reveryTexApp.pdfLinks();
        for (const c of box.querySelectorAll('canvas.pdfpage')) {
          const rr = c.getBoundingClientRect();
          if (rr.bottom < view.top + 20 || rr.top > view.bottom - 20) continue;
          const page = Number(c.dataset.page);
          const s = rr.width / Number(c.dataset.natural);
          const on = ls.filter(l => l.page === page);
          const px = (rr.width / s) / 2;
          for (let py = 40; py < rr.height / s - 40; py += 20) {
            if (on.some(l => px >= l.x1 && px <= l.x2 && py >= l.y1 && py <= l.y2)) continue;
            const cy = rr.top + py * s;
            if (cy < view.top + 10 || cy > view.bottom - 10) continue;
            return { x: rr.left + px * s, y: cy };
          }
        }
        return null;
      })()`, true);
      if (!blank) {
        check('a plain click off a link still does inverse search', true, 'no link-free spot visible');
      } else {
        await cdp.evaluate('window.__reveryTexTest.view().dispatch({ selection: { anchor: 0 } })', true);
        for (const type of ['mousePressed', 'mouseReleased']) {
          await cdp.send('Input.dispatchMouseEvent',
            { type, x: blank.x, y: blank.y, button: 'left', buttons: 1, clickCount: 1 });
        }
        await sleep(500);
        check('a plain click off a link still does inverse search', (await head()) !== 0);
      }
    }

    // A document without hyperref has no links at all, and must behave exactly
    // as it did before any of this existed.
    await cdp.evaluate('window.__reveryTexApp.compile("cv")', true);
    const cvLinks = await cdp.evaluate('window.__reveryTexApp.pdfLinks()', true);
    check('a document with no cross-references has no internal links',
      cvLinks.every(l => !l.target),
      `${cvLinks.length} link(s), all external`);

    /* ── dark mode for the PDF preview ──────────────────────────────── */
    // The feature is one CSS selector, so most of it is checkable by reading
    // computed style. The check that matters is the last one: the whole design
    // rests on `filter` being compositing-only, and a filter that quietly moved
    // a layout box would put every SyncTeX click and every hyperlink on the
    // wrong part of the page — visibly wrong only in ways nobody would connect
    // back to a colour setting.
    await cdp.evaluate('window.__reveryTexApp.compile("book")', true);

    const setSetting = (key, value) => cdp.evaluate(`(async () => {
      const s = await import('./jvscrpt_and_css_extra/settings.js');
      return s.set(${JSON.stringify(key)}, ${JSON.stringify(value)});
    })()`, true);
    const pageFilter = () => cdp.evaluate(
      'getComputedStyle(document.querySelector("canvas.pdfpage")).filter', true);

    await setSetting('pdfTheme', 'off');
    check('the preview is untouched by default', (await pageFilter()) === 'none',
      await pageFilter());

    await setSetting('pdfTheme', 'dark');
    check('Dark inverts the rendered page', /invert/.test(await pageFilter()),
      await pageFilter());

    // "Follow theme" is expressed purely in the selector — both attributes sit
    // on <html> — so this also proves no JS listener is needed to keep them in
    // step, and that nothing has to be recompiled to change it.
    await setSetting('pdfTheme', 'auto');
    await setSetting('theme', 'light');
    check('Follow theme leaves the page alone on a light theme',
      (await pageFilter()) === 'none', await pageFilter());
    await setSetting('theme', 'forest');
    check('…and inverts it on a dark one, with no recompile',
      /invert/.test(await pageFilter()), await pageFilter());
    await setSetting('theme', 'dark');

    // The marker is a sibling of the canvas, not a child, which is why the
    // filter is scoped to .pdfpage and not to #pdf: inverting the marker would
    // turn var(--warn) into its complement.
    const markFilter = await cdp.evaluate(`(() => {
      const box = document.getElementById('pdf');
      const d = document.createElement('div');
      d.className = 'pdf-syncmark';
      box.appendChild(d);
      const f = getComputedStyle(d).filter;
      d.remove();
      return f;
    })()`, true);
    check('the SyncTeX marker is not inverted along with the page',
      markFilter === 'none', markFilter);

    // The claim the whole design rests on.
    const geometry = await cdp.evaluate(`(async () => {
      const s = await import('./jvscrpt_and_css_extra/settings.js');
      const c = document.querySelector('canvas.pdfpage');
      const read = () => {
        const r = c.getBoundingClientRect();
        return { w: r.width, h: r.height, top: c.offsetTop, left: c.offsetLeft,
                 natural: c.dataset.natural };
      };
      s.set('pdfTheme', 'off');
      const before = read();
      s.set('pdfTheme', 'dark');
      const after = read();
      return { before, after };
    })()`, true);
    check('inverting moves no layout box — SyncTeX and links read the same numbers',
      JSON.stringify(geometry.before) === JSON.stringify(geometry.after),
      `${JSON.stringify(geometry.before)} vs ${JSON.stringify(geometry.after)}`);

    // …and the same, end to end, through the real hyperlink path.
    const linkStillWorks = await cdp.evaluate(`(async () => {
      const ls = (await window.__reveryTexApp.pdfLinks()).filter(l => l.target);
      if (!ls.length) return null;
      return window.__reveryTexApp.followFirstLink();
    })()`, true);
    await cdp.evaluate(SETTLE, true);
    check('a hyperlink still lands on its destination with the filter on',
      !linkStillWorks || (await cdp.evaluate(PAGE_AT_TOP, true)) === linkStillWorks.to,
      linkStillWorks ? `went to ${await cdp.evaluate(PAGE_AT_TOP, true)}, wanted ${linkStillWorks.to}` : 'no links');

    // Display-only, and this is how you can tell: a CSS filter is applied when
    // the layer is composited, so the canvas backing store still holds the
    // original pixels. If these ever differ, something is rewriting the render
    // rather than recolouring the display — and Download would be next.
    const raster = await cdp.evaluate(`(async () => {
      const s = await import('./jvscrpt_and_css_extra/settings.js');
      const c = document.querySelector('canvas.pdfpage');
      const sample = () => {
        const d = c.getContext('2d').getImageData(0, 0, Math.min(80, c.width), 8).data;
        let h = 0;
        for (let i = 0; i < d.length; i++) h = (Math.imul(h, 31) + d[i]) | 0;
        return h;
      };
      s.set('pdfTheme', 'off');  const off = sample();
      s.set('pdfTheme', 'dark'); const on  = sample();
      return { off, on };
    })()`, true);
    check('the rendered pixels are untouched — the filter is display-only',
      raster.off === raster.on, `${raster.off} vs ${raster.on}`);

    // A CSS filter should cost essentially nothing. A large regression here is
    // the signal to filter #pdf once instead of all 49 canvases.
    const sweep = await cdp.evaluate(`(async () => {
      const s = await import('./jvscrpt_and_css_extra/settings.js');
      const box = document.getElementById('pdf');
      const run = async () => {
        box.scrollTop = 0;
        await new Promise(r => requestAnimationFrame(r));
        const t0 = performance.now();
        for (let i = 0; i < 40; i++) {
          box.scrollTop += box.clientHeight;
          await new Promise(r => requestAnimationFrame(r));
        }
        return performance.now() - t0;
      };
      s.set('pdfTheme', 'off');  await run();          // warm up
      const off = await run();
      s.set('pdfTheme', 'dark'); const on = await run();
      s.set('pdfTheme', 'off');
      return { off, on, pages: box.querySelectorAll('canvas.pdfpage').length };
    })()`, true);
    check('scrolling the whole document is not meaningfully slower inverted',
      sweep.on < Math.max(sweep.off * 2.5, sweep.off + 400),
      `${sweep.pages} pages: ${sweep.off.toFixed(0)}ms → ${sweep.on.toFixed(0)}ms`);

    /* ── background texture ─────────────────────────────────────────── */
    const texture = await cdp.evaluate(`(async () => {
      const s = await import('./jvscrpt_and_css_extra/settings.js');
      const body = () => getComputedStyle(document.body);
      const paneAlpha = () => getComputedStyle(document.getElementById('sidebar')).backgroundColor;

      const noneImage = body().backgroundImage;
      const opaquePane = paneAlpha();

      s.set('background', 'bg_3');
      s.set('backgroundOpacity', 20);
      const on = {
        image: body().backgroundImage,
        size: body().backgroundSize,
        attr: document.documentElement.getAttribute('data-background'),
        opacity: getComputedStyle(document.documentElement).getPropertyValue('--texture-opacity').trim(),
        veil: getComputedStyle(document.body, '::before').opacity,
        pane: paneAlpha()
      };

      s.set('background', 'none');
      return { noneImage, opaquePane, on, backToNone: body().backgroundImage,
               paneBack: paneAlpha() };
    })()`, true);

    check('no texture by default', texture.noneImage === 'none', texture.noneImage);
    check('choosing one paints it behind the interface',
      /image_assets\/bg_3_web\.jpg/.test(texture.on.image) && texture.on.size === 'cover',
      `${texture.on.image.slice(0, 52)} · ${texture.on.size}`);
    // Strength is a veil of the theme's own background colour at 1 − strength,
    // so the number means the same thing on every theme.
    check('strength veils it by the same amount on any theme',
      texture.on.opacity === '0.2' && Math.abs(Number(texture.on.veil) - 0.8) < 0.01,
      `--texture-opacity ${texture.on.opacity}, veil ${texture.on.veil}`);
    // Opaque panes would leave the texture visible only in the editor, which
    // reads as a bug rather than a choice.
    // Computed colours come back as rgba() or color(srgb …); either way the
    // pane must have gained an alpha it did not have.
    check('the panes let it through',
      /\/\s*0?\.\d+|rgba\(/.test(texture.on.pane) && texture.on.pane !== texture.opaquePane,
      `${texture.opaquePane} → ${texture.on.pane}`);
    check('turning it off removes it entirely',
      texture.backToNone === 'none' && texture.paneBack === texture.opaquePane,
      `${texture.backToNone} · ${texture.paneBack}`);

    /* ── an imported image ──────────────────────────────────────────── */
    const custom = await cdp.evaluate(`(async () => {
      const bg = await import('./jvscrpt_and_css_extra/background_image.js');
      const s = await import('./jvscrpt_and_css_extra/settings.js');

      const menuFor = () => {
        document.getElementById('settings').click();
        const trigger = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
          .find(b => /Background/.test(b.textContent) && b.classList.contains('has-submenu'));
        trigger.click();
        const panel = [...document.querySelectorAll('.submenu')].find(p => !p.hidden);
        const rows = [...panel.querySelectorAll('.menu-item')].map(b => b.textContent.trim());
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return rows;
      };
      const before = menuFor();

      // Stand in for the file picker: the same store path, with an image made
      // here. What is being checked is that an imported picture reaches the
      // page, not that Chrome can open a file dialog.
      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#c04030'; ctx.fillRect(0, 0, 8, 8);
      localStorage.setItem('revery_tex_custom_bg', c.toDataURL('image/jpeg', 0.7));
      bg.applyCustomBackground();
      s.set('background', 'custom');

      const painted = getComputedStyle(document.body).backgroundImage;
      const after = menuFor();

      // Choosing None must stop painting it, even though the image is still
      // stored and still on the custom property.
      s.set('background', 'none');
      const off = getComputedStyle(document.body).backgroundImage;
      s.set('background', 'custom');

      bg.forgetCustomBackground();
      s.set('background', 'none');
      return {
        before, after, painted: painted.slice(0, 24), off,
        gone: getComputedStyle(document.body).backgroundImage,
        stored: localStorage.getItem('revery_tex_custom_bg')
      };
    })()`, true);

    // Offering "Your image" before there is one selects a background that
    // paints nothing.
    check('your image is offered only once there is one',
      !custom.before.some(r => /your image/i.test(r))
      && custom.after.some(r => /your image/i.test(r)),
      `${custom.before.filter(r => /image/i.test(r)).join(' | ')} → ${custom.after.filter(r => /image/i.test(r)).join(' | ')}`);
    check('the menu offers importing and forgetting',
      custom.before.some(r => /choose image/i.test(r))
      && custom.after.some(r => /replace image/i.test(r))
      && custom.after.some(r => /forget image/i.test(r)),
      custom.after.join(' | '));
    check('an imported image is painted', /^url\("data:image/.test(custom.painted), custom.painted);
    // The image stays stored while None is chosen; the attribute is what
    // decides whether anything is painted.
    check('choosing None stops painting it', custom.off === 'none', custom.off);
    check('forgetting it removes both the picture and the storage',
      custom.gone === 'none' && custom.stored === null, `${custom.gone} · ${custom.stored}`);

    // The pre-paint script has to know about it too, or a stored background
    // arrives a frame late — the flash this app already avoids for themes.
    await cdp.evaluate(`(async () => {
      const s = await import('./jvscrpt_and_css_extra/settings.js');
      s.set('background', 'bg_6');
      s.set('backgroundOpacity', 12);
    })()`, true);
    await cdp.send('Page.reload');
    await sleep(2500);
    await cdp.waitFor('!!document.documentElement.getAttribute("data-background")',
      { what: 'reload with a texture', timeoutMs: 30000 });
    const rebooted = await cdp.evaluate(`(() => ({
      attr: document.documentElement.getAttribute('data-background'),
      opacity: getComputedStyle(document.documentElement).getPropertyValue('--texture-opacity').trim(),
      image: getComputedStyle(document.body).backgroundImage.slice(0, 60)
    }))()`, true);
    check('the texture is applied before the app module runs',
      rebooted.attr === 'bg_6' && rebooted.opacity === '0.12'
      && /bg_6_web\.jpg/.test(rebooted.image),
      `${rebooted.attr} at ${rebooted.opacity}`);

    /* ── an imported editor font ────────────────────────────────────── */
    const font = await cdp.evaluate(`(async () => {
      const cf = await import('./jvscrpt_and_css_extra/custom_font.js');
      const s = await import('./jvscrpt_and_css_extra/settings.js');

      const menuFor = () => {
        document.getElementById('settings').click();
        const trigger = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
          .find(b => /Editor font/.test(b.textContent) && b.classList.contains('has-submenu'));
        trigger.click();
        const panel = [...document.querySelectorAll('.submenu')].find(p => !p.hidden);
        const rows = [...panel.querySelectorAll('.menu-item')].map(b => b.textContent.trim());
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return rows;
      };
      const before = menuFor();

      // Stand in for the file picker, with a font that is genuinely a font: the
      // app's own bundled face, re-read as bytes. What is being checked is that
      // an imported typeface reaches the editor, not that Chrome can open a file
      // dialog — and a fabricated payload would prove nothing about either.
      const bytes = new Uint8Array(
        await (await fetch('./fonts/HaraldReveryTextFont.woff2')).arrayBuffer());
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      localStorage.setItem('revery_tex_custom_font', 'data:font/woff2;base64,' + btoa(bin));
      cf.applyCustomFont();
      s.set('editorFont', 'custom');
      await document.fonts.ready;

      const scroller = document.querySelector('.cm-scroller');
      const after = menuFor();
      return {
        before, after,
        family: getComputedStyle(scroller).fontFamily,
        rule: (document.getElementById('custom-font-face')?.textContent || '').slice(0, 40),
        // The face has to be one the browser actually parsed, not merely a rule
        // it accepted: a refused font leaves the stack on the fallback.
        loaded: document.fonts.check("12px " + cf.FAMILY)
      };
    })()`, true);

    // Offering "Your font" before there is one selects a family that resolves to
    // the fallback — the setting appearing to do nothing.
    check('your font is offered only once there is one',
      !font.before.some(r => /your font/i.test(r))
      && font.after.some(r => /your font/i.test(r)),
      `${font.before.filter(r => /font/i.test(r)).join(' | ')} → ${font.after.filter(r => /your font/i.test(r)).join(' | ')}`);
    check('the font menu offers importing and forgetting',
      font.before.some(r => /choose font/i.test(r))
      && font.after.some(r => /replace font/i.test(r))
      && font.after.some(r => /forget font/i.test(r)),
      font.after.join(' | '));
    check('the imported face is registered and parsed',
      /^@font-face/.test(font.rule) && font.loaded, `${font.rule}… loaded=${font.loaded}`);
    check('the editor uses the imported family',
      /ReveryUserFont/.test(font.family || ''), font.family);

    // Applying it before first paint is the whole reason it lives in
    // settings_boot.js — a font that arrives a frame late is the flash this app
    // already avoids for themes.
    await cdp.send('Page.reload');
    await sleep(2500);
    await cdp.waitFor('!!document.querySelector(".cm-scroller")',
      { what: 'reload with an imported font', timeoutMs: 30000 });
    const fontBooted = await cdp.evaluate(`(() => ({
      attr: document.documentElement.getAttribute('data-editor-font'),
      // Injected by the pre-paint script, which runs in <head> — so this is
      // already present before the app module has executed at all.
      rule: !!document.getElementById('custom-font-face'),
      family: getComputedStyle(document.querySelector('.cm-scroller')).fontFamily
    }))()`, true);
    check('an imported font is applied before the app module runs',
      fontBooted.attr === 'custom' && fontBooted.rule
      && /ReveryUserFont/.test(fontBooted.family || ''),
      `${fontBooted.attr}, rule=${fontBooted.rule}, ${fontBooted.family}`);

    /* ── a folder made in the tree survives a reload ────────────────── */
    // It did not before: `emptyDirs` was a plain in-memory Set, so a folder
    // created from the panel was gone on the next load with nothing said about
    // it. A folder holds no file until something is saved into it, which is
    // exactly why it has to be remembered rather than re-derived.
    const madeFolder = await cdp.evaluate(`(async () => {
      const s = await import('./jvscrpt_and_css_extra/settings.js');
      document.getElementById('newfile').click();
      [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /new folder/i.test(b.textContent)).click();
      const i = document.querySelector('.dlg input[type="text"]');
      i.value = 'survives_reload'; i.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('.dlg-foot button')]
        .find(b => !/cancel/i.test(b.textContent)).click();
      await new Promise(r => setTimeout(r, 80));
      const key = window.__reveryTexApp.projectKey;
      return {
        key,
        shown: !!document.querySelector('#filetree .node[data-dir="survives_reload"]'),
        stored: (s.settings.emptyDirsByProject || {})[key] || []
      };
    })()`, true);
    check('a new folder is remembered against the project that owns it',
      madeFolder.shown && madeFolder.stored.includes('survives_reload'),
      `${madeFolder.key} → ${madeFolder.stored.join(', ')}`);

    await cdp.send('Page.reload');
    await sleep(2500);
    await cdp.waitFor('!!document.querySelector("#filetree .node")',
      { what: 'reload with a created folder', timeoutMs: 30000 });
    const afterReload = await cdp.evaluate(`(() => ({
      key: window.__reveryTexApp.projectKey,
      there: !!document.querySelector('#filetree .node[data-dir="survives_reload"]')
    }))()`, true);
    check('and is still in the tree after a reload',
      afterReload.key === madeFolder.key && afterReload.there,
      `${afterReload.key}: ${afterReload.there ? 'present' : 'gone'}`);

    const forgotten = await cdp.evaluate(`(async () => {
      const cf = await import('./jvscrpt_and_css_extra/custom_font.js');
      const s = await import('./jvscrpt_and_css_extra/settings.js');
      cf.forgetCustomFont();
      s.set('editorFont', 'mono');
      return {
        rule: !!document.getElementById('custom-font-face'),
        stored: localStorage.getItem('revery_tex_custom_font'),
        family: getComputedStyle(document.querySelector('.cm-scroller')).fontFamily
      };
    })()`, true);
    check('forgetting it removes the face, the storage and the family',
      !forgotten.rule && forgotten.stored === null
      && !/ReveryUserFont/.test(forgotten.family || ''),
      `rule=${forgotten.rule} stored=${forgotten.stored} · ${forgotten.family}`);

    /* ── the raw log follows you, rather than dragging you along ────── */
    // It re-pinned to the bottom on every line, so scrolling back to read the
    // error you just saw was undone by the next one — and during a compile
    // there is always a next one. It also grew a <div> per line forever: one
    // `book` compile leaves about 6,800 of them.
    const logging = await cdp.evaluate(`(async () => {
      const log = await import('./jvscrpt_and_css_extra/log_console.js');
      const body = document.getElementById('raw');
      log.showTab('raw');
      log.clearLog();
      for (let i = 0; i < 200; i++) log.rawLog('inf', 'line ' + i);
      const pinned = body.scrollHeight - body.scrollTop - body.clientHeight <= 40;

      // Now read something further up, the way anyone chasing an error does.
      body.scrollTop = 0;
      log.rawLog('inf', 'a line that arrived while you were reading');
      const stayed = body.scrollTop;

      // Back at the bottom, it should follow again.
      body.scrollTop = body.scrollHeight;
      log.rawLog('inf', 'and another');
      const refollowed = body.scrollHeight - body.scrollTop - body.clientHeight <= 40;

      // Past the cap.
      log.clearLog();
      for (let i = 0; i < 20100; i++) log.rawLog('dbg', 'x' + i);
      const rows = body.querySelectorAll('div').length;
      const note = body.firstChild.textContent;
      const lastKept = body.lastChild.textContent;
      log.clearLog();
      return { pinned, stayed, refollowed, rows, note, lastKept };
    })()`, true);
    check('the log follows the stream while you are at the bottom', logging.pinned);
    check('and stays put when you have scrolled up to read',
      logging.stayed === 0, `scrollTop ${logging.stayed}`);
    check('and follows again once you return to the bottom', logging.refollowed);
    check('the log is bounded', logging.rows <= 20001, `${logging.rows} rows`);
    check('and says how many lines it dropped',
      /earlier line\(s\) trimmed/.test(logging.note) && logging.lastKept === 'x20099',
      `${logging.note} · last kept ${logging.lastKept}`);

    /* ── the two chords the buttons advertise ───────────────────────── */
    // Ctrl+Enter compiled nothing for as long as it existed. `defaultKeymap`
    // binds Mod-Enter to insertBlankLine and was spread into the same
    // keymap.of([…]) ahead of the app's binding, so the first handler in array
    // order won and the compile binding was unreachable: the chord inserted a
    // blank line, marked the file modified and armed the unsaved-changes guard.
    // Only a real key event can catch this — a synthetic KeyboardEvent never
    // enters the precedence contest that the real one was losing.
    await cdp.evaluate(`window.__reveryTexTest.view().focus(); true`, true);
    const beforeChord = await cdp.evaluate(`(() => ({
      len: window.__reveryTexTest.view().state.doc.length,
      compiling: window.__reveryTexApp.compiling
    }))()`, true);
    await pressChord(cdp, 'Enter', 'Enter');
    const afterChord = await cdp.evaluate(`(() => ({
      len: window.__reveryTexTest.view().state.doc.length,
      // compile() sets this synchronously, so it is true while the run is still
      // in flight — which is the only proof it started at all.
      //
      // Not the compile button's disabled flag, which is what this read
      // before. The button is a live Cancel while a compile runs, so it is
      // never disabled now, and that reading quietly became "no compile ever
      // starts" — including for the two waitFors below, which then let the
      // suite race two live compiles.
      compiling: window.__reveryTexApp.compiling,
      dirty: document.getElementById('dirty').textContent
    }))()`, true);
    check('Ctrl+Enter starts a compile',
      afterChord.compiling && !beforeChord.compiling, `disabled=${afterChord.compiling}`);
    check('Ctrl+Enter does not touch the document',
      afterChord.len === beforeChord.len && !afterChord.dirty,
      `${beforeChord.len} → ${afterChord.len}${afterChord.dirty ? ` (${afterChord.dirty})` : ''}`);
    await cdp.waitFor('!window.__reveryTexApp.compiling',
      { what: 'the Ctrl+Enter compile to finish', timeoutMs: 180000 });

    // And from outside the editor, where they were not bound at all: clicking a
    // file leaves focus on the tree, which is precisely where someone reaches
    // for Ctrl+S — and in a browser that keystroke then offers to save the page.
    const outside = await cdp.evaluate(`(() => {
      const row = document.querySelector('#filetree .node[data-path]');
      row.focus();
      window.__uiSaw = null;
      window.addEventListener('keydown', function once(e) {
        if (e.key === 'Enter') { window.__uiSaw = e.defaultPrevented; window.removeEventListener('keydown', once); }
      });
      return document.activeElement === row;
    })()`, true);
    await pressChord(cdp, 'Enter', 'Enter');
    const claimed = await cdp.evaluate(`window.__uiSaw`, true);
    check('the chords work outside the editor too', outside && claimed === true,
      `focus moved=${outside}, claimed=${claimed}`);
    await cdp.waitFor('!window.__reveryTexApp.compiling',
      { what: 'the second compile to finish', timeoutMs: 180000 });

    /* ── a refused drop refuses, rather than moving to the root ─────── */
    // The guard said no and the row then let the event bubble to the panel,
    // whose handler means *the project root* — so the two moves canAcceptDrop()
    // exists to refuse were silently converted into a different move. For a
    // file nothing \includes there was no confirmation and no status line.
    await realClick(cdp, `document.getElementById('project')`);
    await sleep(200);
    await realClick(cdp,
      `[...document.querySelectorAll('.menu-container .menu-item')].find(b => /homework/.test(b.textContent))`);
    await sleep(1500);

    const drop = await cdp.evaluate(`(() => {
      // One DataTransfer across the three events, as a real drag has: the
      // handlers read \`types\` during dragover, which is all the browser
      // exposes before the drop.
      const drag = (fromSel, toSel) => {
        const src = document.querySelector(fromSel), dst = document.querySelector(toSel);
        if (!src || !dst) return 'missing row';
        const dt = new DataTransfer();
        const fire = (el, type) => el.dispatchEvent(new DragEvent(type, {
          bubbles: true, cancelable: true, dataTransfer: dt, clientX: 10, clientY: 10 }));
        fire(src, 'dragstart');
        fire(dst, 'dragover');
        const lit = document.getElementById('filetree').classList.contains('droproot');
        fire(dst, 'drop');
        return { rootLit: lit };
      };
      const paths = () => [...document.querySelectorAll('.node[data-path]')].map(n => n.dataset.path);
      const before = paths();
      const referenced = before.find(p => /^chapter\\/.*\\.tex$/.test(p));
      const image = before.find(p => /^graphs\\/.*\\.(png|jpe?g)$/i.test(p));
      const onOwnFolder = drag('.node[data-path="' + CSS.escape(referenced) + '"]', '.node.dir[data-dir="chapter"]');
      const imageOnOwnFolder = drag('.node[data-path="' + CSS.escape(image) + '"]', '.node.dir[data-dir="graphs"]');
      return {
        referenced, image, onOwnFolder, imageOnOwnFolder,
        after: paths(), status: document.getElementById('status').textContent
      };
    })()`, true);
    await sleep(400);
    check('a file dropped on the folder it is already in does not move',
      drop.after.includes(drop.referenced) && !drop.after.includes(drop.referenced.split('/').pop()),
      `${drop.referenced} → ${drop.after.includes(drop.referenced) ? 'unchanged' : 'MOVED'}`);
    check('nor does one that no \\input names',
      drop.after.includes(drop.image) && !drop.after.includes(drop.image.split('/').pop()),
      `${drop.image} → ${drop.after.includes(drop.image) ? 'unchanged' : 'MOVED'}`);
    check('the panel does not light up as the target during a refusal',
      drop.onOwnFolder.rootLit === false && drop.imageOnOwnFolder.rootLit === false,
      `rootLit=${drop.onOwnFolder.rootLit}/${drop.imageOnOwnFolder.rootLit}`);

    /* ── the engine dropdown is honoured ────────────────────────────── */
    // It was decoration: compile() repopulated the options and then re-applied
    // the *inferred* engine over the user's pick, and there was no onchange
    // either — so a choice survived exactly until the compile it was made for.
    const header = `[...document.querySelectorAll('#raw .l-hdr')].map(d => d.textContent)[0] || ''`;
    await cdp.evaluate(`window.__reveryTexApp.compile('missing-pkg')`, true);
    const inferred = await cdp.evaluate(header, true);
    await realClick(cdp, `document.getElementById('engine')`);
    await sleep(200);
    const picked = await realClick(cdp,
      `[...document.querySelectorAll('.menu-container .menu-item')].find(b => /xelatex/.test(b.textContent))`);
    await sleep(300);
    await cdp.evaluate(`window.__reveryTexApp.compile()`, true);
    const chose = await cdp.evaluate(`(() => ({
      header: ${header},
      button: document.getElementById('engine').textContent
    }))()`, true);
    check('the inferred engine is what runs by default',
      / pdflatex /.test(inferred), inferred);
    check('a picked engine is the one that runs', picked && / xelatex /.test(chose.header),
      chose.header);
    check('and the dropdown still shows it afterwards', /xelatex/.test(chose.button), chose.button);

    // …and only for that project: the engine a document needs is a property of
    // the document, so opening another one starts from the inference again.
    await realClick(cdp, `document.getElementById('project')`);
    await sleep(200);
    await realClick(cdp,
      `[...document.querySelectorAll('.menu-container .menu-item')]
         .find(b => b.textContent.trim().replace(/^[■□]\\s*/, '') === 'cv')`);
    await sleep(1500);
    const reinferred = await cdp.evaluate(`document.getElementById('engine').textContent`, true);
    check('a new project goes back to the inference', /pdflatex/.test(reinferred), reinferred);

    /* ── which file is the document is a choice ─────────────────────── */
    // It was not. pickMain guessed once, at load, and the guess was final —
    // cv_template holds four \documentclass files and no main.tex, so three of
    // its documents could not be compiled by the app at all. The chosen one was
    // additionally protected from rename, move and delete, so there was not
    // even a workaround.
    //
    // `cv` is the fixture for exactly that folder, and is already open.
    await cdp.waitFor(`!window.__reveryTexApp.compiling`,
      { what: 'the cv project to settle', timeoutMs: 180000 });
    await realClick(cdp, `document.getElementById('docname')`);
    await sleep(250);
    const docMenu = await cdp.evaluate(`(() => {
      const items = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .map(b => b.textContent.trim().replace(/^[■□]\\s*/, ''));
      return { items, marked: [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .filter(b => b.textContent.trim().startsWith('■'))
        .map(b => b.textContent.trim().replace(/^■\\s*/, '')) };
    })()`, true);
    check('every document in the folder is offered, not just the guessed one',
      docMenu.items.length === 4 && docMenu.items.includes('personligt_brev_en.tex'),
      `${docMenu.items.length}: ${docMenu.items.join(', ')}`);
    check('and the one being compiled is the one marked',
      docMenu.marked.length === 1 && docMenu.marked[0] === 'cv_harald_thirslund_sv.tex',
      docMenu.marked.join(', '));

    const pickedDoc = await realClick(cdp,
      `[...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
         .find(b => /personligt_brev_en\\.tex/.test(b.textContent))`);
    await sleep(400);
    const afterPick = await cdp.evaluate(`(() => ({
      button: document.getElementById('docname').textContent,
      editor: document.getElementById('editortitle').textContent,
      // The tree's ■ mark has to follow, or two places disagree about what the
      // document is.
      marked: [...document.querySelectorAll('#filetree .node.main')].map(n => n.dataset.path)
    }))()`, true);
    check('picking one makes it the document', pickedDoc &&
      /personligt_brev_en/.test(afterPick.button) &&
      afterPick.marked.join() === 'personligt_brev_en.tex',
      `${afterPick.button.trim()} · tree=${afterPick.marked.join()}`);
    check('and opens it in the editor', /personligt_brev_en\.tex/.test(afterPick.editor),
      afterPick.editor);

    // The proof: it is the chosen file that is handed to the engine.
    await cdp.evaluate(`window.__reveryTexApp.compile()`, true).catch(() => {});
    const compiledHeader = await cdp.evaluate(header, true);
    check('and it is the chosen file that compiles',
      /personligt_brev_en\.tex/.test(compiledHeader), compiledHeader);

    /* ── a project switch does not leave the last PDF behind ────────── */
    // Download handed over the *previous* project's bytes, and Ctrl+click
    // resolved against its SyncTeX records, because loading a project cleared
    // the editor states, the log and the issues but never this pane.
    const hadPdf = await cdp.evaluate(
      `!document.getElementById('savepdf').disabled`, true);
    await realClick(cdp, `document.getElementById('project')`);
    await sleep(200);
    await realClick(cdp,
      `[...document.querySelectorAll('.menu-container .menu-item')]
         .find(b => b.textContent.trim().replace(/^[■□]\\s*/, '') === 'bibtex')`);
    await sleep(800);
    const afterSwitch = await cdp.evaluate(`(() => ({
      download: document.getElementById('savepdf').disabled,
      meta: document.getElementById('pdfmeta').textContent,
      back: document.getElementById('pdfback').disabled,
      pages: document.querySelectorAll('#pdf canvas.pdfpage').length,
      empty: getComputedStyle(document.getElementById('pdfempty')).display
    }))()`, true);
    check('switching project clears the PDF pane', hadPdf &&
      afterSwitch.download && afterSwitch.back && afterSwitch.pages === 0 &&
      afterSwitch.meta === '' && afterSwitch.empty !== 'none',
      `download disabled=${afterSwitch.download} canvases=${afterSwitch.pages} ` +
      `meta="${afterSwitch.meta}" empty=${afterSwitch.empty}`);

    /* ── a compile can be stopped ───────────────────────────────────── */
    // Both engines have implemented cancel() all along and nothing ever called
    // either. Cancelling cannot make the engine's promise settle — the vendored
    // wrapper holds its own 180s timeout and rejects only then — so what is
    // actually being checked here is that the *app* stops waiting, and that the
    // abandoned run never lands its result afterwards.
    await cdp.waitFor(`!window.__reveryTexApp.compiling`,
      { what: 'the bibtex project to settle', timeoutMs: 180000 });
    const cancelled = await cdp.evaluate(`(async () => {
      window.__reveryTexApp.compile('book');           // deliberately not awaited
      await new Promise(r => setTimeout(r, 600));
      const running = window.__reveryTexApp.compiling;
      const label = document.getElementById('compile').textContent;
      const flagged = document.getElementById('compile').hasAttribute('data-compiling');
      await window.__reveryTexApp.cancel();
      return { running, label, flagged,
               after: window.__reveryTexApp.compiling,
               afterLabel: document.getElementById('compile').textContent,
               status: document.getElementById('status').textContent };
    })()`, true);
    check('the button offers to cancel while a compile runs',
      cancelled.running && /cancel/i.test(cancelled.label) && cancelled.flagged,
      `${cancelled.label} · data-compiling=${cancelled.flagged}`);
    check('cancelling frees the UI without waiting for the engine',
      cancelled.after === false && /compile/i.test(cancelled.afterLabel) &&
      /cancel/i.test(cancelled.status),
      `${cancelled.afterLabel} · ${cancelled.status}`);

    // And the abandoned run must never write its pages over what came after.
    // The wrapper rejects a terminated worker, so this is the window in which a
    // late result would have landed.
    await sleep(2500);
    const afterCancel = await cdp.evaluate(`(() => ({
      compiling: window.__reveryTexApp.compiling,
      pages: document.querySelectorAll('#pdf canvas.pdfpage').length,
      status: document.getElementById('status').textContent
    }))()`, true);
    check('and the abandoned compile never lands a result',
      afterCancel.compiling === false && afterCancel.pages === 0 &&
      !/pages/.test(afterCancel.status),
      `canvases=${afterCancel.pages} · ${afterCancel.status}`);

    /* ── gutter markers belong to a file, not to whatever is open ───── */
    // A diagnostic's line number is meaningless without the file it counts in,
    // and every diagnostic with a line was pushed into the current editor. So
    // an error reported at line 40 drew a marker on line 40 of whichever file
    // you happened to be looking at, and the marker *moved* as you switched
    // files — a wrong answer wearing the costume of a right one.
    //
    // The bundled engine does not pass -file-line-error, so nothing it reports
    // carries a file at all; those are attributed to the main file, which is
    // exactly right for a single-file document and a fixed, stated guess
    // otherwise. What must not happen either way is markers following the
    // reader around.
    await cdp.evaluate(`window.__reveryTexApp.compile('book')`, true).catch(() => {});
    await cdp.waitFor(`!window.__reveryTexApp.compiling`,
      { what: 'the book compile', timeoutMs: 180000 });
    const gutter = await cdp.evaluate(`(async () => {
      // The gutter's initialSpacer is itself a DiagMarker — it exists to
      // reserve the column's width — so it carries .cm-diag and is always in
      // the DOM whether or not anything is wrong. It is the one hidden element
      // among them, which is what tells it apart from a real marker.
      const count = () => [...document.querySelectorAll('#editor .cm-diag')]
        .filter(e => e.closest('.cm-gutterElement')?.style.visibility !== 'hidden').length;
      const openRow = async (p) => {
        const row = document.querySelector('#filetree .node[data-path="' + CSS.escape(p) + '"]');
        if (row) row.click();
        await new Promise(r => setTimeout(r, 250));
      };
      const issues = window.__reveryTexApp.issues().filter(i => i.line);
      const forFile = (p) => issues.filter(i => i.file === p).length;

      await openRow(document.getElementById('docname').textContent.replace(/\\s*▾\\s*$/, ''));
      const main = document.getElementById('editortitle').textContent;
      const onMain = { file: main, markers: count(), owned: forFile(main) };
      await openRow('chapters/introduction.tex');
      const onChapter = {
        file: document.getElementById('editortitle').textContent,
        markers: count(), owned: forFile('chapters/introduction.tex')
      };
      return { total: issues.length, onMain, onChapter };
    })()`, true);
    check('a diagnostic marks the file it is about',
      gutter.onMain.markers > 0 && gutter.onMain.markers <= gutter.onMain.owned,
      `${gutter.onMain.file}: ${gutter.onMain.markers} marker(s), ${gutter.onMain.owned} owned`);
    // The defect, stated exactly: every line-carrying diagnostic used to be
    // pushed into every file. A marker may only appear where it is owned — and
    // the split has to be a real one, or this would pass on a document whose
    // diagnostics all happen to belong to the open file anyway.
    check('and does not follow you into another file',
      gutter.onChapter.file === 'chapters/introduction.tex' &&
      gutter.onChapter.markers <= gutter.onChapter.owned &&
      gutter.onChapter.owned < gutter.total,
      `${gutter.onChapter.file}: ${gutter.onChapter.markers} marker(s), ` +
      `${gutter.onChapter.owned} owned of ${gutter.total} total`);

    /* ── clicking an issue lands on its code, after edits ───────────── */
    // No test ever clicked an issue row, which is how the panel shipped
    // jumping to the wrong line. A diagnostic's line is where the *compiler*
    // saw it; the moment anything is typed above it that number is stale, and
    // the click used it raw while the gutter marker had already moved. The two
    // disagreed by exactly the number of lines inserted.
    const clicked = await cdp.evaluate(`(async () => {
      const T = window.__reveryTexTest, A = window.__reveryTexApp;
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const rows = () => [...document.querySelectorAll('#issues .issue')];
      const openRow = async (p) => {
        document.querySelector('#filetree .node[data-path="' + CSS.escape(p) + '"]')?.click();
        await wait(250);
      };
      const cursorLine = () => {
        const v = T.view(), s = v.state;
        return s.doc.lineAt(s.selection.main.head).number;
      };
      // Does a gutter dot sit on the same screen row as the cursor? This is the
      // invariant that broke: the marker and the click target are two
      // representations of one position, and nothing checked they agreed.
      const dotOnCursorLine = () => {
        const v = T.view();
        const top = v.coordsAtPos(v.state.selection.main.head)?.top;
        if (top == null) return false;
        return [...document.querySelectorAll('#editor .cm-diag')]
          .filter(e => e.closest('.cm-gutterElement')?.style.visibility !== 'hidden')
          .some(e => Math.abs(e.getBoundingClientRect().top - top) < 8);
      };

      const all = A.issues();
      const idx = all.findIndex(i => i.mappedLine);
      if (idx < 0) return { skip: 'no diagnostic carries a line' };
      const target = all[idx];
      await openRow(target.file);
      if (document.getElementById('editortitle').textContent !== target.file) {
        return { skip: 'could not open ' + target.file };
      }

      const PAD = 5;
      const before = A.issues()[idx].mappedLine;
      T.view().dispatch({ changes: { from: 0, insert: '%pad\\n'.repeat(PAD) } });
      await wait(400);                       // the coalesced Issues repaint

      const shifted = A.issues()[idx].mappedLine;
      const label = rows()[idx]?.querySelector('.where')?.textContent.trim() || '';
      rows()[idx]?.click();
      await wait(150);
      const landed = cursorLine();
      const agreed = dotOnCursorLine();

      // Switching away and back rebuilds the gutter from scratch. It used to
      // rebuild from the log's raw number, throwing the mapping away.
      const other = [...document.querySelectorAll('#filetree .node[data-path]')]
        .map(n => n.dataset.path).find(p => p !== target.file);
      let afterSwitch = null;
      if (other) {
        await openRow(other);
        await openRow(target.file);
        rows()[idx]?.click();
        await wait(150);
        afterSwitch = { line: cursorLine(), agreed: dotOnCursorLine() };
      }

      // A wholesale rewrite from outside the editor: no ChangeSet describes it,
      // so the position is not knowable and the row must say so rather than
      // jump somewhere plausible.
      A.setBuffer(target.file, 'totally different\\ncontents\\n');
      await wait(400);
      const stale = A.issues()[idx].mappedLine;
      const staleRow = rows()[idx]?.classList.contains('stale') || false;
      const parked = cursorLine();
      rows()[idx]?.click();
      await wait(150);

      return {
        file: target.file, logLine: target.line, before, shifted, landed, agreed, label,
        afterSwitch, stale, staleRow, movedWhileStale: cursorLine() !== parked
      };
    })()`, true);

    if (clicked.skip) {
      check('clicking an issue lands on its code', false, clicked.skip);
    } else {
      // The bug, stated as a number: five lines in above it, five lines down.
      check('an issue row follows the code it is about through an edit',
        clicked.shifted === clicked.before + 5 && clicked.landed === clicked.shifted,
        `${clicked.file}: log said ${clicked.logLine}, was ${clicked.before}, ` +
        `now ${clicked.shifted}, cursor landed on ${clicked.landed}`);
      // Neither view may drift from the other again.
      check('and the gutter marker is on the line the click landed on',
        clicked.agreed === true, `dot aligned with cursor: ${clicked.agreed}`);
      check('the row names the file, not a bare line number',
        /:\d+/.test(clicked.label), `row said "${clicked.label}"`);
      check('a file switch does not snap the marker back to the stale line',
        !clicked.afterSwitch ||
        (clicked.afterSwitch.line === clicked.shifted && clicked.afterSwitch.agreed),
        clicked.afterSwitch
          ? `back on ${clicked.afterSwitch.line} (expected ${clicked.shifted}), ` +
            `dot aligned: ${clicked.afterSwitch.agreed}`
          : 'no second file to switch to');
      // Refusing to answer is the point. The old clamp would have put the
      // cursor on the last line of the rewritten file and looked deliberate.
      check('a rewrite from outside the editor marks the row stale, not wrong',
        clicked.stale === null && clicked.staleRow && !clicked.movedWhileStale,
        `mapped=${clicked.stale} stale-class=${clicked.staleRow} ` +
        `cursor moved=${clicked.movedWhileStale}`);
    }

    /* ── biblatex without biber: from dead end to one click ─────────── */
    // The whole point of this feature, driven end to end. biber is Perl, so no
    // in-browser engine will ever run it; a biblatex document therefore
    // compiled to a PDF with every citation undefined and said so only in a log
    // tab, with nothing to press. The log did suggest backend=bibtex — but
    // detection ignored the option, so taking the advice changed nothing.
    await cdp.evaluate(`window.__reveryTexApp.compile('book-biber')`, true).catch(() => {});
    await cdp.waitFor(`!document.getElementById('notice').hidden`,
      { what: 'the biber notice', timeoutMs: 120000 });

    const offered = await cdp.evaluate(`(() => {
      const n = document.getElementById('notice');
      return {
        text: n.textContent.trim(),
        buttons: [...n.querySelectorAll('button')].map(b => b.textContent.trim()),
        issues: document.getElementById('issuecount').textContent
      };
    })()`, true);
    check('a document needing biber says so where it can be acted on',
      /biber/i.test(offered.text), offered.text.slice(0, 60));
    check('and offers the fix that works in a browser',
      offered.buttons.includes('Use bundled bibtex'), offered.buttons.join(' | '));

    await realClick(cdp,
      `[...document.querySelectorAll('#notice button')].find(b => /bundled bibtex/i.test(b.textContent))`);
    await cdp.waitFor(`/pages/.test(document.getElementById('status').textContent)`,
      { what: 'the recompile', timeoutMs: 180000 });

    const backendFix = await cdp.evaluate(`(() => {
      const doc = window.__reveryTexTest.view().state.doc.toString();
      return {
        backend: (/backend\\s*=\\s*\\w+/.exec(doc) || [])[0] || null,
        status: document.getElementById('status').textContent,
        dirty: document.getElementById('dirty').textContent,
        issues: document.getElementById('issuecount').textContent,
        noticeHidden: document.getElementById('notice').hidden
      };
    })()`, true);

    check('pressing it rewrites the backend', /=\s*bibtex$/.test(backendFix.backend || ''),
      backendFix.backend);
    // Into the buffer, never straight to disk: it is an ordinary edit, so it
    // marks the file modified and Ctrl+Z takes it back.
    check('as an undoable edit, not a silent write to disk',
      backendFix.dirty === 'modified', `dirty: "${backendFix.dirty}"`);
    check('and the bibliography then builds',
      /✓/.test(backendFix.status) && backendFix.noticeHidden,
      `${offered.issues} → ${backendFix.issues} · ${backendFix.status}`);

    /* ── Clear empties both tabs ────────────────────────────────────── */
    // Placed here because the compile above has just filled both of them with a
    // real log and real diagnostics — clearing an already-empty panel would
    // pass whatever the button did.
    const beforeClear = await cdp.evaluate(`(() => ({
      raw: document.getElementById('raw').children.length,
      issues: document.querySelectorAll('#issues .issue').length,
      meta: document.getElementById('logmeta').textContent,
      count: document.getElementById('issuecount').textContent
    }))()`, true);
    await realClick(cdp, `document.getElementById('clearlog')`);
    await sleep(80);
    const afterClear = await cdp.evaluate(`(() => ({
      raw: document.getElementById('raw').children.length,
      issues: document.querySelectorAll('#issues .issue').length,
      empty: !!document.querySelector('#issues .empty'),
      meta: document.getElementById('logmeta').textContent,
      count: document.getElementById('issuecount').textContent
    }))()`, true);

    check('there was something to clear', beforeClear.raw > 0,
      `${beforeClear.raw} log lines, ${beforeClear.issues} issues`);
    check('Clear empties the raw log', afterClear.raw === 0,
      `${beforeClear.raw} → ${afterClear.raw}`);
    // Both tabs, not the one in front: a count still claiming issues over an
    // empty body is exactly the disagreement one button has to avoid.
    check('and the Issues tab with it, counts included',
      afterClear.issues === 0 && afterClear.empty &&
      afterClear.meta === '' && afterClear.count === '',
      `issues ${beforeClear.issues} → ${afterClear.issues}, ` +
      `meta "${afterClear.meta}", count "${afterClear.count}"`);

    // The panel head has no overflow rule, so a fourth button beside a long
    // "20001 lines" is what would push Hide off the end.
    const narrow = await cdp.evaluate(`(() => {
      document.getElementById('logmeta').textContent = '20001 lines';
      const head = document.querySelector('.panelhead').getBoundingClientRect();
      const hide = document.getElementById('togglepanel').getBoundingClientRect();
      const clear = document.getElementById('clearlog').getBoundingClientRect();
      document.getElementById('logmeta').textContent = '';
      return { headRight: head.right, hideRight: hide.right, clearRight: clear.right,
               hideWidth: hide.width };
    })()`, true);
    check('Clear and Hide stay inside the panel head at a long line count',
      narrow.hideRight <= narrow.headRight + 1 && narrow.hideWidth > 0 &&
      narrow.clearRight <= narrow.headRight + 1,
      `hide ends ${narrow.hideRight.toFixed(0)} of ${narrow.headRight.toFixed(0)}`);

    /* ── the Legal page ─────────────────────────────────────────────── */
    // Not cosmetic. This application links an AGPL-3.0 component, so a hosted
    // copy must offer its corresponding source to everyone who loads it, and
    // that offer has to name the running build rather than gesture at a repo.
    // The checks below are the compliance surface, which is why they assert the
    // build stamp and the repository link rather than only that a box appeared.
    console.log('\n── legal ───────────────────────────────────────────────────────');

    // The logo must survive every width the app supports. #topbar clips from the
    // right rather than wrapping, so its last item is the first one lost —
    // Settings and Toolbox already vanish below ~1130px. Putting the logo first
    // is what keeps Legal, About and the source offer reachable at 640px, which
    // is the minWidth tauri.conf.json sets. This loop is the check that earns
    // that placement; without it the button drifts rightwards one tidy-up later.
    const widths = [1280, 900, 640];
    const clipped = [];
    for (const w of widths) {
      await cdp.send('Emulation.setDeviceMetricsOverride',
        { width: w, height: 800, deviceScaleFactor: 1, mobile: false });
      await sleep(150);
      const ok = await cdp.evaluate(`(() => {
        const bar = document.getElementById('topbar').getBoundingClientRect();
        const b = document.getElementById('logo');
        if (!b) return false;
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.left >= bar.left - 0.5 && r.right <= bar.right + 0.5;
      })()`);
      if (!ok) clipped.push(w);
    }
    check('the logo is reachable at every supported width',
      clipped.length === 0,
      clipped.length ? `clipped at ${clipped.join(', ')}px` : widths.join('px, ') + 'px');

    check('and it renders the brand mark, theme-coloured',
      await cdp.evaluate(`(() => {
        const svg = document.querySelector('#logo svg');
        return !!svg && svg.querySelectorAll('path').length === 4 &&
          getComputedStyle(svg).fill !== 'none';
      })()`));

    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(200);

    // The menu, and that the source offer leads it.
    // Scoped to the open panel. Every menu in the app keeps its container in the
    // document and merely sets `hidden`, so an unscoped `.menu-container`
    // selector collects the project and engine dropdowns opened earlier in this
    // run as well.
    await realClick(cdp, `document.getElementById('logo')`);
    const menu = await cdp.evaluate(`(() => {
      const items = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .map(x => x.textContent.trim());
      return { items, expanded: document.getElementById('logo').getAttribute('aria-expanded') };
    })()`);
    check('the logo opens a menu', menu.expanded === 'true');
    check('carrying Source code, Legal and About',
      menu.items.join('|') === 'Source code|Legal|About', menu.items.join(' | '));

    // Copying is how the offer works at all on desktop, where neither shell will
    // open a browser. Read it back rather than trusting the call not to throw.
    await cdp.send('Browser.grantPermissions',
      { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await cdp.evaluate(`[...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
      .find(x => x.textContent.trim() === 'Source code').click()`);
    await sleep(250);
    const copied = await cdp.evaluate(`navigator.clipboard.readText()`);
    check('Source code puts the address on the clipboard',
      /github\.com\/haraldrevery\/revery_tex/.test(copied || ''), copied);

    await realClick(cdp, `document.getElementById('logo')`);
    await cdp.evaluate(`[...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
      .find(x => x.textContent.trim() === 'Legal').click()`);
    await sleep(200);
    const legal = await cdp.evaluate(`(() => {
      const dlg = document.querySelector('.legal-dlg');
      if (!dlg) return { open: false };
      const scroll = dlg.querySelector('.legal-scroll');
      const foot = dlg.querySelector('.dlg-foot');
      const footTop = foot.getBoundingClientRect().top;
      scroll.scrollTop = scroll.scrollHeight;
      return {
        open: true,
        sections: dlg.querySelectorAll('.legal-section').length,
        libs: dlg.querySelectorAll('.legal-lib').length,
        stamp: dlg.querySelector('.legal-source')?.textContent.trim() || '',
        scrolled: scroll.scrollTop > 0,
        // The overflow is on .legal-scroll rather than on .dlg so that Close
        // does not scroll away above the fold on a three-screen document.
        footStayed: Math.abs(foot.getBoundingClientRect().top - footTop) < 1
      };
    })()`);
    check('Source opens the Legal page', legal.open);
    check('it carries every section', legal.sections === 7, `${legal.sections} sections`);
    // One card per third-party component in the shipped bundle. A dependency
    // added without a row here is an attribution the distribution owes and
    // does not make.
    check('every bundled component is attributed', legal.libs === 7, `${legal.libs} components`);
    check('the source offer names the running build',
      /github\.com\/haraldrevery\/revery_tex/.test(legal.stamp) &&
      /version \d+\.\d+\.\d+/.test(legal.stamp), legal.stamp);
    check('long licence text scrolls', legal.scrolled);
    check('and Close stays put while it does', legal.footStayed);

    await pressEscape(cdp);
    const dismissed = await cdp.evaluate(`(() => ({
      closed: !document.querySelector('.legal-dlg'),
      focus: document.activeElement?.id
    }))()`);
    check('Escape dismisses it', dismissed.closed);
    check('and focus returns to the button that opened it',
      dismissed.focus === 'logo', `focus: "${dismissed.focus}"`);

    // About. Its safety claims are checked against the backends by hand, not
    // here; what this asserts is that the page exists, opens, and names the
    // build — a version that silently went missing would be the failure.
    await realClick(cdp, `document.getElementById('logo')`);
    await cdp.evaluate(`[...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
      .find(x => x.textContent.trim() === 'About').click()`);
    await sleep(200);
    const about = await cdp.evaluate(`(() => {
      const dlg = document.querySelector('.legal-dlg');
      if (!dlg) return { open: false };
      return {
        open: true,
        head: dlg.querySelector('.dlg-head')?.textContent,
        sections: dlg.querySelectorAll('.legal-section').length,
        stamp: dlg.querySelector('.legal-source')?.textContent.trim() || ''
      };
    })()`);
    check('About opens from the same menu', about.open && about.head === 'About');
    check('with all four sections', about.sections === 4, `${about.sections} sections`);
    check('and names the running build',
      /version \d+\.\d+\.\d+/.test(about.stamp), about.stamp);
    await pressEscape(cdp);
    check('About dismisses too',
      await cdp.evaluate(`!document.querySelector('.legal-dlg')`));

    await cdp.send('Emulation.clearDeviceMetricsOverride');

    const expected = /favicon|\/api\/projects/i;
    const real = pageErrors.filter(e => !expected.test(e));
    check('no unexpected page errors', real.length === 0, real.slice(0, 2).join(' | '));
  } finally {
    cleanup();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
