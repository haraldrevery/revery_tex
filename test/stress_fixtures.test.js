// The in-tree LaTeX fixtures, held to the rules that make them worth having.
//
// These run in `npm test`, and that is the point of them. The older fixtures
// live in a sibling repo and every test that touches them is guarded on
// `fs.existsSync` — so on a machine without that repo those tests do not fail,
// they *vanish*, and the suite reports green while proving less. Nothing here
// can do that: the files are beside the code, so the assertions either hold or
// break the build.
//
// Most of what is asserted needs no compile at all. Structure, encoding, the
// include graph and which bibliography tool a document infers are all
// answerable from the source, by the same pure functions the app uses. Only the
// things that genuinely need an engine go through the gate — see
// latex_stress_test/README.md.
//
// **Nothing here is pinned by page count.** A page count is a function of font
// metrics and the texmf version, not of correctness: `homework` in the sibling
// repo was pinned at 27, its own comment recorded a 28-page reference build, and
// it produces 26. Three numbers, none of them wrong, none of them a bug, and one
// red gate — it is unpinned now. What is asserted instead is what the fixture *author*
// decided: file counts, nesting depth, include-chain length, tool inference,
// and which line a diagnostic must point at.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const core = require('../electron/fs_core.js');
const load = () => import('../www/jvscrpt_and_css_extra/project_store.js');

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(ROOT, 'latex_stress_test');
const read = (...p) => fs.readFileSync(path.join(FIX, ...p), 'utf8');

/** Every file under `dir`, project-relative, at any depth. */
function walkAll(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkAll(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/* ── the rules ───────────────────────────────────────────────────────── */

test('the fixtures are in the project root, not a sibling repo', () => {
  assert.ok(fs.existsSync(FIX), 'latex_stress_test/ must exist');
  for (const d of ['deep_structure', 'bib_and_index', 'bib_classic',
                   'broken_on_purpose', 'encoding']) {
    assert.ok(fs.statSync(path.join(FIX, d)).isDirectory(), `${d}/ is missing`);
  }
});

// The rule the old book templates broke. A committed .bbl is not a shortcut:
// bibtex8 rebuilds it on every compile, so the committed copy only goes stale,
// and biblatex rejects one written by a different version outright — every
// citation silently becomes undefined.
test('no build output is committed', () => {
  const BUILD = new Set(['.aux', '.bbl', '.bcf', '.blg', '.fdb_latexmk', '.fls',
    '.idx', '.ilg', '.ind', '.lof', '.log', '.lot', '.out', '.pdf', '.toc',
    '.gz', '.xml']);
  const offenders = walkAll(FIX).filter(f => BUILD.has(path.extname(f).toLowerCase()));
  assert.deepEqual(offenders, [], `build output committed: ${offenders.join(', ')}`);
});

// …and git must agree, because a .gitignore does not untrack what is already in.
test('git tracks only sources here', () => {
  const r = spawnSync('git', ['-C', ROOT, 'ls-files', 'latex_stress_test'],
    { encoding: 'utf8' });
  if (r.error || r.status !== 0) return;              // not a checkout: nothing to check
  const tracked = r.stdout.split('\n').filter(Boolean);
  const bad = tracked.filter(f => !/\.(tex|bib|md)$|\.gitignore$/.test(f));
  assert.deepEqual(bad, [], `non-source files tracked: ${bad.join(', ')}`);
});

// Self-containment is the whole reason these moved in-tree, so it is checked
// rather than trusted: a fixture that reaches outside its own directory has
// quietly reintroduced the dependency this replaces.
test('nothing reaches outside its own fixture', () => {
  for (const rel of walkAll(FIX).filter(f => f.endsWith('.tex'))) {
    const src = read(rel);
    for (const m of src.matchAll(/\\(?:input|include|includegraphics|addbibresource)\s*(?:\[[^\]]*\])?\{([^}]*)\}/g)) {
      const target = m[1].trim();
      assert.ok(!target.startsWith('/'), `${rel} names an absolute path: ${target}`);
      assert.ok(!target.startsWith('..'), `${rel} climbs out of the fixture: ${target}`);
    }
  }
});

// No system fonts and no EPS. Both are why the sibling repo's homework fixture
// has to be rewritten in flight by serve.js before it will compile at all —
// which means the thing under test there is not the thing on disk.
test('nothing needs a patch to compile', async () => {
  // Through stripTexComments, not over the raw source. These files *discuss*
  // shell-escape and EPS in their header comments, explaining why they avoid
  // them — and a check that cannot tell a comment from code failed on the
  // prose. That is the same trap biblatexBackend documents: a matcher that does
  // not know what a comment is cannot be trusted with the answer.
  const { stripTexComments } = await load();
  for (const rel of walkAll(FIX).filter(f => f.endsWith('.tex'))) {
    const src = stripTexComments(read(rel));
    assert.ok(!/\\setmainfont|\\setsansfont|\\setmonofont/.test(src),
      `${rel} asks for a system font`);
    assert.ok(!/\.eps\b/.test(src), `${rel} references EPS, which needs Ghostscript`);
    assert.ok(!/\\write18|shell-escape/.test(src), `${rel} wants shell escape`);
  }
});

