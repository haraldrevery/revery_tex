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
