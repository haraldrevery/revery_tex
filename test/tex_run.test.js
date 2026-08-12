// Mirrors the Rust tests in tauri/src/tex_run.rs. Two shells that spawn
// processes differently would be two sets of security bugs, so both are held
// to the same cases.
//
// The tests that matter are the refusals and the two live ones: that a real
// compile works, and that \write18 does not.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tex = require('../electron/tex_run.js');

let n = 0;
function tmpdir(tag) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `revery-tex-run-${tag}-${n++}-`)));
}
const HAVE_TEX = !!tex.findTool('pdflatex');

test('refuses programs not on the allowlist', async () => {
  const root = tmpdir('allow');
  for (const bad of ['sh', 'bash', 'rm', '/bin/sh', 'curl', 'python3', 'latexmk']) {
    await assert.rejects(() => tex.runTool(bad, 'main.tex', root, 5), /not a program/,
      `${bad} must be refused`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('latexmk is deliberately absent from the allowlist', () => {
  // It executes latexmkrc from the working directory as Perl, so opening a
  // downloaded project would run its author's code.
  assert.ok(!tex.ALLOWED.includes('latexmk'));
});

test('findTool only resolves allowlisted names', () => {
  assert.equal(tex.findTool('sh'), null, 'sh must never resolve');
  assert.equal(tex.findTool('rm'), null);
  assert.equal(tex.findTool('../../bin/sh'), null);
});

test('findTool never searches an empty PATH entry', () => {
  const before = process.env.PATH;
  const root = tmpdir('pathdot');
  // An empty entry means "." — a project containing a file called `pdflatex`
  // must not become the compiler.
  fs.writeFileSync(path.join(root, 'pdflatex'), '#!/bin/sh\necho pwned\n', { mode: 0o755 });
  process.env.PATH = `:${root}X`;
  const cwd = process.cwd();
  try {
    process.chdir(root);
    assert.equal(tex.findTool('pdflatex'), null);
  } finally {
    process.chdir(cwd);
    process.env.PATH = before;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a main file that escapes or looks like a flag', async () => {
  const root = tmpdir('mainfile');
  for (const bad of ['../outside.tex', 'a/../../b.tex', '/etc/passwd',
                     '-shell-escape', '--output-directory=/tmp', '', 'a\0b']) {
    await assert.rejects(() => tex.runTool('pdflatex', bad, root, 5), /not a valid file name/,
      `${JSON.stringify(bad)} must be refused`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('argv always disables shell escape', () => {
  for (const engine of ['pdflatex', 'xelatex', 'lualatex']) {
    const args = tex.argvFor(engine, 'main.tex');
    assert.ok(args.includes('-no-shell-escape'), `${engine} must disable \\write18`);
    assert.ok(args.includes('-interaction=nonstopmode'));
    // Passed as ./name, so a name starting with a dash is never an option.
    assert.ok(args[args.length - 1].startsWith('./'));
  }
});

test('a filename with shell metacharacters stays one argument', () => {
  const args = tex.argvFor('pdflatex', 'weird; rm -rf ~.tex');
  assert.equal(args[args.length - 1], './weird; rm -rf ~.tex');
  assert.equal(args.filter(a => a.includes('rm')).length, 1);
});

test('argv matches the Rust implementation exactly', () => {
  // The two shells must build identical command lines, or a document that
  // compiles in one fails in the other for reasons no user could diagnose.
  const rust = fs.readFileSync(path.join(__dirname, '..', 'tauri', 'src', 'tex_run.rs'), 'utf8');
  for (const flag of ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error',
                      '-no-shell-escape', '-output-directory=.']) {
    assert.ok(rust.includes(`"${flag}"`), `Rust is missing ${flag}`);
    assert.ok(tex.argvFor('pdflatex', 'm.tex').includes(flag), `JS is missing ${flag}`);
  }
  for (const name of tex.ALLOWED) {
    assert.ok(rust.includes(`"${name}"`), `Rust allowlist is missing ${name}`);
  }
});

/* ── live, only where a system TeX exists ─────────────────────────────── */

test('compiles a real document', { skip: !HAVE_TEX }, async () => {
  const root = tmpdir('compile');
  fs.writeFileSync(path.join(root, 'main.tex'),
    '\\documentclass{article}\\begin{document}Hello from the system TeX.\\end{document}');
  const r = await tex.runTool('pdflatex', 'main.tex', root, 120);
  assert.equal(r.code, 0, r.stdout.slice(-800));
  assert.ok(fs.existsSync(path.join(root, 'main.pdf')), 'no PDF was produced');
  assert.equal(r.timedOut, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('\\write18 does not execute', { skip: !HAVE_TEX }, async () => {
  const root = tmpdir('write18');
  fs.writeFileSync(path.join(root, 'main.tex'),
    '\\documentclass{article}\\begin{document}\n' +
    '\\immediate\\write18{touch pwned.txt}\nHello\\end{document}');
  await tex.runTool('pdflatex', 'main.tex', root, 60);
  assert.ok(!fs.existsSync(path.join(root, 'pwned.txt')),
    'shell escape is not actually disabled');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a document cannot write outside the project', { skip: !HAVE_TEX }, async () => {
  const root = tmpdir('openout');
  const outside = tmpdir('openout-outside');
  const victim = path.join(outside, 'escaped.txt').replace(/\\/g, '/');
  fs.writeFileSync(path.join(root, 'main.tex'),
    '\\documentclass{article}\\begin{document}\n' +
    `\\newwrite\\x\\immediate\\openout\\x=${victim}\n` +
    '\\immediate\\write\\x{escaped}\\immediate\\closeout\\x\nHello\\end{document}');
  await tex.runTool('pdflatex', 'main.tex', root, 60);
  assert.ok(!fs.existsSync(victim), 'openout_any=p did not contain the write');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('a run that overruns is killed', { skip: !HAVE_TEX }, async () => {
  const root = tmpdir('timeout');
  fs.writeFileSync(path.join(root, 'main.tex'),
    '\\documentclass{article}\\begin{document}\n' +
    '\\count0=0 \\loop\\advance\\count0 by 1 \\ifnum\\count0<200000000 \\repeat\n' +
    '\\end{document}');
  const r = await tex.runTool('pdflatex', 'main.tex', root, 5);
  assert.ok(r.seconds < 15, `the kill must be prompt, took ${r.seconds}s`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('detect reports only allowlisted tools', { skip: !HAVE_TEX }, async () => {
  const found = await tex.detect();
  assert.ok(found.length > 0, 'a system TeX is installed but nothing was detected');
  for (const t of found) {
    assert.ok(tex.ALLOWED.includes(t.name));
    assert.ok(t.path && fs.existsSync(t.path));
  }
});
