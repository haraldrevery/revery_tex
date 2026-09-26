// The known-bug marker is only worth having if it is strict, so its strictness
// is tested: a marker that quietly absorbed every failure would be a skip with
// better manners.

const { test } = require('node:test');
const assert = require('node:assert');
const { knownBug, knownBugCheck } = require('./known_bug.js');

/** A stand-in for node:test's context that records what todo() was told. */
const fakeContext = () => ({ todos: [], todo(msg) { this.todos.push(msg); } });

test('a known bug that still reproduces is recorded as todo, not failed', async () => {
  const t = fakeContext();
  await knownBug(t, { phase: 'Phase 9', symptom: /the known symptom/ }, () => {
    assert.fail('the known symptom, still here');
  });
  assert.equal(t.todos.length, 1);
  assert.match(t.todos[0], /Phase 9/);
});

test('a known bug that no longer reproduces fails, so the marker cannot outlive the fix', async () => {
  const t = fakeContext();
  await assert.rejects(
    knownBug(t, { phase: 'Phase 9', symptom: /anything/ }, () => { /* passes now */ }),
    /no longer reproduces/);
  assert.equal(t.todos.length, 0);
});

test('a different failure is a real failure, not the known bug', async () => {
  const t = fakeContext();
  await assert.rejects(
    knownBug(t, { phase: 'Phase 9', symptom: /the known symptom/ }, () => {
      throw new Error('ENOENT: the harness broke');
    }),
    /ENOENT/);
  assert.equal(t.todos.length, 0);
});

test('the harness form needs both the absence of the fix and evidence of the bug', () => {
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(knownBugCheck('still broken', { ok: false, symptom: true, phase: 'P' }), false,
      'the known bug, reproducing: not a failure');
    assert.equal(knownBugCheck('fixed', { ok: true, symptom: false, phase: 'P' }), true,
      'no longer reproduces: a failure until the marker is removed');
    assert.equal(knownBugCheck('broken differently', { ok: false, symptom: false, phase: 'P' }), true,
      'not the known symptom: a real failure');
  } finally {
    console.log = log;
  }
});
