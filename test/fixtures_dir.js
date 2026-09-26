// Where the sibling fixture repo lives, and what happens when it is not there.
//
// The gate, the UI suite and the fixture-backed unit tests all read
// latex_project_tests/, which is a separate repository beside this one. Each
// used to hard-code `../latex_project_tests` and quietly skip when it was
// missing, so a checkout without it reported green while the project's own
// invariant — the gate — had never run.
//
//   REVERY_TEX_FIXTURES=/path/to/latex_project_tests   use a different location
//   REVERY_TEX_SKIP_FIXTURES=1                          skip, and say so, on purpose
//
// Without either, a missing repo is a failure that names both variables.

const fs = require('fs');
const path = require('path');

const FIXTURES_DIR = path.resolve(
  process.env.REVERY_TEX_FIXTURES || path.join(__dirname, '..', '..', 'latex_project_tests'));

const SKIP_REQUESTED = process.env.REVERY_TEX_SKIP_FIXTURES === '1';

const fixturesPresent = () => fs.existsSync(FIXTURES_DIR);

const MISSING = `the fixture repo is not at ${FIXTURES_DIR} — clone it there, ` +
  'point REVERY_TEX_FIXTURES at it, or set REVERY_TEX_SKIP_FIXTURES=1 to skip these tests deliberately';

/**
 * node:test options for a test that reads the fixtures: skipped only when the
 * skip was asked for, never merely because the directory is absent.
 */
function fixtureTestOptions() {
  if (fixturesPresent() || !SKIP_REQUESTED) return {};
  return { skip: `REVERY_TEX_SKIP_FIXTURES=1 (fixtures not at ${FIXTURES_DIR})` };
}

/** First line of a fixture-backed test: throws the actionable message if absent. */
function requireFixtures() {
  if (!fixturesPresent()) throw new Error(MISSING);
}

module.exports = { FIXTURES_DIR, SKIP_REQUESTED, fixturesPresent, fixtureTestOptions, requireFixtures, MISSING };
