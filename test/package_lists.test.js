// Reading a \usepackage line.
//
// `inferEngine` and the biblatex check matched the package group *literally* —
// `\{fontspec\}` — so the package had to be alone in the braces with no spaces
// and no newline. Three perfectly ordinary preambles were therefore invisible:
//
//     \usepackage{amsmath,fontspec}     one line, several packages
//     \usepackage{ fontspec }           TeX ignores the spaces; this did not
//     \usepackage\n{fontspec}           a long option list wrapped
//
// The fontspec cases fail loudly, with the "requires either XeTeX or LuaTeX"
// error that inferEngine's own docstring says it exists to prevent. The
// biblatex case does not fail at all: `\usepackage{csquotes,biblatex}` with a
// legacy `\bibliography{}` read as classic BibTeX, so a biblatex document was
// run through the wrong tool — which inferBibTool's own comment calls out as
// producing a bibliography that is silently wrong. `csquotes` beside `biblatex`
// is what biblatex's manual leads people to write.
//
// document_model.js already read the group correctly for its `packages` set and
// was the only place that did; `packagesIn` is now that reading, shared.

const { test } = require('node:test');
const assert = require('node:assert');

let _store;
const store = async () =>
  (_store ??= await import('../www/jvscrpt_and_css_extra/project_store.js'));

/* ── the group is a list ─────────────────────────────────────────────── */

test('a package group is read as the comma list it is', async () => {
  const { packagesIn } = await store();
  assert.deepEqual([...packagesIn('\\usepackage{amsmath,fontspec}')], ['amsmath', 'fontspec']);
  assert.deepEqual([...packagesIn('\\usepackage[a,b]{x, y}')], ['x', 'y'], 'options are not names');
  assert.deepEqual([...packagesIn('\\RequirePackage{z}')], ['z'], '\\RequirePackage counts too');
  assert.deepEqual([...packagesIn('\\usepackage{ fontspec }')], ['fontspec'], 'spaces are trimmed');
  assert.deepEqual([...packagesIn('\\usepackage\n{fontspec}')], ['fontspec'], 'newline before the group');
  assert.deepEqual([...packagesIn('nothing here')], []);
});

/* ── the engine ──────────────────────────────────────────────────────── */

test('fontspec is found wherever it sits in the group', async () => {
  const { inferEngine } = await store();
  for (const src of [
    '\\usepackage{fontspec}',
    '\\usepackage{amsmath,fontspec}',
    '\\usepackage{fontspec,xunicode}',
    '\\usepackage{ fontspec }',
    '\\usepackage\n{fontspec}',
    '\\usepackage{amsmath, unicode-math}',
    '\\usepackage[math-style=ISO]{unicode-math}'
  ]) {
    assert.equal(inferEngine(src), 'xetex', src);
  }
});

test('a document that branches on the engine still wins', async () => {
  const { inferEngine } = await store();
  // The rule this must not undo: a preamble that loads fontspec *conditionally*
  // runs under either engine, so pdfLaTeX wins — it is faster and needs fewer
  // font files. Widening the package match makes iftex easier to find too.
  assert.equal(inferEngine('\\usepackage{iftex}\\usepackage{fontspec}'), 'pdftex');
  assert.equal(inferEngine('\\usepackage{iftex,xparse}\\usepackage{fontspec}'), 'pdftex');
  assert.equal(inferEngine('\\ifPDFTeX\\else\\usepackage{fontspec}\\fi'), 'pdftex');
});

test('a commented-out fontspec does not choose the engine', async () => {
  const { inferEngine } = await store();
  assert.equal(inferEngine('% \\usepackage{amsmath,fontspec}'), 'pdftex');
});

test('a document with no font packages stays on pdftex', async () => {
  const { inferEngine } = await store();
  assert.equal(inferEngine('\\documentclass{article}\\usepackage{amsmath,graphicx}'), 'pdftex');
});

/* ── the bibliography tool ───────────────────────────────────────────── */

test('biblatex is found in a package list', async () => {
  const { inferBibTool } = await store();
  // The one that produced a silently wrong bibliography: read as classic
  // \bibliography, this ran bibtex over a biblatex document.
  assert.equal(inferBibTool('\\usepackage{csquotes,biblatex}\\bibliography{refs}'), 'biber');
  assert.equal(inferBibTool('\\usepackage{csquotes,biblatex}\\addbibresource{refs.bib}'), 'biber');
  assert.equal(inferBibTool('\\usepackage\n{biblatex}'), 'biber');
});

test('the backend option is read off whichever \\usepackage loads biblatex', async () => {
  const { inferBibTool, biblatexBackend } = await store();
  assert.equal(inferBibTool('\\usepackage[backend=bibtex]{biblatex}'), 'bibtex');
  assert.equal(inferBibTool('\\usepackage[backend=bibtex]{csquotes,biblatex}'), 'bibtex');
  // Options on a *different* package must not be mistaken for biblatex's.
  assert.equal(biblatexBackend('\\usepackage[backend=bibtex]{someother}\\usepackage{biblatex}'), null);
  assert.equal(inferBibTool('\\usepackage[backend=bibtex]{someother}\\usepackage{biblatex}'), 'biber');
});

test('a comment inside the option list still does not hide the backend', async () => {
  const { inferBibTool } = await store();
  // Regression guard, not a new case. `[^\]]*` stops at the first `]`, and real
  // option lists carry comments like "% Vancouver-style [1] [2] citations" —
  // with those in place the option group never closes and the backend reads as
  // unset. Widening the package match must not lose that.
  assert.equal(
    inferBibTool('\\usepackage[backend=bibtex, % Vancouver [1] [2]\n style=numeric]{biblatex}'),
    'bibtex');
});

test('classic \\bibliography is still classic', async () => {
  const { inferBibTool } = await store();
  assert.equal(inferBibTool('\\bibliography{refs}'), 'bibtex');
  assert.equal(inferBibTool('\\bibliographystyle{plain}'), null, 'style alone is inert');
  assert.equal(inferBibTool('\\documentclass{article}'), null);
});

test('ExecuteBibliographyOptions is still honoured', async () => {
  const { inferBibTool } = await store();
  assert.equal(
    inferBibTool('\\usepackage{csquotes,biblatex}\\ExecuteBibliographyOptions{backend=bibtex}'),
    'bibtex');
});

/* ── the fixtures cannot move ────────────────────────────────────────── */

test('the shapes the test fixtures actually use are unchanged', async () => {
  const { inferEngine, inferBibTool } = await store();
  // Every occurrence of these packages across latex_project_tests/ is alone in
  // its group, so this fix can only start matching preambles no fixture has —
  // which is what keeps the compile gate where it was. Pinned here so the
  // argument is checkable rather than remembered.
  assert.equal(inferEngine('\\usepackage{fontspec}'), 'xetex');
  assert.equal(inferEngine('\\usepackage{unicode-math}'), 'xetex');
  assert.equal(
    inferBibTool('\\usepackage[backend=bibtex, style=numeric, sorting=none]{biblatex}'),
    'bibtex');
});
