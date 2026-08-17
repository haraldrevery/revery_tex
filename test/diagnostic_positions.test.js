// Keeping a diagnostic's line pointing at its code after the reader has typed.
//
// Driven with a stub ChangeDesc rather than a real CodeMirror one. What is
// under test is *our* bookkeeping — when a baseline is taken, what invalidates
// it, and when the module refuses to answer — not `mapPos`, which is upstream's
// and already tested there. The real ChangeSet path is covered end-to-end in
// run_ui.js, in the shell where it matters.
//
// The stub models the only case the bookkeeping cares about: text inserted at a
// single offset, composed. That is enough to exercise every branch, and it
// keeps this suite runnable without a browser.

const { test } = require('node:test');
const assert = require('node:assert');

let _mod;
const mod = async () =>
  (_mod ??= await import('../www/jvscrpt_and_css_extra/diagnostic_positions.js'));
const fresh = async () => (await mod()).createDiagnosticPositions();

/**
 * A ChangeDesc-alike for "insert `len` characters at `at`".
 *
 * `composeDesc` returns another of the same, so a sequence of edits behaves the
 * way the module expects to be able to fold them.
 */
function insertion(at, len, oldLength) {
  return {
    length: oldLength,
    newLength: oldLength + len,
    mapPos(pos, assoc = 1) {
      if (pos < at) return pos;
      if (pos > at) return pos + len;
      return assoc < 0 ? pos : pos + len;
    },
    composeDesc(other) {
      const self = this;
      return {
        length: self.length,
        newLength: other.newLength,
        mapPos: (pos, assoc = 1) => other.mapPos(self.mapPos(pos, assoc), assoc),
        composeDesc(next) { return insertionCompose(this, next); }
      };
    }
  };
}
function insertionCompose(self, other) {
  return {
    length: self.length,
    newLength: other.newLength,
    mapPos: (pos, assoc = 1) => other.mapPos(self.mapPos(pos, assoc), assoc),
    composeDesc(next) { return insertionCompose(this, next); }
  };
}
/**
 * A ChangeDesc-alike for "delete [from, to)".
 *
 * Both ends of a deleted range map to `from`, which is what CodeMirror does and
 * what lets the module notice that a line's content is gone rather than
 * reporting whatever moved into its place.
 */
function deletion(from, to, oldLength) {
  return {
    length: oldLength,
    newLength: oldLength - (to - from),
    mapPos(pos) {
      if (pos <= from) return pos;
      if (pos >= to) return pos - (to - from);
      return from;
    },
    composeDesc(other) { return insertionCompose(this, other); }
  };
}

/** The shape the module actually receives: a ChangeSet with a `.desc`. */
const changeSet = (desc) => ({ desc });

const DOC = 'one\ntwo\nthree\nfour\n';

test('with no edits the log\'s own number is used unchanged', async () => {
  const p = await fresh();
  p.snapshot([{ path: 'main.tex', content: DOC }]);
  assert.equal(p.locate('main.tex', 3, DOC).line, 3);
});

test('a file that was not in the compile is never guessed at', async () => {
  const p = await fresh();
  p.snapshot([{ path: 'main.tex', content: DOC }]);
  assert.equal(p.locate('chapters/two.tex', 3, DOC).line, null);
});

// The reported bug, reduced: five lines inserted at the top, and the row must
// now point five lines lower.
test('text inserted above a diagnostic moves it down', async () => {
  const p = await fresh();
  p.snapshot([{ path: 'main.tex', content: DOC }]);
  const pad = '%pad\n'.repeat(5);
  p.record('main.tex', changeSet(insertion(0, pad.length, DOC.length)));
  assert.equal(p.locate('main.tex', 3, pad + DOC).line, 8);
});

test('text inserted below a diagnostic leaves it alone', async () => {
  const p = await fresh();
  p.snapshot([{ path: 'main.tex', content: DOC }]);
  const after = DOC + '%tail\n';
  p.record('main.tex', changeSet(insertion(DOC.length, 6, DOC.length)));
  assert.equal(p.locate('main.tex', 2, after).line, 2);
});

// A single scalar offset cannot express this, which is why the module keeps a
// ChangeDesc: one edit, two diagnostics, two different answers.
test('one edit moves the diagnostics below it and not those above', async () => {
  const p = await fresh();
  p.snapshot([{ path: 'main.tex', content: DOC }]);
  // Insert two lines at the start of line 3 ("three"), offset 8.
  const at = DOC.indexOf('three');
  const ins = '%a\n%b\n';
  const after = DOC.slice(0, at) + ins + DOC.slice(at);
  p.record('main.tex', changeSet(insertion(at, ins.length, DOC.length)));
  assert.equal(p.locate('main.tex', 2, after).line, 2);   // above
  assert.equal(p.locate('main.tex', 3, after).line, 5);   // below
});

