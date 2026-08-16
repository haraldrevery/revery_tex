// Which file is the document, and re-deriving what follows from it.
//
// Two defects are covered here, and they are the same defect seen twice: the
// main file was inferred once, at load, and everything derived from it was
// computed once with it. Neither could be revised afterwards.
//
//   - A folder with several \documentclass files compiled whichever one
//     `pickMain` happened to choose. `cv_template` in latex_project_tests holds
//     four and no main.tex, so three of its documents could not be compiled by
//     the app at all, and the chosen one was additionally protected from
//     rename, move and delete — so there was no workaround either.
//   - Adding \makeindex or \bibliography{} to an open project changed nothing
//     until the folder was reopened. Unlike the engine, which at least has the
//     topbar dropdown to overrule it, neither of those has any override.
//
// project_store.js touches no DOM, so it imports directly — the same
// arrangement test/bib_detect.test.js uses, and for the same reason.

const { test } = require('node:test');
const assert = require('node:assert');

let _store;
const store = async () =>
  (_store ??= await import('../www/jvscrpt_and_css_extra/project_store.js'));

/** A project shaped like the real one, from `{path: source}`. */
const projectOf = (files, main = null) => ({
  key: 'test', main, onDisk: true,
  files: new Map(Object.entries(files).map(([p, content]) => [p, { content }]))
});

/* ── which files could be the document ───────────────────────────────── */

test('only .tex files carrying \\documentclass are candidates', async () => {
  const { mainCandidates } = await store();
  const p = projectOf({
    'main.tex': '\\documentclass{article}\\begin{document}x\\end{document}',
    'chapters/one.tex': '\\section{One}',
    'references.bib': '@book{a, title={T}}',
    'preamble.sty': '\\documentclass{article}'      // not .tex
  });
  assert.deepEqual(mainCandidates(p), ['main.tex']);
});

test('a commented-out \\documentclass does not make a file a candidate', async () => {
  const { mainCandidates } = await store();
  // How people park an alternative preamble. This scan was the one place in
  // project_store.js reading raw text rather than comment-stripped text, so a
  // parked preamble counted as a document the project could be compiled from.
  const p = projectOf({
    'main.tex': '\\documentclass{article}',
    'old.tex': '% \\documentclass{report}\n\\section{leftovers}'
  });
  assert.deepEqual(mainCandidates(p), ['main.tex']);
});

test('an escaped percent does not hide a real \\documentclass', async () => {
  const { mainCandidates } = await store();
  const p = projectOf({ 'odd.tex': '\\documentclass{article} % 50\\% margin' });
  assert.deepEqual(mainCandidates(p), ['odd.tex']);
});

test('every .tex is offered when none declares a class', async () => {
  const { mainCandidates } = await store();
  // A project whose preamble lives in an \input-ed file still has to be
  // compilable, so "nothing qualifies" must not mean "nothing is offered".
  const p = projectOf({ 'doc.tex': '\\input{preamble}', 'preamble.tex': '\\usepackage{amsmath}' });
  assert.deepEqual(mainCandidates(p), ['doc.tex', 'preamble.tex']);
});

test('the four-document case that started this is fully offered', async () => {
  const { mainCandidates } = await store();
  // cv_template: four \documentclass files, no main.tex. pickMain takes
  // cv_harald_thirslund_sv.tex alphabetically; the other three were unreachable.
  const cls = '\\documentclass{article}\\begin{document}x\\end{document}';
  const p = projectOf({
    'cv_teknisk_fysik_en.tex': cls,
    'personligt_brev_en.tex': cls,
    'personligt_brev_sv.tex': cls,
    'cv_harald_thirslund_sv.tex': cls
  });
  assert.deepEqual(mainCandidates(p), [
    'cv_harald_thirslund_sv.tex',
    'cv_teknisk_fysik_en.tex',
    'personligt_brev_en.tex',
    'personligt_brev_sv.tex'
  ]);
});

test('the current main is always in the list, even if it would not qualify', async () => {
  const { mainCandidates } = await store();
  // The list is a menu. A menu that omits what it is currently set to cannot
  // show its own state — SelectMenu would fall back to the first option and the
  // topbar would name a file that is not the one being compiled.
  const p = projectOf({
    'main.tex': '\\documentclass{article}',
    'fragment.tex': '\\section{no class here}'
  }, 'fragment.tex');
  assert.deepEqual(mainCandidates(p), ['fragment.tex', 'main.tex']);
});

