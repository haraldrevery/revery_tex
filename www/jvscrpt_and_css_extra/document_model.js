// What the project contains, scanned once.
//
// The single index. Completions, the outline and every picker read from here;
// nothing else scans project text. That rule is the point: the alternative is
// each feature running its own `matchAll` over every file on every keystroke,
// which is both slow and how two features end up disagreeing about how many
// figures the document has.
//
// It is regex over comment-stripped text, not a parser. LaTeX is not regular,
// so nested environments and verbatim blocks will eventually be read wrong.
// That is acceptable for an *index* — a missed figure is a missing card, not a
// broken document — and it must never become the thing that decides what to
// compile.

// The include graph lives in project_store.js, not here, because `describe()`
// needs it too and this module already depends on that one — the other
// direction would be a cycle.
import { stripTexComments, resolveInput, documentOrder } from './project_store.js';

/** Environments worth indexing, and what kind of thing each is. */
const ENVIRONMENTS = {
  figure: 'figure', 'figure*': 'figure',
  table: 'table', 'table*': 'table', longtable: 'table',
  equation: 'equation', 'equation*': 'equation',
  align: 'equation', 'align*': 'equation',
  gather: 'equation', 'gather*': 'equation',
  multline: 'equation', 'multline*': 'equation',
  eqnarray: 'equation', 'eqnarray*': 'equation'
};

const SECTION_LEVELS = {
  part: 0, chapter: 1, section: 2, subsection: 3,
  subsubsection: 4, paragraph: 5, subparagraph: 6
};

const IMAGE_EXT = /\.(png|jpe?g|pdf|gif|bmp|webp|svg)$/i;

const EMPTY = {
  labels: [], labelInfo: [], citations: [], files: [], bib: [],
  environments: [], sections: [], images: [], macros: {},
  packages: [], inputs: {}, order: []
};

/* ── braces ──────────────────────────────────────────────────────────── */

/**
 * Read a `{…}` group starting at `open`, respecting nesting.
 *
 * A regex cannot do this: `\caption{a {b} c}` truncates at the first `}`, and
 * captions containing maths or `\textbf{…}` are the common case rather than the
 * exotic one.
 */
function readGroup(text, open) {
  if (text[open] !== '{') return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }          // skip an escaped brace
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { body: text.slice(open + 1, i), end: i };
  }
  return null;
}

/**
 * A heading's argument as a person would read it.
 *
 * Formatting commands go, but escaped characters must come back: a section
 * called `Multi-Row \& Multi-Column` is displayed with the backslash otherwise,
 * which looks like a bug in the outline rather than correct TeX in the source.
 */
