// Build every installer this machine can build.
//
//   node build_tools/build_installers.js            # both shells
//   node build_tools/build_installers.js tauri      # one shell
//   node build_tools/build_installers.js electron
//
// Getting a shippable artifact used to mean knowing three commands and the
// order they go in — `build:tauri`, `build:electron`, then `verify:installers`
// — with the target list spelled out twice more in electron-builder.yml and
// tauri.conf.json. This is the one command, and the one place that decides what
// gets built where.
//
// Two rules are load-bearing rather than tidiness:
//
// **One build at a time.** rpmbuild on this payload peaks around 2.3 GB and
// runs multithreaded. A Tauri release build running beside it is what killed
// the machine before. The shells are built in sequence, never concurrently.
//
// **The host decides the targets.** Tauri needs the MSVC toolchain to produce a
// Windows binary and cannot cross-build to it; electron-builder's msi/nsis
// targets need Wine plus a downloaded WiX. So this builds what the machine it
// is running on can actually build, and Windows installers come from a Windows
// machine. Anything else would be a command that appears to work and emits an
// installer nobody has run.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/**
 * What each host can produce, per shell.
 *
 * Tauri's list is passed as `--bundles`, which overrides `bundle.targets` in
 * tauri.conf.json. That config stays as it is: it is JSON, so it cannot carry a
 * comment explaining a platform conditional, and two files disagreeing about
 * the target list is the thing this table exists to prevent.
 *
 * darwin is absent on purpose. There is no `mac:` block in
 * electron-builder.yml and no `bundle.macOS` config, so a build there would be
 * packaging defaults nobody has looked at rather than a supported artifact.
 */
const TARGETS = {
  linux: {
    label: '.deb and .rpm',
    tauri: ['deb', 'rpm'],
    electron: ['--linux', 'deb', 'rpm']
  },
  win32: {
    label: '.msi and .exe',
    tauri: ['msi', 'nsis'],
    electron: ['--win', 'msi', 'nsis']
  }
};

/** Where each shell leaves its output, and which shell to credit for a file. */
const OUTPUTS = [
  { shell: 'electron', dir: 'dist-electron' },
  { shell: 'tauri', dir: path.join('tauri', 'target', 'release', 'bundle') }
];

const INSTALLER = /\.(deb|rpm|msi|exe)$/;

/**
 * Both CLIs ship as plain `#!/usr/bin/env node` scripts, so they are run
 * through this same node rather than through node_modules/.bin. On Windows the
 * .bin entry is a .cmd, which Node 22 refuses to spawn without a shell — and
 * reaching for `shell: true` to work around that is how a path with a space in
 * it (there is one: "Revery TeX") turns into an argument-splitting bug.
 */
function cli(spec, entry) {
  return path.join(path.dirname(require.resolve(`${spec}/package.json`, { paths: [ROOT] })), entry);
}

/**
 * Child output is inherited, never captured. A long build piped somewhere
 * buffers until EOF, so a run killed by a timeout prints nothing at all and the
 * failure reads as a hang.
 */
function run(label, argv, env) {
  console.log(`\n\x1b[1m${label}\x1b[0m\n  ${argv.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}\n`);
  const started = Date.now();
  const res = spawnSync(process.execPath, argv, { cwd: ROOT, stdio: 'inherit', env: env || process.env });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    console.error(`\n${label} failed (exit ${res.status})`);
    process.exit(res.status || 1);
  }
  console.log(`\n${label} finished in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

function findInstallers() {
  const found = [];
  for (const { shell, dir } of OUTPUTS) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        // `*-unpacked/` holds the app binary electron-builder packs *into* the
        // installer. On Windows that is a `.exe` matching the pattern below.
        if (e.isDirectory()) { if (!/unpacked/.test(e.name)) walk(p); }
        else if (INSTALLER.test(e.name)) found.push({ shell, file: p });
      }
    };
    walk(full);
  }
  return found;
}

const SHELLS = ['tauri', 'electron'];

function main(argv) {
  const args = argv.filter(a => !a.startsWith('-'));
  const unknown = args.filter(a => !SHELLS.includes(a));

  if (unknown.length) {
    console.error(`unknown argument: ${unknown.join(', ')}\n` +
      'usage: node build_tools/build_installers.js [tauri|electron]');
    process.exit(2);
  }

  const plan = TARGETS[process.platform];
  if (!plan) {
    console.error(`No installer targets for ${process.platform}.\n` +
      'deb and rpm are built on Linux, msi and exe on Windows. Tauri cannot ' +
      'cross-build to Windows, so a Windows installer comes from a Windows machine.');
    process.exit(2);
  }

  // Sequence matters: Tauri is the longer and more memory-hungry of the two, so
  // running it first means a failure surfaces before an hour of packaging.
  const shells = args.length ? SHELLS.filter(s => args.includes(s)) : SHELLS;

  console.log(`Building ${plan.label} for ${process.platform} — ${shells.join(' then ')}, one at a time.`);

  // The version lives in four files that no tool keeps in agreement, and the
  // moment before packaging is the last one where a drift is still cheap.
  run('version check', [path.join(__dirname, 'sync_version.js'), '--check']);

  for (const shell of shells) {
    if (shell === 'tauri') {
      run('tauri build', [
        cli('@tauri-apps/cli', 'tauri.js'),
        'build', '--config', 'tauri/tauri.conf.json',
        '--bundles', plan.tauri.join(',')
      ]);
    } else {
      // electron-builder must not run with ELECTRON_RUN_AS_NODE set — that
      // variable turns the Electron it spawns into a bare Node process. Matches
      // `env -u ELECTRON_RUN_AS_NODE` in the build:electron script.
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      run('electron-builder', [cli('electron-builder', 'cli.js'), ...plan.electron], env);
    }
  }

  const built = findInstallers();

  console.log('\n\x1b[1mInstallers\x1b[0m');
  for (const { shell, file } of built.sort((a, b) => a.file.localeCompare(b.file))) {
    const mb = fs.statSync(file).size / 1e6;
    // On Linux this yields two .deb files with near-identical names in different
    // directories, so the shell has to be on the line.
    console.log(`  ${shell.padEnd(9)} ${`${mb.toFixed(0)} MB`.padStart(7)}  ${path.relative(ROOT, file)}`);
  }
  if (!built.length) console.log('  (none found — the build reported success but produced nothing)');

  run('verify', [path.join(ROOT, 'test', 'verify_installers.js')]);
}

// Guarded, so a test can assert the target table without starting a build.
if (require.main === module) main(process.argv.slice(2));

module.exports = { TARGETS, SHELLS, INSTALLER, findInstallers };