test('successive edits compose', async () => {
  const p = await fresh();
  p.snapshot([{ path: 'main.tex', content: DOC }]);
  let text = DOC;
  for (let i = 0; i < 3; i++) {
    p.record('main.tex', changeSet(insertion(0, 5, text.length)));
    text = '%pad\n' + text;
  }
  assert.equal(p.locate('main.tex', 1, text).line, 4);
});

test('a line number past the end of the baseline is refused, not clamped', async () => {
  const p = await fresh();
  p.snapshot([{ path: 'main.tex', content: DOC }]);
  p.record('main.tex', changeSet(insertion(0, 5, DOC.length)));
  // The clamp this replaced would have answered "the last line", which for a
  // diagnostic attributed to the wrong file looked exactly like a real answer.
  assert.equal(p.locate('main.tex', 99, '%pad\n' + DOC).line, null);
});

// The subtlest case, and the reason mapPos alone is not enough: mapping a
// deleted line still yields a position, inside whatever closed up over it. That
// is a different line wearing the diagnostic's number.
test('a diagnostic whose line was deleted is refused, not relocated', async () => {
  const p = await fresh();
  p.snapshot([{ path: 'main.tex', content: DOC }]);
  const from = DOC.indexOf('two');
  const to = DOC.indexOf('three');
  p.record('main.tex', changeSet(deletion(from, to, DOC.length)));
  assert.equal(p.locate('main.tex', 2, 'one\nthree\nfour\n').line, null);
});

test('a deletion elsewhere still moves the lines below it up', async () => {
  const p = await fresh();
  p.snapshot([{ path: 'main.tex', content: DOC }]);
  const from = DOC.indexOf('two');
  const to = DOC.indexOf('three');
  p.record('main.tex', changeSet(deletion(from, to, DOC.length)));
  const after = 'one\nthree\nfour\n';
  assert.equal(p.locate('main.tex', 3, after).line, 2);   // "three" moved up
  assert.equal(p.locate('main.tex', 1, after).line, 1);   // "one" did not
});

test('invalidate stops the module answering for that file', async () => {
  const p = await fresh();
  p.snapshot([{ path: 'main.tex', content: DOC }, { path: 'two.tex', content: DOC }]);
  p.invalidate('main.tex');
  assert.equal(p.locate('main.tex', 2, DOC).line, null);
  // …and only that file.
  assert.equal(p.locate('two.tex', 2, DOC).line, 2);
});

// The backstop: a writer reached project.files without calling invalidate.
// There are several such writers and a seventh would not think to.
test('a length that disagrees with the mapping refuses rather than guesses', async () => {
  const p = await fresh();
  p.snapshot([{ path: 'main.tex', content: DOC }]);
  p.record('main.tex', changeSet(insertion(0, 5, DOC.length)));
  assert.equal(p.locate('main.tex', 2, 'something else entirely').line, null);
  // And it stays refused — the baseline is known bad now, not just mismatched
  // for this one call.
  assert.equal(p.locate('main.tex', 2, '%pad\n' + DOC).line, null);
});

test('a missing content string is treated as an unknown position', async () => {
  const p = await fresh();
  p.snapshot([{ path: 'main.tex', content: DOC }]);
  p.record('main.tex', changeSet(insertion(0, 5, DOC.length)));
  assert.equal(p.locate('main.tex', 2, undefined).line, null);
});

test('a rename carries the mapping to the new path', async () => {
  const p = await fresh();
  p.snapshot([{ path: 'main.tex', content: DOC }]);
  p.record('main.tex', changeSet(insertion(0, 5, DOC.length)));
  p.rename('main.tex', 'thesis.tex');
  const after = '%pad\n' + DOC;
  assert.equal(p.locate('thesis.tex', 2, after).line, 3);
  assert.equal(p.locate('main.tex', 2, after).line, null);
});

test('forget and clear drop baselines', async () => {
  const p = await fresh();
  p.snapshot([{ path: 'a.tex', content: DOC }, { path: 'b.tex', content: DOC }]);
  p.forget('a.tex');
  assert.equal(p.locate('a.tex', 1, DOC).line, null);
  assert.equal(p.locate('b.tex', 1, DOC).line, 1);
  p.clear();
  assert.equal(p.locate('b.tex', 1, DOC).line, null);
});

test('a new snapshot replaces the previous one entirely', async () => {
  const p = await fresh();
  p.snapshot([{ path: 'a.tex', content: DOC }]);
  p.record('a.tex', changeSet(insertion(0, 5, DOC.length)));
  // A recompile: the log's numbers now count against the current text, so the
  // accumulated edits must not be applied on top of them a second time.
  p.snapshot([{ path: 'a.tex', content: '%pad\n' + DOC }]);
  assert.equal(p.locate('a.tex', 3, '%pad\n' + DOC).line, 3);
});

test('binary or contentless entries are skipped rather than stored empty', async () => {
  const p = await fresh();
  p.snapshot([{ path: 'logo.png', content: null }, { path: 'a.tex', content: DOC }]);
  assert.equal(p.locate('logo.png', 1, '').line, null);
  assert.equal(p.locate('a.tex', 1, DOC).line, 1);
});