function plainTitle(body) {
  return body
    .replace(/\\\\/g, ' ')                  // line break inside a title
    .replace(/\\[a-zA-Z]+\s*/g, '')         // \textbf, \emph, …
    .replace(/\\([&%$#_{}])/g, '$1')        // \& \% \_ … are literal characters
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The argument of the first `\cmd{…}` in `text`, or null. */
function firstArg(text, cmd) {
  const at = text.search(new RegExp(`\\\\${cmd}\\s*(?:\\[[^\\]]*\\])?\\s*\\{`));
  if (at < 0) return null;
  const open = text.indexOf('{', at);
  const g = readGroup(text, open);
  return g ? g.body.trim() : null;
}

/* ── per-file scanning ───────────────────────────────────────────────── */

const lineOf = (offsets, index) => {
  // Binary search the line-start table: a 5000-line file scanned linearly per
  // environment is O(n²) on exactly the documents that need this most.
  let lo = 0, hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;   // 1-based, as CodeMirror counts
};

function lineOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') offsets.push(i + 1);
  return offsets;
}

/**
 * The fields the citation list assembles a reference from.
 *
 * Everything past `year` was added when the picker stopped being a row of
 * truncated cards and became a list of full references — a journal article
 * without its journal, volume and pages is not a reference, it is a hint. The
 * `field` reader below is generic, so this is a list rather than new parsing.
 *
 * Still deliberately shallow: no crossrefs, no @string expansion, no month
 * normalisation. It reads what is written in the entry.
 */
const BIB_FIELDS = [
  // `editor` is not a nicety: an edited volume carries no `author` at all, so
  // without it a whole class of entries lists under no name whatsoever.
  'author', 'editor', 'title', 'year',
  'journal', 'booktitle', 'publisher', 'institution', 'school',
  'volume', 'number', 'pages', 'edition', 'doi', 'url'
];

/** Entry types that are directives to BibTeX, not works anyone can cite. */
const BIB_NON_ENTRIES = new Set(['comment', 'preamble', 'string', 'control']);

/**
 * BibTeX entries with the fields worth showing in a picker.
 * Deliberately shallow: enough to tell two papers apart, not a .bib parser.
 */
function scanBib(text, out) {
  for (const m of text.matchAll(/@(\w+)\s*\{\s*([^,\s}]+)\s*,/g)) {
    const type = m[1].toLowerCase();
    // `control` belongs here as much as the other three: REVTeX bibliographies
    // open with `@CONTROL{apsrev42Control,author="08",…}`, which was being
    // listed as a citable work by someone called "08".
    if (BIB_NON_ENTRIES.has(type)) continue;
    const key = m[2];
    // The entry body runs to the matching close brace of the @type{ group.
    const g = readGroup(text, text.indexOf('{', m.index));
    const body = g ? g.body : text.slice(m.index, m.index + 600);
    const field = (name) => {
      const f = new RegExp(`\\b${name}\\s*=\\s*[{"]?`).exec(body);
      if (!f) return '';
      const at = f.index + f[0].length - 1;
      if (body[at] === '{') { const v = readGroup(body, at); return v ? v.body.trim() : ''; }
      const q = /^"([^"]*)"/.exec(body.slice(at));
      if (q) return q[1].trim();
      return (/^\s*([^,\n}]+)/.exec(body.slice(f.index + f[0].length)) || [, ''])[1].trim();
    };
    // Braces are stripped from every field, not just author and title: they are
    // BibTeX's casing protection ({LaTeX}) and grouping, never content.
    const entry = { key, type };
    for (const name of BIB_FIELDS) entry[name] = field(name).replace(/[{}]/g, '');
    out.push(entry);
  }
}

function scanFile(path, raw, acc) {
  const text = stripTexComments(raw);
  const offsets = lineOffsets(text);

  for (const m of text.matchAll(/\\label\{([^}]+)\}/g)) {
    acc.labels.add(m[1]);
    // Where it is, so a \ref dropdown can say what the key actually refers to.
    // What it *labels* cannot be decided here — the environment it sits inside
    // may not have been scanned yet — so that is resolved in scanProject once
    // every file's environments and sections are known.
    acc.labelSites.push({ label: m[1], file: path, line: lineOf(offsets, m.index) });
  }
  for (const m of text.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g)) acc.citations.add(m[1]);
  scanBib(text, acc.bib);
  for (const b of acc.bib) acc.citations.add(b.key);

  // Sections, for the outline.
  for (const m of text.matchAll(/\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{/g)) {
    const g = readGroup(text, text.indexOf('{', m.index + m[0].length - 1));
    if (!g) continue;
    acc.sections.push({
      level: SECTION_LEVELS[m[1]],
      title: plainTitle(g.body),
      file: path,
      line: lineOf(offsets, m.index)
    });
  }

  // Environments worth referencing.
  for (const m of text.matchAll(/\\begin\{([a-zA-Z*]+)\}/g)) {
    const kind = ENVIRONMENTS[m[1]];
    if (!kind) continue;
    const close = text.indexOf(`\\end{${m[1]}}`, m.index);
    if (close < 0) continue;                     // unterminated: skip, do not guess
    const source = text.slice(m.index, close + `\\end{${m[1]}}`.length);
    acc.environments.push({
      kind,
      env: m[1],
      label: firstArg(source, 'label'),
      caption: firstArg(source, 'caption'),
      graphic: kind === 'figure' ? firstArg(source, 'includegraphics') : null,
      file: path,
      startLine: lineOf(offsets, m.index),
      endLine: lineOf(offsets, close),
      source
    });
  }

  // Which packages the document loads. Read, never written: the app offers
  // booktabs rules when booktabs is already there and plain \hline when it is
  // not, rather than adding a \usepackage to someone's preamble behind them.
  for (const m of text.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    for (const name of m[1].split(',')) {
      const n = name.trim();
      if (n) acc.packages.add(n);
    }
  }

  // What this file pulls in, in order — the document's reading order, which is
  // not the same as the order the files happen to sit in the project map.
  // `\includegraphics` and `\includeonly` do not match: neither has `{` directly
  // after the command name.
  for (const m of text.matchAll(/\\(?:input|include)\s*\{([^}]*)\}/g)) {
    (acc.inputs[path] ??= []).push(m[1].trim());
  }

  // Macros, so a maths preview can be told what the document defines.
  for (const m of text.matchAll(/\\(?:re)?newcommand\s*\{?\\([a-zA-Z@]+)\}?\s*(?:\[(\d+)\])?\s*\{/g)) {
    const g = readGroup(text, text.indexOf('{', m.index + m[0].length - 1));
    if (g) acc.macros[`\\${m[1]}`] = g.body;
  }
  for (const m of text.matchAll(/\\DeclareMathOperator\s*\*?\s*\{?\\([a-zA-Z@]+)\}?\s*\{([^}]*)\}/g)) {
    acc.macros[`\\${m[1]}`] = `\\operatorname{${m[2]}}`;
  }
}

