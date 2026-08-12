// Dropdown menus, in the house idiom: mono, uppercase, ■ for the active choice.
//
// One generic component driven by a spec, rather than a function per menu. The
// visual language is Revery Notebook's (menu-container / menu-item / ■□), but
// the structure is not — its version hand-builds every row, so a new setting
// means new DOM code, and the keyboard handling exists in some menus and not
// others.
//
// A menu is a list of rows:
//   { type: 'radio',   label, options: [{label, value}], get(), set(v) }
//   { type: 'stepper', ... }         − value + on one line, for scales
//   { type: 'submenu', ... }         a nested panel, for themes
//   { type: 'action',  label, run() }
//   { type: 'divider' }
//   { type: 'note',    label }       non-interactive, for stating a limitation
//
// Most rows are flat — a label with its choices beneath, each prefixed ■ or □ —
// because a submenu costs hover intent, an open delay and edge flipping, and
// every one of those is a bug surface. Themes get one anyway: four colour
// schemes are the least-changed setting here and do not deserve four permanent
// rows at the top of the menu.
//
// SelectMenu at the bottom replaces `<select>`, which draws the operating
// system's own popup in system fonts and cannot show the ■ marker.

const OPEN = new Set();

/** Close every open menu. Exported so a global Escape or a compile can clear them. */
export function closeAllMenus() {
  for (const m of OPEN) m.close();
}

let globalsBound = false;
function bindGlobals() {
  if (globalsBound) return;
  globalsBound = true;
  // Capture phase: a click on another menu's button must close this one before
  // that button's own handler decides whether to toggle itself open.
  document.addEventListener('mousedown', (e) => {
    for (const m of [...OPEN]) {
      if (m.el.contains(e.target)) continue;
      if (m.button && m.button.contains(e.target)) continue;
      m.close();
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && OPEN.size) {
      const last = [...OPEN].pop();
      last.close();
      // A context menu has no button to return focus to; leave focus wherever
      // it was, which for the editor is the text.
      last.button?.focus();
      e.stopPropagation();
    }
  });
  window.addEventListener('resize', closeAllMenus);
}

/**
 * The menu itself: rendering, keyboard handling, placement and dismissal.
 * Not exported — callers reach it through attachMenu or openMenuAt, which
 * differ only in what they anchor to.
 *
 * @param {() => Array<object>} spec  called on every open, so rows reflect
 *        current values without anyone having to remember to refresh them
 * @param {{align?, button?, anchor?, transient?}} [opts]
 */
