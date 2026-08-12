// A small modal form, in the house idiom.
//
// Built for the table builder, but deliberately generic: a spec of fields in, a
// values object out, with an optional live preview of whatever the values will
// produce. The figure and citation pickers in the next phase want the same
// shell — backdrop, Escape, focus trap, one at a time — and two modals that
// each implement their own are two modals that disagree about dismissal.
//
// Fields:
//   { key, label, type: 'number', min, max, def }
//   { key, label, type: 'text', def, placeholder }
//   { key, label, type: 'check', def }
//   { key, label, type: 'choice', options: [{value, label}], def }
//
// Choices are buttons rather than <select> for the same reason the menus are:
// a native list draws the operating system's popup in system fonts, ignoring
// the theme entirely.

import { closeAllMenus } from './menus.js';

let current = null;

/** Close whatever dialog is open. Exported so a compile or a reload can clear it. */
export function closeDialog() {
  if (current) current.close();
}

export function dialogIsOpen() {
  return !!current;
}

/**
 * The modal shell: backdrop, title, Escape, focus trap, focus restored on close.
 *
 * Everything modal in the app goes through this — the table form below and the
 * figure picker in picker.js — so there is one answer to "what does Escape do"
 * and one place that remembers where focus came from.
 *
 * @param {{title: string, className?: string, onClose?: () => void,
 *          onKey?: (e: KeyboardEvent) => boolean}} opts
 *        onKey returns true when it has handled the key.
 * @returns {{panel: HTMLElement, body: HTMLElement, foot: HTMLElement, close: () => void}}
 */
export function openModal({ title, className = 'dlg', onClose, onKey }) {
  closeDialog();
  closeAllMenus();

  const back = document.createElement('div');
  back.className = 'dlg-backdrop';

  const panel = document.createElement('div');
  panel.className = className;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', title);

  const head = document.createElement('div');
  head.className = 'dlg-head';
  head.textContent = title;
  panel.appendChild(head);

  const body = document.createElement('div');
  body.className = 'dlg-body';
  panel.appendChild(body);

  const foot = document.createElement('div');
  foot.className = 'dlg-foot';

  back.appendChild(panel);
  document.body.appendChild(back);

  // Where focus was, so it can go back. A dialog that dumps you on <body> when
  // it closes costs a keyboard user their place in the document.
  const returnTo = document.activeElement;

  function close() {
    if (current !== api) return;
    current = null;
    document.removeEventListener('keydown', keyHandler, true);
    back.remove();
    if (onClose) onClose();
    if (returnTo && returnTo.isConnected) returnTo.focus();
  }

  function keyHandler(e) {
    if (onKey && onKey(e)) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    // Trap: Tab out of the last control goes to the first, not to the page
    // behind the backdrop, which is inert but still focusable.
    const focusable = [...panel.querySelectorAll('input, button')].filter(n => !n.disabled);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  }

  // Capture, so Escape reaches this before CodeMirror's own key handling.
  document.addEventListener('keydown', keyHandler, true);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });

  const api = { panel, body, foot, close };
  current = api;
  return api;
}

/**
 * A form.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {Array<object>} opts.fields
 * @param {(values: object) => string} [opts.preview]  text shown, live
 * @param {string} [opts.submitLabel]
 * @param {(values: object) => void} opts.onSubmit
 * @param {(values: object, key: string) => object} [opts.onChange]  derive fields
 *        from each other — the label field following the caption, say
 */
export function openDialog({ title, fields, preview, submitLabel = 'Insert', onSubmit, onChange }) {
  const values = {};
  for (const f of fields) values[f.key] = f.def;

  const modal = openModal({
    title,
    onKey: (e) => {
      // Enter in a text box means "do it", the way it does in every other form.
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
        e.preventDefault(); submit.click(); return true;
      }
      return false;
    }
  });
  const { panel, body, foot, close } = modal;

  const pre = preview ? document.createElement('pre') : null;
  if (pre) pre.className = 'dlg-preview';

  const inputs = new Map();

  /** Push `values` back into the controls — used when onChange derives one. */
  function syncInputs() {
    for (const [key, node] of inputs) {
      if (node.dataset.kind === 'choice') {
        for (const b of node.querySelectorAll('button')) {
          b.setAttribute('aria-pressed', String(b.dataset.value === String(values[key])));
        }
      } else if (node.type === 'checkbox') {
        node.checked = !!values[key];
      } else if (node.value !== String(values[key] ?? '')) {
        node.value = values[key] ?? '';
      }
    }
  }

  function changed(key) {
    if (onChange) Object.assign(values, onChange({ ...values }, key) || {});
    syncInputs();
    if (pre) pre.textContent = preview(values);
  }

  for (const f of fields) {
    const row = document.createElement('label');
    row.className = 'dlg-row';
    const name = document.createElement('span');
    name.className = 'dlg-label';
    name.textContent = f.label;
    row.appendChild(name);

    if (f.type === 'choice') {
      const group = document.createElement('div');
      group.className = 'dlg-choice';
      group.dataset.kind = 'choice';
      group.setAttribute('role', 'group');
      for (const opt of f.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.value = String(opt.value);
        b.textContent = opt.label;
        b.setAttribute('aria-pressed', String(opt.value === f.def));
        b.onclick = () => { values[f.key] = opt.value; changed(f.key); };
        group.appendChild(b);
      }
      row.appendChild(group);
      inputs.set(f.key, group);
    } else {
      const input = document.createElement('input');
      input.type = f.type === 'number' ? 'number' : f.type === 'check' ? 'checkbox' : 'text';
      if (f.type === 'number') {
        input.min = String(f.min ?? 1);
        input.max = String(f.max ?? 99);
        input.value = String(f.def);
      } else if (f.type === 'check') {
        input.checked = !!f.def;
      } else {
        input.value = f.def ?? '';
        if (f.placeholder) input.placeholder = f.placeholder;
      }
      input.oninput = () => {
        values[f.key] = f.type === 'number' ? Number(input.value)
          : f.type === 'check' ? input.checked
          : input.value;
        changed(f.key);
      };
      // A checkbox fires change, not input, in every browser that matters.
      if (f.type === 'check') input.onchange = input.oninput;
      row.appendChild(input);
      inputs.set(f.key, input);
    }
    body.appendChild(row);
  }

  if (pre) {
    pre.textContent = preview(values);
    panel.appendChild(pre);
  }

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => close();
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'primary';
  submit.textContent = submitLabel;
  submit.onclick = () => { const v = { ...values }; close(); onSubmit(v); };
  foot.append(cancel, submit);
  panel.appendChild(foot);

  panel.querySelector('input, button')?.focus();
  return modal;
}
