// The recents list. One implementation for every shell, so this is the only
// place its rules are stated — see recent_projects.js for why it is not
// persisted separately in Rust and in Node.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The module is ESM and the suite is CJS, as the other unit tests are. Loaded
// through a data: URL so there is no build step and no .mjs copy to drift.
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'www', 'jvscrpt_and_css_extra', 'recent_projects.js'), 'utf8');
const load = () => import(`data:text/javascript;base64,${Buffer.from(SRC).toString('base64')}`);

/** The two methods the module uses, and nothing else. */
function fakeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    _raw: () => map.get('revery_tex_recents')
  };
}

const entry = (id, label = 'thesis', env = 'tauri') => ({ id, label, root: id, env });

test('a project opened twice appears once, at the front', async () => {
  const { record, list } = await load();
  const s = fakeStore();
  record(s, entry('/a/one', 'one'));
  record(s, entry('/b/two', 'two'));
  record(s, entry('/a/one', 'one'));
  assert.deepEqual(list(s, 'tauri').map(e => e.id), ['/a/one', '/b/two']);
});

test('the list is capped, dropping the least recent', async () => {
  const { record, list } = await load();
  const s = fakeStore();
  for (let i = 0; i < 15; i++) record(s, entry(`/p/${i}`, `p${i}`));
  const got = list(s, 'tauri');
  assert.equal(got.length, 10);
  assert.equal(got[0].id, '/p/14');
  assert.ok(!got.some(e => e.id === '/p/4'), 'the oldest must have been dropped');
});

// The whole reason `id` is not the project name: two folders called `thesis`
// are two projects. Keyed on the name, one would have replaced the other.
test('two projects with the same name are two entries', async () => {
  const { record, list } = await load();
  const s = fakeStore();
  record(s, entry('/work/thesis'));
  record(s, entry('/home/thesis'));
  assert.equal(list(s, 'tauri').length, 2);
});

// An absolute path recorded by the desktop shell means nothing in a browser
// tab, and a web-fs handle id means nothing in Tauri. Offering either would be
// offering a row that cannot open.
test('entries are not offered to a backend that cannot use them', async () => {
  const { record, list } = await load();
  const s = fakeStore();
  record(s, entry('/a/one', 'one', 'tauri'));
  record(s, entry('handle-xyz', 'one', 'web-fs'));
  assert.deepEqual(list(s, 'tauri').map(e => e.id), ['/a/one']);
  assert.deepEqual(list(s, 'web-fs').map(e => e.id), ['handle-xyz']);
});

test('forget removes one entry and leaves the rest', async () => {
  const { record, forget, list } = await load();
  const s = fakeStore();
  record(s, entry('/a/one', 'one'));
  record(s, entry('/b/two', 'two'));
  forget(s, 'tauri', '/a/one');
  assert.deepEqual(list(s, 'tauri').map(e => e.id), ['/b/two']);
  // Same id under a different backend is a different entry.
  record(s, entry('/b/two', 'two', 'electron'));
  forget(s, 'tauri', '/b/two');
  assert.deepEqual(list(s, 'electron').map(e => e.id), ['/b/two']);
});

test('a label is disambiguated only when it repeats', async () => {
  const { labelled } = await load();
  const rows = labelled([
    { id: '/work/thesis', label: 'thesis', root: '/work/thesis' },
    { id: '/home/thesis', label: 'thesis', root: '/home/thesis' },
    { id: '/x/notes', label: 'notes', root: '/x/notes' }
  ]);
  assert.equal(rows[0].text, 'thesis — work');
  assert.equal(rows[1].text, 'thesis — home');
  // The common case stays readable: no path on a row that needs none.
  assert.equal(rows[2].text, 'notes');
});

/* ── the list is a convenience; the project is not ─────────────────────
   Every read and write is guarded, because losing the list costs a menu row
   and throwing here would take the project open with it. */

test('a storage that throws degrades to no recents', async () => {
  const { record, list, forget } = await load();
  const hostile = {
    getItem: () => { throw new Error('storage disabled'); },
    setItem: () => { throw new Error('storage disabled'); }
  };
  assert.deepEqual(list(hostile, 'tauri'), []);
  assert.doesNotThrow(() => record(hostile, entry('/a/one')));
  assert.doesNotThrow(() => forget(hostile, 'tauri', '/a/one'));
});

test('hand-edited or corrupt storage is ignored, not thrown on', async () => {
  const { list } = await load();
  assert.deepEqual(list(fakeStore({ revery_tex_recents: 'not json' }), 'tauri'), []);
  assert.deepEqual(list(fakeStore({ revery_tex_recents: '{"not":"an array"}' }), 'tauri'), []);
  // Rows without the two fields that make an entry openable are dropped.
  const partial = fakeStore({
    revery_tex_recents: JSON.stringify([null, { label: 'x' }, { id: '/a', env: 'tauri', label: 'a' }])
  });
  assert.deepEqual(list(partial, 'tauri').map(e => e.id), ['/a']);
});

test('an entry with no id is refused rather than stored', async () => {
  const { record, list } = await load();
  const s = fakeStore();
  record(s, { label: 'x', env: 'tauri' });
  record(s, { id: '/a', label: 'x' });
  record(s, null);
  assert.deepEqual(list(s, 'tauri'), []);
});
