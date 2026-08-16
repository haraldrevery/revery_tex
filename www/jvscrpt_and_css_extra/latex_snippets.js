// Text the editor inserts on your behalf.
//
// Every function here is pure: text in, a change description out. No DOM, no
// CodeMirror import, no project. That is what lets the fiddly cases — empty
// selections, toggling a wrap off, trailing spaces — be tested in `npm test`
// rather than only by clicking through a browser, and it follows
// `beginEndInsertion` in latex_editor.js, which is the same shape.
//
// The returned shape is what a caller turns into a transaction:
//   { from, to, insert, cursor }   cursor is an absolute document offset

/** Wrapping commands offered by the right-click menu. */
export const WRAPS = {
  bold: 'textbf',
  italic: 'textit',
  code: 'texttt',
  // \underline does not break across lines. The typographically correct answer
  // is soul's \ul, which needs \usepackage{soul} — and silently editing
  // someone's preamble is not something an editor should do behind their back.
  // So: \underline, and the menu says what it is.
  underline: 'underline'
};

/**
 * Wrap (or unwrap) a selection in `\cmd{…}`.
 *
 * Three cases that all come up immediately:
 *  - **already wrapped** → unwrap, because a Bold button that only ever adds
 *    another layer is broken; pressing it twice must return the original.
 *  - **empty selection** → insert `\cmd{}` and put the cursor inside.
 *  - **selection with surrounding spaces** → wrap the words, not the spaces,
 *    so `\textbf{ word }` never happens.
 *
 * @param {string} text  the whole document
 * @param {number} from
 * @param {number} to
 * @param {string} cmd   e.g. 'textbf'
 */
export function wrapSelection(text, from, to, cmd) {
  const open = `\\${cmd}{`;

  if (from === to) {
    return { from, to, insert: `${open}}`, cursor: from + open.length };
  }

  // Trim the selection inward so the wrap lands on the words.
  let a = from, b = to;
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  const inner = text.slice(a, b);

  // Already exactly this wrap, selected from inside the braces?
  const before = text.slice(Math.max(0, a - open.length), a);
  if (before === open && text[b] === '}') {
    return { from: a - open.length, to: b + 1, insert: inner, cursor: a - open.length + inner.length };
  }
  // …or selected including the braces?
  if (inner.startsWith(open) && inner.endsWith('}') && balanced(inner.slice(open.length, -1))) {
    const stripped = inner.slice(open.length, -1);
    return { from: a, to: b, insert: stripped, cursor: a + stripped.length };
  }

  return { from: a, to: b, insert: `${open}${inner}}`, cursor: a + open.length + inner.length + 1 };
}

/** Braces balanced, ignoring escaped ones — used to be sure an unwrap is safe. */
function balanced(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * A label that is not already taken.
 * `fig:setup` → `fig:setup-2` when the first is used. Duplicate labels make
 * every `\ref` to them ambiguous, and LaTeX only warns.
 */
export function uniqueLabel(base, existing) {
  const taken = new Set(existing || []);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** A slug suitable for the tail of a label, from a caption or filename. */
export function slug(text, fallback = 'x') {
  const s = String(text || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
  return s || fallback;
}

/**
 * Insert a block on its own lines.
 *
 * Blocks pasted mid-line produce `text\begin{figure}` and a compile error, so
 * this opens a line first when the cursor is not on a blank one, and leaves a
 * blank line after only when the following text needs separating.
 */
export function insertBlock(text, at, block) {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const beforeOnLine = text.slice(lineStart, at);
  const rest = text.slice(at);

  const lead = beforeOnLine.trim() ? '\n' : '';
  const trail = /^\s*\n/.test(rest) || rest === '' ? '' : '\n';
  const insert = `${lead}${block}${trail}`;
  return { from: at, to: at, insert, cursor: at + insert.length };
}

/**
 * The source with comment bodies blanked to spaces.
 *
 * Length-preserving, unlike project_store's `stripTexComments`, because the
 * caller needs offsets that still index the original buffer — it is producing
 * an edit, not a reading. A `%` escaped as `\%` is literal and stays.
 */
function maskComments(src) {
  let out = '';
  for (let i = 0; i < src.length; ) {
    if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
    if (src[i] === '%') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    out += src[i++];
  }
  return out;
}

/**
 * Point biblatex at the bundled bibtex8 instead of biber.
 *
 * The one repair for the failure the bundled engine cannot compile around: no
 * WASM build has biber, because biber is Perl, so a biblatex document either
 * ships a prebuilt `.bbl` or gets no bibliography. When that `.bbl` was built by
 * a different biblatex the entries do not typeset at all — and regenerating it
 * needs the very tool that is missing. `backend=bibtex` breaks the loop:
 * `biblatex.bst` ships in the slim bundle, so bibtex8 can build the `.bbl` here.
 *
 * Three preamble shapes, because all three are written in practice:
 *
 *     \usepackage{biblatex}                  → \usepackage[backend=bibtex]{biblatex}
 *     \usepackage[style=authoryear]{biblatex}→ \usepackage[backend=bibtex,style=…]{…}
 *     \usepackage[backend=biber]{biblatex}   → \usepackage[backend=bibtex]{biblatex}
 *
 * Only the package options are rewritten. A `backend=` set later through
 * `\ExecuteBibliographyOptions` is left alone deliberately: editing two places
 * to express one intent is how a preamble ends up contradicting itself, and the
 * package option is the one biblatex reads first.
 *
 * The edit is as small as it can be — the value alone where there is one — so
 * that an annotated option list survives it. Real preambles look like this:
 *
 *     \usepackage[
 *       backend   = biber,       % use biber for full Unicode support
 *       style     = numeric,     % Vancouver-style [1] [2] [3] citations
 *     ]{biblatex}
 *
 * Replacing the whole call would take every one of those comments with it.
 *
 * @returns {{from:number, to:number, insert:string, cursor:number}|null}
 *   null when there is nothing to change — not biblatex, already on bibtex, or
 *   the backend is only ever set outside the package options.
 */
export function switchBiblatexBackend(text) {
  const src = String(text);
  // Matched against the masked copy, not the source. That `[1] [2] [3]` in the
  // comment above is a real line from the book template, and `[^\]]*` stops
  // dead at its first `]` — the option group then never closes and the whole
  // call goes unrecognised. Masking is length-preserving, so every offset the
  // match reports still indexes the original text.
  const mask = maskComments(src);
  const m = /\\(?:usepackage|RequirePackage)(?:\[([^\]]*)\])?\{biblatex\}/.exec(mask);
  if (!m) return null;

  const opts = m[1] ?? null;
  const edit = (from, to, insert) => ({ from, to, insert, cursor: from + insert.length });

  if (opts !== null) {
    const optStart = m.index + m[0].indexOf('[') + 1;
    const has = /\bbackend(\s*=\s*)(\w+)/.exec(opts);
    if (has) {
      if (/^bibtex8?$/i.test(has[2])) return null;                 // already there
      // Just the value, so alignment, spacing and the trailing comment all stay.
      const at = optStart + has.index + has[0].length - has[2].length;
      return edit(at, at + has[2].length, 'bibtex');
    }
    // No backend named: put one at the head of the list, where it reads first.
    return edit(optStart, optStart, 'backend=bibtex,');
  }

  // `\usepackage{biblatex}` — no group to edit, so one is added.
  const at = m.index + m[0].indexOf('{biblatex}');
  return edit(at, at, '[backend=bibtex]');
}

/**
 * Whether an insertion at the end of `before` begins a sentence.
 *
 * Decides `\Cref` ("Figure 1 shows…") from `\cref` ("…see fig. 1"), which is the
 * one thing cleveref cannot work out for itself. True at the start of the
 * document, after a paragraph break, and after `.` `!` `?` — looking back past
 * whitespace, and past the `}` `)` `$` that a sentence can legitimately end
 * inside before its full stop.
 *
 * A heuristic, deliberately. "e.g." and "Fig. 1." read as sentence ends and will
 * produce a capital that is wrong; that costs one keystroke, where the reverse
 * default costs one at every real sentence start. Nothing here can produce a
 * command that fails to compile, which is what keeps it worth guessing at all.
 */
export function startsSentence(before) {
  const s = String(before ?? '');
  // A comment runs to the end of its line, so what precedes the cursor on a
  // commented line is not prose the sentence continues from.
  const tail = s.replace(/\s+$/, '');
  if (!tail) return true;                                  // start of document
  // A blank line between them is a paragraph break, whatever ended the last one.
  if (/\n[^\S\n]*\n\s*$/.test(s)) return true;
  return /[.!?][)\]}$'"]*$/.test(tail);
}