/* ── structure ───────────────────────────────────────────────────────── */

test('deep_structure has the shape it claims', () => {
  const files = walkAll(path.join(FIX, 'deep_structure'));
  assert.equal(files.length, 67, 'file count changed — update README.md too');

  const chapters = files.filter(f => /^chapters\/ch\d+\.tex$/.test(f));
  assert.equal(chapters.length, 40, 'the include chain should be 40 chapters');

  const deepest = files
    .map(f => f.split('/').length)
    .reduce((a, b) => Math.max(a, b), 0);
  assert.equal(deepest, 22, 'the deep chain should be 20 directories plus a file');
});

// The gap this fixture exists to make visible.
//
// `readDirectory` stops at depth 16 in both desktop backends (fs_core.js and
// the `walk` in main.rs) and returns what it has — no warning, no marker, no
// entry in the log. A project nested deeper is silently truncated, and the user
// is told nothing at all: the files simply are not in the tree.
//
// This asserts the truncation rather than the fix, deliberately. It is a
// characterisation test: it pins what the code does today so the loss is
// impossible to overlook, and it fails the moment somebody changes the
// behaviour — at which point this test is the checklist of what to update.
test('readDirectory silently truncates past depth 16, losing real files', () => {
  const dir = path.join(FIX, 'deep_structure');
  const listed = core.readDirectory(dir)
    .filter(e => e.type === 'file')
    .map(e => e.path);
  const onDisk = walkAll(dir);

  const lost = onDisk.filter(f => !listed.includes(f));
  assert.ok(lost.length > 0,
    'the depth cap appears to be gone — if it was fixed, update this test and README.md');
  assert.ok(lost.every(f => f.startsWith('deep/')),
    `only the deep chain should be truncated, lost: ${lost.join(', ')}`);
  // The leaf is the file a user would notice missing.
  assert.ok(lost.some(f => f.endsWith('leaf.tex')),
    'the deepest file should be among the ones dropped');
  // And nothing anywhere says so.
  assert.ok(listed.length < onDisk.length,
    'the truncation must actually drop files for this fixture to mean anything');
});

