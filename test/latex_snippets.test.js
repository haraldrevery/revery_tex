// The text transforms behind the toolbox and the right-click menu.
//
// Pure functions, so the awkward cases are cheap to pin down here rather than
// discovering them by clicking: toggling a wrap off, an empty selection, a
// selection that includes surrounding spaces, and inserting a block mid-line.

const { test } = require('node:test');
const assert = require('node:assert');

let _mod;
const mod = async () => (_mod ??= await import('../www/jvscrpt_and_css_extra/latex_snippets.js'));

/** Apply a change spec to text, the way the editor would. */
function apply(text, c) {
  return text.slice(0, c.from) + c.insert + text.slice(c.to);
}

/* ── wrapping ────────────────────────────────────────────────────────── */

test('wraps a selection', async () => {
  const { wrapSelection } = await mod();
  const text = 'make this bold please';
  const c = wrapSelection(text, 10, 14, 'textbf');       // "bold"
  assert.equal(apply(text, c), 'make this \\textbf{bold} please');
  assert.equal(text.slice(c.from, c.to), 'bold');
});

test('an empty selection inserts the command with the cursor inside', async () => {
  const { wrapSelection } = await mod();
  const text = 'abc';
  const c = wrapSelection(text, 3, 3, 'textit');
  assert.equal(apply(text, c), 'abc\\textit{}');
  assert.equal(c.cursor, 3 + '\\textit{'.length, 'cursor must land between the braces');
});

test('wrapping twice returns the original text', async () => {
  // A Bold button that only ever adds another layer is broken.
  const { wrapSelection } = await mod();
  const text = 'make this bold please';
  const once = apply(text, wrapSelection(text, 10, 14, 'textbf'));
  assert.equal(once, 'make this \\textbf{bold} please');

  // Select the inner word again and toggle off.
  const at = once.indexOf('bold');
  const twice = apply(once, wrapSelection(once, at, at + 4, 'textbf'));
  assert.equal(twice, text);
});

test('unwraps when the braces are inside the selection too', async () => {
  const { wrapSelection } = await mod();
  const text = 'a \\textbf{word} b';
  const c = wrapSelection(text, 2, 15, 'textbf');        // "\textbf{word}"
  assert.equal(apply(text, c), 'a word b');
});

test('surrounding spaces stay outside the braces', async () => {
  const { wrapSelection } = await mod();
  const text = 'one two three';
  const c = wrapSelection(text, 3, 8, 'texttt');         // " two "
  assert.equal(apply(text, c), 'one \\texttt{two} three');
});

test('a selection spanning lines is wrapped whole', async () => {
  const { wrapSelection } = await mod();
  const text = 'first\nsecond';
  const c = wrapSelection(text, 0, 12, 'textit');
  assert.equal(apply(text, c), '\\textit{first\nsecond}');
});

test('a nested wrap of a different command is added, not confused for an unwrap', async () => {
  const { wrapSelection } = await mod();
  const text = '\\textbf{word}';
  const c = wrapSelection(text, 0, 13, 'textit');
  assert.equal(apply(text, c), '\\textit{\\textbf{word}}');
});

test('every offered wrap maps to a real command', async () => {
  const { WRAPS } = await mod();
  assert.deepEqual(Object.keys(WRAPS).sort(), ['bold', 'code', 'italic', 'underline']);
  for (const cmd of Object.values(WRAPS)) assert.match(cmd, /^[a-z]+$/);
});

/* ── labels ──────────────────────────────────────────────────────────── */

test('a label that is taken gets a suffix', async () => {
  const { uniqueLabel } = await mod();
  assert.equal(uniqueLabel('fig:setup', []), 'fig:setup');
  assert.equal(uniqueLabel('fig:setup', ['fig:setup']), 'fig:setup-2');
  assert.equal(uniqueLabel('fig:setup', ['fig:setup', 'fig:setup-2']), 'fig:setup-3');
});

test('slugs are safe for a label', async () => {
  const { slug } = await mod();
  assert.equal(slug('img/Chalmers Logo.png'), 'img-chalmers-logo');
  assert.equal(slug('Résultats: 2024!'), 'r-sultats-2024');
  assert.equal(slug(''), 'x');
  assert.equal(slug('%%%'), 'x', 'a slug of nothing must still be usable');
});

/* ── blocks ──────────────────────────────────────────────────────────── */