/* ── the index ───────────────────────────────────────────────────────── */

/**
 * What each `\label` in the project actually labels.
 *
 * A bare key is close to useless in a dropdown — `eq:3` and `fig:3` say nothing
 * about which equation or which figure, which is the whole reason people keep a
 * second window open on the PDF while writing `\ref`. Every label therefore
 * carries the caption or heading it sits under.
 *
 * Resolved by containment rather than by proximity: the innermost environment
 * whose span covers the label wins, because a `\label` inside a subfigure
 * belongs to the subfigure and not to the figure around it. Only if no
 * environment contains it does the nearest preceding heading apply — that is
 * the `\section{…}\label{sec:…}` case.
 *
 * @returns {Array<{label, file, line, kind, title}>} sorted by label
 */
function describeLabels(acc) {
  const out = [];
  for (const site of acc.labelSites) {
    let kind = null, title = '';

    let best = null;
    for (const e of acc.environments) {
      if (e.file !== site.file) continue;
      if (site.line < e.startLine || site.line > e.endLine) continue;
      // Innermost: the one that starts latest still contains the label.
      if (!best || e.startLine > best.startLine) best = e;
    }
    if (best) {
      kind = best.kind;
      title = best.caption || '';
    } else {
      let head = null;
      for (const s of acc.sections) {
        if (s.file !== site.file || s.line > site.line) continue;
        if (!head || s.line > head.line) head = s;
      }
      if (head) { kind = 'section'; title = head.title || ''; }
    }

    out.push({ ...site, kind, title });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export function scanProject(project) {
  if (!project) return EMPTY;

  const acc = {
    labels: new Set(), labelSites: [], citations: new Set(), bib: [],
    environments: [], sections: [], images: [], macros: {}, inputs: {},
    packages: new Set()
  };
  const files = [];

  for (const [path, f] of project.files) {
    files.push(path);
    if (f.binary || typeof f.content !== 'string') {
      if (IMAGE_EXT.test(path)) {
        acc.images.push({ path, ext: (path.split('.').pop() || '').toLowerCase() });
      }
      continue;
    }
    scanFile(path, f.content, acc);
  }

  return {
    labels: [...acc.labels].sort(),
    labelInfo: describeLabels(acc),
    citations: [...acc.citations].sort(),
    files: files.sort(),
    bib: acc.bib,
    environments: acc.environments,
    sections: acc.sections,
    images: acc.images.sort((a, b) => a.path.localeCompare(b.path)),
    macros: acc.macros,
    packages: [...acc.packages].sort(),
    inputs: acc.inputs,
    // `main` is set by project_store; the fallback keeps scanProject usable on
    // a bare {files} map, as the tests use it.
    // The scan above already recorded what each file pulls in, so the walk is
    // handed that map rather than re-reading every source for it.
    order: documentOrder(project.main || (project.files.has('main.tex') ? 'main.tex' : null),
                         project.files, (p) => acc.inputs[p])
  };
}

let cache = { sig: null, data: null };

/**
 * A cheap content fingerprint.
 *
 * Length alone used to be the whole signature, and it is wrong in exactly the
 * case this index exists for: renaming `\label{fig:aa}` to `\label{fig:ab}`
 * does not change the length, so the cache was never invalidated and the \ref
 * dropdown went on offering a key the document no longer defines. A rolling
 * hash costs one pass over the buffer and catches it.
 *
 * Not a cryptographic digest — a collision serves a stale index for one edit,
 * which is what the old code did on *every* same-length edit.
 */
function fingerprint(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The index for a project, cached.
 *
 * The signature changes whenever any buffer's contents change, and it includes
 * the project key so switching projects cannot serve the previous one's index.
 */
export function projectIndex(project) {
  if (!project) return EMPTY;
  let sig = project.key + '|';
  for (const [p, f] of project.files) {
    sig += typeof f.content === 'string'
      ? `${p}${f.content.length}:${fingerprint(f.content)};`
      : `${p}b;`;
  }
  if (cache.sig !== sig) cache = { sig, data: scanProject(project) };
  return cache.data;
}

/**
 * The project file an `\includegraphics{…}` argument refers to, or null.
 *
 * The extension is usually omitted — TeX picks it — and `\graphicspath` can put
 * the file somewhere the argument does not name, so a basename match is the
 * last resort. Getting this wrong costs a missing thumbnail, never a wrong
 * document: nothing here decides what is compiled.
 */
export function resolveGraphic(project, ref) {
  if (!project || !ref) return null;
  const cleaned = String(ref).replace(/^\.\//, '').trim();
  if (!cleaned) return null;
  for (const ext of ['', '.png', '.jpg', '.jpeg', '.pdf', '.gif', '.bmp', '.webp', '.svg']) {
    if (project.files.has(cleaned + ext)) return cleaned + ext;
  }
  // Case matters on Linux and not on macOS, and fixtures contain both
  // `img-2867.JPG` and `logo.png`, so the fallback compares case-insensitively.
  const base = (cleaned.split('/').pop() || '').toLowerCase();
  for (const path of project.files.keys()) {
    const name = (path.split('/').pop() || '').toLowerCase();
    if (name === base || name.replace(/\.[^.]+$/, '') === base) return path;
  }
  return null;
}

/** Environments of one kind, in document order. */
export const environmentsOfKind = (project, kind) =>
  projectIndex(project).environments.filter(e => e.kind === kind);

/**
 * Which files `\input` or `\include` the given path.
 *
 * For warning before a move. Moving a file is a filesystem operation and the
 * `\include{...}` naming it is text, so nothing keeps the two in step — and
 * LaTeX treats a missing `\include` as a *warning*, not an error. The document
 * then compiles, shorter, with no failure anywhere: the homework template lost
 * five pages this way and the only sign was a page count.
 *
 * Uses the same `resolveInput` the include graph is built from, so "what the
 * document actually reads" and "what a move would break" cannot disagree.
 *
 * @returns {string[]} paths of the referencing files, sorted
 */
export function referencesTo(project, target) {
  if (!project || !target) return [];
  const { inputs } = projectIndex(project);
  const out = [];
  for (const [from, raws] of Object.entries(inputs)) {
    if (raws.some(raw => resolveInput(raw, from, project.files) === target)) out.push(from);
  }
  return out.sort();
}

/**
 * Sections in reading order, each flagged with whether the document includes it.
 *
 * Files the main file never reads still appear, at the end and marked — a
 * scratch chapter you are working on should not vanish from the outline just
 * because the `\include` line is commented out, which is exactly when you are
 * most likely to be looking for it.
 */
export function outlineOf(project) {
  const ix = projectIndex(project);
  const rank = new Map(ix.order.map((p, i) => [p, i]));
  const orphans = [...new Set(ix.sections.map(s => s.file))]
    .filter(p => !rank.has(p)).sort();
  orphans.forEach((p, i) => rank.set(p, ix.order.length + i));

  return ix.sections
    .slice()
    .sort((a, b) => (rank.get(a.file) - rank.get(b.file)) || (a.line - b.line))
    .map(s => ({ ...s, included: rank.get(s.file) < ix.order.length }));
}