test('the include graph is walked to the bottom', async () => {
  const { includesIn, documentOrder } = await load();
  const dir = path.join(FIX, 'deep_structure');
  const all = walkAll(dir);

  // The whole project by path, as the app holds it — not through readDirectory,
  // whose cap is the subject of the test above.
  const files = new Map(all.map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

  const named = includesIn(files.get('main.tex'));
  assert.equal(named.filter(n => n.startsWith('chapters/')).length, 40,
    'main.tex should name all 40 chapters');

  const order = documentOrder('main.tex', files, (p) => includesIn(files.get(p) || ''));
  assert.equal(order[0], 'main.tex');
  // Three deep: macros.tex -> commands.tex -> lengths.tex. A walker that stops
  // at one level finds two thirds of the preamble.
  for (const f of ['preamble/macros.tex', 'preamble/commands.tex', 'preamble/lengths.tex']) {
    assert.ok(order.includes(f), `${f} is not reached by the walk`);
  }
  // And the file whose name contains a space.
  assert.ok(order.some(f => f.includes(' ')),
    'the filename with spaces is not reached');
  // The leaf, 20 directories down.
  assert.ok(order.some(f => f.endsWith('leaf.tex')),
    'the deep leaf is not reached by the include walk');
});

/* ── bibliography and index ──────────────────────────────────────────── */

// Both infer 'bibtex', and that is the trap: they get there by different
// routes, and only `biblatexBackend` separates them. A change that collapsed
// the two would leave inferBibTool looking correct.
test('the two bibliography shapes are told apart', async () => {
  const { inferBibTool, biblatexBackend } = await load();

  const biblatex = read('bib_and_index', 'main.tex');
  assert.equal(inferBibTool(biblatex), 'bibtex', 'backend=bibtex must not report biber');
  assert.equal(biblatexBackend(biblatex), 'bibtex', 'the declared backend should be read');

  const classic = read('bib_classic', 'main.tex');
  assert.equal(inferBibTool(classic), 'bibtex');
  assert.equal(biblatexBackend(classic), null, 'there is no biblatex in the classic fixture');
});

// biber is Perl; no WASM build has it. A fixture asking for it could never
// build its bibliography in the browser, which is the dead end the old book
// template sat in.
test('nothing here asks for biber', async () => {
  const { inferBibTool } = await load();
  for (const rel of walkAll(FIX).filter(f => f.endsWith('.tex'))) {
    assert.notEqual(inferBibTool(read(rel)), 'biber', `${rel} would need biber`);
  }
});

test('a document with no bibliography infers no tool', async () => {
  const { inferBibTool } = await load();
  assert.equal(inferBibTool(read('deep_structure', 'main.tex')), null);
  assert.equal(inferBibTool(read('encoding', 'main.tex')), null);
});

test('the index fixture actually asks for an index', () => {
  const src = read('bib_and_index', 'main.tex');
  assert.match(src, /\\makeindex/, 'makeindex must be requested');
  assert.match(src, /\\printindex/, 'the index must be printed, or makeindex proves nothing');
  const entries = [...src.matchAll(/\\index\{/g)].length;
  assert.ok(entries >= 8, `only ${entries} index entries — too few to exercise sorting`);
});

/* ── failure modes ───────────────────────────────────────────────────── */

/**
 * The marker contract: the line *after* a `STRESS-*` comment is the line the
 * tool must report.
 *
 * Written this way so the fixture stays editable. Hardcoding "line 25" means
 * adding a sentence to the file's header comment breaks the test instead of the
 * behaviour it is about, and a test that breaks for the wrong reason gets
 * loosened rather than fixed.
 */
function markedLine(rel, marker) {
  const lines = read(...rel.split('/')).split('\n');
  const i = lines.findIndex(l => l.includes(marker));
  assert.ok(i >= 0, `${marker} not found in ${rel}`);
  return { line: i + 2, text: lines[i + 1] };   // 1-based, the line after
}

test('the deliberate error is one line, and the fixture names which', () => {
  const { line, text } = markedLine('broken_on_purpose/main.tex', 'STRESS-ERROR-LINE');
  assert.match(text, /^\\thiscontrolsequencedoesnotexist\s*$/,
    'the marked line must be the undefined control sequence and nothing else');
  // Deliberately no hardcoded number here. An earlier draft asserted line 25 and
  // then broke the moment a package was added to the preamble — which is the
  // brittleness the marker exists to remove, reintroduced two lines below the
  // comment explaining it. Whatever checks a diagnostic against this fixture
  // must locate the marker the same way, not carry a copy of the number.
  assert.ok(line > 0 && line <= read('broken_on_purpose', 'main.tex').split('\n').length,
    'the marked line must be inside the file');

  // Exactly one mistake, or "the line it reports" is ambiguous.
  const src = read('broken_on_purpose', 'main.tex');
  assert.equal([...src.matchAll(/\\thiscontrolsequencedoesnotexist/g)].length, 1);
});

// The distinction a log parser most often gets wrong. Promoting these to errors
// makes a working document look broken; ignoring them hides the two mistakes
// users actually make most.
test('the warning fixture warns rather than fails', () => {
  const ref = markedLine('broken_on_purpose/undefined_reference.tex', 'STRESS-WARN-REF');
  assert.match(ref.text, /\\ref\{sec:nowhere\}/);
  const cite = markedLine('broken_on_purpose/undefined_reference.tex', 'STRESS-WARN-CITE');
  assert.match(cite.text, /\\cite\{nosuchkey\}/);

  // It must have something that *does* resolve, or "warning not error" is not
  // being demonstrated — a document where nothing works proves less.
  const src = read('broken_on_purpose', 'undefined_reference.tex');
  assert.match(src, /\\label\{sec:present\}/);
  assert.match(src, /\\ref\{sec:present\}/);
});

/* ── encoding ────────────────────────────────────────────────────────── */

test('the UTF-8 fixture is valid UTF-8 and carries what it claims', () => {
  const bytes = fs.readFileSync(path.join(FIX, 'encoding', 'main.tex'));
  assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const src = bytes.toString('utf8');
  for (const s of ['åäö', 'æøå', 'ß', 'ąćęłń']) {
    assert.ok(src.includes(s), `${s} is missing from the encoding fixture`);
  }
});

// The refusal path needs something real to refuse. This file is latin-1, so a
// UTF-8 decode of it either throws or produces replacement characters — and the
// app must say so rather than write mangled bytes back over the original.
test('the latin-1 fixture is genuinely not UTF-8', () => {
  const bytes = fs.readFileSync(path.join(FIX, 'encoding', 'latin1.tex'));
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    'latin1.tex decodes cleanly as UTF-8 — it is no longer testing anything');
  assert.match(bytes.toString('latin1'), /åäö/,
    'the bytes should be meaningful latin-1, not random');
});

// It must not be pulled into a compile, or the fixture that is supposed to
// build stops building for a reason unrelated to what it tests.
test('the latin-1 file is not part of any document', () => {
  for (const rel of walkAll(FIX).filter(f => f.endsWith('.tex'))) {
    const named = [...read(rel).matchAll(/\\(?:input|include)\s*\{([^}]*)\}/g)]
      .map(m => m[1]);
    assert.ok(!named.some(n => n.includes('latin1')), `${rel} inputs latin1.tex`);
  }
});
