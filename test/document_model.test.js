// The single project index.
//
// Everything that needs to know what the document contains — completions, the
// outline, every picker — reads this. So the cases that matter are the ones
// where a naive regex is wrong: nested braces in a caption, commented-out code,
// and an unterminated environment.

const { test } = require('node:test');
const assert = require('node:assert');

let _mod;
const mod = async () => (_mod ??= await import('../www/jvscrpt_and_css_extra/document_model.js'));

/** A project in the shape the app uses: a Map of path → {content, binary}. */
function project(files) {
  return {
    key: 'test',
    files: new Map(Object.entries(files).map(([path, content]) => [
      path,
      typeof content === 'string'
        ? { content, binary: false }
        : { content, binary: true }
    ]))
  };
}

const scan = async (files) => (await mod()).scanProject(project(files));

/* ── labels, sections, structure ─────────────────────────────────────── */

test('collects labels and sections in order', async () => {
  const ix = await scan({
    'main.tex': [
      '\\section{Introduction}',
      'Text \\label{sec:intro}',
      '\\subsection{Background}',
      '\\section{Method}'
    ].join('\n')
  });
  assert.deepEqual(ix.labels, ['sec:intro']);
  assert.deepEqual(ix.sections.map(s => [s.level, s.title]), [
    [2, 'Introduction'], [3, 'Background'], [2, 'Method']
  ]);
  assert.deepEqual(ix.sections.map(s => s.line), [1, 3, 4]);
});

test('a section title containing a command is readable', async () => {
  const ix = await scan({ 'main.tex': '\\section{The \\textbf{hard} case}' });
  assert.equal(ix.sections[0].title, 'The hard case');
});

test('escaped characters survive the title cleanup', async () => {
  // From the book fixture. Showing the backslash reads as a bug in the outline
  // rather than as correct TeX in the source.
  const ix = await scan({
    'main.tex': '\\subsection{Multi-Row \\& Multi-Column, 50\\% done\\\\ or so}'
  });
  assert.equal(ix.sections[0].title, 'Multi-Row & Multi-Column, 50% done or so');
});

test('commented-out structure is ignored', async () => {
  // The homework fixture is full of this. A commented \section in the outline
  // would jump the cursor to a line that is not a heading.
  const ix = await scan({
    'main.tex': '% \\section{Not real}\n\\section{Real}\n%\\begin{figure}\n'
  });
  assert.deepEqual(ix.sections.map(s => s.title), ['Real']);
  assert.deepEqual(ix.environments, []);
});

/* ── environments ────────────────────────────────────────────────────── */

test('indexes figures, tables and equations by kind', async () => {
  const ix = await scan({
    'main.tex': [
      '\\begin{figure}\\includegraphics{img/a.png}\\caption{A}\\label{fig:a}\\end{figure}',
      '\\begin{table}\\caption{T}\\label{tab:t}\\end{table}',
      '\\begin{equation}\\label{eq:e} x=1 \\end{equation}',
      '\\begin{align*} y=2 \\end{align*}'
    ].join('\n')
  });
  assert.deepEqual(ix.environments.map(e => e.kind),
    ['figure', 'table', 'equation', 'equation']);
  assert.equal(ix.environments[0].label, 'fig:a');
  assert.equal(ix.environments[0].caption, 'A');
  assert.equal(ix.environments[0].graphic, 'img/a.png');
  assert.equal(ix.environments[3].label, null, 'align* has no label here');
});

test('a caption with nested braces is read whole', async () => {
  // The case a regex gets wrong: /\\caption\{([^}]+)\}/ stops at the first }.
  const ix = await scan({
    'main.tex': '\\begin{figure}\\caption{Result for $\\alpha_{1}$ and \\textbf{bold}}\\end{figure}'
  });
  assert.equal(ix.environments[0].caption, 'Result for $\\alpha_{1}$ and \\textbf{bold}');
});

test('an unterminated environment is skipped, not guessed at', async () => {
  const ix = await scan({ 'main.tex': '\\begin{figure}\\caption{oops}\n' });
  assert.deepEqual(ix.environments, []);
});

test('environments carry the line range and file', async () => {
  const ix = await scan({
    'ch/one.tex': 'line one\n\\begin{equation}\nx = 1\n\\end{equation}\n'
  });
  const e = ix.environments[0];
  assert.equal(e.file, 'ch/one.tex');
  assert.equal(e.startLine, 2);
  assert.equal(e.endLine, 4);
});

/* ── the include graph, and the outline built on it ──────────────────── */

/** A project with a `main`, which the include walk starts from. */
function doc(main, files) {
  const p = project(files);
  p.main = main;
  return p;
}

test('reading order follows \\input and \\include, not the file map', async () => {
  const { projectIndex } = await mod();
  const ix = projectIndex(doc('main.tex', {
    // Deliberately inserted in an order that is not the reading order.
    'ch/b.tex': '\\chapter{B}',
    'main.tex': '\\input{ch/a}\n\\include{ch/b}\n\\input{./ch/c.tex}',
    'ch/c.tex': '\\chapter{C}',
    'ch/a.tex': '\\chapter{A}'
  }));
  assert.deepEqual(ix.order, ['main.tex', 'ch/a.tex', 'ch/b.tex', 'ch/c.tex']);
});

