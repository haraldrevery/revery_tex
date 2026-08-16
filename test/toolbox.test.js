// The pure parts of the toolbox: how things are named in a list, and which
// files are worth offering as figures.
//
// The menus themselves are checked in the browser (test/run_ui.js). What is
// worth testing here is the naming, because a list you cannot scan is the same
// as no list, and the output-PDF filter, because every fixture in this repo has
// compiled PDFs sitting beside its sources.

const { test } = require('node:test');
const assert = require('node:assert');

let _mod;
const mod = async () => (_mod ??= await import('../www/jvscrpt_and_css_extra/toolbox.js'));

test('a filename becomes a first draft of a caption', async () => {
  const { captionFromPath } = await mod();
  assert.equal(captionFromPath('logo/chalmers_logo.png'), 'Chalmers logo');
  assert.equal(captionFromPath('graphs/time-res.jpg'), 'Time res');
  assert.equal(captionFromPath('a.png'), 'A');
});

test('a compiled PDF is not offered as an illustration', async () => {
  // Every fixture here has one. Offering main.pdf as a figure for main.tex is
  // never what anyone meant.
  const { figureCandidates } = await mod();
  const project = {
    files: new Map([
      ['main.tex', { content: 'x' }],
      ['main.pdf', { content: new Uint8Array(), binary: true }],
      ['diagram.pdf', { content: new Uint8Array(), binary: true }],
      ['photo.png', { content: new Uint8Array(), binary: true }]
    ])
  };
  const index = { images: [{ path: 'main.pdf' }, { path: 'diagram.pdf' }, { path: 'photo.png' }] };
  assert.deepEqual(figureCandidates(project, index).map(i => i.path),
    ['diagram.pdf', 'photo.png'], 'a PDF with no matching .tex is a real figure');
});

test('a citation is findable by author, title, year or key', async () => {
  // The picker's filter box matches this string. The submenu it replaced showed
  // an author, a year and a title cut at 40 characters, so anything further in
  // than that was unreachable except by already knowing the key.
  const { citationSearchText } = await mod();
  const text = citationSearchText({
    key: 'smith2020', type: 'article', author: 'Smith, Jane and Doe, John',
    title: 'On indexing very large bibliographies without losing your mind', year: '2020'
  });
  for (const q of ['smith2020', 'Doe', 'losing your mind', '2020', 'article']) {
    assert.ok(text.toLowerCase().includes(q.toLowerCase()), `should be findable by ${q}`);
  }
});

test('a \\bibitem key with no metadata is still findable', async () => {
  // It is still citable, so it must still be listed — under the only name it has.
  const { citationSearchText } = await mod();
  assert.equal(citationSearchText({ key: 'manual99', author: '', title: '', year: '' }), 'manual99');
});

test('a journal article reads as a full reference', async () => {
  // The list shows the whole thing. This is the shape every entry in
  // latex_project_tests/Simulation_Latex_folder/biblio-FFR120-FYM119.bib has.
  const { formatReference } = await mod();
  const r = formatReference({
    key: 'boccaletti2014', type: 'article',
    author: 'Boccaletti, S. and Bianconi, G. and Criado, R.',
    title: 'The structure and dynamics of multilayer networks',
    journal: 'Physics Reports', publisher: 'Elsevier BV',
    volume: '544', number: '1', pages: '1--122', year: '2014',
    doi: '10.1016/j.physrep.2014.07.001'
  });
  // Every author, not "et al." — the point of the list is that nothing is cut.
  assert.equal(r.authors, 'Boccaletti, S.; Bianconi, G.; Criado, R.');
  assert.equal(r.title, 'The structure and dynamics of multilayer networks');
  assert.equal(r.source,
    'Physics Reports, Elsevier BV, 544(1), pp. 1–122, 2014 · doi:10.1016/j.physrep.2014.07.001');
});

