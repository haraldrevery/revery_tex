// Reading a LaTeX log — the part the Issues panel turns into clickable rows.
//
// This suite did not exist, which is how the Issues panel shipped jumping to
// the wrong line. Every case below is a shape taken verbatim from a log in
// ../latex_project_tests, because the failures that matter here are all "the
// engine does not print what the regex assumed" and a plausible-looking
// synthetic log proves nothing about that.
//
// The three facts under test that used to be wrong:
//
//   - `l.NNN` is where TeX puts the line an error was reading. It was never
//     read, so on the bundled engine errors had no line and the panel would not
//     link them, while warnings — which say `on input line N` — were linked.
//   - TeX continues its own warnings on a `(pkgname)` line, and wraps the whole
//     log at column 79 when max_print_line is unset. Either one dropped
//     `on input line N` off the end of what the `$`-anchored patterns saw.
//   - The dedupe key omitted `file`, so the same message at the same line in
//     two chapters collapsed to one row.

const { test } = require('node:test');
const assert = require('node:assert');

let _mod;
const mod = async () =>
  (_mod ??= await import('../www/jvscrpt_and_css_extra/latex_log.js'));
const parse = async (log) => (await mod()).parseLatexLog(log);

/** The column pdfTeX flushes at when max_print_line is unset. */
const WRAP = 79;

/**
 * What TeX does to a long line, so the fixtures below are wrapped rather than
 * hand-counted. Hand-counting them is how the first draft of this file got
 * three fixtures wrong while the code under test was right.
 */
function wrapAt79(line) {
  const parts = [];
  for (let i = 0; i < line.length; i += WRAP) parts.push(line.slice(i, i + WRAP));
  return parts.join('\n');
}

test('a clean log yields nothing', async () => {
  assert.deepEqual(await parse(''), []);
  assert.deepEqual(await parse(null), []);
  assert.deepEqual(await parse('Output written on main.pdf (49 pages).'), []);
});

// Verbatim from examensLatexv5/Slutsats.log. The message and its line arrive on
// two separate lines, and the second is indented under the first.
test('an error takes its line from the l.NNN context line below it', async () => {
  const [d, ...rest] = await parse(
    `! Undefined control sequence.
l.1 \\section
            {Conclusion}`);
  assert.equal(rest.length, 0);
  assert.equal(d.severity, 'error');
  assert.equal(d.message, 'Undefined control sequence.');
  // The whole point: without this the row is not clickable at all.
  assert.equal(d.line, 1);
});

test('a context line never attaches to an error two errors up', async () => {
  const found = await parse(
    `! Undefined control sequence.
! Emergency stop.
l.7 \\bye`);
  assert.deepEqual(found.map(d => d.line), [null, 7]);
});

test('l.NNN is never itself parsed as a diagnostic', async () => {
  assert.deepEqual(await parse('l.42 \\section'), []);
});

// Verbatim from examensLatexv5/main.log, where this shape occurs ten times.
// LaTeX continues its own warnings like this at any max_print_line — it is the
// format, not the wrapping — so this case is engine-independent.
test('a (pkgname) continuation still yields the input line', async () => {
  const [d] = await parse(
    `Package hyperref Warning: Token not allowed in a PDF string (PDFDocEncoding):
(hyperref)                removing \`math shift' on input line 99.`);
  assert.equal(d.severity, 'warning');
  assert.equal(d.package, 'hyperref');
  assert.equal(d.line, 99);
  // Joined into one sentence, with the (hyperref) gutter dropped.
  assert.match(d.message, /Token not allowed/);
  assert.match(d.message, /removing `math shift'/);
  assert.doesNotMatch(d.message, /\(hyperref\)/);
});

// The continuation and the dedupe compounded: all of these lost their line, so
// their keys became identical and ten warnings arrived as one row.
test('warnings differing only in their continuation stay separate rows', async () => {
  const found = await parse(
    `Package hyperref Warning: Token not allowed in a PDF string (PDFDocEncoding):
(hyperref)                removing \`math shift' on input line 99.

Package hyperref Warning: Token not allowed in a PDF string (PDFDocEncoding):
(hyperref)                removing \`\\times' on input line 99.

Package hyperref Warning: Token not allowed in a PDF string (PDFDocEncoding):
(hyperref)                removing \`math shift' on input line 133.`);
  assert.equal(found.length, 3);
  assert.deepEqual(found.map(d => d.line), [99, 99, 133]);
});

// A (pkgname) line is not a file-open line. `(./main.tex` has no closing paren
// and `(…/article.cls)` has no run of spaces after one, so neither can be
// mistaken for a continuation and glued onto the diagnostic above.
test('file-open lines are not treated as continuations', async () => {
  const [d] = await parse(
    `LaTeX Warning: Citation \`knuth' undefined on input line 40.
(./chapters/two.tex
(/usr/local/texlive/2024/texmf-dist/tex/latex/base/article.cls)`);
  assert.equal(d.line, 40);
  assert.equal(d.message, "Citation `knuth' undefined");
});

