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

import { stripTexComments } from './project_store.js';

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
  labels: [], citations: [], files: [], bib: [],
  environments: [], sections: [], images: [], macros: {}
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
 * BibTeX entries with the fields worth showing in a picker.
 * Deliberately shallow: enough to tell two papers apart, not a .bib parser.
 */
function scanBib(text, out) {
  for (const m of text.matchAll(/@(\w+)\s*\{\s*([^,\s}]+)\s*,/g)) {
    const type = m[1].toLowerCase();
    if (type === 'comment' || type === 'preamble' || type === 'string') continue;
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
    out.push({
      key, type,
      author: field('author').replace(/[{}]/g, ''),
      title: field('title').replace(/[{}]/g, ''),
      year: field('year')
    });
  }
}

function scanFile(path, raw, acc) {
  const text = stripTexComments(raw);
  const offsets = lineOffsets(text);

  for (const m of text.matchAll(/\\label\{([^}]+)\}/g)) acc.labels.add(m[1]);
  for (const m of text.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g)) acc.citations.add(m[1]);
  scanBib(text, acc.bib);
  for (const b of acc.bib) acc.citations.add(b.key);

  // Sections, for the outline.
  for (const m of text.matchAll(/\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{/g)) {
    const g = readGroup(text, text.indexOf('{', m.index + m[0].length - 1));
    if (!g) continue;
    acc.sections.push({
      level: SECTION_LEVELS[m[1]],
      title: g.body.replace(/\\[a-zA-Z]+\s*/g, '').replace(/[{}]/g, '').trim(),
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

export function scanProject(project) {
  if (!project) return EMPTY;

  const acc = {
    labels: new Set(), citations: new Set(), bib: [],
    environments: [], sections: [], images: [], macros: {}
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
    citations: [...acc.citations].sort(),
    files: files.sort(),
    bib: acc.bib,
    environments: acc.environments,
    sections: acc.sections,
    images: acc.images.sort((a, b) => a.path.localeCompare(b.path)),
    macros: acc.macros
  };
}

let cache = { sig: null, data: null };

/**
 * The index for a project, cached.
 *
 * The signature changes whenever any buffer changes length — good enough to
 * keep the index fresh without rescanning on every character, and it includes
 * the project key so switching projects cannot serve the previous one's index.
 */
export function projectIndex(project) {
  if (!project) return EMPTY;
  let sig = project.key + '|';
  for (const [p, f] of project.files) sig += p + (typeof f.content === 'string' ? f.content.length : 0) + ';';
  if (cache.sig !== sig) cache = { sig, data: scanProject(project) };
  return cache.data;
}

/** Environments of one kind, in document order. */
export const environmentsOfKind = (project, kind) =>
  projectIndex(project).environments.filter(e => e.kind === kind);