/**
 * `\ref{…}` / `\eqref{…}` / `\cite{…}` at the cursor, or cleveref's `\cref`.
 *
 * `opts.cref` is `'cref'`, `'Cref'` or null, and is decided by the caller: only
 * it knows whether the document loads cleveref, and where in a sentence the
 * cursor sits. A citation is never a `\cref` — cleveref handles labelled
 * elements, and `\cite` is not one of them.
 */
export function reference(kind, key, at, opts = {}) {
  const cmd = opts.cref && kind !== 'citation'
    ? opts.cref
    : ({ equation: 'eqref', citation: 'cite' }[kind] || 'ref');
  const insert = `\\${cmd}{${key}}`;
  return { from: at, to: at, insert, cursor: at + insert.length };
}

/**
 * Escape the characters that are always wrong in running text.
 *
 * Only `% & # _`, and only outside `$…$`. Those four are never intended
 * literally — `%` silently comments away the rest of the caption, which is the
 * worst kind of failure because the document still compiles. `\ { } $ ^` are
 * left alone so `\emph{x}` and `$x^2$` typed into the caption box still work,
 * which is the whole reason for the maths carve-out.
 */
export function escapeCaption(s) {
  return String(s ?? '')
    .split(/(\$[^$]*\$)/g)
    // A capturing split puts the maths parts at the odd indices.
    .map((part, i) => (i % 2 ? part : part.replace(/\\?([%&#_])/g, (_, c) => `\\${c}`)))
    .join('');
}

/**
 * A displayed equation.
 *
 * The label is emitted only when the equation is numbered. `\label` inside
 * `equation*` attaches to whatever counter last moved, so a `\ref` to it points
 * somewhere arbitrary — and it compiles without complaint, which is what makes
 * it worth refusing rather than passing through.
 */
export function equationBlock({ body = '', numbered = true, label = '' }) {
  const env = numbered ? 'equation' : 'equation*';
  const lines = [`\\begin{${env}}`];
  if (numbered && label) lines.push(`  \\label{${label}}`);
  lines.push(`  ${String(body).trim() || '% your equation here'}`);
  lines.push(`\\end{${env}}`);
  return lines.join('\n');
}

/**
 * A figure block around an image file.
 * `width=0.8\linewidth` rather than a bare include: an unscaled photograph
 * overflowing the text block is the single most common LaTeX surprise.
 */
export function figureBlock({ path, caption = '', label }) {
  return [
    '\\begin{figure}[htbp]',
    '  \\centering',
    `  \\includegraphics[width=0.8\\linewidth]{${path}}`,
    `  \\caption{${escapeCaption(caption)}}`,
    `  \\label{${label}}`,
    '\\end{figure}'
  ].join('\n');
}