function createMenu(spec, opts = {}) {
  bindGlobals();
  // A button is one kind of anchor. A context menu has none — it is positioned
  // at a point — so everything below treats it as optional rather than there
  // being two menu implementations that drift apart on focus and dismissal.
  const button = opts.button || null;

  const el = document.createElement('div');
  el.className = 'menu-container';
  el.setAttribute('role', 'menu');
  el.hidden = true;
  document.body.appendChild(el);

  button?.setAttribute('aria-haspopup', 'true');
  button?.setAttribute('aria-expanded', 'false');

  const menu = { el, button, close, open, toggle };

  function items() {
    return [...el.querySelectorAll('.menu-item:not([disabled])')];
  }

  /** Focus the row at `i`, clamped — used to survive a re-render. */
  function focusAt(i) {
    const list = items();
    if (!list.length) return;
    list[Math.max(0, Math.min(i, list.length - 1))].focus();
  }

  // Submenu panels are mounted on <body>, so they have to be taken down by
  // hand — clearing el.textContent would otherwise leave them orphaned there.
  const panels = [];
  function dropPanels() {
    for (const p of panels.splice(0)) p.remove();
  }

  function render() {
    dropPanels();
    el.textContent = '';
    for (const row of spec()) {
      if (row.type === 'divider') {
        const d = document.createElement('div');
        d.className = 'menu-divider';
        el.appendChild(d);
        continue;
      }
      if (row.type === 'note') {
        const n = document.createElement('div');
        n.className = 'menu-note';
        n.textContent = row.label;
        el.appendChild(n);
        continue;
      }
      if (row.type === 'submenu') {
        // A nested panel, opening sideways like Revery Notebook's. Used where a
        // setting has enough choices to crowd the parent — themes — without
        // being worth a stepper.
        const trigger = document.createElement('button');
        trigger.className = 'menu-item has-submenu';
        trigger.setAttribute('aria-haspopup', 'true');
        trigger.setAttribute('aria-expanded', 'false');
        const current = row.get ? row.get() : null;
        const chosen = (row.options || []).find(o => o.value === current);
        trigger.append(
          Object.assign(document.createElement('span'), { textContent: row.label }),
          Object.assign(document.createElement('span'), {
            className: 'menu-sub-value',
            textContent: `${chosen ? chosen.label : ''} \u25B8`
          })
        );

        // The panel lives on <body>, not inside the trigger. The parent menu
        // scrolls (overflow-y:auto for long menus), and an overflow container
        // clips any descendant positioned outside it — so a nested panel simply
        // never appears. Positioning it against the trigger's rect avoids that
        // entirely, the same way the parent menu is positioned.
        const panel = document.createElement('div');
        panel.className = 'submenu';
        panel.hidden = true;
        panel.setAttribute('role', 'menu');
        document.body.appendChild(panel);
        panels.push(panel);

        for (const opt of row.options || []) {
          const b = document.createElement('button');
          b.className = 'menu-item';
          b.setAttribute('role', 'menuitemradio');
          const active = opt.value === current;
          b.setAttribute('aria-checked', String(active));
          b.textContent = `${active ? '\u25A0' : '\u25A1'}  ${opt.label}`;
          // Focus returns to the trigger: the chosen row is about to be
          // rebuilt, and the trigger is where the user was.
          b.onclick = () => { row.set(opt.value); render(); items()[0]?.focus(); };
          panel.appendChild(b);
        }

        let closeTimer = null;
        const place = () => {
          const r = trigger.getBoundingClientRect();
          panel.style.top = `${Math.max(8, Math.min(r.top - 4, window.innerHeight - panel.offsetHeight - 8))}px`;
          // Opens leftwards, because the settings menu is already at the right
          // edge; flips to the right if there is no room on the left.
          const w = panel.offsetWidth;
          const left = r.left - w - 4;
          panel.style.left = `${left < 8 ? Math.min(r.right + 4, window.innerWidth - w - 8) : left}px`;
        };
        const show = (on) => {
          panel.hidden = !on;
          trigger.setAttribute('aria-expanded', String(on));
          if (on) place();
        };
        const cancelClose = () => { clearTimeout(closeTimer); closeTimer = null; };
        const scheduleClose = () => { closeTimer = setTimeout(() => show(false), 220); };
        // Both halves need the handlers now that they are not nested, and the
        // grace period covers the gap the pointer crosses between them.
        for (const el2 of [trigger, panel]) {
          el2.addEventListener('mouseenter', () => { cancelClose(); show(true); });
          el2.addEventListener('mouseleave', scheduleClose);
        }
        // Deliberately not opened on focus: arrow-keying down the menu would
        // pop a panel over the rows below, and a click straight after a focus
        // would then read as "close" and look broken.
        trigger.onclick = (e) => {
          e.preventDefault();
          show(panel.hidden);
          if (!panel.hidden) panel.querySelector('.menu-item')?.focus();
        };
        trigger.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault(); show(true); panel.querySelector('.menu-item')?.focus();
          }
        });
        panel.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowLeft') { e.preventDefault(); show(false); trigger.focus(); }
        });

        el.appendChild(trigger);
        continue;
      }

      if (row.type === 'stepper') {
        // A scale with 14 values is 14 rows as a radio list, which turns the
        // settings menu into a scrolling column where nothing is scannable.
        // As − value + it is one line, and the arrow-key order still walks
        // through the settings rather than through every percentage.
        const head = document.createElement('div');
        head.className = 'menu-head';
        head.textContent = row.label;
        el.appendChild(head);

        const wrap = document.createElement('div');
        wrap.className = 'menu-stepper';
        const i = row.options.findIndex(o => o.value === row.get());
        const at = i < 0 ? 0 : i;

        const step = (delta) => {
          const next = row.options[at + delta];
          if (next) { row.set(next.value); render(); focusAt(items().findIndex(b => b.dataset.step === String(delta))); }
        };
        for (const [delta, glyph] of [[-1, '−'], [1, '+']]) {
          const b = document.createElement('button');
          b.className = 'menu-item menu-step';
          b.dataset.step = String(delta);
          b.textContent = glyph;
          b.setAttribute('aria-label', `${row.label} ${delta < 0 ? 'smaller' : 'larger'}`);
          if (!row.options[at + delta]) b.disabled = true;
          b.onclick = () => step(delta);
          if (delta < 0) wrap.appendChild(b);
          else {
            const val = document.createElement('span');
            val.className = 'menu-value';
            val.textContent = row.options[at].label;
            wrap.appendChild(val);
            wrap.appendChild(b);
          }
        }
        el.appendChild(wrap);
        continue;
      }

      if (row.type === 'radio') {
        const head = document.createElement('div');
        head.className = 'menu-head';
        head.textContent = row.label;
        el.appendChild(head);

        const current = row.get();
        for (const opt of row.options) {
          const b = document.createElement('button');
          b.className = 'menu-item';
          b.setAttribute('role', 'menuitemradio');
          const active = opt.value === current;
          b.setAttribute('aria-checked', String(active));
          b.textContent = `${active ? '■' : '□'}  ${opt.label}`;
          // Re-render so every ■ in the menu reflects the new state, then put
          // focus back where it was. Without the restore, choosing an option
          // with the keyboard drops focus to the body, because the element that
          // had it no longer exists.
          b.onclick = () => { const at = items().indexOf(b); row.set(opt.value); render(); focusAt(at); };
          el.appendChild(b);
        }
        continue;
      }
      const b = document.createElement('button');
      b.className = 'menu-item';
      b.setAttribute('role', 'menuitem');
      b.textContent = row.label;
      b.onclick = () => { close(); row.run(); };
      el.appendChild(b);
    }
  }

  /**
   * Place the menu under its button, kept inside the viewport.
   *
   * Fixed positioning against the button's rect rather than an absolutely
   * positioned child, because the topbar clips overflow and a tall settings
   * menu would otherwise be cut off at the first row.
   */
  function place() {
    const r = opts.anchor ? opts.anchor() : button.getBoundingClientRect();
    el.style.position = 'fixed';
    el.style.top = `${r.bottom + 4}px`;
    el.style.maxHeight = `${Math.max(160, window.innerHeight - r.bottom - 16)}px`;
    el.style.left = 'auto';
    el.style.right = 'auto';
    // Measure after the width is known, then clamp to the window.
    const w = el.offsetWidth;
    let left = opts.align === 'right' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    el.style.left = `${left}px`;
  }

  function open() {
    if (!el.hidden) return;
    for (const m of [...OPEN]) m.close();
    render();
    el.hidden = false;
    OPEN.add(menu);
    button?.setAttribute('aria-expanded', 'true');
    place();
    const first = items()[0];
    if (first) first.focus();
  }

  function close() {
    if (el.hidden) return;
    dropPanels();
    el.hidden = true;
    OPEN.delete(menu);
    button?.setAttribute('aria-expanded', 'false');
    // A menu opened at a point is built per use; leaving them attached would
    // add a dead <div> to the document on every right-click.
    if (opts.transient) el.remove();
  }

  function toggle() { el.hidden ? open() : close(); }

  el.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = list[(i + step + list.length) % list.length];
      if (next) next.focus();
    } else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === 'Tab') { close(); }
  });

  return menu;
}

