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

// Line endings. CodeMirror holds every document as LF, so a CRLF file read
// raw disagreed with the editor about every offset past its first line break,
// and the first save after an edit rewrote all of it as LF. Held as LF here,
// with the file's own ending kept for the way back.
test('a CRLF file is held as LF and remembers it was CRLF', async () => {
  const { readProjectFromDisk } = await store();
  const p = await readProjectFromDisk(fakeApi({
    'main.tex': enc.encode('\\documentclass{article}\r\n\\begin{document}\r\nx\r\n\\end{document}\r\n'),
    'unix.tex': enc.encode('just lf\n')
  }), '/work/windows');
  const f = p.files.get('main.tex');
  assert.equal(f.eol, '\r\n');
  assert.ok(!f.content.includes('\r'), `the buffer holds a CR: ${JSON.stringify(f.content)}`);
  assert.equal(p.files.get('unix.tex').eol, '\n');
  // Description reads the same text the editor will, so it is unaffected.
  assert.equal(p.main, 'main.tex');
});

test('a file mixing line endings is named, since saving will change the minority', async () => {
  const { readProjectFromDisk } = await store();
  const warned = [];
  const p = await readProjectFromDisk(fakeApi({
    'main.tex': enc.encode('\\documentclass{article}\r\n\\begin{document}\r\nx\n\\end{document}\r\n')
  }), '/work/mixed', { onWarn: (m) => warned.push(m) });
  assert.equal(p.files.get('main.tex').eol, '\r\n');
  assert.ok(warned.some(m => /main\.tex mixes line endings .*CRLF/.test(m)), warned.join('; '));
});

// Large folders. Sizes come from the listing so the question is asked before
// the first file is read — reading them is what took the time and the memory.
function sizedApi(entries, text = '\\documentclass{article}\n') {
  const reads = [];
  return {
    reads,
    readDirectory: async () => entries,
    readTextFile: async (p) => { reads.push(p); return { content: text, stamp: { mtime_ms: 1, size: 1 } }; },
    readBinaryFile: async (p) => { reads.push(p); return new Uint8Array(1); }
  };
}

test('a folder the listing could not enter is named, and the rest still opens', async () => {
  const { readProjectFromDisk } = await store();
  const warned = [];
  const p = await readProjectFromDisk(sizedApi([
    { name: 'main.tex', path: 'main.tex', type: 'file', size: 10 },
    { name: 'private', path: 'private', type: 'skipped', why: 'unreadable' },
    { name: 'd17', path: 'a/b/d17', type: 'skipped', why: 'too deep' }
  ]), '/work/p', { onWarn: (m) => warned.push(m) });
  assert.equal(p.main, 'main.tex');
  assert.ok(warned.some(m => /^private\/ was not read \(unreadable\)/.test(m)), warned.join('; '));
  assert.ok(warned.some(m => /^a\/b\/d17\/ was not read \(too deep\)/.test(m)), warned.join('; '));
});

test('a very large folder is asked about before anything is read, and a no reads nothing', async () => {
  const { readProjectFromDisk, LARGE_PROJECT } = await store();
  const api = sizedApi([
    { name: 'main.tex', path: 'main.tex', type: 'file', size: 10 },
    { name: 'data.bin', path: 'data/data.bin', type: 'file', size: LARGE_PROJECT.bytes + 1 }
  ]);
  let asked = null;
  await assert.rejects(
    readProjectFromDisk(api, '/work/big', { confirmLarge: (s) => { asked = s; return false; } }),
    /not opened — that folder holds 2 files/);
  assert.equal(asked.files, 2);
  assert.equal(asked.largest[0].path, 'data/data.bin', 'the largest file should lead');
  assert.deepEqual(api.reads, [], 'declining must not have read a single file');
});

test('a yes reads it as before, and so does a folder of ordinary size, unasked', async () => {
  const { readProjectFromDisk, LARGE_PROJECT } = await store();
  const many = Array.from({ length: LARGE_PROJECT.files + 1 }, (_, i) =>
    ({ name: `f${i}.tex`, path: `f${i}.tex`, type: 'file', size: 1 }));
  const p = await readProjectFromDisk(sizedApi(many), '/work/many', { confirmLarge: () => true });
  assert.equal(p.files.size, many.length);

  let asked = false;
  await readProjectFromDisk(sizedApi([{ name: 'main.tex', path: 'main.tex', type: 'file', size: 10 }]),
    '/work/small', { confirmLarge: () => { asked = true; return true; } });
  assert.equal(asked, false, 'an ordinary project must not be asked about');
});

test('a folder with no .tex is refused before the size question is asked', async () => {
  const { readProjectFromDisk, LARGE_PROJECT } = await store();
  let asked = false;
  await assert.rejects(readProjectFromDisk(sizedApi([
    { name: 'v.mp4', path: 'v.mp4', type: 'file', size: LARGE_PROJECT.bytes * 2 }
  ]), '/work/videos', { confirmLarge: () => { asked = true; return true; } }), /no \.tex/);
  assert.equal(asked, false);
});

test('reading reports progress', async () => {
  const { readProjectFromDisk } = await store();
  const entries = Array.from({ length: 60 }, (_, i) =>
    ({ name: `f${i}.tex`, path: `f${i}.tex`, type: 'file', size: 1 }));
  const seen = [];
  await readProjectFromDisk(sizedApi(entries), '/work/p', { onProgress: (d, t) => seen.push([d, t]) });
  assert.deepEqual(seen, [[0, 60], [25, 60], [50, 60]]);
});