test('a block inserted mid-line opens a line first', async () => {
  const { insertBlock } = await mod();
  const text = 'some text';
  const out = apply(text, insertBlock(text, 9, '\\begin{figure}\n\\end{figure}'));
  assert.equal(out, 'some text\n\\begin{figure}\n\\end{figure}');
});

test('a block on a blank line does not add a leading newline', async () => {
  const { insertBlock } = await mod();
  const text = 'para\n\nrest';
  const out = apply(text, insertBlock(text, 5, 'BLOCK'));
  assert.equal(out, 'para\nBLOCK\nrest');
});

test('figure blocks scale the image', async () => {
  const { figureBlock } = await mod();
  const b = figureBlock({ path: 'img/a.png', caption: 'A photo', label: 'fig:a' });
  // An unscaled photograph overflowing the text block is the most common
  // LaTeX surprise there is.
  assert.match(b, /width=0\.8\\linewidth/);
  assert.match(b, /\\includegraphics\[[^\]]*\]\{img\/a\.png\}/);
  assert.match(b, /\\caption\{A photo\}/);
  assert.match(b, /\\label\{fig:a\}/);
});

test('references use the right command per kind', async () => {
  const { reference } = await mod();
  assert.equal(reference('equation', 'eq:x', 0).insert, '\\eqref{eq:x}');
  assert.equal(reference('citation', 'smith2020', 0).insert, '\\cite{smith2020}');
  assert.equal(reference('figure', 'fig:a', 0).insert, '\\ref{fig:a}');
  assert.equal(reference('table', 'tab:a', 0).insert, '\\ref{tab:a}');
});

test('cleveref replaces the command, but never for a citation', async () => {
  const { reference } = await mod();
  assert.equal(reference('figure', 'fig:a', 0, { cref: 'cref' }).insert, '\\cref{fig:a}');
  assert.equal(reference('table', 'tab:a', 0, { cref: 'Cref' }).insert, '\\Cref{tab:a}');
  // \eqref gives up to \cref: both number the same way, and \cref adds the "eq."
  assert.equal(reference('equation', 'eq:x', 0, { cref: 'cref' }).insert, '\\cref{eq:x}');
  // cleveref is for labelled elements. \cite is not one, and a \cref{smith2020}
  // would compile to a broken reference rather than to a citation.
  assert.equal(reference('citation', 'smith2020', 0, { cref: 'Cref' }).insert, '\\cite{smith2020}');
  // No opts at all must behave exactly as before.
  assert.equal(reference('figure', 'fig:a', 0).insert, '\\ref{fig:a}');
});

test('the cursor decides \\cref from \\Cref', async () => {
  const { startsSentence } = await mod();
  // Sentence starts.
  assert.equal(startsSentence(''), true, 'start of document');
  assert.equal(startsSentence('   \n  '), true, 'nothing but whitespace');
  assert.equal(startsSentence('The result holds. '), true, 'after a full stop');
  assert.equal(startsSentence('Does it? '), true);
  assert.equal(startsSentence('It does! '), true);
  assert.equal(startsSentence('End of para.\n\n'), true, 'paragraph break');
  assert.equal(startsSentence('No stop here\n\n  '), true, 'blank line is enough on its own');
  // A sentence can end inside a closing delimiter.
  assert.equal(startsSentence('(as shown there.) '), true);
  assert.equal(startsSentence('the value is $x$. '), true);
  // Mid-sentence.
  assert.equal(startsSentence('as shown in '), false);
  assert.equal(startsSentence('see the plot in\n'), false, 'a single newline is not a break');
  assert.equal(startsSentence('compare with, '), false);
  assert.equal(startsSentence('in \\emph{fig} '), false);
  // The documented false positive: an abbreviation reads as a sentence end. It
  // costs one keystroke, and is pinned here so it is a known cost rather than a
  // surprise.
  assert.equal(startsSentence('see e.g. '), true, 'known heuristic limit');
});

/* ── escaping ────────────────────────────────────────────────────────── */

test('a caption escapes what is always an error in text', async () => {
  const { escapeCaption } = await mod();
  // The dangerous one: % compiles fine and eats the rest of the caption.
  assert.equal(escapeCaption('50% of R&D on file_name #2'),
    '50\\% of R\\&D on file\\_name \\#2');
});

test('escaping is idempotent — already-escaped input is left alone', async () => {
  const { escapeCaption } = await mod();
  assert.equal(escapeCaption('50\\% done'), '50\\% done');
});

test('maths in a caption survives', async () => {
  const { escapeCaption } = await mod();
  // Escaping the subscript here would turn valid maths into a compile error,
  // which is why the escape stops at $…$ boundaries.
  assert.equal(escapeCaption('Values of $x_1$ and $y^2$, 10% error'),
    'Values of $x_1$ and $y^2$, 10\\% error');
});

