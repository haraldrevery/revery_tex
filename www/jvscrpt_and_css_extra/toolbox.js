// What the Toolbox button offers.
//
// The menu *spec* lives here rather than in the app shell, so adding an insert
// action is a change to this file and not to the 850-line shell. The shell only
// says which button it hangs off and how to reach the editor and the project.
//
// Everything here reads the one index and writes through editor_actions, so no
// feature in this menu scans project text or touches CodeMirror directly.

import { projectIndex, environmentsOfKind, resolveGraphic } from './document_model.js';
import {
  clipboardRows, formattingRows, commentRows, insertBlockAtCursor, insertReference
} from './editor_actions.js';
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

/**
 * Everything about an entry that is worth filtering on.
 *
 * The picker's filter box matches against this, so typing an author's surname,
 * a word from a title, a year or the cite key all find the same entry. The old
 * submenu could only be read down, and it showed a title cut at 40 characters —
 * on a bibliography of any size, finding the right paper meant knowing its key
 * already, which is exactly what a picker exists to avoid.
 */
export function citationSearchText(e) {
  return [
    e.key, e.author, e.editor, e.title, e.year, e.type,
    e.journal, e.booktitle, e.publisher, e.institution, e.school, e.doi
  ].filter(Boolean).join(' ');
}

/**
 * The handful of TeX escapes that actually turn up in a bibliography.
 *
 * Not a LaTeX interpreter, and deliberately not extensible. A `.bib` title is
 * source, and the honest default for source is to show it — but four escaped
 * punctuation marks and three logo macros account for very nearly everything
 * anyone has ever written in a real `title` field, and leaving `\&` on screen
 * in a list of references reads as a bug rather than as fidelity. Anything
 * outside this table is left exactly as written.
 */
/* Two details that are not arbitrary.

   No `\b` after the macro names. The real fixtures write `The {\TeX}book`, and
   scanBib strips braces on the way in — they are BibTeX's casing protection,
   not content — so this sees `The \TeXbook`. A word boundary would refuse to
   match before that `b` and leave the backslash on screen, which is what it did.

   Longest name first. `\LaTeXe` has to be taken before `\LaTeX`, and `\LaTeX`
   before `\TeX`, or each is eaten by the shorter one and leaves a stray tail. By
   the time the `\TeX` rule runs the LaTeX matches have already lost their
   backslash, so it cannot reach inside them. */
