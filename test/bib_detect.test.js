// Which bibliography tool a document needs.
//
// This exists because the app shipped with the answer permanently "none":
// project.bibtex was read but never assigned, so neither engine ever ran a
// bibliography step — including the bundled one, which has had working
// bibtex8 all along.
//
// The distinction that matters is biblatex vs classic. They are not
// substitutes: biber on a classic document fails, bibtex on a biblatex one
// produces a bibliography that is silently wrong. Picking "whichever is
// installed" is wrong for one of the two test fixtures either way.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// project_store.js touches no DOM, so it imports directly — this used to lift
// the functions out of the app module's source by name, because they lived in a
// file that could not be loaded outside a browser.
//
// Memoised rather than assigned by a first test: tests that depend on an
// earlier one having run pass in order and fail the moment anyone filters.
let _store;
const store = async () =>
  (_store ??= await import('../www/jvscrpt_and_css_extra/project_store.js'));
const inferBibTool = async (src) => (await store()).inferBibTool(src);

test('biblatex resolves to biber', async () => {
  assert.equal(await inferBibTool('\\addbibresource{references.bib}'), 'biber');
  assert.equal(await inferBibTool('\\printbibliography[heading=bibintoc]'), 'biber');
  assert.equal(await inferBibTool('\\usepackage[backend=biber]{biblatex}'), 'biber');
  assert.equal(await inferBibTool('\\usepackage{biblatex}'), 'biber');
});

test('biblatex with backend=bibtex resolves to bibtex, not biber', async () => {
  // The bug this covers: the option string was ignored, so *any* biblatex
  // reported 'biber' and the app refused to run a tool. Meanwhile the log was
  // telling people to write exactly this line — biblatex.bst ships in the slim
  // bundle, so bundled bibtex8 can build the .bbl. Following the advice did
  // nothing, and the same advice was printed again next compile.
  assert.equal(await inferBibTool('\\usepackage[backend=bibtex]{biblatex}'), 'bibtex');
  assert.equal(await inferBibTool('\\usepackage[backend=bibtex8]{biblatex}'), 'bibtex');
  assert.equal(
    await inferBibTool('\\usepackage[style=authoryear, backend = bibtex]{biblatex}\n\\addbibresource{r.bib}'),
    'bibtex', 'reached past other options, and past whitespace around the =');
  // \addbibresource still means biblatex; it just no longer decides the backend.
  assert.equal(await inferBibTool('\\addbibresource{r.bib}\n\\usepackage[backend=bibtex]{biblatex}'), 'bibtex');
});

test('a backend set through ExecuteBibliographyOptions is honoured too', async () => {
  assert.equal(
    await inferBibTool('\\usepackage{biblatex}\n\\ExecuteBibliographyOptions{backend=bibtex}'),
    'bibtex');
  assert.equal(
    await inferBibTool('\\usepackage{biblatex}\n\\ExecuteBibliographyOptions{sorting=nyt}'),
    'biber', 'no backend named anywhere is still biber, which is biblatex\'s default');
});

test('a commented-out backend does not count', async () => {
  // stripTexComments runs first, so this is the biber default rather than the
  // line someone tried and put back.
  assert.equal(
    await inferBibTool('% \\usepackage[backend=bibtex]{biblatex}\n\\usepackage[backend=biber]{biblatex}'),
    'biber');
});

test('classic bibliography resolves to bibtex', async () => {
  assert.equal(await inferBibTool('\\bibliography{refs}'), 'bibtex');
  assert.equal(await inferBibTool('\\bibliographystyle{plain}\n\\bibliography{refs}'), 'bibtex');
});

test('a document with no bibliography needs no tool', async () => {
  assert.equal(await inferBibTool('\\documentclass{article}\\begin{document}hi\\end{document}'), null);
  assert.equal(await inferBibTool(''), null);
});

test('\\bibliographystyle alone is not a bibliography', async () => {
  // It writes no \bibdata, so BibTeX would end in "I found no \bibdata command".
  // It is also the single most common leftover in a real document: people
  // migrate to a hand-written thebibliography, comment out \bibliography, and
  // leave the style line behind. Running the tool on that reports a citation
  // failure for a bibliography that was already correct.
  assert.equal(await inferBibTool('\\bibliographystyle{plain}'), null);
  assert.equal(await inferBibTool('\\bibliographystyle{vancouver}\n%\\bibliography{kallor}'), null);
  // …and a manual list still needs nothing, however many \cite calls it has.
  assert.equal(await inferBibTool(
    '\\cite{a}\\begin{thebibliography}{9}\\bibitem{a}A.\\end{thebibliography}'), null);
});

