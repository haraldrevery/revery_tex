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

async function main() {
  const { cdp, cleanup, pageErrors } = await launch({ url: BASE, port: CDP_PORT });
  try {
    cdp.on((msg) => {
      if (msg.method === 'Page.javascriptDialogOpening') {
        cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });
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
      const marked = choices.filter(t => t.startsWith('■'));
      // Choosing from the submenu must change the page, same as any other row.
      panel?.querySelector('.menu-item')?.click();
      const after = document.documentElement.getAttribute('data-theme');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { label, choices, marked, after, opened: !!panel };
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