// pdfTeX flushes its log buffer at column 79 when max_print_line is unset,
// which the bundled WASM engine cannot set. Both desktop shells set it to 1000.
test('a warning wrapped at column 79 still yields its input line', async () => {
  const logical =
    "LaTeX Warning: Reference `sec:a-rather-long-label-name-here' on page 1 undefined on input line 40.";
  const wrapped = wrapAt79(logical);
  assert.equal(wrapped.split('\n').length, 2, 'the fixture must actually wrap');
  // The line number falls off the end of the first physical line, which is the
  // whole failure: the row silently stopped being a link.
  assert.doesNotMatch(wrapped.split('\n')[0], /input line 40/);

  const [d] = await parse(wrapped);
  assert.equal(d.severity, 'warning');
  assert.equal(d.line, 40);
});

test('a 79-column line in an unwrapped log does not swallow the next line', async () => {
  // One line longer than the column proves max_print_line is not 79, so the
  // join must not happen — a native log is full of long paths and a
  // coincidental 79-character line in one is just a line.
  const head = 'LaTeX Warning: Citation `';
  const tail = "' undefined on input line 7.";
  const exactly79 = head + 'a'.repeat(WRAP - head.length - tail.length) + tail;
  assert.equal(exactly79.length, WRAP);

  const found = await parse(
    `(/usr/local/texlive/2024/texmf-dist/tex/latex/hyperref/hyperref.sty and some more)
${exactly79}
LaTeX Warning: There were undefined references.`);
  assert.equal(found.length, 2);
  assert.equal(found[0].line, 7);
  assert.match(found[1].message, /undefined references/);
});

test('-file-line-error carries both the file and the line', async () => {
  const [d, ...rest] = await parse(
    `./chapters/two.tex:40: Undefined control sequence.
l.40 \\secton
             {Two}`);
  assert.equal(rest.length, 0);
  assert.equal(d.file, './chapters/two.tex');
  assert.equal(d.line, 40);
  assert.equal(d.message, 'Undefined control sequence.');
});

// The bug that silently lost a real error: same message, same line number, two
// different chapters — sibling chapters share a preamble and a shape, so this
// is likelier than it sounds.
test('the same message at the same line in two files is two rows', async () => {
  const found = await parse(
    `./chapters/one.tex:12: Undefined control sequence.
./chapters/two.tex:12: Undefined control sequence.`);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map(d => d.file), ['./chapters/one.tex', './chapters/two.tex']);
});

test('a diagnostic repeated across passes is still one row', async () => {
  const pass = `LaTeX Warning: Citation \`knuth' undefined on input line 40.`;
  assert.equal((await parse([pass, pass, pass].join('\n'))).length, 1);
});

test('an error satisfying both error patterns produces one row, not two', async () => {
  // `! Undefined Error: x` matched the typed-error pattern *and* the bare-error
  // pattern, and as independent passes that was two rows for one error, with
  // two different messages.
  const found = await parse('! Undefined Error: x');
  assert.equal(found.length, 1);
});

test('diagnostics come out in log order', async () => {
  const found = await parse(
    `LaTeX Warning: first on input line 1.
! Emergency stop.
l.2 \\bye
LaTeX Warning: third on input line 3.`);
  assert.deepEqual(found.map(d => d.message),
    ['first', 'Emergency stop.', 'third']);
});

test('a package error keeps its package name and its line', async () => {
  const [d] = await parse(
    `! Package babel Error: Unknown option \`foo'.
l.5 \\usepackage[foo]{babel}`);
  assert.equal(d.package, 'babel');
  assert.equal(d.severity, 'error');
  assert.equal(d.line, 5);
});

test('a wrapped missing-file line is still named', async () => {
  // The gate's missing-pkg fixture depends on this: the filename is what the
  // Issues panel and the "not in this bundle" message are built from, and at 79
  // columns it can land across the flush.
  const { missingPackages } = await mod();
  // The busytex stdout prefix is what pushes this past the flush column in the
  // real gate log; the same shape appears in engine_limits.test.js. It is
  // padded so the flush lands *inside* `not found` — a break anywhere else
  // leaves the pattern matchable and the fixture proves nothing.
  const msg = "! LaTeX Error: File `pgfornament.sty' not found.";
  const prefix = '/bin/busytex stdout: '.padEnd(WRAP - msg.length + 6, '.');
  const wrapped = wrapAt79(prefix + msg);

  const [first, ...more] = wrapped.split('\n');
  assert.equal(more.length, 1, 'the fixture must actually wrap');
  assert.doesNotMatch(first, /not found/);
  assert.deepEqual(missingPackages(wrapped), ['pgfornament.sty']);
});