/**
 * Attach a dropdown to a button.
 *
 * @param {HTMLElement} button
 * @param {() => Array<object>} spec  called on every open, so rows reflect
 *        current values without anyone having to remember to refresh them
 * @param {{align?: 'left'|'right'}} [opts]
 */
export function attachMenu(button, spec, opts = {}) {
  const menu = createMenu(spec, { ...opts, button });
  button.addEventListener('click', (e) => { e.preventDefault(); menu.toggle(); });
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); menu.open(); }
  });
  return menu;
}

/**
 * Open a menu at a point — the right-click case.
 *
 * The same renderer, keyboard handling and dismissal as every other menu; only
 * the anchor differs. A separate context-menu component is how two menus end up
 * disagreeing about what Escape does.
 */
export function openMenuAt(x, y, spec, opts = {}) {
  const menu = createMenu(spec, {
    ...opts,
    transient: true,
    anchor: () => ({ top: y, bottom: y, left: x, right: x })
  });
  menu.open();
  return menu;
}

/**
 * A drop-down that behaves like `<select>` but looks like the rest of the app.
 *
 * A native `<select>` draws the operating system's own list — a white popup
 * with system fonts, in an app where every other control is mono, uppercase and
 * themed. It also cannot show the ■ marker the menus use. This keeps the same
 * `.value` / `.onchange` surface so call sites read the same.
 */
export class SelectMenu {
  /**
   * @param {HTMLElement} button
   * @param {{empty?: string}} [opts]  label shown when there are no options
   */
  constructor(button, { empty = '—' } = {}) {
    this.button = button;
    this.empty = empty;
    this.options = [];
    this._value = null;
    this.onchange = null;
    attachMenu(button, () => (this.options.length
      ? [{
          type: 'radio',
          label: button.dataset.label || '',
          options: this.options,
          get: () => this._value,
          set: (v) => { this.value = v; if (this.onchange) this.onchange(v); closeAllMenus(); }
        }]
      : [{ type: 'note', label: 'nothing to choose yet' }]));
    this._paint();
  }

  setOptions(list) {
    this.options = list.map(o => (typeof o === 'string' ? { label: o, value: o } : o));
    // Keep the current value if it survived; otherwise take the first, which is
    // what a <select> does when its options are replaced.
    if (!this.options.some(o => o.value === this._value)) {
      this._value = this.options.length ? this.options[0].value : null;
    }
    this._paint();
  }

  get value() { return this._value ?? ''; }

  set value(v) {
    if (!this.options.some(o => o.value === v)) return;
    this._value = v;
    this._paint();
  }

  _paint() {
    const chosen = this.options.find(o => o.value === this._value);
    this.button.textContent = `${chosen ? chosen.label : this.empty} ▾`;
    this.button.disabled = this.options.length === 0;
  }
}