test('commands typed into the caption box still work', async () => {
  const { escapeCaption } = await mod();
  assert.equal(escapeCaption('\\emph{Measured} results'), '\\emph{Measured} results');
});

/* ── biblatex backend ────────────────────────────────────────────────── */

/** Apply an edit the way editor_actions.applyEdit would, for readability. */
const applied = (src, edit) =>
  edit === null ? null : src.slice(0, edit.from) + edit.insert + src.slice(edit.to);

test('a bare \\usepackage{biblatex} gains the backend option', async () => {
  const { switchBiblatexBackend } = await mod();
  const src = '\\documentclass{book}\n\\usepackage{biblatex}\n\\addbibresource{r.bib}\n';
  assert.equal(applied(src, switchBiblatexBackend(src)),
    '\\documentclass{book}\n\\usepackage[backend=bibtex]{biblatex}\n\\addbibresource{r.bib}\n');
});

test('an existing backend is replaced in place, keeping the other options', async () => {
  // In place, not appended: the author's option order is theirs, and moving it
  // makes a one-word change look like a rewrite in a diff.
  const { switchBiblatexBackend } = await mod();
  const src = '\\usepackage[style=authoryear,backend=biber,sorting=nyt]{biblatex}';
  assert.equal(applied(src, switchBiblatexBackend(src)),
    '\\usepackage[style=authoryear,backend=bibtex,sorting=nyt]{biblatex}');
});

test('other options are kept when there was no backend', async () => {
  const { switchBiblatexBackend } = await mod();
  const src = '\\usepackage[style=numeric]{biblatex}';
  assert.equal(applied(src, switchBiblatexBackend(src)),
    '\\usepackage[backend=bibtex,style=numeric]{biblatex}');
});

test('a document already on bibtex is left alone', async () => {
  // null, not a no-op edit: the caller uses it to decide whether to offer the
  // button at all, and an edit that changes nothing would still mark the file
  // modified and push a useless entry onto the undo stack.
  const { switchBiblatexBackend } = await mod();
  assert.equal(switchBiblatexBackend('\\usepackage[backend=bibtex]{biblatex}'), null);
  assert.equal(switchBiblatexBackend('\\usepackage[backend=bibtex8]{biblatex}'), null);
});

test('a document that is not biblatex has nothing to switch', async () => {
  const { switchBiblatexBackend } = await mod();
  assert.equal(switchBiblatexBackend('\\bibliography{refs}'), null);
  assert.equal(switchBiblatexBackend(''), null);
});

test('the edit touches only the backend value', async () => {
  // As small as it can be, so an annotated option list survives it.
  const { switchBiblatexBackend } = await mod();
  const src = 'before\n\\usepackage[backend=biber]{biblatex}\nafter';
  const edit = switchBiblatexBackend(src);
  assert.equal(src.slice(edit.from, edit.to), 'biber');
  assert.equal(applied(src, edit), 'before\n\\usepackage[backend=bibtex]{biblatex}\nafter');
});

test('a bracket inside an option comment does not hide the package', async () => {
  // The line that actually broke this, from the book template. `[^\]]*` stops
  // at the `]` in "[1]", so the option group never closes and the whole
  // \usepackage call went unrecognised — the button reported "could not find
  // the \usepackage{biblatex} line" on the very document it was offered for.
  const { switchBiblatexBackend } = await mod();
  const src = [
    '\\usepackage[',
    '  backend   = biber,       % use biber for full Unicode support',
    '  style     = numeric,     % Vancouver-style [1] [2] [3] citations',
    ']{biblatex}'
  ].join('\n');
  const out = applied(src, switchBiblatexBackend(src));
  assert.match(out, /backend   = bibtex,/);
  // Alignment and every comment survive, because only the value was replaced.
  assert.match(out, /% Vancouver-style \[1\] \[2\] \[3\] citations/);
  assert.match(out, /% use biber for full Unicode support/);
});

test('a commented-out backend is not the one edited', async () => {
  const { switchBiblatexBackend } = await mod();
  const src = '\\usepackage[\n  % backend = biber,\n  backend = biber,\n]{biblatex}';
  const out = applied(src, switchBiblatexBackend(src));
  assert.match(out, /% backend = biber,/, 'the commented line is left alone');
  assert.match(out, /\n  backend = bibtex,/, 'the live one is switched');
});
