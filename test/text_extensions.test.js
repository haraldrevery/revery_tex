// Which files the editor will open, and which it refuses.
//
// TEXT_EXT_RE decides the whole text/binary split: a file matching it is read
// with readTextFile and becomes an editable buffer, and everything else is read
// as bytes and only ever previewed. Nothing downstream re-tests the extension —
// they all read the stored `binary` flag — so this regex is the only place the
// decision is made, and the only place it can be got wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TEXT_EXT_RE, PLAIN_TEXT_EXT_RE } from '../www/jvscrpt_and_css_extra/project_store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('sources and prose are text', () => {
  for (const p of ['main.tex', 'refs.bib', 'thesis.cls', 'a.sty', 'x.bbl', 'x.ind',
                   'x.def', 'x.cfg', 'notes.txt', 'x.clo', 'x.ltx',
                   'README.md', 'CHANGES.markdown']) {
    assert.ok(TEXT_EXT_RE.test(p), `${p} should be text`);
  }
});

// The risk this guards is not a missing feature but a lossy one: a binary read
// through readTextFile is UTF-8 decoded, every invalid byte replaced, and the
// next saveAll() writes the mangled string back over the original.
test('binaries are never text', () => {
  for (const p of ['logo.png', 'plot.pdf', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp',
                   'a.svg', 'font.otf', 'font.ttf', 'data.dat', 'archive.zip']) {
    assert.ok(!TEXT_EXT_RE.test(p), `${p} must not be read as text`);
  }
});

test('the extension is matched at the end, not anywhere in the path', () => {
  assert.ok(!TEXT_EXT_RE.test('tex/logo.png'));
  assert.ok(!TEXT_EXT_RE.test('a.txt.png'));
  assert.ok(TEXT_EXT_RE.test('png/notes.txt'));
});

test('matching is case-insensitive', () => {
  assert.ok(TEXT_EXT_RE.test('MAIN.TEX'));
  assert.ok(TEXT_EXT_RE.test('Readme.MD'));
});

test('the plain-text set is a subset of the text set', () => {
  for (const p of ['a.md', 'a.markdown', 'a.txt']) {
    assert.ok(PLAIN_TEXT_EXT_RE.test(p), `${p} should be plain`);
    assert.ok(TEXT_EXT_RE.test(p), `${p} should also be text`);
  }
});

// Inverting TEXT_EXT_RE to find the plain files would silently strip the LaTeX
// layer from these, which are LaTeX and want every bit of it.
test('LaTeX extensions are never plain text', () => {
  for (const p of ['a.tex', 'a.cls', 'a.clo', 'a.def', 'a.sty', 'a.bib', 'a.ltx']) {
    assert.ok(!PLAIN_TEXT_EXT_RE.test(p), `${p} must keep the LaTeX layer`);
  }
});

/**
 * The dev server keeps its own copy of this list, deciding utf8 vs base64 in
 * the fixture manifest. readProjectFromFixture trusts TEXT_EXT_RE over the
 * encoding and falls back to atob() when they disagree — which is latin-1, so a
 * file that is text in one list and not the other arrives with every non-ASCII
 * character mangled. `.ltx` was missing from serve.js for exactly that reason.
 *
 * Read as text rather than imported: importing serve.js starts a listener.
 */
test('the dev server agrees with TEXT_EXT_RE', () => {
  const src = fs.readFileSync(path.join(ROOT, 'test', 'serve.js'), 'utf8');
  const block = /const TEXT_EXT = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  assert.ok(block, 'TEXT_EXT not found in test/serve.js');

  const serveExts = [...block[1].matchAll(/'\.([a-z0-9]+)'/g)].map(m => m[1]).sort();
  assert.ok(serveExts.length > 0);

  const reExts = /\\\.\(([^)]+)\)\$/.exec(TEXT_EXT_RE.source)[1].split('|').sort();

  assert.deepEqual(serveExts, reExts,
    'test/serve.js TEXT_EXT and project_store.js TEXT_EXT_RE have drifted');
});
