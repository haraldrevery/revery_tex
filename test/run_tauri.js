// Smoke-test a *release* Tauri build.
//
//   node test/run_tauri.js [path/to/binary]
//
// Why this is a screenshot rather than a real driver: our CDP client speaks
// Chrome's DevTools protocol, and Tauri on Linux is WebKitGTK, which does not
// implement it. There is no headless driver available, so the window itself is
// the evidence.
//
// What it is actually checking is narrow but has been open since Phase A: a
// release build serves the frontend over the `tauri://localhost` custom
// protocol, while `tauri dev` serves it from a local http server. Those are
// different origins with different CSP behaviour, and only the dev path had
// ever been exercised. If the production protocol were broken, the window would
// come up blank — which is exactly what a screenshot shows.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const BIN = process.argv[2] || path.join(ROOT, 'tauri', 'target', 'release', 'revery-tex');
const SHOT = process.env.SHOT || path.join(os.tmpdir(), 'revery-tex-tauri.png');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function scratchProject() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'revery-tex-tauri-')));
  fs.writeFileSync(path.join(dir, 'main.tex'), String.raw`\documentclass{article}
\begin{document}
\section{Release build}
If you can read this in the PDF pane, the production custom protocol works.
\end{document}
`);
  return dir;
}

async function main() {
  if (!fs.existsSync(BIN)) {
    console.error(`No release binary at ${BIN}\n  npm run build:tauri`);
    process.exit(2);
  }
  if (!process.env.DISPLAY) {
    console.error('No DISPLAY. This needs a real X session; there is no headless path for WebKitGTK.');
    process.exit(2);
  }

  const project = scratchProject();
  const child = spawn(BIN, [], {
    env: { ...process.env, REVERY_TEX_OPEN: project },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });

  const cleanup = () => {
    // By PID and process group, never by pattern — a pattern matches this
    // script's own command line and kills the session.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { }
    try { process.kill(child.pid, 'SIGKILL'); } catch { }
    try { fs.rmSync(project, { recursive: true, force: true }); } catch { }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  let wid = null;
  for (let i = 0; i < 40 && !wid; i++) {
    await sleep(500);
    try {
      const tree = execFileSync('xwininfo', ['-root', '-tree'], { encoding: 'utf8', maxBuffer: 1 << 24 });
      const line = tree.split('\n').find(l => l.includes('"Revery TeX"'));
      if (line) wid = (line.trim().match(/^(0x[0-9a-f]+)/) || [])[1];
    } catch { /* xwininfo can fail transiently while the window maps */ }
  }

  if (!wid) {
    cleanup();
    console.error(`✗ no "Revery TeX" window appeared\n--- output ---\n${output.slice(-2000)}`);
    process.exit(1);
  }
  console.log(`  ✓ window mapped  ${wid}`);
  await sleep(4000);            // let the app boot and open the project

  // Compile is manual (Ctrl+Enter), so without this the screenshot only proves
  // the UI loaded — and the engine is the half most likely to break in a
  // release bundle, where the wasm and every data package are served from
  // tauri://localhost rather than an http server.
  //
  // There is no xdotool here, but python-xlib can drive XTEST directly, which
  // is the same mechanism. wmctrl focuses the window first; XTEST sends to
  // whatever has focus.
  // XTEST types into whatever currently has focus, which on a desktop where
  // someone is working is *their* window, not ours. So this is opt-in, and it
  // refuses unless focus has actually landed on the app. Off by default the
  // screenshot shows the UI only; see the note this script prints.
  let compiled = false;
  if (process.env.REVERY_TEX_ALLOW_INPUT === '1') {
    try {
      execFileSync('wmctrl', ['-i', '-a', wid]);
      await sleep(1000);
      execFileSync('python3', ['-c', `
import sys, time
from Xlib import display, X, XK
from Xlib.ext import xtest

target = int(sys.argv[1], 16)
d = display.Display()

# Walk up from the focused window: the toplevel we want may be an ancestor of
# whatever actually holds focus inside the webview.
w = d.get_input_focus().focus
ok = False
for _ in range(8):
    if getattr(w, 'id', None) == target:
        ok = True
        break
    try:
        w = w.query_tree().parent
    except Exception:
        break
if not ok:
    sys.exit('focus is elsewhere; refusing to send keys into another application')

ctrl = d.keysym_to_keycode(XK.string_to_keysym('Control_L'))
ret  = d.keysym_to_keycode(XK.string_to_keysym('Return'))
xtest.fake_input(d, X.KeyPress, ctrl); d.sync(); time.sleep(0.05)
xtest.fake_input(d, X.KeyPress, ret);  d.sync(); time.sleep(0.05)
xtest.fake_input(d, X.KeyRelease, ret); d.sync(); time.sleep(0.05)
xtest.fake_input(d, X.KeyRelease, ctrl); d.sync()
`, wid]);
      compiled = true;
      console.log('  ✓ focused the window and sent Ctrl+Enter');
    } catch (e) {
      console.log(`  · no keystroke sent: ${String(e.stderr || e.message).trim().split('\n').pop()}`);
    }
  }

  // The engine has to fetch and decompress the whole texmf image first.
  await sleep(compiled ? 40000 : 8000);
  execFileSync('import', ['-window', wid, SHOT]);
  cleanup();

  const bytes = fs.statSync(SHOT).size;
  console.log(`  ✓ screenshot written  ${SHOT}  (${(bytes / 1024).toFixed(0)} KB)`);
  console.log('\nInspect it: a blank window means the tauri://localhost protocol is not serving www/.');
  if (output.trim()) console.log(`\n--- app output ---\n${output.slice(-1000)}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
