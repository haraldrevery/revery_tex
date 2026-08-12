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

test('citations are named by author and year, not by key', async () => {
  const { citationRowLabel } = await mod();
  assert.equal(
    citationRowLabel({ key: 'smith2020', author: 'Smith, Jane and Doe, John', title: 'On indexing', year: '2020' }),
    'Smith et al. 2020 — On indexing');
  assert.equal(
    citationRowLabel({ key: 'jones1999', author: 'Jones, A', title: 'Older', year: '1999' }),
    'Jones 1999 — Older');
  // A \bibitem key with no metadata is still citable, so it must still be
  // listed — under the only name it has.
  assert.equal(citationRowLabel({ key: 'manual99', author: '', title: '', year: '' }), 'manual99');
});

test('a table is named by its caption, falling back to its label', async () => {
  const { tableRowLabel } = await mod();
  assert.equal(tableRowLabel({ caption: 'Results\n  by year', label: 'tab:r' }), 'Results by year');
  assert.equal(tableRowLabel({ caption: '', label: 'tab:r' }), 'tab:r');
  assert.equal(tableRowLabel({ caption: '', label: null }), '(untitled)');
  assert.ok(tableRowLabel({ caption: 'x'.repeat(80), label: 'y' }).length <= 44);
});
