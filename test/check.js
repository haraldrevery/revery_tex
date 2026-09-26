// Everything, in one command.
//
//   npm run check
//
// Five suites need two dev servers up, in the right order, and are otherwise
// run by hand — which is exactly when a suite quietly stops being run. This
// starts the servers, runs the lot, and tears them down whatever happens.
//
// Not a CI config: `git remote -v` is empty, so there is nowhere for one to run
// yet. When there is, this is what it should call.
//
//   CHECK_TIMEOUT_MINUTES=n      one ceiling for every suite instead of its own
//   REVERY_TEX_FIXTURES=…         where the sibling fixture repo is (fixtures_dir.js)
//   REVERY_TEX_SKIP_FIXTURES=1    report the suites that need it as SKIP, on purpose

const { spawn } = require('child_process');
const path = require('path');
const { fixturesPresent, SKIP_REQUESTED, MISSING } = require('./fixtures_dir.js');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const only = process.argv.slice(2).filter(a => !a.startsWith('-'));

/**
 * Suites in the order a failure is most useful: cheapest and most basic first.
 *
 * `minutes` is a ceiling, not an estimate. A suite that hangs — an unanswered
 * dialog in headless Chrome is the usual cause — used to hang this command
 * forever with no output; now it is stopped and reported as a timeout.
 */
const SUITES = [
  // Cheapest of the lot, and the one most easily forgotten: package.json,
  // tauri.conf.json, Cargo.toml and Cargo.lock all carry the version, and
  // nothing else here would notice them drifting apart.
  { name: 'version', cmd: ['node', 'build_tools/sync_version.js', '--check'], minutes: 1 },
  { name: 'unit', cmd: ['npm', 'test'], minutes: 5 },
  // Includes the build, which is minutes on a cold target directory.
  { name: 'rust', cmd: ['cargo', 'test', '--manifest-path', 'tauri/Cargo.toml'], minutes: 20 },
  { name: 'gate', cmd: ['node', 'test/run_phase0.js'], minutes: 60, fixtures: true },
  { name: 'ui', cmd: ['node', 'test/run_ui.js'], minutes: 30, fixtures: true },
  { name: 'web', cmd: ['node', 'test/run_web_backends.js'], minutes: 15 },
  { name: 'electron', cmd: ['node', 'test/run_electron.js'], minutes: 15 }
];

const servers = [];
let running = null;          // the suite in flight, so an interrupt can stop it too

function startServer(label, env) {
  const p = spawn('node', ['test/serve.js'], {
    cwd: ROOT, env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'], detached: true
  });
  servers.push({ label, proc: p });
  return p;
}

/** By PID and process group. Never by pattern — a pattern matches this script's own command line. */
function killGroup(proc, signal) {
  try { process.kill(-proc.pid, signal); } catch { }
  try { process.kill(proc.pid, signal); } catch { }
}

function stopServers() {
  for (const { proc } of servers) killGroup(proc, 'SIGKILL');
  servers.length = 0;
  if (running) killGroup(running, 'SIGKILL');
}

async function waitFor(url, what) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (r.status < 500) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`${what} never came up at ${url}`);
}

/**
 * Run one suite with a ceiling. Stopped with SIGINT first, because every
 * harness tears down its own Chrome or Electron in a SIGINT handler — and those
 * run detached, in process groups of their own, so a bare SIGKILL of the suite
 * would leave them holding their debug ports for the next suite to trip on.
 */
function runSuite(s) {
  const limitMs = (Number(process.env.CHECK_TIMEOUT_MINUTES) || s.minutes) * 60000;
  return new Promise((resolve) => {
    const child = spawn(s.cmd[0], s.cmd.slice(1), { cwd: ROOT, stdio: 'inherit', detached: true });
    running = child;
    let timedOut = false;
    let grace = null;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`\n${s.name}: no result after ${limitMs / 60000} min — stopping it`);
      killGroup(child, 'SIGINT');
      grace = setTimeout(() => killGroup(child, 'SIGKILL'), 10000);
    }, limitMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      clearTimeout(grace);
      running = null;
      resolve({ ok: code === 0 && !timedOut, note: timedOut ? 'timed out' : '' });
    });
  });
}

/** Is anything already answering on `port`? */
const serving = (port, route) =>
  fetch(`http://localhost:${port}${route}`, { signal: AbortSignal.timeout(500) })
    .then(() => true).catch(() => false);

async function main() {
  // A server left over from an earlier run serves stale code, and the failure
  // looks like the change broke something. Start our own, always — on both
  // ports. Only 8777 used to be checked, and the web suite runs against 8778:
  // a leftover there won the port, the new server's EADDRINUSE went to a pipe
  // nobody read, and the suite ran against the old code.
  for (const [port, route] of [[8777, '/api/projects'], [8778, '/www/index.html']]) {
    if (await serving(port, route)) {
      console.error(`Port ${port} is already serving. Stop that \`node test/serve.js\` first —\n` +
                    'a long-lived one does not pick up edits, and this would test the old code.');
      process.exit(2);
    }
  }

  const haveFixtures = fixturesPresent();
  if (!haveFixtures) {
    console.error(`\n!! ${MISSING}\n`);
  }

  startServer('fixtures :8777', {});
  // REVERY_TEX_CSP=site serves the policy the deployed host really sends. The
  // static server exists to be a real host; serving it without the real headers
  // is how the blob:-image failure reached production unnoticed.
  startServer('static :8778', { REVERY_TEX_STATIC: '1', PORT: '8778', REVERY_TEX_CSP: 'site' });
  await waitFor('http://localhost:8777/api/projects', 'fixture server');
  await waitFor('http://localhost:8778/www/index.html', 'static server');

  const results = [];
  for (const s of SUITES) {
    if (only.length && !only.includes(s.name)) continue;
    process.stdout.write(`\n── ${s.name} ${'─'.repeat(Math.max(0, 60 - s.name.length))}\n`);
    // Not run at all rather than run into a wall: without the fixture repo
    // these fail on their first project, with an error about something else.
    if (s.fixtures && !haveFixtures) {
      const skip = SKIP_REQUESTED;
      console.log(skip ? 'skipped — REVERY_TEX_SKIP_FIXTURES=1' : 'not run — the fixture repo is missing');
      results.push({ name: s.name, ok: skip, skipped: skip, secs: '0.0',
                     note: skip ? 'skipped on request' : 'fixture repo missing' });
      continue;
    }
    const t0 = Date.now();
    const r = await runSuite(s);
    results.push({ name: s.name, ...r, secs: ((Date.now() - t0) / 1000).toFixed(1) });
  }

  console.log('\n════ check ════');
  for (const r of results) {
    const mark = r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
    console.log(`  ${mark}  ${r.name.padEnd(10)} ${r.secs}s${r.note ? `  (${r.note})` : ''}`);
  }
  const failed = results.filter(r => !r.ok);
  const skipped = results.filter(r => r.skipped);
  console.log(failed.length ? `\n${failed.length} suite(s) failed`
    : skipped.length ? `\npassed, but ${skipped.length} suite(s) were skipped — this is not a full check`
    : '\neverything passed');
  return failed.length ? 1 : 0;
}

process.on('exit', stopServers);
process.on('SIGINT', () => { stopServers(); process.exit(130); });

main()
  .then((code) => { stopServers(); process.exit(code); })
  .catch((err) => { console.error(err.message); stopServers(); process.exit(1); });
