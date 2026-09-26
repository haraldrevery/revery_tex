// root_gate.js: the order a project switch is allowed to move the root in.
//
// The bug it exists for: every backend resolves a project-relative path against
// the root open when a call *lands*, so a switch that moved the root while a
// save or a folder move was still on its way sent the rest of it into the other
// project's folder. These drive the gate with a backend whose calls finish only
// when the test says so, which is how the interleavings below are reached
// deterministically rather than by timing.

const { test } = require('node:test');
const assert = require('node:assert');

let _gate;
const gateModule = async () =>
  (_gate ??= await import('../www/jvscrpt_and_css_extra/root_gate.js'));

/** Lets pending promise reactions run. */
const tick = () => new Promise((r) => setImmediate(r));

/**
 * A backend whose root calls park until released, recording what reached it.
 * `open(key)` lists the calls still parked under that name.
 */
function parkedBackend() {
  const reached = [];
  const parked = [];
  const park = (key) => (...args) => new Promise((resolve, reject) => {
    reached.push(key);
    parked.push({ key, args, resolve, reject });
  });
  const backend = {
    env: 'fake',
    isDesktop: false,
    readDirectory: park('readDirectory'),
    writeFile: park('writeFile'),
    renameFile: park('renameFile'),
    writeBackup: park('writeBackup'),
    runTex: park('runTex'),
    openFolder: async () => { reached.push('openFolder'); return '/somewhere'; },
    detectTex: async () => { reached.push('detectTex'); return []; }
  };
  const finish = (key, value) => {
    const i = parked.findIndex((p) => p.key === key);
    assert.ok(i >= 0, `nothing parked under ${key}`);
    parked.splice(i, 1)[0].resolve(value);
  };
  return { backend, reached, parked, finish };
}

test('the gated api offers exactly what the backend does', async () => {
  const { createRootGate } = await gateModule();
  const { backend } = parkedBackend();
  const { api } = createRootGate(backend);
  // Presence is how every caller decides what a backend can do, so a method
  // appearing or vanishing here would change the UI.
  assert.deepStrictEqual(Object.keys(api).sort(), Object.keys(backend).sort());
  assert.equal(api.env, 'fake');
  assert.equal(api.isDesktop, false);
});

test('only a switch can move the root', async () => {
  const { createRootGate } = await gateModule();
  const { backend, reached } = parkedBackend();
  const { api } = createRootGate(backend);
  await assert.rejects(api.openFolder(), /only a project switch may call it/);
  assert.deepStrictEqual(reached, [], 'the backend must not have been asked');
});

test('calls unrelated to the root pass straight through', async () => {
  const { createRootGate } = await gateModule();
  const { backend, reached } = parkedBackend();
  const gate = createRootGate(backend);
  const release = await gate.lock();
  assert.deepStrictEqual(await gate.api.detectTex(), []);
  assert.deepStrictEqual(reached, ['detectTex'], 'not held while the root is moving');
  release(true);
});

test('a switch waits for the call in flight before it may move the root', async () => {
  const { createRootGate } = await gateModule();
  const { backend, finish } = parkedBackend();
  const gate = createRootGate(backend);

  const write = gate.api.writeFile('chapters/one.tex', 'text', null);
  let locked = false;
  const lock = gate.lock().then((release) => { locked = true; return release; });
  await tick();
  assert.equal(locked, false, 'the root moved while a write was still on its way');

  finish('writeFile', { mtime_ms: 1, size: 4 });
  await write;
  const release = await lock;
  assert.equal(locked, true);
  release(true);
});

test('a switch waits for a whole task, and the task is not starved of its own calls', async () => {
  const { createRootGate } = await gateModule();
  const { backend, finish, reached } = parkedBackend();
  const gate = createRootGate(backend);

  // Two renames in a row, the shape of a folder move. Holding calls before the
  // task finished would park the second one forever and the lock with it.
  const move = gate.task((async () => {
    await gate.api.renameFile('a.tex', 'x/a.tex');
    await gate.api.renameFile('b.tex', 'x/b.tex');
  })());
  let locked = false;
  const lock = gate.lock().then((release) => { locked = true; return release; });

  await tick();
  finish('renameFile');
  await tick();
  assert.equal(locked, false, 'the root moved between the two halves of a move');
  assert.deepStrictEqual(reached, ['renameFile', 'renameFile'], 'the second rename was held');
  finish('renameFile');
  await move;
  (await lock)(true);
  assert.equal(locked, true);
});

test('a call made while the root is moving runs if the old project survives', async () => {
  const { createRootGate } = await gateModule();
  const { backend, reached, finish } = parkedBackend();
  const gate = createRootGate(backend);
  const release = await gate.lock();

  const listing = gate.api.readDirectory();
  await tick();
  assert.deepStrictEqual(reached, [], 'it reached the backend while the root was moving');

  release(true);                          // cancelled, or put back
  await tick();
  assert.deepStrictEqual(reached, ['readDirectory']);
  finish('readDirectory', []);
  assert.deepStrictEqual(await listing, []);
});

test('a call made while the root is moving is refused if the project is gone', async () => {
  const { createRootGate, MOVED } = await gateModule();
  const { backend, reached } = parkedBackend();
  const gate = createRootGate(backend);
  const release = await gate.lock();

  const write = gate.api.writeFile('main.tex', 'the old project', null);
  release(false);
  await assert.rejects(write, (err) => err.message === MOVED);
  assert.deepStrictEqual(reached, [], 'the old project\'s write reached the new root');
});

test('a system TeX pass does not keep a switch waiting, but cannot start during one', async () => {
  const { createRootGate } = await gateModule();
  const { backend, reached, finish } = parkedBackend();
  const gate = createRootGate(backend);

  const pass = gate.api.runTex('xelatex', 'main.tex', 180);
  const release = await gate.lock();       // resolves with the pass still running
  const next = gate.api.runTex('xelatex', 'main.tex', 180);
  await tick();
  assert.deepStrictEqual(reached, ['runTex'], 'a second pass started while the root was moving');

  release(true);
  await tick();
  finish('runTex', { code: 0 });
  finish('runTex', { code: 0 });
  await pass; await next;
});

test('one switch at a time', async () => {
  const { createRootGate } = await gateModule();
  const { backend } = parkedBackend();
  const gate = createRootGate(backend);
  const release = await gate.lock();
  await assert.rejects(gate.lock(), /already in progress/);
  release(true);
  release(false);                          // a second release is ignored…
  (await gate.lock())(true);               // …and the gate can be locked again
  assert.equal(gate.moving, false);
});

test('a backend that throws instead of rejecting is still a rejection', async () => {
  const { createRootGate } = await gateModule();
  const gate = createRootGate({ writeFile: () => { throw new Error('sync failure'); } });
  await assert.rejects(gate.api.writeFile('a', 'b', null), /sync failure/);
  // …and it is not counted as in flight, or the next switch would wait forever.
  (await gate.lock())(true);
});