test('binary files are never candidates', async () => {
  const { mainCandidates } = await store();
  // content is bytes, not a string — reading it as text would throw.
  const p = { key: 't', main: null, files: new Map([
    ['main.tex', { content: '\\documentclass{article}' }],
    ['figure.tex', { content: new Uint8Array([1, 2, 3]), binary: true }]
  ]) };
  assert.deepEqual(mainCandidates(p), ['main.tex']);
});

/* ── re-deriving what follows from the document ──────────────────────── */

test('an edit that adds \\makeindex is picked up', async () => {
  const { redescribeProject } = await store();
  const p = projectOf({ 'main.tex': '\\documentclass{article}' }, 'main.tex');
  redescribeProject(p);
  assert.equal(p.makeindex, false);

  p.files.get('main.tex').content = '\\documentclass{article}\\makeindex';
  redescribeProject(p);
  assert.equal(p.makeindex, true, 'should be re-derived from the buffer, not the load-time text');
});

test('an edit that adds a bibliography is picked up', async () => {
  const { redescribeProject } = await store();
  const p = projectOf({ 'main.tex': '\\documentclass{article}' }, 'main.tex');
  redescribeProject(p);
  assert.equal(p.bibtex, null);

  p.files.get('main.tex').content = '\\documentclass{article}\\bibliography{refs}';
  redescribeProject(p);
  assert.equal(p.bibtex, 'bibtex');
});

test('the walk follows \\input, so a bibliography in an included file counts', async () => {
  const { redescribeProject } = await store();
  const p = projectOf({
    'main.tex': '\\documentclass{article}\\input{back}',
    'back.tex': '\\addbibresource{refs.bib}\\printbibliography'
  }, 'main.tex');
  redescribeProject(p);
  assert.equal(p.bibtex, 'biber');
});

test('changing the main file re-derives everything that follows from it', async () => {
  const { redescribeProject } = await store();
  // The book case: two complete main files in one folder, wanting different
  // engines and different bibliography tools. Re-pointing main without
  // re-deriving would compile the second document with the first one's answers.
  const p = projectOf({
    'main.tex': '\\documentclass{book}\\usepackage{fontspec}\\addbibresource{r.bib}',
    'main_legacy.tex': '\\documentclass{book}\\makeindex'
  }, 'main.tex');

  redescribeProject(p);
  assert.equal(p.engine, 'xetex');
  assert.equal(p.bibtex, 'biber');
  assert.equal(p.makeindex, false);

  p.main = 'main_legacy.tex';
  redescribeProject(p);
  assert.equal(p.engine, 'pdftex', 'the legacy document does not load fontspec');
  assert.equal(p.bibtex, null, 'and has no bibliography');
  assert.equal(p.makeindex, true, 'but does have an index');
});

test('a file the document never reads cannot contribute settings', async () => {
  const { redescribeProject } = await store();
  // The reason the walk exists at all: main_legacy.tex is a second complete
  // main file nothing includes, and reading its preamble too would pick up
  // settings this document never asked for.
  const p = projectOf({
    'main.tex': '\\documentclass{article}',
    'main_legacy.tex': '\\documentclass{book}\\usepackage{fontspec}\\makeindex'
  }, 'main.tex');
  redescribeProject(p);
  assert.equal(p.engine, 'pdftex');
  assert.equal(p.makeindex, false);
});

test('redescribeProject is idempotent', async () => {
  const { redescribeProject } = await store();
  // It is called on every compile, so running it twice must not drift.
  const p = projectOf({
    'main.tex': '\\documentclass{article}\\usepackage{unicode-math}\\bibliography{r}\\makeindex'
  }, 'main.tex');
  redescribeProject(p);
  const first = { engine: p.engine, bibtex: p.bibtex, makeindex: p.makeindex };
  redescribeProject(p);
  assert.deepEqual({ engine: p.engine, bibtex: p.bibtex, makeindex: p.makeindex }, first);
});