test('\\includegraphics is not an include', async () => {
  const { projectIndex } = await mod();
  const ix = projectIndex(doc('main.tex', {
    'main.tex': '\\includegraphics{fig}\n\\includeonly{ch/a}',
    'fig.tex': '\\section{Trap}',
    'ch/a.tex': '\\section{Also a trap}'
  }));
  assert.deepEqual(ix.order, ['main.tex']);
});

test('an include cycle terminates', async () => {
  const { projectIndex } = await mod();
  const ix = projectIndex(doc('main.tex', {
    'main.tex': '\\input{a}',
    'a.tex': '\\input{b}',
    'b.tex': '\\input{a}\n\\input{main}'
  }));
  assert.deepEqual(ix.order, ['main.tex', 'a.tex', 'b.tex']);
});

test('the outline is in reading order across files', async () => {
  const { outlineOf } = await mod();
  const out = outlineOf(doc('main.tex', {
    'ch/two.tex': '\\chapter{Two}\n\\section{Two.a}',
    'main.tex': '\\chapter{One}\n\\include{ch/two}\n\\include{ch/three}',
    'ch/three.tex': '\\chapter{Three}'
  }));
  assert.deepEqual(out.map(s => s.title), ['One', 'Two', 'Two.a', 'Three']);
  assert.ok(out.every(s => s.included));
});

test('a file nothing includes is flagged, not silently merged in', async () => {
  // The book fixture ships main_legacy.tex — a whole second copy of the
  // document. Treating its chapters as part of the outline would show the book
  // twice, in an order that means nothing.
  const { outlineOf } = await mod();
  const out = outlineOf(doc('main.tex', {
    'main.tex': '\\chapter{Real}',
    'main_legacy.tex': '\\chapter{Old}'
  }));
  assert.deepEqual(out.map(s => [s.title, s.included]), [['Real', true], ['Old', false]]);
});

/* ── bibliography ────────────────────────────────────────────────────── */

test('reads bib entries with the fields a picker needs', async () => {
  const ix = await scan({
    'refs.bib': [
      '@article{smith2020,',
      '  author = {Smith, Jane and Doe, John},',
      '  title  = {On {LaTeX} indexing},',
      '  year   = {2020}',
      '}',
      '@book{jones1999, author = "Jones, A", title = "Older", year = 1999 }'
    ].join('\n')
  });
  assert.deepEqual(ix.citations, ['jones1999', 'smith2020']);
  const smith = ix.bib.find(b => b.key === 'smith2020');
  assert.equal(smith.author, 'Smith, Jane and Doe, John');
  assert.equal(smith.title, 'On LaTeX indexing', 'brace-protected casing is unwrapped');
  assert.equal(smith.year, '2020');
  // Quoted and bare values, which real .bib files mix freely.
  const jones = ix.bib.find(b => b.key === 'jones1999');
  assert.equal(jones.author, 'Jones, A');
  assert.equal(jones.year, '1999');
});

test('\\bibitem keys count as citations', async () => {
  const ix = await scan({ 'main.tex': '\\bibitem[X]{manual99} Manual entry' });
  assert.deepEqual(ix.citations, ['manual99']);
});

/* ── images and macros ───────────────────────────────────────────────── */

test('binary files with image extensions are listed', async () => {
  const ix = await scan({
    'main.tex': 'text',
    'img/a.png': new Uint8Array([1, 2]),
    'img/b.pdf': new Uint8Array([3]),
    'data/notes.dat': new Uint8Array([4])
  });
  assert.deepEqual(ix.images.map(i => i.path), ['img/a.png', 'img/b.pdf']);
  assert.equal(ix.images[0].ext, 'png');
});

test('collects macros for a maths preview', async () => {
  const ix = await scan({
    'main.tex': [
      '\\newcommand{\\R}{\\mathbb{R}}',
      '\\newcommand{\\norm}[1]{\\left\\|#1\\right\\|}',
      '\\DeclareMathOperator{\\tr}{tr}'
    ].join('\n')
  });
  assert.equal(ix.macros['\\R'], '\\mathbb{R}');
  assert.equal(ix.macros['\\norm'], '\\left\\|#1\\right\\|');
  assert.equal(ix.macros['\\tr'], '\\operatorname{tr}');
});

/* ── the cache ───────────────────────────────────────────────────────── */

test('the index is cached until a buffer changes', async () => {
  const { projectIndex } = await mod();
  const p = project({ 'main.tex': '\\section{One}' });
  const first = projectIndex(p);
  assert.equal(projectIndex(p), first, 'same content must not rescan');

  p.files.get('main.tex').content = '\\section{One}\n\\section{Two}';
  const second = projectIndex(p);
  assert.notEqual(second, first, 'a changed buffer must rescan');
  assert.equal(second.sections.length, 2);
});

test('switching project rescans even at the same length', async () => {
  const { projectIndex } = await mod();
  const a = projectIndex(project({ 'main.tex': '\\section{AAA}' }));
  const b = projectIndex({ key: 'other', files: new Map([['main.tex', { content: '\\section{BBB}', binary: false }]]) });
  assert.notEqual(a.sections[0].title, b.sections[0].title);
});

test('an empty or missing project is safe', async () => {
  const { projectIndex } = await mod();
  const ix = projectIndex(null);
  assert.deepEqual(ix.labels, []);
  assert.deepEqual(ix.environments, []);
});
