// A table, from a description of one.
//
// Pure, like latex_snippets.js: a plain object in, LaTeX text out. That is what
// lets the awkward parts — caption before label, escaping, column counts —
// be tested in `npm test` instead of by compiling and looking.
//
// It never emits a package it has not been told the document loads. `booktabs`
// rules are offered only when booktabs is already in the preamble, for the same
// reason \underline is not silently upgraded to soul's \ul: an editor that adds
// \usepackage lines behind your back is an editor you cannot trust with a file.

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

/** `align` widened to `cols` columns, repeating its last character. */
function columnSpec(align, cols, verticals) {
  const chars = [];
  const src = /^[lcr]+$/.test(String(align)) ? String(align) : 'l';
  for (let i = 0; i < cols; i++) chars.push(src[Math.min(i, src.length - 1)]);
  return verticals ? `|${chars.join('|')}|` : chars.join('');
}

const RULES = {
  lines:    { top: '\\hline', mid: '\\hline', bottom: '\\hline', verticals: true },
  booktabs: { top: '\\toprule', mid: '\\midrule', bottom: '\\bottomrule', verticals: false },
  none:     { top: null, mid: null, bottom: null, verticals: false }
};

/**
 * A `table` float containing a `tabular`.
 *
 * @param {object} spec
 * @param {number} spec.rows       body rows, not counting the header
 * @param {number} spec.cols
 * @param {string} [spec.align]    'l' | 'c' | 'r', or one character per column
 * @param {boolean} [spec.header]  a header row above the first rule
 * @param {string} [spec.caption]
 * @param {string} [spec.label]
 * @param {string} [spec.placement]
 * @param {'lines'|'booktabs'|'none'} [spec.rules]
 */
export function tableBlock({
  rows = 3, cols = 3, align = 'l', header = true,
  caption = '', label = '', placement = 'htbp', rules = 'lines'
} = {}) {
  const nCols = Math.max(1, Math.min(20, Math.floor(cols) || 1));
  const nRows = Math.max(1, Math.min(60, Math.floor(rows) || 1));
  const r = RULES[rules] || RULES.lines;

  // Empty cells: n-1 ampersands and the row terminator. Placeholder text like
  // "Column 1" reads as generated junk and has to be deleted before it can be
  // typed over, which is strictly more work than typing into an empty cell.
  const cells = Array(nCols - 1).fill('&').join(' ');
  const blank = () => `    ${cells ? `${cells} ` : ''}\\\\`;
  const body = [];
  if (r.top) body.push(`    ${r.top}`);
  if (header) {
    body.push(blank());
    if (r.mid) body.push(`    ${r.mid}`);
  }
  for (let i = 0; i < nRows; i++) body.push(blank());
  if (r.bottom) body.push(`    ${r.bottom}`);

  const out = [`\\begin{table}[${placement}]`, '  \\centering'];
  // Caption before label, and before the tabular. \label takes the number of
  // the most recent \caption — put it above, and every \ref to this table
  // silently points at the previous one.
  if (caption || label) out.push(`  \\caption{${escapeCaption(caption)}}`);
  if (label) out.push(`  \\label{${label}}`);
  out.push(
    `  \\begin{tabular}{${columnSpec(align, nCols, r.verticals)}}`,
    ...body,
    '  \\end{tabular}',
    '\\end{table}'
  );
  return out.join('\n');
}

/** Which rule styles this document can actually use, given its preamble. */
export function availableRules(packages = []) {
  const has = new Set(packages);
  return [
    { value: 'lines', label: 'Lines' },
    ...(has.has('booktabs') ? [{ value: 'booktabs', label: 'Booktabs' }] : []),
    { value: 'none', label: 'None' }
  ];
}
