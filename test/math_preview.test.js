// Turning an indexed environment into something KaTeX can render.
//
// The rendering itself is checked in the browser (test/run_ui.js). What is
// worth testing here is the extraction, because when it is wrong the preview
// shows `\begin{equation}` as literal red text — which reads as a KaTeX bug
// rather than as ours.

const { test } = require('node:test');
const assert = require('node:assert');

let _mod;
const mod = async () => (_mod ??= await import('../www/jvscrpt_and_css_extra/math_preview.js'));
const src = async (env, source) => (await mod()).mathSource({ env, source });

test('an equation is unwrapped to its body', async () => {
  assert.equal(await src('equation', '\\begin{equation}\n  E = mc^2\n\\end{equation}'), 'E = mc^2');
  assert.equal(await src('equation*', '\\begin{equation*}x=1\\end{equation*}'), 'x=1');
});

test('a label is not maths', async () => {
  // KaTeX has no \label, so leaving it in renders the word in the error colour
  // right in the middle of the equation.
  assert.equal(
    await src('equation', '\\begin{equation}\\label{eq:x} a = b \\end{equation}'),
    'a = b');
});

test('align becomes aligned, gather becomes gathered', async () => {
  // The unstarred forms number their rows from KaTeX's own counter, which the
  // document knows nothing about. The inner forms do not number at all.
  assert.equal(await src('align', '\\begin{align} a &= b \\end{align}'),
    '\\begin{aligned}a &= b\\end{aligned}');
  assert.equal(await src('gather*', '\\begin{gather*} x \\end{gather*}'),
    '\\begin{gathered}x\\end{gathered}');
});

test('eqnarray becomes the array it actually is', async () => {
  // lhs & rel & rhs — three columns, right, centre, left. `aligned` would put
  // the relation in the wrong place and swallow a column.
  assert.equal(await src('eqnarray', '\\begin{eqnarray} a &=& b \\end{eqnarray}'),
    '\\begin{array}{rcl}a &=& b\\end{array}');
});

test('\\nonumber is dropped', async () => {
  assert.equal(await src('align', '\\begin{align} a = b \\nonumber \\end{align}'),
    '\\begin{aligned}a = b\\end{aligned}');
});

test('nothing to render is empty, not a crash', async () => {
  const { mathSource } = await mod();
  assert.equal(mathSource(null), '');
  assert.equal(mathSource({ env: 'equation', source: '' }), '');
});

/* ── the block that gets written ─────────────────────────────────────── */

test('an unnumbered equation carries no label', async () => {
  const { equationBlock } = await import('../www/jvscrpt_and_css_extra/latex_snippets.js');
  // \label inside equation* attaches to whatever counter last moved, so a \ref
  // to it points somewhere arbitrary — and it compiles without complaint.
  const starred = equationBlock({ body: 'x = 1', numbered: false, label: 'eq:x' });
  assert.match(starred, /\\begin\{equation\*\}/);
  assert.ok(!starred.includes('\\label'), starred);

  const numbered = equationBlock({ body: 'x = 1', numbered: true, label: 'eq:x' });
  assert.match(numbered, /\\begin\{equation\}\n\s*\\label\{eq:x\}\n\s*x = 1\n\\end\{equation\}/);
});

test('an empty equation leaves something to type into', async () => {
  const { equationBlock } = await import('../www/jvscrpt_and_css_extra/latex_snippets.js');
  // An empty \begin{equation}\end{equation} is a LaTeX error ("missing $"),
  // so the placeholder is a comment rather than nothing.
  assert.match(equationBlock({ body: '' }), /%/);
});