test('biblatex wins when both shapes appear', async () => {
  // \bibliographystyle is inert under biblatex but people leave it behind when
  // they migrate. Running bibtex on that document would rebuild the .bbl in the
  // wrong format and the bibliography would come out empty.
  const migrated = '\\usepackage{biblatex}\n\\addbibresource{refs.bib}\n% \\bibliographystyle{plain}';
  assert.equal(await inferBibTool(migrated), 'biber');
});

/* ── against the real fixtures, which is what this is for ─────────────── */

const FIXTURES = path.join(__dirname, '..', '..', 'latex_project_tests');
const haveFixtures = fs.existsSync(FIXTURES);

/**
 * The files the fixture repo actually ships, as a Set of repo-relative paths.
 *
 * `null` when the answer cannot be had — no git, or a fixtures directory that
 * is not a checkout — so the caller can say so rather than guess.
 *
 * This is asked of git rather than of the filesystem because the two answer
 * different questions, and the test below wants the one only git can answer.
 * `existsSync` was standing in for "does this template ship a .bbl", but the
 * gate compiles these very directories in place, so bibtex8 writes a main.bbl
 * next to the source on every run. The test then failed for the *opposite* of
 * its own reason: not a stale artifact committed by mistake, but proof that the
 * tool it is asserting about had just run and worked. A tracked-files check
 * cannot be fooled by build output, which is the whole distinction.
 */
function shippedFiles() {
  const r = spawnSync('git', ['-C', FIXTURES, 'ls-files'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return new Set(r.stdout.split('\n').filter(Boolean));
}

test('the book templates build with the bundled bibtex8', { skip: !haveFixtures }, async () => {
  // They asked for biber and shipped a prebuilt main.bbl, because no WASM build
  // has biber. biblatex then rejected that .bbl as the wrong format version and
  // every citation came out undefined — the flagship template demonstrating the
  // bug. On backend=bibtex the bundle's own bibtex8 builds the .bbl, so the
  // bibliography is real everywhere and no .bbl needs committing.
  const shipped = shippedFiles();
  for (const dir of ['hrldrvry_book_templt_v1', 'hrldrvry_book_templt_v2']) {
    const src = fs.readFileSync(path.join(FIXTURES, dir, 'main.tex'), 'utf8');
    assert.equal(await inferBibTool(src), 'bibtex', `${dir} should be on backend=bibtex`);
    if (shipped) {
      assert.ok(!shipped.has(`${dir}/main.bbl`),
        `${dir} ships a committed .bbl — bibtex8 builds one on every compile, ` +
        `so the committed copy can only go stale`);
    }
  }
});

test('the thesis fixture needs no bibliography tool', { skip: !haveFixtures }, async () => {
  // examensLatexv5 is the document that exposed this. It keeps an uncommented
  // \bibliographystyle{vancouver}, has \bibliography{kallor} commented out, and
  // writes its bibliography by hand in manuellreferens.tex. It used to come
  // back as 'bibtex', so every compile ran bibtex8 on a document with no
  // \bibdata and reported the failure as a citation error.
  const dir = path.join(FIXTURES, 'examensLatexv5');
  if (!fs.existsSync(dir)) return;
  const src = fs.readFileSync(path.join(dir, 'main.tex'), 'utf8');
  assert.equal(await inferBibTool(src), null);
});

test('the homework fixture needs no bibliography tool', { skip: !haveFixtures }, async () => {
  const src = fs.readFileSync(path.join(FIXTURES, 'homework_template', 'main.tex'), 'utf8');
  assert.equal(await inferBibTool(src), null,
    'homework hand-writes its bibliography; both bib commands are commented out');
});

/* ── the engine must run the named tool, or none ──────────────────────── */

/** A NativeAPI stand-in that records what was asked of it. */
function fakeApi({ tools }) {
  const calls = [];
  return {
    calls,
    detectTex: async () => tools.map(name => ({ name, path: `/usr/bin/${name}`, version: name })),
    runTex: async (tool, mainFile) => {
      calls.push(tool);
      return { tool, code: 0, stdout: 'Output written on main.pdf (1 page).', stderr: '', timedOut: false };
    },
    readBinaryFile: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])   // "%PDF"
  };
}

async function compileWith({ tools, bibtex }) {
  const { NativeTexEngine } = await import('../www/jvscrpt_and_css_extra/tex_engine_native.js');
  const api = fakeApi({ tools });
  const logs = [];
  const eng = new NativeTexEngine({ api, onLog: (line) => logs.push(line) });
  await eng.init();
  await eng.compile({ mainFile: 'main.tex', engine: 'pdftex', passes: false, bibtex });
  return { calls: api.calls, logs: logs.join('\n') };
}

