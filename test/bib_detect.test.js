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

/**
 * The implementation lives in the app module, which cannot be imported here —
 * it touches the DOM at load. Lifting the two functions out by name keeps this
 * a real unit test of the shipped source rather than a copy that can drift.
 */
function lift(...names) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'www', 'jvscrpt_and_css_extra', 'revery_tex_app.js'), 'utf8');
  const bodies = names.map((name) => {
    const start = src.indexOf(`function ${name}`);
    assert.ok(start > 0, `${name} has been renamed or removed`);
    // To the closing brace at column 0 — the app file is formatted that way.
    const end = src.indexOf('\n}\n', start);
    assert.ok(end > start, `could not find the end of ${name}`);
    return src.slice(start, end + 3);
  });
  // eslint-disable-next-line no-new-func
  return new Function(`${bodies.join('\n')}; return { ${names.join(', ')} };`)();
}

const { inferBibTool } = lift('stripTexComments', 'inferBibTool');

test('biblatex resolves to biber', () => {
  assert.equal(inferBibTool('\\addbibresource{references.bib}'), 'biber');
  assert.equal(inferBibTool('\\printbibliography[heading=bibintoc]'), 'biber');
  assert.equal(inferBibTool('\\usepackage[backend=biber]{biblatex}'), 'biber');
  assert.equal(inferBibTool('\\usepackage{biblatex}'), 'biber');
});

test('classic bibliography resolves to bibtex', () => {
  assert.equal(inferBibTool('\\bibliography{refs}'), 'bibtex');
  assert.equal(inferBibTool('\\bibliographystyle{plain}\n\\bibliography{refs}'), 'bibtex');
});

test('a document with no bibliography needs no tool', () => {
  assert.equal(inferBibTool('\\documentclass{article}\\begin{document}hi\\end{document}'), null);
  assert.equal(inferBibTool(''), null);
});

test('biblatex wins when both shapes appear', () => {
  // \bibliographystyle is inert under biblatex but people leave it behind when
  // they migrate. Running bibtex on that document would rebuild the .bbl in the
  // wrong format and the bibliography would come out empty.
  const migrated = '\\usepackage{biblatex}\n\\addbibresource{refs.bib}\n% \\bibliographystyle{plain}';
  assert.equal(inferBibTool(migrated), 'biber');
});

/* ── against the real fixtures, which is what this is for ─────────────── */

const FIXTURES = path.join(__dirname, '..', '..', 'latex_project_tests');
const haveFixtures = fs.existsSync(FIXTURES);

test('the book fixture is detected as biblatex', { skip: !haveFixtures }, () => {
  const src = fs.readFileSync(path.join(FIXTURES, 'hrldrvry_book_templt_v2', 'main.tex'), 'utf8');
  assert.equal(inferBibTool(src), 'biber',
    'the book template uses \\addbibresource and \\printbibliography');
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

test('a commented-out bibliography is not detected', { skip: !haveFixtures }, () => {
  // homework has \bibliography commented out. Running bibtex because of a
  // commented line would be a spurious failure on a document that compiles.
  const src = fs.readFileSync(path.join(FIXTURES, 'homework_template', 'main.tex'), 'utf8');
  assert.equal(inferBibTool(src), null,
    'the homework template only mentions \\bibliography inside comments');
});
