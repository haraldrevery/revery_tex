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

const { spawn, spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const only = process.argv.slice(2).filter(a => !a.startsWith('-'));

/** Suites in the order a failure is most useful: cheapest and most basic first. */
const SUITES = [
  { name: 'unit', cmd: ['npm', 'test'] },
  { name: 'rust', cmd: ['cargo', 'test', '--manifest-path', 'tauri/Cargo.toml'] },
  { name: 'gate', cmd: ['node', 'test/run_phase0.js'] },
  { name: 'ui', cmd: ['node', 'test/run_ui.js'] },
  { name: 'web', cmd: ['node', 'test/run_web_backends.js'] },
  { name: 'electron', cmd: ['node', 'test/run_electron.js'] }
];

const servers = [];

function startServer(label, env) {
  const p = spawn('node', ['test/serve.js'], {
    cwd: ROOT, env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'], detached: true
  });
  servers.push({ label, proc: p });
  return p;
}

function stopServers() {
  for (const { proc } of servers) {
    // By PID and process group. Never by pattern — a pattern matches this
    // script's own command line and takes the session with it.
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { }
    try { process.kill(proc.pid, 'SIGKILL'); } catch { }
  }
  servers.length = 0;
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

async function main() {
  // A server left over from an earlier run serves stale code, and the failure
  // looks like the change broke something. Start our own, always.
  const inUse = await fetch('http://localhost:8777/api/projects', { signal: AbortSignal.timeout(500) })
    .then(() => true).catch(() => false);
  if (inUse) {
    console.error('Port 8777 is already serving. Stop that `node test/serve.js` first —\n' +
                  'a long-lived one does not pick up edits, and this would test the old code.');
    process.exit(2);
  }

  startServer('fixtures :8777', {});
  startServer('static :8778', { REVERY_TEX_STATIC: '1', PORT: '8778' });
  await waitFor('http://localhost:8777/api/projects', 'fixture server');
  await waitFor('http://localhost:8778/www/index.html', 'static server');

  const results = [];
  for (const s of SUITES) {
    if (only.length && !only.includes(s.name)) continue;
    process.stdout.write(`\n── ${s.name} ${'─'.repeat(Math.max(0, 60 - s.name.length))}\n`);
    const t0 = Date.now();
    const r = spawnSync(s.cmd[0], s.cmd.slice(1), { cwd: ROOT, stdio: 'inherit' });
    results.push({ name: s.name, ok: r.status === 0, secs: ((Date.now() - t0) / 1000).toFixed(1) });
  }

  console.log('\n════ check ════');
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(10)} ${r.secs}s`);
  const failed = results.filter(r => !r.ok);
  console.log(failed.length ? `\n${failed.length} suite(s) failed` : '\neverything passed');
  return failed.length ? 1 : 0;
}

process.on('exit', stopServers);
process.on('SIGINT', () => { stopServers(); process.exit(130); });

main()
  .then((code) => { stopServers(); process.exit(code); })
  .catch((err) => { console.error(err.message); stopServers(); process.exit(1); });
