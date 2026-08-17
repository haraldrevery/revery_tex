// The Files panel's undo stack.
//
// Pure, so the bookkeeping can be checked here rather than by dragging rows
// around the sidebar: what a new operation does to the redo stack, what a
// barrier does to both, that nothing is consumed until the caller says the
// operation landed, and that the cap drops the oldest entry.

const { test } = require('node:test');
const assert = require('node:assert');

let _mod;
const mod = async () => (_mod ??= await import('../www/jvscrpt_and_css_extra/tree_history.js'));
const fresh = async (opts) => (await mod()).createHistory(opts);

/** Entries are opaque to the module, so a bare label is enough to tell them apart. */
const e = (label) => ({ label });

test('undo hands back the most recent entry, and redo hands it forward again', async () => {
  const h = await fresh();
  h.push(e('a'));
  h.push(e('b'));

  assert.equal(h.peekUndo().label, 'b');
  assert.equal(h.commitUndo().label, 'b');
  assert.equal(h.peekUndo().label, 'a');
  assert.equal(h.peekRedo().label, 'b');

  assert.equal(h.commitRedo().label, 'b');
  assert.equal(h.peekUndo().label, 'b');
  assert.equal(h.peekRedo(), null);
});

test('peeking consumes nothing — an inverse that is refused can be retried', async () => {
  const h = await fresh();
  h.push(e('a'));

  // Three peeks, no commit: the operation was refused every time, so the entry
  // must still be there. This is the whole reason peek and commit are separate.
  assert.equal(h.peekUndo().label, 'a');
  assert.equal(h.peekUndo().label, 'a');
  assert.equal(h.peekUndo().label, 'a');
  assert.equal(h.depth, 1);
  assert.equal(h.redoDepth, 0);
});

test('a new operation after an undo drops the redo stack', async () => {
  const h = await fresh();
  h.push(e('a'));
  h.push(e('b'));
  h.commitUndo();                 // 'b' is now redoable
  assert.equal(h.peekRedo().label, 'b');

  h.push(e('c'));                 // …and the user did something else instead

  // 'b' would have been replayed onto a project it no longer describes.
  assert.equal(h.peekRedo(), null);
  assert.equal(h.redoDepth, 0);
  assert.equal(h.peekUndo().label, 'c');
});

test('a barrier clears both stacks, not just the undoable one', async () => {
  const h = await fresh();
  h.push(e('a'));
  h.push(e('b'));
  h.commitUndo();                 // one entry in each stack
  assert.equal(h.depth, 1);
  assert.equal(h.redoDepth, 1);

  h.barrier();                    // a delete happened

  // Neither direction may step past it: 'a' predates the delete and could
  // name a file the delete removed.
  assert.equal(h.peekUndo(), null);
  assert.equal(h.peekRedo(), null);
  assert.equal(h.depth, 0);
  assert.equal(h.redoDepth, 0);
});

test('clear is a barrier by another name, for a project switch', async () => {
  const h = await fresh();
  h.push(e('a'));
  h.commitUndo();
  h.clear();
  assert.equal(h.peekUndo(), null);
  assert.equal(h.peekRedo(), null);
});

test('the cap drops the oldest entry, keeping the newest', async () => {
  const h = await fresh({ limit: 3 });
  for (const label of ['a', 'b', 'c', 'd', 'e']) h.push(e(label));

  assert.equal(h.depth, 3);
  assert.equal(h.commitUndo().label, 'e');
  assert.equal(h.commitUndo().label, 'd');
  assert.equal(h.commitUndo().label, 'c');
  assert.equal(h.peekUndo(), null);   // 'a' and 'b' were evicted
});

test('an empty history commits nothing rather than throwing', async () => {
  const h = await fresh();
  assert.equal(h.peekUndo(), null);
  assert.equal(h.peekRedo(), null);
  assert.equal(h.commitUndo(), null);
  assert.equal(h.commitRedo(), null);
  assert.equal(h.depth, 0);
});

test('undoing everything then redoing everything restores the original order', async () => {
  const h = await fresh();
  for (const label of ['a', 'b', 'c']) h.push(e(label));

  assert.deepEqual([h.commitUndo().label, h.commitUndo().label, h.commitUndo().label],
                   ['c', 'b', 'a']);
  assert.equal(h.depth, 0);

  assert.deepEqual([h.commitRedo().label, h.commitRedo().label, h.commitRedo().label],
                   ['a', 'b', 'c']);
  assert.equal(h.peekUndo().label, 'c');
  assert.equal(h.redoDepth, 0);
});