test('a sparse book reference emits no stray punctuation', async () => {
  // The failure mode worth guarding: joining absent fields leaves ", , 1984".
  const { formatReference } = await mod();
  const r = formatReference({
    key: 'knuth1984', type: 'book',
    author: 'Knuth, Donald E.', title: 'The \\TeX book',
    publisher: 'Addison-Wesley', year: '1984'
  });
  assert.equal(r.authors, 'Knuth, Donald E.');
  assert.equal(r.title, 'The TeX book');
  assert.equal(r.source, 'Addison-Wesley, 1984');
});

test('an edited volume lists its editors, marked as such', async () => {
  // @book{goossens1993, editor={…}} — the shape in
  // latex_project_tests/hrldrvry_book_templt_v1/references.bib. Reading only
  // `author` listed it under no name at all.
  const { formatReference } = await mod();
  const r = formatReference({
    key: 'goossens1993', type: 'book',
    editor: 'Goossens, Michel and Mittelbach, Frank',
    title: 'The {\\LaTeX} Companion'.replace(/[{}]/g, ''),
    publisher: 'Addison-Wesley', year: '1993'
  });
  assert.equal(r.authors, 'Goossens, Michel; Mittelbach, Frank (eds.)');
  assert.equal(r.title, 'The LaTeX Companion');
});

test('an author beats an editor when an entry carries both', async () => {
  const { formatReference } = await mod();
  const r = formatReference({ key: 'x', author: 'Real, A', editor: 'Other, B' });
  assert.equal(r.authors, 'Real, A');
});

test('an issue number with no volume is dropped, not shown bare', async () => {
  const { formatReference } = await mod();
  const r = formatReference({ key: 'x', journal: 'J', number: '3', year: '2020' });
  assert.equal(r.source, 'J, 2020', 'a lone "(3)" reads as a typo');
});

test('an entry with nothing in it formats to nothing', async () => {
  // What the row's "key only" fallback tests for. Three empty strings, not
  // three strings of leftover separators.
  const { formatReference } = await mod();
  assert.deepEqual(formatReference({ key: 'manual99' }), { authors: '', title: '', source: '' });
});

test('the escapes that actually appear in a .bib are resolved', async () => {
  const { bibText } = await mod();
  assert.equal(bibText('Knuth \\& Plass'), 'Knuth & Plass');
  assert.equal(bibText('\\LaTeX and \\TeX and \\LaTeXe'), 'LaTeX and TeX and LaTeX2e');
  // The real fixtures write `The {\TeX}book`, and scanBib strips the braces
  // before this sees it — so the macro has to resolve with a letter right
  // behind it, or the backslash survives onto the screen.
  assert.equal(bibText('The \\TeXbook'), 'The TeXbook');
  // Longest first, or \LaTeX eats the \TeX inside it and leaves a stray tail.
  assert.equal(bibText('\\LaTeXe'), 'LaTeX2e');
  assert.equal(bibText('pages 45--67'), 'pages 45–67');
  assert.equal(bibText('\\LaTeX --- Wikipedia'), 'LaTeX — Wikipedia');
  assert.equal(bibText('a\n  b   c'), 'a b c', 'wrapped .bib values collapse to one line');
  // Not a LaTeX interpreter: anything outside the table is shown as written,
  // which is more honest than a wrong guess.
  assert.equal(bibText('\\textbf{bold}'), '\\textbf{bold}');
});

test('a table is named by its caption, falling back to its label', async () => {
  const { tableRowLabel } = await mod();
  assert.equal(tableRowLabel({ caption: 'Results\n  by year', label: 'tab:r' }), 'Results by year');
  assert.equal(tableRowLabel({ caption: '', label: 'tab:r' }), 'tab:r');
  assert.equal(tableRowLabel({ caption: '', label: null }), '(untitled)');
  assert.ok(tableRowLabel({ caption: 'x'.repeat(80), label: 'y' }).length <= 44);
});
