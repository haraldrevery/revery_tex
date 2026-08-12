// The sidebar tree.
//
// Pure, so the shape can be checked here rather than by looking at the sidebar:
// depth, ordering, directories that only exist because something is inside
// them, and the path normalisation that decides what a person is allowed to
// type into "New file".

const { test } = require('node:test');
const assert = require('node:assert');

let _mod;
const mod = async () => (_mod ??= await import('../www/jvscrpt_and_css_extra/file_tree.js'));
const tree = async (paths) => (await mod()).buildTree(paths.map(path => ({ path })));

/** `dir/` and `file` with depth, as one line each — easy to assert on. */
async function shape(paths, collapsed = []) {
  const { buildTree, flattenTree } = await mod();
  return flattenTree(buildTree(paths.map(p => ({ path: p }))), new Set(collapsed))
    .map(n => `${'  '.repeat(n.depth)}${n.name}${n.type === 'dir' ? '/' : ''}`);
}

test('nesting comes from the path, at any depth', async () => {
  assert.deepEqual(await shape(['a/b/c/d.tex', 'main.tex']), [
    'a/',
    '  b/',
    '    c/',
    '      d.tex',
    'main.tex'
  ]);
});

test('directories come before files, then name order', async () => {
  // The old render grouped by immediate directory and sorted nothing across
  // levels, so a loose file could appear above the folder holding the chapters.
  assert.deepEqual(await shape(['zeta.tex', 'main.tex', 'img/b.png', 'chapters/a.tex']), [
    'chapters/', '  a.tex', 'img/', '  b.png', 'main.tex', 'zeta.tex'
  ]);
});

test('name order ignores case', async () => {
  assert.deepEqual(await shape(['b.tex', 'A.tex']), ['A.tex', 'b.tex']);
});

test('a directory appears once however many files are in it', async () => {
  const rows = await shape(['ch/a.tex', 'ch/b.tex', 'ch/c.tex']);
  assert.equal(rows.filter(r => r === 'ch/').length, 1);
  assert.equal(rows.length, 4);
});

test('a collapsed directory hides its contents but not itself', async () => {
  assert.deepEqual(await shape(['ch/a.tex', 'ch/deep/b.tex', 'main.tex'], ['ch']),
    ['ch/', 'main.tex']);
  // Collapsing an inner one leaves the outer open.
  assert.deepEqual(await shape(['ch/a.tex', 'ch/deep/b.tex', 'main.tex'], ['ch/deep']),
    ['ch/', '  deep/', '  a.tex', 'main.tex']);
});

test('entries keep their own properties', async () => {
  const { buildTree, flattenTree } = await mod();
  const nodes = buildTree([{ path: 'img/a.png', binary: true }, { path: 'main.tex' }]);
  const png = flattenTree(nodes).find(n => n.name === 'a.png');
  assert.equal(png.binary, true, 'binaries are shown, so the flag has to survive');
  assert.equal(png.path, 'img/a.png');
});

test('a folder with nothing in it can still be shown', async () => {
  // "New folder" has to put something on screen before there is a file to put
  // in it, or the click looks like it did nothing.
  const { buildTree, flattenTree } = await mod();
  const rows = flattenTree(buildTree([{ path: 'main.tex' }, { path: 'draft', dir: true }]));
  assert.deepEqual(rows.map(n => `${n.name}${n.type === 'dir' ? '/' : ''}`), ['draft/', 'main.tex']);
  assert.deepEqual(rows[0].children, []);
});

test('directoryPaths lists every folder', async () => {
  const { buildTree, directoryPaths } = await mod();
  assert.deepEqual(directoryPaths(buildTree([{ path: 'a/b/c.tex' }, { path: 'd/e.tex' }])),
    ['a', 'a/b', 'd']);
});

test('an empty list is an empty tree, not a crash', async () => {
  assert.deepEqual(await tree([]), []);
  assert.deepEqual(await shape(['', '   ']), []);
});

/* ── what a person may type ──────────────────────────────────────────── */

test('a typed path is normalised against its parent', async () => {
  const { normalizePath } = await mod();
  assert.equal(normalizePath('notes.tex'), 'notes.tex');
  assert.equal(normalizePath('notes.tex', 'chapters'), 'chapters/notes.tex');
  assert.equal(normalizePath('  spaced.tex  '), 'spaced.tex');
  assert.equal(normalizePath('sub/deep.tex', 'ch'), 'ch/sub/deep.tex');
  assert.equal(normalizePath('./a/./b.tex'), 'a/b.tex');
  // Windows separators, because people paste them.
  assert.equal(normalizePath('ch\\a.tex'), 'ch/a.tex');
});

test('a path that would escape the project is refused', async () => {
  const { normalizePath } = await mod();
  // The backends refuse these too; this is so the UI can say no first, rather
  // than surfacing a containment error as if the app had crashed.
  for (const bad of ['../outside.tex', 'ch/../../x.tex', '/etc/passwd', 'C:/x.tex', '', '   ', '.']) {
    assert.equal(normalizePath(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(normalizePath('..', 'ch'), null);
});
