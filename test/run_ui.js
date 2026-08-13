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

    // Derived from the schema rather than hardcoded: the invariant is "a row
    // per setting", and a count that has to be bumped by hand is a count that
    // gets bumped without anyone checking what it now means.
    const schema = await cdp.evaluate(`(async () => {
      const s = await import('./jvscrpt_and_css_extra/settings.js');
      const shown = s.SCHEMA.filter(e => e.key !== 'engineSource');
      return {
        headed: shown.filter(e => e.ui !== 'submenu').length,
        radios: shown.filter(e => !e.ui).length,
        steppers: shown.filter(e => e.ui === 'stepper').length,
        submenus: shown.filter(e => e.ui === 'submenu').length
      };
    })()`, true);

    check('menu opens', opened.open);
    // One head per setting, plus the theme submenu trigger, which has none.
    // engineSource is hidden where no process can be started, which is every
    // browser — see settingsMenuSpec.
    check('has a row per setting',
      opened.heads.length === schema.headed,
      `${opened.heads.length} of ${schema.headed}: ${opened.heads.join(' · ')}`);
    // Scales are steppers and theme is a submenu, so only the remaining
    // list-style settings carry a ■ in the top level.
    check('marks one choice per top-level list setting',
      opened.checked.length === schema.radios,
      `${opened.checked.length} marked: ${opened.checked.join(' | ')}`);
    check('scales render as steppers', opened.steppers === schema.steppers,
      `${opened.steppers} of ${schema.steppers}`);
    // Theme and background: the two settings with enough choices to crowd the
    // menu as a flat list.
    check('the long lists are submenus', opened.subTriggers === schema.submenus,
      `${opened.subTriggers} of ${schema.submenus} triggers`);
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
      const row = [...document.querySelectorAll('.menu-container:not([hidden]) .menu-item')]
        .find(b => /Toolbox$/.test(b.textContent.trim()));
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
      document.getElementById('outlinetoggle').click();
      const off = { pane: pane.hidden, divider: div.hidden,
                    label: document.getElementById('outlinetoggle').textContent.trim(),
                    stored: JSON.parse(localStorage.getItem('revery_tex_settings') || '{}').showOutline };
      document.getElementById('outlinetoggle').click();
      return { off, onAgain: !pane.hidden && !div.hidden,
               label: document.getElementById('outlinetoggle').textContent.trim() };
    })()`, true);
    check('the topbar button hides the pane and its divider',
      toggled.off.pane && toggled.off.divider, JSON.stringify(toggled.off));
    // A divider left behind is a drag handle for something that is not there.
    check('the button says which state it is in',
      toggled.off.label === 'Outline' && toggled.label === 'Outline ✓',
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
      const row = [...document.querySelectorAll('#filetree .node[data-path]')]
        .find(r => !r.hasAttribute('aria-disabled'));
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

      const binary = document.querySelector('#filetree .node.binary');
      // aria-disabled, never the disabled property: a disabled button gets no
      // mouse events, which would take right-click Rename away from it.
      const binaryFocusable = !!binary && !binary.disabled
        && binary.getAttribute('aria-disabled') === 'true';

      const sec = document.querySelector('#outline .node.sec');
      return {
        tag, focused, opened, expanded, binaryFocusable,
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
    check('binary rows stay focusable and right-clickable', rowKeys.binaryFocusable);
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
    // project in a way nothing in the UI would explain.
    check('the main file cannot be deleted', /main file/i.test(mainGuard.status) && mainGuard.survived,
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
      const file = () => rows().find(r => r.dataset.path && !r.dataset.path.includes('/')
        && !r.classList.contains('main'));

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
      await new Promise(r => setTimeout(r, 250));
      return { skipped: false, moved: included.dataset.path, into: dir.dataset.dir };
    })()`, true);
    if (inc.skipped) {
      check('a move that breaks an \\include asks first', true, 'no suitable file in this fixture');
    } else {
      check('a move that breaks an \\include asks first',
        dialogs.some(d => /\\input\/\\include|will break/i.test(d)),
        dialogs[0] ? dialogs[0].split('\n')[0] : 'no dialog was shown');
    }

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
