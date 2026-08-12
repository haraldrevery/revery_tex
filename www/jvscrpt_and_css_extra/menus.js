// Dropdown menus, in the house idiom: mono, uppercase, ■ for the active choice.
//
// One generic component driven by a spec, rather than a function per menu. The
// visual language is Revery Notebook's (menu-container / menu-item / ■□), but
// the structure is not — its version hand-builds every row, so a new setting
// means new DOM code, and the keyboard handling exists in some menus and not
// others.
//
// A menu is a list of rows:
//   { type: 'radio',  label, options: [{label, value}], get(), set(v) }
//   { type: 'action', label, run() }
//   { type: 'divider' }
//   { type: 'note',   label }        non-interactive, for stating a limitation
//
// Radio rows render as a label with the choices beneath, each prefixed ■ or □.
// That is deliberate rather than a submenu: submenus need hover intent, an open
// delay and edge flipping, and every one of those is a bug surface for a menu
// that has to hold seven settings.

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
    for (const m of [...OPEN]) if (!m.el.contains(e.target) && !m.button.contains(e.target)) m.close();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && OPEN.size) {
      const last = [...OPEN].pop();
      last.close();
      last.button.focus();
      e.stopPropagation();
    }
  });
  window.addEventListener('resize', closeAllMenus);
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
  bindGlobals();

  const el = document.createElement('div');
  el.className = 'menu-container';
  el.setAttribute('role', 'menu');
  el.hidden = true;
  document.body.appendChild(el);

  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');

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

  function render() {
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
    const r = button.getBoundingClientRect();
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
    button.setAttribute('aria-expanded', 'true');
    place();
    const first = items()[0];
    if (first) first.focus();
  }

  function close() {
    if (el.hidden) return;
    el.hidden = true;
    OPEN.delete(menu);
    button.setAttribute('aria-expanded', 'false');
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

  button.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); open(); }
  });

  return menu;
}
