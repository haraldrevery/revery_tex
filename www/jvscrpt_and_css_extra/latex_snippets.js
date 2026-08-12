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

/** `\ref{…}` / `\eqref{…}` / `\cite{…}` at the cursor. */
export function reference(kind, key, at) {
  const cmd = { equation: 'eqref', citation: 'cite' }[kind] || 'ref';
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
