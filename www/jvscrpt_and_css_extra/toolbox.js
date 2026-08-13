// What the Toolbox button offers.
//
// The menu *spec* lives here rather than in the app shell, so adding an insert
// action is a change to this file and not to the 850-line shell. The shell only
// says which button it hangs off and how to reach the editor and the project.
//
// Everything here reads the one index and writes through editor_actions, so no
// feature in this menu scans project text or touches CodeMirror directly.

import { projectIndex, environmentsOfKind, resolveGraphic } from './document_model.js';
import { formattingRows, insertBlockAtCursor, insertReference } from './editor_actions.js';
import { tableBlock, availableRules } from './table_builder.js';
import { slug, uniqueLabel, figureBlock, equationBlock } from './latex_snippets.js';
import { openDialog } from './dialog.js';
import { openPicker } from './picker.js';
import { renderMath, mathSource, shrinkToFit } from './math_preview.js';

/** One line of an environment's source, for the tooltip on a reference row. */
function snippet(env, lines = 3) {
  return env.source.split('\n').slice(0, lines).join('\n').slice(0, 300);
}

/** How a table is named in a list: its caption, falling back to its label. */
export function tableRowLabel(env) {
  const caption = (env.caption || '').replace(/\s+/g, ' ').trim();
  const shown = caption || env.label || '(untitled)';
  return shown.length > 44 ? `${shown.slice(0, 43)}…` : shown;
}

function insertTableDialog(view, project) {
  const ix = projectIndex(project());
  const rules = availableRules(ix.packages);
  // True once the label box has been typed in: after that the caption stops
  // overwriting it, or every keystroke in the caption would undo the edit.
  let labelEdited = false;

  openDialog({
    title: 'Insert table',
    fields: [
      { key: 'rows', label: 'Rows', type: 'number', def: 3, min: 1, max: 60 },
      { key: 'cols', label: 'Columns', type: 'number', def: 3, min: 1, max: 20 },
      { key: 'header', label: 'Header row', type: 'check', def: true },
      {
        key: 'align', label: 'Align', type: 'choice', def: 'l',
        options: [{ value: 'l', label: 'Left' }, { value: 'c', label: 'Centre' }, { value: 'r', label: 'Right' }]
      },
      // Booktabs appears only when the document already loads it — see
      // table_builder.js. The menu never offers what would need a new
      // \usepackage line.
      { key: 'rules', label: 'Rules', type: 'choice', def: rules[0].value, options: rules },
      { key: 'caption', label: 'Caption', type: 'text', def: '', placeholder: 'optional' },
      { key: 'label', label: 'Label', type: 'text', def: '', placeholder: 'tab:…' }
    ],
    onChange: (v, key) => {
      if (key === 'label') { labelEdited = true; return null; }
      if (key !== 'caption' || labelEdited) return null;
      // The label follows the caption, deduplicated against the whole project:
      // two \label{tab:results} make every \ref to them ambiguous, and LaTeX
      // only warns about it.
      return { label: v.caption ? uniqueLabel(`tab:${slug(v.caption)}`, ix.labels) : '' };
    },
    preview: (v) => tableBlock(v),
    onSubmit: (v) => insertBlockAtCursor(view(), tableBlock(v))
  });
}

/** The reference-a-table submenu: existing tables, by caption and label. */
function tableReferenceRow(view, project) {
  const tables = environmentsOfKind(project(), 'table');
  const labelled = tables.filter(t => t.label);

  if (!tables.length) return { type: 'note', label: 'no tables to reference yet' };
  if (!labelled.length) {
    // A \ref to an unlabelled table cannot be written, and offering rows that
    // insert \ref{} would be worse than saying why the list is empty.
    return { type: 'note', label: `${tables.length} table(s), none labelled` };
  }

  return {
    type: 'submenu',
    label: 'Reference a table',
    hint: String(labelled.length),
    actions: labelled.map(t => ({
      label: tableRowLabel(t),
      title: `${t.label} — ${t.file}:${t.startLine}\n\n${snippet(t)}`,
      run: () => insertReference(view(), 'table', t.label)
    }))
  };
}

/* ── figures ─────────────────────────────────────────────────────────── */

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf'
};

