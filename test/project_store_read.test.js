// readProjectFromDisk, over a stand-in backend: what happens to a file the
// backend will not hand over as text.

const { test } = require('node:test');
const assert = require('node:assert');

let _store;
const store = async () =>
  (_store ??= await import('../www/jvscrpt_and_css_extra/project_store.js'));

const enc = new TextEncoder();
const LATIN1 = Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x0a]);   // "Café\n" in Latin-1

/**
 * A backend holding `files` (path → bytes). Text reads refuse anything that is
 * not valid UTF-8, the way the Tauri shell already does and the others will.
 */
function fakeApi(files) {
  return {
    readDirectory: async () => Object.keys(files).map(p => ({ name: p.split('/').pop(), path: p, type: 'file' })),
    readTextFile: async (p) => {
      try {
        return { content: new TextDecoder('utf-8', { fatal: true }).decode(files[p]),
                 stamp: { mtime_ms: 1, size: files[p].length } };
      } catch {
        throw new Error(`Cannot read ${p}: stream did not contain valid UTF-8`);
      }
    },
    readBinaryFile: async (p) => files[p]
  };
}

test('a project of UTF-8 files loads as text', async () => {
  const { readProjectFromDisk } = await store();
  const p = await readProjectFromDisk(fakeApi({
    'main.tex': enc.encode('\\documentclass{article}\n')
  }), '/work/thesis');
  assert.equal(p.main, 'main.tex');
  assert.equal(p.files.get('main.tex').binary, false);
});

// A file the backend refused as text used to be dropped with a warning. It
// vanished from the tree, from the WASM compile and — on the zip backend, where
// the store *is* the project — from Export, so the next import of that export
// had lost it. It is kept, as bytes, and left alone.
test('a file that is not UTF-8 is kept as bytes rather than dropped', async () => {
  const { readProjectFromDisk } = await store();
  const warned = [];
  const p = await readProjectFromDisk(fakeApi({
    'main.tex': enc.encode('\\documentclass{article}\n\\input{legacy}\n'),
    'legacy.tex': LATIN1
  }), '/work/thesis', { onWarn: (m) => warned.push(m) });
  const f = p.files.get('legacy.tex');
  assert.ok(f, `legacy.tex was dropped from the project (${warned.join('; ')})`);
  assert.equal(f.binary, true, 'kept, but as text it cannot faithfully hold');
  assert.deepEqual([...f.content], [...LATIN1], 'kept, but not byte for byte');
  // Read-only is the binary flag; this says why, for the tree and the preview.
  assert.match(f.textError, /valid UTF-8/);
  assert.equal(f.stamp, null);
  assert.ok(warned.some(m => /legacy\.tex .*read-only/.test(m)), warned.join('; '));
});

// A Latin-1 main.tex is still the document — its \documentclass is found by
// reading the bytes one per character — and inference still reads its preamble.
test('a main file held as bytes is still recognised, and still described', async () => {
  const { readProjectFromDisk } = await store();
  const src = Uint8Array.from(Buffer.from(
    '\\documentclass{article}\n\\usepackage[latin1]{inputenc}\n\\begin{document}\nCaf\xe9 \\cite{k}\n' +
    '\\bibliography{refs}\n\\end{document}\n', 'latin1'));
  const p = await readProjectFromDisk(fakeApi({
    'main.tex': src,
    'chapters/one.tex': enc.encode('Just a chapter.\n'),
    'refs.bib': enc.encode('@book{k, title={K}}\n')
  }), '/work/legacy');
  assert.equal(p.main, 'main.tex');
  assert.equal(p.files.get('main.tex').binary, true);
  assert.equal(p.bibtex, 'bibtex', 'the preamble of a main file held as bytes was not read');
});

// Between two equally good guesses, the one that can be edited. Neither is
// main.tex and both are top-level, so the tie is broken by what can be opened —
// alphabetically, the Latin-1 one would have won.
test('between two equal candidates, the one held as text is the main file', async () => {
  const { readProjectFromDisk, mainCandidates } = await store();
  const p = await readProjectFromDisk(fakeApi({
    'a_legacy.tex': Uint8Array.from(Buffer.from('\\documentclass{article}\n% Caf\xe9\n', 'latin1')),
    'b_current.tex': enc.encode('\\documentclass{article}\n')
  }), '/work/two');
  assert.equal(p.main, 'b_current.tex');
  assert.deepEqual(mainCandidates(p), ['a_legacy.tex', 'b_current.tex'],
    'the one held as bytes is still offered in the Document menu');
});

// …but a better guess is not given up for it: main.tex wins on its name alone.
test('main.tex held as bytes still beats a better-encoded file elsewhere', async () => {
  const { readProjectFromDisk } = await store();
  const p = await readProjectFromDisk(fakeApi({
    'main.tex': Uint8Array.from(Buffer.from('\\documentclass{book}\n% \xe9\n', 'latin1')),
    'notes.tex': enc.encode('\\documentclass{article}\n')
  }), '/work/book');
  assert.equal(p.main, 'main.tex');
});
