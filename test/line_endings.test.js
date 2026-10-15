// line_endings.js — the buffer is LF, the disk keeps what it had.

const { test } = require('node:test');
const assert = require('node:assert');

let _mod;
const mod = async () => (_mod ??= await import('../www/jvscrpt_and_css_extra/line_endings.js'));

const CRLF_DOC = '\\documentclass{article}\r\n\\begin{document}\r\nx\r\n\\end{document}\r\n';

test('a CRLF file round-trips byte for byte through the buffer form', async () => {
  const { fromDisk, toDisk } = await mod();
  const d = fromDisk(CRLF_DOC);
  assert.equal(d.eol, '\r\n');
  assert.equal(d.mixed, false);
  assert.ok(!d.content.includes('\r'), 'the buffer form must hold no \\r at all');
  assert.equal(toDisk(d.content, d.eol), CRLF_DOC);
});

test('an LF file is left exactly as it is', async () => {
  const { fromDisk, toDisk } = await mod();
  const text = 'a\nb\n';
  const d = fromDisk(text);
  assert.equal(d.eol, '\n');
  assert.equal(d.content, text);
  assert.equal(toDisk(d.content, d.eol), text);
});

test('an edit to a CRLF buffer is written back as CRLF throughout', async () => {
  // The bug: CodeMirror hands back LF, and the save wrote it as-is.
  const { fromDisk, toDisk } = await mod();
  const d = fromDisk(CRLF_DOC);
  const edited = d.content.replace('x\n', 'x\nan added line\n');
  const out = toDisk(edited, d.eol);
  assert.ok(out.includes('an added line\r\n'));
  assert.ok(!/(^|[^\r])\n/.test(out), `a bare LF reached the disk: ${JSON.stringify(out)}`);
});

test('the buffer form is what CodeMirror would hold — lone CRs included', async () => {
  // CodeMirror splits on \r\n, \r and \n alike. Any other buffer form would
  // put our offsets and the editor's out of step past the first break.
  const { toBuffer } = await mod();
  assert.equal(toBuffer('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('a mixed file takes its majority, and says it is mixed', async () => {
  const { detectEol } = await mod();
  assert.deepEqual(detectEol('a\r\nb\r\nc\nd'), { eol: '\r\n', mixed: true });
  assert.deepEqual(detectEol('a\r\nb\nc\nd'), { eol: '\n', mixed: true });
});

test('a tie, and no line breaks at all, are LF', async () => {
  const { detectEol } = await mod();
  assert.equal(detectEol('a\r\nb\nc').eol, '\n');
  assert.deepEqual(detectEol('one line'), { eol: '\n', mixed: false });
  assert.deepEqual(detectEol(''), { eol: '\n', mixed: false });
});

test('a file created in the app, with no eol recorded, is written as LF', async () => {
  const { toDisk } = await mod();
  assert.equal(toDisk('a\nb\n'), 'a\nb\n');
  assert.equal(toDisk('a\nb\n', undefined), 'a\nb\n');
});

test('text that already holds CRLF is not doubled into \\r\\r\\n', async () => {
  const { toDisk } = await mod();
  assert.equal(toDisk('a\r\nb\n', '\r\n'), 'a\r\nb\r\n');
});

test('a byte-order mark is not a line ending and is left alone', async () => {
  // Phase 2 keeps the BOM in the text on purpose.
  const { fromDisk, toDisk } = await mod();
  const text = '\uFEFF\\documentclass{article}\r\n';
  const d = fromDisk(text);
  assert.equal(d.content, '\uFEFF\\documentclass{article}\n');
  assert.equal(toDisk(d.content, d.eol), text);
});
