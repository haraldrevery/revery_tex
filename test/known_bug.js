// Tests for bugs that are known and not yet fixed.
//
// Each one is written as the *correct* assertion and then marked with the phase
// of the fix plan that closes it. A plain failing test would turn the suite red
// until then and hide every new regression behind it; a skipped one would rot.
// So the marker is strict in both directions:
//
//   - **It must fail with its own symptom.** A known bug that fails for some
//     other reason — a harness fault, a renamed function — is reported as a
//     real failure rather than absorbed.
//   - **It must keep failing.** A known bug that no longer reproduces fails the
//     run, so the change that fixes it is also the change that turns it into an
//     ordinary test.

/**
 * node:test form. The body asserts what *should* happen; `symptom` matches the
 * message of the assertion that is expected to fail today.
 *
 *   test('…', (t) => knownBug(t, { phase: 'Phase 2', symptom: /decoded/ }, async () => {
 *     assert.throws(…, /./, 'non-UTF-8 text was decoded instead of refused');
 *   }));
 *
 * @param {import('node:test').TestContext} t
 * @param {{phase: string, symptom: RegExp}} spec
 * @param {() => unknown} body
 */
async function knownBug(t, { phase, symptom }, body) {
  try {
    await body();
  } catch (err) {
    const message = String(err && err.message !== undefined ? err.message : err);
    if (!symptom.test(message)) throw err;           // a different failure is a real one
    t.todo(`known bug, fixed in ${phase}: ${message.split('\n')[0]}`);
    return;
  }
  throw new Error(`this known bug (${phase}) no longer reproduces — ` +
                  'remove the knownBug() wrapper so it stays fixed');
}

/**
 * Harness form, for the CDP-driven scripts that report with their own check().
 *
 * `ok` is the correct behaviour; `symptom` is positive evidence of the known
 * wrong one. Asking for both is what keeps an unrelated breakage — a selector
 * that no longer matches, a dialog that never opened — from passing as "still
 * the known bug".
 *
 * @returns {boolean} true when the run should count this as a failure
 */
function knownBugCheck(name, { ok, symptom, phase, detail = '' }) {
  const tail = detail ? `  ${detail}` : '';
  if (ok) {
    console.log(`  ✗ ${name}  — known bug (${phase}) no longer reproduces; ` +
                `make this an ordinary check${tail}`);
    knownBugCheck.fixed++;
    return true;
  }
  if (!symptom) {
    console.log(`  ✗ ${name}  — failed, but not with the known symptom (${phase})${tail}`);
    return true;
  }
  console.log(`  ~ ${name}  (known bug, ${phase})${tail}`);
  knownBugCheck.known++;
  return false;
}
knownBugCheck.known = 0;
knownBugCheck.fixed = 0;

module.exports = { knownBug, knownBugCheck };
