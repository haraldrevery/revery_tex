// Zip reader/writer. The tests that matter are the interop ones: a zip only we
// can read would be useless, and a reader that only handles our own output
// would fail on the first archive a user actually has.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const load = () => import('../www/jvscrpt_and_css_extra/zip_core.js');

let n = 0;
const tmpdir = (tag) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `revery-zip-${tag}-${n++}-`)));

function have(cmd) {
  try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAVE_ZIP = have('zip');
const HAVE_UNZIP = have('unzip');

const text = (s) => new TextEncoder().encode(s);
const str = (b) => new TextDecoder().decode(b);

test('crc32 matches the known check value', async () => {
  const { crc32 } = await load();
  assert.equal(crc32(text('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('round-trips text, binary and empty files', async () => {
  const { writeZip, readZip } = await load();
  const binary = new Uint8Array(1024);
  for (let i = 0; i < binary.length; i++) binary[i] = (i * 37) & 0xff;

  const zip = await writeZip([
    { path: 'main.tex', bytes: text('\\documentclass{article}\n\\begin{document}hi\\end{document}\n') },
    { path: 'chapters/one.tex', bytes: text('chapter one') },
    { path: 'img/logo.png', bytes: binary },
    { path: 'empty.txt', bytes: new Uint8Array(0) }
  ]);

  const back = await readZip(zip);
  assert.deepEqual(back.map(e => e.path), ['main.tex', 'chapters/one.tex', 'img/logo.png', 'empty.txt']);
  assert.match(str(back[0].bytes), /documentclass/);
  assert.deepEqual(back[2].bytes, binary);
  assert.equal(back[3].bytes.length, 0);
});

test('compressible content is deflated, incompressible content is stored', async () => {
  const { writeZip, readZip } = await load();
  const repetitive = text('x'.repeat(10000));
  const random = new Uint8Array(4096);
  for (let i = 0; i < random.length; i++) random[i] = Math.floor(Math.random() * 256);

  const zip = await writeZip([{ path: 'a.txt', bytes: repetitive }, { path: 'b.bin', bytes: random }]);
  // Deflate must have paid off on one and been declined on the other.
  assert.ok(zip.length < repetitive.length + random.length, 'total should be smaller than raw');
  assert.ok(zip.length > random.length, 'random data cannot have shrunk');

  const back = await readZip(zip);
  assert.deepEqual(back[0].bytes, repetitive);
  assert.deepEqual(back[1].bytes, random);
});

test('a damaged file is caught rather than silently truncated', async () => {
  const { writeZip, readZip } = await load();
  const zip = await writeZip([{ path: 'main.tex', bytes: text('important content here') }]);
  // Flip a byte in the payload, which starts right after the local header.
  const corrupt = zip.slice();
  corrupt[30 + 'main.tex'.length + 2] ^= 0xff;
  await assert.rejects(() => readZip(corrupt), /checksum|damaged|incorrect/i);
});

test('rejects input that is not a zip', async () => {
  const { readZip } = await load();
  await assert.rejects(() => readZip(text('this is a plain text file, not an archive at all')), /not a zip/i);
  await assert.rejects(() => readZip(new Uint8Array(4)), /not a zip/i);
});

/* ── interop: the tests this file exists for ──────────────────────────── */

test('unzip reads what we write', { skip: !HAVE_UNZIP }, async () => {
  const { writeZip } = await load();
  const dir = tmpdir('ours');
  const zipPath = path.join(dir, 'p.zip');

  fs.writeFileSync(zipPath, await writeZip([
    { path: 'main.tex', bytes: text('\\documentclass{article}\n') },
    { path: 'chapters/one.tex', bytes: text('one') },
    { path: 'big.txt', bytes: text('y'.repeat(50000)) }
  ]));

  // -t is unzip's own integrity check: signatures, CRCs, the lot.
  const tested = execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
  assert.match(tested, /No errors detected/);

  execFileSync('unzip', ['-q', zipPath, '-d', path.join(dir, 'out')]);
  assert.equal(fs.readFileSync(path.join(dir, 'out/main.tex'), 'utf8'), '\\documentclass{article}\n');
  assert.equal(fs.readFileSync(path.join(dir, 'out/chapters/one.tex'), 'utf8'), 'one');
  assert.equal(fs.readFileSync(path.join(dir, 'out/big.txt'), 'utf8').length, 50000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('we read what zip writes', { skip: !HAVE_ZIP }, async () => {
  const { readZip } = await load();
  const dir = tmpdir('theirs');
  fs.mkdirSync(path.join(dir, 'proj/chapters'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'proj/main.tex'), '\\documentclass{book}\n');
  fs.writeFileSync(path.join(dir, 'proj/chapters/one.tex'), 'z'.repeat(30000));
  fs.writeFileSync(path.join(dir, 'proj/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]));

  execFileSync('zip', ['-q', '-r', '../p.zip', '.'], { cwd: path.join(dir, 'proj') });
  const entries = await readZip(fs.readFileSync(path.join(dir, 'p.zip')));
  const byPath = new Map(entries.map(e => [e.path, e.bytes]));

  assert.equal(str(byPath.get('main.tex')), '\\documentclass{book}\n');
  assert.equal(byPath.get('chapters/one.tex').length, 30000);
  assert.deepEqual([...byPath.get('logo.png')], [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
  // Directory entries are dropped, not surfaced as zero-byte files.
  assert.ok(![...byPath.keys()].some(p => p.endsWith('/')), `directories leaked: ${[...byPath.keys()]}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A one-entry zip in streamed form: flag bit 3 set, zeros for the crc and both
 * sizes in the local header, and the real values in a trailing data descriptor.
 *
 * Built by hand rather than with `zip`, because Info-ZIP buffers through a temp
 * file and can therefore seek back to patch the local header — so it never
 * produces this shape. Tools that write straight to a socket or stdout do
 * (Java's jar, most server-side zip streamers, GitHub's archive downloads), and
 * a reader that scans local headers turns every one of their files into an
 * empty one. Silently.
 */
function streamedZip(name, content, crc32) {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const data = enc.encode(content);
  const crc = crc32(data);

  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(6, 0x0008, true);       // sizes follow the data, not here
  local.setUint16(26, nameBytes.length, true);
  // crc, compressed and uncompressed size are all left as zero on purpose.

  const desc = new DataView(new ArrayBuffer(16));
  desc.setUint32(0, 0x08074b50, true);
  desc.setUint32(4, crc, true);
  desc.setUint32(8, data.length, true);
  desc.setUint32(12, data.length, true);

  const cd = new DataView(new ArrayBuffer(46));
  cd.setUint32(0, 0x02014b50, true);
  cd.setUint16(4, 20, true);
  cd.setUint16(6, 20, true);
  cd.setUint16(8, 0x0008, true);
  cd.setUint32(16, crc, true);
  cd.setUint32(20, data.length, true);
  cd.setUint32(24, data.length, true);
  cd.setUint16(28, nameBytes.length, true);

  const cdSize = 46 + nameBytes.length;
  const cdOffset = 30 + nameBytes.length + data.length + 16;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, 1, true);
  eocd.setUint16(10, 1, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdOffset, true);

  const parts = [new Uint8Array(local.buffer), nameBytes, data, new Uint8Array(desc.buffer),
                 new Uint8Array(cd.buffer), nameBytes, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

test('reads a streamed zip, where the local header carries no sizes', async () => {
  const { readZip, crc32 } = await load();
  const zip = streamedZip('main.tex', 'streamed content\n', crc32);

  // The local header says zero bytes; the central directory says 17. Reading
  // the former is how this becomes an empty file with no error anywhere.
  assert.equal(new DataView(zip.buffer).getUint32(22, true), 0, 'local header must claim zero');

  const entries = await readZip(zip);
  assert.equal(entries.length, 1);
  assert.equal(str(entries[0].bytes), 'streamed content\n');
});

test('reads a zip with a trailing comment', { skip: !HAVE_ZIP }, async () => {
  const { readZip } = await load();
  const dir = tmpdir('comment');
  fs.writeFileSync(path.join(dir, 'main.tex'), 'commented\n');
  execFileSync('zip', ['-q', 'p.zip', 'main.tex'], { cwd: dir });
  execFileSync('sh', ['-c', 'echo "a comment that sits after the EOCD" | zip -z p.zip'], { cwd: dir });

  const entries = await readZip(fs.readFileSync(path.join(dir, 'p.zip')));
  assert.equal(str(entries[0].bytes), 'commented\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ── path handling ───────────────────────────────────────────────────── */

test('strips the wrapper directory a zip almost always has', async () => {
  const { normalizeZipEntries } = await load();
  const out = normalizeZipEntries([
    { path: 'thesis/main.tex', bytes: text('a') },
    { path: 'thesis/chapters/one.tex', bytes: text('b') }
  ]);
  assert.deepEqual(out.map(e => e.path), ['main.tex', 'chapters/one.tex']);
});

test('keeps paths when there is no single shared root', async () => {
  const { normalizeZipEntries } = await load();
  const out = normalizeZipEntries([
    { path: 'main.tex', bytes: text('a') },
    { path: 'chapters/one.tex', bytes: text('b') }
  ]);
  assert.deepEqual(out.map(e => e.path), ['main.tex', 'chapters/one.tex']);
});

test('drops archive junk', async () => {
  const { normalizeZipEntries } = await load();
  const out = normalizeZipEntries([
    { path: 'main.tex', bytes: text('a') },
    { path: '__MACOSX/._main.tex', bytes: text('x') },
    { path: '.DS_Store', bytes: text('x') }
  ]);
  assert.deepEqual(out.map(e => e.path), ['main.tex']);
});

test('refuses paths that climb out of the archive', async () => {
  const { normalizeZipEntries } = await load();
  assert.throws(() => normalizeZipEntries([{ path: '../../etc/passwd', bytes: text('x') }]), /outside/);
  assert.throws(() => normalizeZipEntries([{ path: 'a/../../b', bytes: text('x') }]), /outside/);
  assert.throws(() => normalizeZipEntries([{ path: 'C:/windows/x', bytes: text('x') }]), /outside/);
  // A leading slash is stripped rather than refused: it is common and harmless.
  assert.deepEqual(normalizeZipEntries([{ path: '/main.tex', bytes: text('x') }])[0].path, 'main.tex');
});
