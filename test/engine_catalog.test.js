// Every texmf part must be mounted for every compile, and this pins the two
// things that make that true.
//
// The macro tree ships as several data packages because git rejects a file over
// 100 MB and the tree is ~57 MB compressed. The split is by byte offset, so a
// package and its dependencies routinely land in different parts, and a class
// file lands wherever it lands. Mount them selectively and a document fails on
// a file that is sitting in the bundle.
//
// Two mechanisms could reintroduce selectivity, and both look like obvious
// improvements from the outside:
//
//   1. Moving a part out of `preload` into `catalog`. busytex_pipeline.js mounts
//      a catalog package only when a document has at least one *unresolved*
//      \usepackage, found by matching lines that START WITH \usepackage in the
//      MAIN FILE ONLY. A beamer deck with no \usepackage in its preamble
//      resolves cleanly to nothing and mounts nothing. This is measured: putting
//      macros in the catalog broke beamer, scrartcl and memoir while every gate
//      fixture stayed green, because every gate fixture happens to have a
//      \usepackage.
//
//   2. Restoring the `// \ProvidesPackage{…}` index that build_slim_texmf.js
//      strips from each part. That index is what the resolver matches against;
//      with it absent nothing resolves and the pipeline's "enable all" fallback
//      does the right thing. Restore it and selectivity switches back on — with
//      a resolver that still cannot see \documentclass, \RequirePackage, or any
//      included file.
//
// Neither failure moves a page count, so the gate would not catch either one.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'www', 'engine', 'dist');
const MANIFEST = path.join(DIST, 'texlive-slim.manifest.json');

const manifest = () => JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

test('every part is preloaded, so nothing depends on the resolver', () => {
  const m = manifest();
  assert.deepEqual(m.catalog, [],
    `these parts are in the catalog rather than preloaded: ${m.catalog.join(', ')}.\n` +
    '  A catalog part is mounted only when a document has an unresolved\n' +
    '  \\usepackage at the start of a line in its main file. A document whose\n' +
    '  preamble has none — a beamer deck, say — mounts no catalog parts at all\n' +
    '  and then fails on a class file that is in the bundle.');

  assert.equal(m.preload.length, m.parts.length,
    'every part must be preloaded');
});

test('no part advertises packages, so the pipeline cannot mount selectively', () => {
  for (const p of manifest().parts) {
    const text = fs.readFileSync(path.join(DIST, `${p.name}.js`), 'utf8');
    assert.equal(text.includes('\\ProvidesPackage'), false,
      `${p.name}.js carries a \\ProvidesPackage index.\n` +
      '  That turns selective mounting back on in busytex_pipeline.js, whose\n' +
      '  resolver only reads \\usepackage in the main file — no \\documentclass,\n' +
      '  no \\RequirePackage, no included files. Parts are split by byte offset,\n' +
      '  so a class or a transitive dependency in another part would stop being\n' +
      '  mounted. See splitPart() in build_tools/build_slim_texmf.js.');
  }
});

test('every part is under the git file cap', () => {
  // 50 MB decimal, matching CAP in the repacker: GitHub warns at 50 and rejects
  // at 100, and a failing test is a better place to learn that than a push.
  for (const p of manifest().parts) {
    const bytes = fs.statSync(path.join(DIST, `${p.name}.data`)).size;
    assert.ok(bytes < 50 * 1000 * 1000,
      `${p.name}.data is ${(bytes / 1e6).toFixed(0)} MB, over the 50 MB cap`);
  }
});

test('dist holds no part the manifest does not reference', () => {
  // Part names are derived from the selection policy, so changing the policy
  // renames them. Tauri embeds all of www/ with no whitelist, so an orphaned
  // part from a previous build ships to every user inside the binary.
  const referenced = new Set(manifest().parts.flatMap(p => [`${p.name}.data`, `${p.name}.js`]));
  const orphans = fs.readdirSync(DIST)
    .filter(f => f.startsWith('texlive-slim-') && /\.(data|js)$/.test(f) && !referenced.has(f));

  assert.deepEqual(orphans, [],
    'stale data packages in www/engine/dist/. Re-run node build_tools/build_slim_texmf.js.');
});

test('classes and packages a document is likely to need are actually present', () => {
  // The bundle used to be selected from a trace of the five gate fixtures, so
  // it covered those five documents and very little else — 87 of 2270 package
  // directories whole, and 10 more half-present. These are the names whose
  // absence users actually hit; they are checked against the manifest's own
  // record rather than by unpacking 140 MB.
  const m = manifest();
  assert.ok(m.policy.macros.includes('minus macroBlocklist'),
    'the macro policy is no longer whole-tree-minus-blocklist; this test assumes it is');

  const blocked = new Set(m.policy.macroBlocklist);
  const expected = [
    'beamer', 'koma-script', 'memoir', 'moderncv',   // classes, none of them shipped before
    'polyglossia', 'babel',                          // languages
    'pgf', 'pgfplots', 'tcolorbox',                  // pgf was 200/481 files
    'amsmath', 'tools', 'graphics',                  // amsmath was 9/18, tools 51/104
    'glossaries-extra', 'tabularray', 'siunitx', 'biblatex'
  ];
  const wrongly = expected.filter(p => blocked.has(p));
  assert.deepEqual(wrongly, [],
    `the macro blocklist excludes ${wrongly.join(', ')}, which real documents need`);
});