test('a biblatex document runs biber, never bibtex', async () => {
  const { calls } = await compileWith({ tools: ['pdflatex', 'bibtex', 'biber'], bibtex: 'biber' });
  assert.ok(calls.includes('biber'), `expected biber, ran: ${calls.join(', ')}`);
  assert.ok(!calls.includes('bibtex'), 'bibtex on a biblatex document builds a wrong bibliography');
});

test('a classic document runs bibtex even when biber is installed', async () => {
  // The bug this replaces: the engine picked biber whenever biber existed, so
  // every classic document failed on machines with a full TeX Live.
  const { calls } = await compileWith({ tools: ['pdflatex', 'bibtex', 'biber'], bibtex: 'bibtex' });
  assert.ok(calls.includes('bibtex'), `expected bibtex, ran: ${calls.join(', ')}`);
  assert.ok(!calls.includes('biber'), 'biber on a classic document fails');
});

test('a missing tool is named, and the other is not substituted', async () => {
  const { calls, logs } = await compileWith({ tools: ['pdflatex', 'bibtex'], bibtex: 'biber' });
  assert.ok(!calls.includes('bibtex'), 'must not fall back to the wrong tool');
  assert.match(logs, /needs biber/, `log should name the missing tool:\n${logs}`);
});

test('no bibliography means no bib tool runs', async () => {
  const { calls } = await compileWith({ tools: ['pdflatex', 'bibtex', 'biber'], bibtex: null });
  assert.deepEqual(calls.filter(c => c === 'biber' || c === 'bibtex'), []);
});

test('a commented-out bibliography is not detected', { skip: !haveFixtures }, async () => {
  // homework has \bibliography commented out. Running bibtex because of a
  // commented line would be a spurious failure on a document that compiles.
  const src = fs.readFileSync(path.join(FIXTURES, 'homework_template', 'main.tex'), 'utf8');
  assert.equal(await inferBibTool(src), null,
    'the homework template only mentions \\bibliography inside comments');
});

/* ── detection reads the document, not just the main file ────────────── */

/**
 * A fake NativeAPI over a plain {path: content} map.
 *
 * readProjectFromDisk is the only way in: `describe()` is private, which is
 * right — what matters is that a project opened from a folder comes out with
 * the correct tools, not how it got there.
 */
const openFolder = async (files) => {
  const { readProjectFromDisk } = await store();
  return readProjectFromDisk({
    readDirectory: async () => Object.keys(files).map(path => ({ path, type: 'file' })),
    readTextFile: async (path) => ({ content: files[path], stamp: null }),
    readBinaryFile: async () => new Uint8Array()
  }, '/tmp/proj');
};

test('a preamble in an \\input-ed file is still read', async () => {
  // The silent failure: describe() scanned main.tex alone, so a project that
  // keeps its preamble in its own file got no index and no bibliography at all
  // — and nothing was logged, because as far as the app knew the document had
  // never asked for either.
  const p = await openFolder({
    'main.tex': '\\documentclass{book}\n\\input{preamble}\n\\begin{document}\\printindex\\end{document}',
    'preamble.tex': '\\usepackage{biblatex}\n\\addbibresource{r.bib}\n\\makeindex\n'
  });
  assert.equal(p.bibtex, 'biber');
  assert.equal(p.makeindex, true);
});

test('the backend option survives being in an included preamble', async () => {
  const p = await openFolder({
    'main.tex': '\\documentclass{book}\n\\input{config/preamble.tex}\n',
    'config/preamble.tex': '\\usepackage[backend=bibtex]{biblatex}\n\\addbibresource{r.bib}\n'
  });
  assert.equal(p.bibtex, 'bibtex');
});

test('a file nothing includes does not decide the document', async () => {
  // The book fixture ships main_legacy.tex, a complete alternative main file
  // that nothing reads. Concatenating the folder rather than walking from the
  // main file would let its preamble set tools for a document it is not part of.
  const p = await openFolder({
    'main.tex': '\\documentclass{article}\n\\begin{document}hi\\end{document}',
    'main_legacy.tex': '\\documentclass{book}\n\\makeindex\n\\addbibresource{r.bib}\n'
  });
  assert.equal(p.bibtex, null);
  assert.equal(p.makeindex, false);
});

test('a commented-out include is not followed', async () => {
  const p = await openFolder({
    'main.tex': '\\documentclass{book}\n% \\input{preamble}\n',
    'preamble.tex': '\\makeindex\n'
  });
  assert.equal(p.makeindex, false);
});

test('an include cycle terminates', async () => {
  const p = await openFolder({
    'main.tex': '\\documentclass{book}\n\\input{a}\n',
    'a.tex': '\\input{b}\n',
    'b.tex': '\\input{a}\n\\makeindex\n'
  });
  assert.equal(p.makeindex, true);
});
