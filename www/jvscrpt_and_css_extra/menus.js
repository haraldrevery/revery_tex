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
//   { type: 'submenu', ... }         a nested panel: `options` for a choice
//                                    (themes), `actions` for a list (tables)
//   { type: 'toggle',  label, on, off, get(), set(v) }   one ■/□ row
//   { type: 'action',  label, run() }
//   { type: 'divider' }
//   { type: 'note',    label }       non-interactive, for stating a limitation
//
// A setting with two choices is a toggle, one with several is a submenu, and a
// scale is a stepper — so what is left as a flat headed list is the case where
// neither shape fits. The flat list is still the honest default: a submenu costs
// hover intent, an open delay and edge flipping, and every one of those is a bug
// surface. It is worth paying where the choices would otherwise crowd out
// everything else (four themes, eight backgrounds), and not worth paying for two.
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
      // A submenu panel belongs to this menu even though it lives on <body>.
      // Without this, pressing a submenu row closes the parent, which removes
      // the panel — and the row is gone before the browser can deliver the
      // click, so the row's action never runs. Every submenu in the app was
      // unusable with a real mouse: Reference a table, Insert citation, and
      // the theme picker. Tests missed it because el.click() fires no
      // mousedown at all; see realClick in test/run_ui.js.
      if (m.panels?.some(p => p.contains(e.target))) continue;
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

  // Submenu panels are mounted on <body>, so they are not inside `el` and the
  // outside-click check below cannot find them by containment. The menu has to
  // carry them, or pressing a submenu row dismisses the menu it belongs to.
  const panels = [];

  const menu = { el, button, panels, close, open, toggle };

  function items() {
    return [...el.querySelectorAll('.menu-item:not([disabled])')];
  }

  /** Focus the row at `i`, clamped — used to survive a re-render. */
  function focusAt(i) {
    const list = items();
    if (!list.length) return;
    list[Math.max(0, Math.min(i, list.length - 1))].focus();
  }

  // They also have to be taken down by hand — clearing el.textContent would
  // otherwise leave them orphaned on <body>.
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
            // `hint` is for panels that are a list rather than a choice \u2014 how
            // many tables there are to reference, say, where there is no
            // "current value" to echo back.
            textContent: `${chosen ? chosen.label : (row.hint ?? '')} \u25B8`
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

        // A submenu can equally be a *list* — the tables you could reference —
        // where each row does something once rather than selecting a value that
        // stays selected. Same panel, same keyboard handling; only the row
        // semantics differ, which is why this is not a second component.
        for (const act of row.actions || []) {
          const b = document.createElement('button');
          b.className = 'menu-item';
          b.setAttribute('role', 'menuitem');
          b.textContent = act.label;
          if (act.title) b.title = act.title;
          b.onclick = () => { close(); button?.focus(); act.run(); };
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

      if (row.type === 'toggle') {
        // Two choices as one row, Revery Notebook's idiom. As a headed list this
        // is three lines to say one thing, and the head repeats what the two
        // options already spell out.
        const b = document.createElement('button');
        b.className = 'menu-item menu-toggle';
        // menuitemcheckbox, not menuitemradio: there is one control here whose
        // state is on or off, not two controls of which one is chosen.
        b.setAttribute('role', 'menuitemcheckbox');
        const on = row.get() === row.on;
        b.setAttribute('aria-checked', String(on));
        b.append(
          Object.assign(document.createElement('span'), {
            className: 'menu-item-check', textContent: on ? '■' : '□'
          }),
          Object.assign(document.createElement('span'), { textContent: row.label })
        );
        // Same focus restore as the radio rows below: render() replaces the
        // element that has focus, and without this the keyboard user is dropped
        // to the body mid-menu.
        b.onclick = () => {
          const at = items().indexOf(b);
          row.set(on ? row.off : row.on);
          render();
          focusAt(at);
        };
        el.appendChild(b);
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
      // An action that cannot do anything right now — Copy with no selection —
      // is shown rather than hidden, so the menu keeps the same shape and the
      // rows do not move under the pointer between one opening and the next.
      // `title` is where the reason goes.
      if (row.disabled) {
        b.disabled = true;
        b.setAttribute('aria-disabled', 'true');
        if (row.title) b.title = row.title;
      } else {
        // Focus back to the trigger before the action runs, as Escape already
        // does above. `close()` only hides the menu, so without this the focus
        // stays on a row that is now invisible: calling .focus() on it does
        // nothing and focus falls to <body>. That is invisible for a row that
        // toggles a setting, and costs a keyboard user their place for a row
        // that opens a dialog — the dialog records document.activeElement to
        // return focus to, and would record the hidden row.
        b.onclick = () => { close(); button?.focus(); row.run(); };
        if (row.title) b.title = row.title;
      }
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

  /**
   * @param {Array} list
   * @param {{allowNone?: boolean}} [opts]  when true, a menu that has nothing
   *        selected stays that way instead of adopting the first option.
   *        For a list you choose *from* rather than a value that is always set:
   *        the recent-projects list is offered before any project is open, and
   *        auto-selecting there would put a project's name on the button while
   *        that project is not open. The engine and document menus always have
   *        a current value, so they keep the <select> behaviour.
   */
  setOptions(list, { allowNone = false } = {}) {
    this.options = list.map(o => (typeof o === 'string' ? { label: o, value: o } : o));
    // Keep the current value if it survived; otherwise take the first, which is
    // what a <select> does when its options are replaced.
    if (!this.options.some(o => o.value === this._value)) {
      this._value = (allowNone && this._value === null) || !this.options.length
        ? null
        : this.options[0].value;
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