const TEX_TEXT = [
  [/\\LaTeXe/g, 'LaTeX2e'],
  [/\\LaTeX/g, 'LaTeX'],
  [/\\TeX/g, 'TeX'],
  [/\\([&%_#$])/g, '$1'],
  [/\s---\s/g, ' — '],          // {\LaTeX} --- {Wikipedia}
  [/(\w)--(\w)/g, '$1–$2']      // page ranges: 45--67
];

/** A bib field as prose: escapes resolved, whitespace collapsed. */
export function bibText(raw) {
  let s = String(raw || '');
  for (const [re, to] of TEX_TEXT) s = s.replace(re, to);
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * One entry as the three parts of a reference.
 *
 * Three strings rather than one, so the row can give the title and the source
 * different weight and so each part can be asserted on its own. Nothing is
 * truncated and no author is dropped for an "et al." — the list exists to show
 * the whole reference, which is what a 40-character card could never do.
 *
 * `source` is assembled from whichever fields the entry actually has, in the
 * order a reference reads: where it appeared, then where in it, then when, then
 * how to find it. An entry missing all of them yields an empty string rather
 * than a line of stray punctuation.
 */
export function formatReference(e = {}) {
  // An edited volume has no `author` at all — `@book{goossens1993, editor={…}}`
  // is the standard shape, and reading only `author` left every one of them
  // listed under no name. The "(eds.)" is what stops that reading as authorship.
  const names = (raw) => bibText(raw).split(/\s+and\s+/).filter(Boolean).join('; ');
  const authors = names(e.author) ||
    (names(e.editor) ? `${names(e.editor)} (eds.)` : '');
  const title = bibText(e.title);

  // Where it appeared. A work has at most one of these; `publisher` also rides
  // along for a book that names both its series and its publisher.
  const container = bibText(e.journal) || bibText(e.booktitle) ||
                    bibText(e.institution) || bibText(e.school);
  const publisher = bibText(e.publisher);

  // Where in it. "544(1)" and "544" both read correctly; "(1)" alone does not,
  // so an issue with no volume is dropped rather than shown bare.
  const volume = bibText(e.volume);
  const number = bibText(e.number);
  const at = volume ? `${volume}${number ? `(${number})` : ''}` : '';

  const parts = [
    [container, publisher].filter(Boolean).join(', '),
    bibText(e.edition) && `${bibText(e.edition)} ed.`,
    at,
    bibText(e.pages) && `pp. ${bibText(e.pages)}`,
    bibText(e.year)
  ].filter(Boolean);

  // The locator goes last and keeps its own separator: a DOI reads as an
  // address, not as another comma-separated fact about the work.
  const locator = e.doi ? `doi:${bibText(e.doi)}` : bibText(e.url);
  const source = [parts.join(', '), locator].filter(Boolean).join(' · ');

  return { authors, title, source };
}

/**
 * One row of the citation list: the full reference, in reading order.
 *
 * Rendered as text at the body size rather than as a card — see the
 * `layout: 'list'` branch of openPicker. There is nothing to re-fit when the
 * card size steps, which is why this passes no `onResize` hook.
 */
function paintCitation(e, mount) {
  mount.classList.add('cite-row');

  const line = (cls, text) => {
    if (!text) return;
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    mount.appendChild(d);
  };

  const { authors, title, source } = formatReference(e);

  // A bare \bibitem key carries no fields at all. Saying so is more useful than
  // an empty row that looks like a rendering failure.
  if (!authors && !title && !source) {
    line('cite-none', 'no bibliography entry — key only');
    return;
  }

  line('cite-authors', authors);
  line('cite-title', title);
  line('cite-source', source);
}

function citationPicker(view, project) {
  const ix = projectIndex(project());
  // Entries with parsed fields first; a \bibitem key with no metadata is still
  // citable, so keys without an entry are appended rather than dropped.
  const known = new Set(ix.bib.map(b => b.key));
  const entries = [
    ...ix.bib,
    ...ix.citations.filter(k => !known.has(k)).map(key => ({ key, author: '', title: '', year: '' }))
  ];

  openPicker({
    title: 'Insert citation',
    // A list, not the grid the figure and equation pickers use. A reference is
    // three lines of prose; a grid cell wide enough to hold one fits two to a
    // screen, and narrow enough to fit twelve truncates all of them.
    layout: 'list',
    items: entries,
    text: citationSearchText,
    // The key, because the key is what gets inserted. The reference beside it
    // is how you actually recognise the work.
    label: (e) => e.key,
    preview: paintCitation,
    empty: 'no bibliography entries found',
    onPick: (e) => insertReference(view(), 'citation', e.key)
  });
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
    { type: 'action', label: 'Insert citation…', run: () => citationPicker(view, project) }
  ];
}

/**
 * The Toolbox button's menu: inserting first, since that is why it is there.
 *
 * Commenting is here as well as in the right-click menu, not instead of it. The
 * right-click Toolbox is off by default — it costs spellcheck and Look Up — so a
 * row offered only there would be as hard to find as the Ctrl+/ it advertises.
 */
export function toolboxRows(ctx) {
  return [
    ...insertRows(ctx),
    { type: 'divider' },
    { type: 'note', label: 'Formatting applies to the selection.' },
    ...formattingRows(ctx.view),
    ...commentRows(ctx.view)
  ];
}

/**
 * The right-click menu: clipboard, then formatting, then inserting.
 *
 * Clipboard first because this menu *replaced* the browser's own, which had Cut,
 * Copy and Paste at the top — leaving them out did not remove a feature so much
 * as move it somewhere nobody would look. Formatting comes next: the menu opens
 * over a selection as often as not, and with text selected the likely intent is
 * to format it. Everything below is the same `insertRows` the Toolbox button
 * shows, which is what stops the two drifting into offering different things.
 *
 * @param {{view: () => object, project: () => object|null,
 *          report?: (msg: string, cls?: string) => void}} ctx
 */
export function contextRows(ctx) {
  return [
    ...clipboardRows(ctx.view, ctx.report),
    { type: 'divider' },
    ...formattingRows(ctx.view),
    // With the selection right there, commenting it out is the other thing this
    // menu is opened for. It sits with formatting because both act on what is
    // selected, above the divider that fences off the inserts.
    ...commentRows(ctx.view),
    { type: 'divider' },
    ...insertRows(ctx)
  ];
}
