// Running the user's own TeX installation — the Electron half.
//
// Mirrors tauri/src/tex_run.rs one-for-one, the same way fs_core.js mirrors the
// filesystem commands: the same allowlist, the same argv, the same timeout, and
// held to the same tests. Two shells that spawn processes differently would be
// two sets of security bugs.
//
// The two rules that shape this, repeated here because they are not obvious:
//
//   - **Never latexmk.** It reads `latexmkrc` from the working directory and
//     executes it as Perl, so opening a downloaded project would run its
//     author's code. Driving the engines directly is the only safe version.
//   - **Always -no-shell-escape.** \write18 runs shell commands from inside the
//     document. Restricted mode is the usual default; "usually" is not a
//     security property.
//
// Pure Node, no Electron imports, so it is unit-testable without a browser.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/** The only programs this may ever execute. A name, never a path. */
const ALLOWED = ['pdflatex', 'xelatex', 'lualatex', 'bibtex', 'biber', 'makeindex'];

const MAX_OUTPUT = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECS = 180;

/* ── finding programs ─────────────────────────────────────────────────── */

function isExecutable(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    return (st.mode & 0o111) !== 0;
  } catch { return false; }
}

/**
 * Resolve a program name against PATH by hand — not `which`, and never a shell.
 * Spawning a shell to find a program is how a name with a metacharacter becomes
 * a command. Only allowlisted names get this far; the property should not
 * depend on that.
 */
function findTool(name) {
  if (!ALLOWED.includes(name)) return null;
  const dirs = (process.env.PATH || '').split(path.delimiter);
  // `.exe` only, matching tauri/src/tex_run.rs — and not `.bat`/`.cmd` for a
  // second reason: Node refuses to spawn either without `shell: true` (the
  // fix for CVE-2024-27980), and a shell is the one thing this must never
  // use. Accepting them here only ever produced a confusing spawn error.
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of dirs) {
    if (!dir) continue;                 // an empty PATH entry means "." — never search it
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Arguments for a tool, built here and never taken from the frontend.
 *
 * The caller names a tool and a main file; every flag is decided in this
 * function, so no document, filename or setting can become a command-line
 * option.
 */
function argvFor(tool, mainFile) {
  const stem = path.basename(mainFile).replace(/\.[^.]+$/, '');
  switch (tool) {
    case 'pdflatex':
    case 'xelatex':
    case 'lualatex':
      return [
        '-interaction=nonstopmode',
        '-halt-on-error',
        '-file-line-error',
        '-no-shell-escape',            // \write18 runs shell commands
        // Without this TeX Live writes no .synctex.gz at all, and the app's
        // click-to-source silently does nothing. A fixed flag, not a setting.
        '-synctex=1',
        '-output-directory=.',         // stop TeX writing outside the project
        `./${mainFile}`                // ./ so a leading dash is never an option
      ];
    case 'bibtex': return [stem];
    // The stem and nothing else. Biber has no safe mode and no shell-escape
    // switch, so there is no flag to pass here — and an unrecognised one makes
    // Getopt::Long print usage and exit non-zero, which is a bibliography that
    // never builds.
    case 'biber': return [stem];
    case 'makeindex': return [`${stem}.idx`];
    default: return [];
  }
}

/** A relative path inside the project that cannot be mistaken for a flag. */
function validMainFile(mainFile) {
  return typeof mainFile === 'string'
    && mainFile.length > 0
    && !mainFile.startsWith('-')
    && !mainFile.includes('\0')
    && !path.isAbsolute(mainFile)
    // Both separators. Containment is enforced above this by safePathInside,
    // so a backslash escape was never live — but this check exists to be the
    // one that does not depend on the other, and on Windows it was splitting
    // on '/' alone and would have waved `sub\..\..\x.tex` through.
    && !mainFile.split(/[/\\]/).includes('..');
}

/* ── running ──────────────────────────────────────────────────────────── */

function runTool(tool, mainFile, root, timeoutSecs) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED.includes(tool)) {
      return reject(new Error(`${tool} is not a program Revery TeX will run`));
    }
    if (!validMainFile(mainFile)) {
      return reject(new Error(`${mainFile} is not a valid file name for a compile`));
    }
    const exe = findTool(tool);
    if (!exe) return reject(new Error(`${tool} was not found on your PATH`));

    const started = Date.now();
    const child = spawn(exe, argvFor(tool, mainFile), {
      cwd: root,
      // No shell, ever. An args array plus shell:false is what makes a
      // filename containing ; or $( ) inert.
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],   // stdin closed: never wait for input
      env: {
        ...process.env,
        // Belt and braces alongside -no-shell-escape: refuse writes outside the
        // tree and reads of absolute paths the document names.
        openout_any: 'p',
        openin_any: 'p',
        shell_escape: 'f',
        max_print_line: '1000'
      }
    });

    let stdout = '', stderr = '', truncated = false;
    const cap = (chunk, which) => {
      const s = chunk.toString();
      if (which === 'o') {
        if (stdout.length < MAX_OUTPUT) stdout += s.slice(0, MAX_OUTPUT - stdout.length);
        else truncated = true;
      } else {
        if (stderr.length < MAX_OUTPUT) stderr += s.slice(0, MAX_OUTPUT - stderr.length);
        else truncated = true;
      }
    };
    // Both pipes are always drained. A child that fills the stderr buffer with
    // nobody reading blocks forever, and then only the timeout ends the
    // compile — a warning-heavy document would look like a hang.
    child.stdout.on('data', (c) => cap(c, 'o'));
    child.stderr.on('data', (c) => cap(c, 'e'));

    const limit = Math.min(Math.max(Number(timeoutSecs) || DEFAULT_TIMEOUT_SECS, 5), 1800);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, limit * 1000);

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`could not start ${exe}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        tool,
        code: timedOut ? null : code,
        stdout, stderr, timedOut, truncated,
        seconds: (Date.now() - started) / 1000
      });
    });
  });
}

/* ── detection ────────────────────────────────────────────────────────── */

function probeVersion(exe) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(exe, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return finish(null); }
    // A --version that hangs would hang detection.
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(null); }, 10000);
    child.stdout.on('data', (c) => { if (out.length < 4096) out += c.toString(); });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => {
      clearTimeout(timer);
      finish((out.split('\n')[0] || '').trim() || null);
    });
  });
}

/** What the user has installed. Re-checked on demand: people install TeX Live
 *  while the app is open. */
async function detect() {
  const out = [];
  for (const name of ALLOWED) {
    const p = findTool(name);
    if (!p) continue;
    out.push({ name, path: p, version: await probeVersion(p) });
  }
  return out;
}

module.exports = { ALLOWED, findTool, argvFor, validMainFile, runTool, detect, MAX_OUTPUT };
