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
    cdp.on((msg) => {
      if (msg.method === 'Page.javascriptDialogOpening') {
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
        themeButton: !!document.getElementById('theme'),
        selects: document.querySelectorAll('select').length
      };
    })()`);

    check('menu opens', opened.open);
    // Six headed rows plus the theme submenu trigger, which has no head.
    check('has a row per setting',
      opened.heads.length === 6 && opened.subTriggers === 1, opened.heads.join(' · '));
    // Scales are steppers and theme is a submenu, so only the remaining
    // list-style settings carry a ■ in the top level.
    check('marks one choice per top-level list setting',
      opened.checked.length === 4,
      `${opened.checked.length} marked: ${opened.checked.join(' | ')}`);
    check('scales render as steppers', opened.steppers === 2, `${opened.steppers} steppers`);
    check('theme is a submenu', opened.subTriggers === 1, `${opened.subTriggers} triggers`);
    check('the standalone Theme button is gone', !opened.themeButton);
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
      const before = getComputedStyle(document.documentElement).fontSize;
      // Theme lives behind a submenu now: open it, then pick.
      document.querySelector('.menu-item.has-submenu')?.click();
      const okTheme = pick('Forest');
      // UI size is the first stepper; three clicks of + walks 100 -> 130%.
      const plus = document.querySelectorAll('.menu-stepper')[0].querySelector('[data-step="1"]');
      for (let i = 0; i < 3; i++) {
        document.querySelectorAll('.menu-stepper')[0].querySelector('[data-step="1"]').click();
      }
      const okSize = !!plus;
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
      pick('Harald Text');
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
      const trigger = document.querySelector('.menu-item.has-submenu');
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
      document.querySelector('.menu-item.has-submenu')?.click();
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

      // With nothing selected the browser's own menu must survive.
      select(3, 3);
      const ev = new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 });
      target.dispatchEvent(ev);
      const suppressedWithNoSelection = ev.defaultPrevented;

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
        suppressedWithNoSelection, suppressedOutside: outside.defaultPrevented,
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
    check('the native menu survives with no selection', !fmt.suppressedWithNoSelection);
    check('the native menu survives outside the editor', !fmt.suppressedOutside);
    // A transient menu that is not removed leaves a dead <div> per right-click.
    check('context menus do not accumulate', fmt.after === fmt.baseline,
      `${fmt.baseline} permanent → ${fmt.after} after five right-clicks`);

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

    const collapsed = await cdp.evaluate(`(() => {
      document.getElementById('toggleoutline').click();
      const hidden = getComputedStyle(document.getElementById('outline')).display === 'none';
      const stored = JSON.parse(localStorage.getItem('revery_tex_settings') || '{}');
      document.getElementById('toggleoutline').click();
      return { hidden, stored: stored.outlineCollapsed,
               shownAgain: getComputedStyle(document.getElementById('outline')).display !== 'none' };
    })()`, true);
    check('the outline collapses and the state is remembered',
      collapsed.hidden && collapsed.stored === true && collapsed.shownAgain,
      JSON.stringify(collapsed));

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
    const cite = await cdp.evaluate(`(() => {
      const view = window.__reveryTexTest.view();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      document.getElementById('toolbox').click();
      const trigger = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /insert citation/i.test(b.textContent));
      if (!trigger) return { found: false };
      trigger.click();
      const panel = [...document.querySelectorAll('.submenu')].find(p => !p.hidden);
      const rows = panel ? [...panel.querySelectorAll('.menu-item')] : [];
      return { found: true, count: rows.length, labels: rows.map(b => b.textContent.trim()) };
    })()`, true);
    await realClick(cdp, `[...document.querySelectorAll('.submenu')].find(p => !p.hidden)?.querySelector('.menu-item')`);
    cite.tail = await cdp.evaluate(
      `window.__reveryTexTest.view().state.doc.toString().slice(-30)`, true);
    check('citations are listed from the bibliography',
      cite.found && cite.count > 0, `${cite.count} entr(ies)`);
    // Author and year, not the key: "smith2020" is what goes in the document,
    // not what you scan a list for.
    check('entries are named by author and year',
      cite.labels?.some(l => /\d{4}/.test(l)), (cite.labels || []).slice(0, 2).join(' | '));
    check('picking one inserts a \\cite', /\\cite\{[^}]+\}$/.test(cite.tail || ''), cite.tail);

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
      // The observer needs a frame to run before anything has been painted.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const painted = () => cards.filter(c => c.querySelector('.picker-thumb').children.length
        || c.querySelector('.picker-thumb').textContent).length;
      const paintedEarly = painted();

      const filterBox = panel.querySelector('.picker-filter');
      filterBox.value = 'zzz-nothing-matches';
      filterBox.dispatchEvent(new Event('input', { bubbles: true }));
      const afterFilter = cards.filter(c => !c.hidden).length;
      const countText = panel.querySelector('.picker-count').textContent;
      filterBox.value = '';
      filterBox.dispatchEvent(new Event('input', { bubbles: true }));

      // Every blob URL the picker made must be handed back on close.
      const live = new Set();
      const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
      URL.createObjectURL = (b) => { const u = realCreate.call(URL, b); live.add(u); return u; };
      URL.revokeObjectURL = (u) => { live.delete(u); return realRevoke.call(URL, u); };
      // Scroll to the end so more cards render, then close.
      const strip = panel.querySelector('.picker-strip');
      strip.scrollLeft = strip.scrollWidth;
      await new Promise(r => setTimeout(r, 250));
      const madeMore = live.size;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const leaked = live.size;
      URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke;

      return {
        opened: true, total: cards.length, paintedEarly, afterFilter, countText,
        madeMore, leaked, closed: !document.querySelector('.dlg.picker'),
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
      cards[0]?.click();
      return {
        opened: true, count: cards.length, withMath,
        labels: cards.slice(0, 3).map(c => c.querySelector('.picker-caption').textContent),
        tail: view.state.doc.toString().slice(-24)
      };
    })()`, true);

    check('equations can be referenced', refEq.opened && refEq.count > 0,
      `${refEq.count}: ${(refEq.labels || []).join(' | ')}`);
    check('their cards are rendered maths', refEq.withMath > 0,
      `${refEq.withMath} of ${refEq.count} rendered`);
    // amsmath is in this document's preamble, so \eqref exists. Without it the
    // menu must fall back to \ref, which is defined everywhere.
    check('picking one inserts an \\eqref', /\\eqref\{[^}]+\}$/.test(refEq.tail || ''), refEq.tail);

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
