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
const HAVE_BIBER = HAVE_TEX && !!tex.findTool('biber');

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

test('-synctex=1 is passed, or there is no click-to-source', () => {
  // TeX Live writes no .synctex.gz unless asked. Without this the app reads a
  // file that was never produced, and SyncTeX silently does nothing under the
  // system engine while capabilities.synctex still reports true.
  for (const engine of ['pdflatex', 'xelatex', 'lualatex']) {
    assert.ok(tex.argvFor(engine, 'main.tex').includes('-synctex=1'),
      `${engine} must be asked for a synctex file`);
  }
});

test('biber is given the stem and nothing else', () => {
  // It once carried '--nosafe-mode-off-placeholder', which is not a biber
  // option: Getopt::Long prints usage and exits non-zero on an unrecognised
  // one, so the bibliography never built. Biber has no safe mode and no
  // shell-escape switch — there is no flag this was standing in for.
  assert.deepEqual(tex.argvFor('biber', 'main.tex'), ['main']);
  assert.deepEqual(tex.argvFor('biber', 'src/thesis.tex'), ['thesis']);
});

/**
 * The literal argv the Rust shell builds for one tool, read out of its source.
 *
 * A grep for flag *substrings* is what let both shells carry the same wrong
 * biber flag for as long as they did: every string it looked for was present,
 * and the extra one nobody looked for was the bug. Extracting the vec! bodies
 * and comparing them as sequences is the version that fails when they diverge.
 */
function rustArgv() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tauri', 'src', 'tex_run.rs'), 'utf8');
  const body = /fn argv_for\([\s\S]*?\n}/.exec(src);
  assert.ok(body, 'argv_for could not be located in tex_run.rs');

  const out = {};
  // `"pdflatex" | "xelatex" | "lualatex" => vec![ … ],` and the single-tool arms.
  for (const arm of body[0].matchAll(/((?:"[a-z]+"\s*\|\s*)*"[a-z]+")\s*=>\s*vec!\[([\s\S]*?)\],\n/g)) {
    const tools = [...arm[1].matchAll(/"([a-z]+)"/g)].map(m => m[1]);
    const items = arm[2]
      .split('\n')
      .map(l => l.replace(/\/\/.*$/, '').trim())      // drop comment lines
      .join(' ')
      .split(/,(?![^{]*\})/)                           // commas, not the ones in format!{}
      .map(s => s.trim())
      .filter(Boolean)
      // `"-flag".into()` → -flag ·  `format!("./{main_file}")` → ./{main_file}
      // `stem` stays as the bare word, which the JS side is normalised to match.
      .map(s => {
        const lit = /^"((?:[^"\\]|\\.)*)"\s*(?:\.into\(\))?$/.exec(s);
        if (lit) return lit[1];
        const fmt = /^format!\("((?:[^"\\]|\\.)*)"\)$/.exec(s);
        if (fmt) return fmt[1];
        return s;
      });
    for (const t of tools) out[t] = items;
  }
  return out;
}

test('argv matches the Rust implementation exactly', () => {
  // The two shells must build identical command lines, or a document that
  // compiles in one fails in the other for reasons no user could diagnose.
  const rust = rustArgv();

  // Placeholders, so the two sides are compared as shapes rather than as one
  // particular filename. `main.tex` at the root makes stem and basename agree.
  const MAIN = 'main.tex', STEM = 'main';
  const normalise = (a) => a.map(s => s
    .replace(`./${MAIN}`, './{main_file}')
    .replace(new RegExp(`^${STEM}$`), 'stem')
    .replace(new RegExp(`^${STEM}\\.idx$`), '{stem}.idx'));

  for (const tool of tex.ALLOWED) {
    assert.ok(rust[tool], `Rust argv_for has no arm for ${tool}`);
    assert.deepEqual(normalise(tex.argvFor(tool, MAIN)), rust[tool],
      `argv for ${tool} differs between the shells`);
  }
});

test('the Rust allowlist holds exactly the same names', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tauri', 'src', 'tex_run.rs'), 'utf8');
  const decl = /const ALLOWED[^=]*=\s*&?\[([\s\S]*?)\]/.exec(src);
  assert.ok(decl, 'ALLOWED could not be located in tex_run.rs');
  const names = [...decl[1].matchAll(/"([a-z0-9]+)"/g)].map(m => m[1]);
  // deepEqual, not "includes": a program added to one shell and not the other
  // is exactly as bad as one missing from both.
  assert.deepEqual(names, tex.ALLOWED);
  assert.ok(!names.includes('latexmk'), 'latexmk executes latexmkrc as Perl');
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

test('a real compile writes the synctex file the app reads', { skip: !HAVE_TEX }, async () => {
  // The unit above proves the flag is in argv. This proves the flag does what
  // the app assumes: without it TeX Live writes nothing and click-to-source is
  // dead, which is exactly how it shipped.
  const root = tmpdir('synctex');
  fs.writeFileSync(path.join(root, 'main.tex'),
    '\\documentclass{article}\\begin{document}Hello\\end{document}');
  const r = await tex.runTool('pdflatex', 'main.tex', root, 120);
  assert.equal(r.code, 0, r.stdout.slice(-800));
  assert.ok(fs.existsSync(path.join(root, 'main.synctex.gz'))
         || fs.existsSync(path.join(root, 'main.synctex')),
    'no synctex file — -synctex=1 is missing or was ignored');
  fs.rmSync(root, { recursive: true, force: true });
});

test('biber actually runs on a biblatex document', { skip: !HAVE_BIBER }, async () => {
  // The regression this exists for: biber was invoked with a flag it does not
  // have, so it printed usage and exited non-zero on every document. Nothing
  // caught it, because no test had ever run biber.
  const root = tmpdir('biber');
  fs.writeFileSync(path.join(root, 'refs.bib'),
    '@book{knuth84,\n  author = {Knuth, Donald E.},\n  title = {The {\\TeX}book},\n' +
    '  publisher = {Addison-Wesley},\n  year = {1984}\n}\n');
  fs.writeFileSync(path.join(root, 'main.tex'),
    '\\documentclass{article}\n\\usepackage[backend=biber]{biblatex}\n' +
    '\\addbibresource{refs.bib}\n\\begin{document}\n' +
    'See \\cite{knuth84}.\n\\printbibliography\n\\end{document}\n');

  const first = await tex.runTool('pdflatex', 'main.tex', root, 120);
  assert.equal(first.code, 0, first.stdout.slice(-800));
  assert.ok(fs.existsSync(path.join(root, 'main.bcf')), 'biblatex wrote no .bcf');

  const bib = await tex.runTool('biber', 'main.tex', root, 120);
  assert.equal(bib.code, 0,
    `biber exited ${bib.code}: ${(bib.stdout + bib.stderr).slice(-500)}`);
  assert.doesNotMatch(bib.stdout + bib.stderr, /Unknown option/,
    'biber rejected an argument — argv carries a flag it does not have');
  assert.ok(fs.existsSync(path.join(root, 'main.bbl')), 'biber produced no .bbl');

  await tex.runTool('pdflatex', 'main.tex', root, 120);
  const log = fs.readFileSync(path.join(root, 'main.log'), 'utf8');
  assert.doesNotMatch(log, /Citation 'knuth84' (on page \d+ )?undefined/,
    'the citation never resolved — the bibliography did not build');
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