/** A filename as a first draft of a caption: `chalmers_logo.png` → `Chalmers logo`. */
export function captionFromPath(path) {
  const base = (path.split('/').pop() || '').replace(/\.[^.]+$/, '');
  const words = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

/**
 * The images worth offering as figures.
 *
 * A `.pdf` beside a `.tex` of the same name is that document's own compiled
 * output — every fixture here has several — and offering `main.pdf` as an
 * illustration for `main.tex` is never what anyone meant.
 */
export function figureCandidates(project, index) {
  return index.images.filter(img => {
    if (!/\.pdf$/i.test(img.path)) return true;
    return !project.files.has(img.path.replace(/\.pdf$/i, '.tex'));
  });
}

/** Draw an image file into a card, from the bytes already in memory. */
function paintThumb(project, path, mount, blobUrl) {
  const file = project.files.get(path);
  const ext = (path.split('.').pop() || '').toLowerCase();
  // A PDF figure cannot go in an <img>. Rendering it would mean a second pdf.js
  // instance for a thumbnail; the extension is more honest than a broken image.
  if (!file || ext === 'pdf' || !file.content || typeof file.content === 'string') {
    mount.classList.add('picker-noimage');
    mount.textContent = ext.toUpperCase() || 'FILE';
    return;
  }
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = path;
  img.src = blobUrl(file.content, MIME[ext] || 'application/octet-stream');
  img.onerror = () => { mount.classList.add('picker-noimage'); mount.textContent = ext.toUpperCase(); };
  mount.appendChild(img);
}

function insertFigurePicker(view, project) {
  const p = project();
  const ix = projectIndex(p);
  const images = figureCandidates(p, ix);

  openPicker({
    title: 'Insert figure',
    items: images,
    text: (img) => img.path,
    label: (img) => img.path.split('/').pop(),
    preview: (img, mount, { blobUrl }) => paintThumb(p, img.path, mount, blobUrl),
    empty: 'no image files in this project',
    onPick: (img) => {
      const caption = captionFromPath(img.path);
      insertBlockAtCursor(view(), figureBlock({
        path: img.path,
        caption,
        label: uniqueLabel(`fig:${slug(img.path)}`, ix.labels)
      }));
    }
  });
}

function referenceFigurePicker(view, project) {
  const p = project();
  const figures = environmentsOfKind(p, 'figure').filter(f => f.label);

  openPicker({
    title: 'Reference a figure',
    items: figures,
    text: (f) => `${f.caption ? f.caption.replace(/\s+/g, ' ') : ''} ${f.label}`.trim(),
    label: (f) => (f.caption ? f.caption.replace(/\s+/g, ' ') : f.label),
    preview: (f, mount, { blobUrl }) => {
      const path = resolveGraphic(p, f.graphic);
      if (!path) { mount.classList.add('picker-noimage'); mount.textContent = 'no image'; return; }
      paintThumb(p, path, mount, blobUrl);
    },
    empty: 'no labelled figures to reference',
    onPick: (f) => insertReference(view(), 'figure', f.label)
  });
}

/* ── equations ───────────────────────────────────────────────────────── */

/**
 * `\eqref` needs amsmath. Without it the command does not exist and the
 * document fails to compile — so a document that has not loaded amsmath gets a
 * plain `\ref`, which is correct everywhere. Same rule as booktabs.
 */
const refKindForEquations = (packages) =>
  packages.includes('amsmath') || packages.includes('mathtools') ? 'equation' : 'ref';

function insertEquationDialog(view, project) {
  const ix = projectIndex(project());
  let labelEdited = false;

  openDialog({
    title: 'Insert equation',
    fields: [
      { key: 'body', label: 'Equation', type: 'text', def: '', placeholder: 'E = mc^2' },
      { key: 'numbered', label: 'Numbered', type: 'check', def: true },
      { key: 'label', label: 'Label', type: 'text', def: '', placeholder: 'eq:…' }
    ],
    onChange: (v, key) => {
      if (key === 'label') { labelEdited = true; return null; }
      if (key !== 'body' || labelEdited) return null;
      return { label: v.body ? uniqueLabel(`eq:${slug(v.body)}`, ix.labels) : '' };
    },
    // KaTeX, not the document's own typesetting — see math_preview.js. It is
    // fed the project's \newcommand definitions so a preview of notation the
    // document defines is not wrong in exactly the documents that define it.
    renderPreview: (v, mount) => {
      renderMath(v.body || '\\;', mount, { macros: ix.macros, display: true });
    },
    onSubmit: (v) => insertBlockAtCursor(view(), equationBlock(v))
  });
}

function referenceEquationPicker(view, project) {
  const p = project();
  const ix = projectIndex(p);
  const all = environmentsOfKind(p, 'equation');
  const labelled = all.filter(e => e.label);
  const kind = refKindForEquations(ix.packages);

  openPicker({
    title: 'Reference an equation',
    items: labelled,
    text: (e) => `${e.label} ${mathSource(e).replace(/\s+/g, ' ')}`,
    label: (e) => e.label,
    // No equation number on the card: KaTeX numbers from its own counter, and
    // a "(3)" here that the PDF disagrees with is worse than none.
    preview: (e, mount) => { renderMath(mathSource(e), mount, { macros: ix.macros, fit: true }); },
    // `fit` bakes a scale computed against the card as it was, so a card that
    // grows shows the same small equation in a bigger box. The figure pickers
    // need no hook: an <img> is max-width/max-height and re-fits itself.
    onResize: (e, mount) => shrinkToFit(mount),
    empty: all.length
      ? `${all.length} equation(s), none labelled — add a \\label to reference one`
      : 'no equations to reference yet',
    onPick: (e) => insertReference(view(), kind, e.label)
  });
}

/* ── citations ───────────────────────────────────────────────────────── */

/** `Smith, Jane and Doe, John` → `Smith et al.` — enough to tell entries apart. */
export function citationRowLabel(entry) {
  const first = (entry.author || '').split(' and ')[0].split(',')[0].trim();
  const many = (entry.author || '').includes(' and ');
  const who = first ? `${first}${many ? ' et al.' : ''}` : entry.key;
  const year = entry.year ? ` ${entry.year}` : '';
  const title = (entry.title || '').replace(/\s+/g, ' ');
  const head = `${who}${year}`;
  return title ? `${head} — ${title.slice(0, 40)}${title.length > 40 ? '…' : ''}` : head;
}

function citationRow(view, project) {
  const ix = projectIndex(project());
  // Entries with parsed fields first; a \bibitem key with no metadata is still
  // citable, so keys without an entry are appended rather than dropped.
  const known = new Set(ix.bib.map(b => b.key));
  const entries = [
    ...ix.bib,
    ...ix.citations.filter(k => !known.has(k)).map(key => ({ key, author: '', title: '', year: '' }))
  ];

  if (!entries.length) return { type: 'note', label: 'no bibliography entries found' };

  return {
    type: 'submenu',
    label: 'Insert citation',
    hint: String(entries.length),
    actions: entries.map(e => ({
      label: citationRowLabel(e),
      title: `${e.key}${e.title ? `\n\n${e.title}` : ''}${e.author ? `\n${e.author}` : ''}`,
      run: () => insertReference(view(), 'citation', e.key)
    }))
  };
}

/**
 * The insert half of the menu — everything that puts new LaTeX in the document.
 *
 * @param {{view: () => object, project: () => object|null}} ctx
 */
export function insertRows({ view, project }) {
  return [
    { type: 'action', label: 'Insert figure…', run: () => insertFigurePicker(view, project) },
    { type: 'action', label: 'Reference a figure…', run: () => referenceFigurePicker(view, project) },
    { type: 'action', label: 'Insert table…', run: () => insertTableDialog(view, project) },
    tableReferenceRow(view, project),
    { type: 'action', label: 'Insert equation…', run: () => insertEquationDialog(view, project) },
    { type: 'action', label: 'Reference an equation…', run: () => referenceEquationPicker(view, project) },
    citationRow(view, project)
  ];
}

/** The Toolbox button's menu: inserting first, since that is why it is there. */
export function toolboxRows(ctx) {
  return [
    ...insertRows(ctx),
    { type: 'divider' },
    { type: 'note', label: 'Formatting applies to the selection.' },
    ...formattingRows(ctx.view)
  ];
}

/**
 * The right-click menu: the same rows, formatting first.
 *
 * It only opens over a selection (see the app shell), and with text selected
 * the likely intent is to format it — so that half goes on top. Both menus are
 * built from the same two pieces, which is what stops them drifting into
 * offering different things.
 */
export function contextRows(ctx) {
  return [
    ...formattingRows(ctx.view),
    { type: 'divider' },
    ...insertRows(ctx)
  ];
}
