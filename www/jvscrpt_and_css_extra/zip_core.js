// Zip reader and writer. No dependencies.
//
// Firefox and Safari have no File System Access API, so a zip is the only way
// to get a project in and out of those browsers. Rather than pull in a zip
// library, this uses `CompressionStream('deflate-raw')`, which every browser
// that matters has had since 2023 — and which Node has too, so the whole thing
// is unit-testable and checked against the system `zip`/`unzip` for interop.
//
// Two decisions worth knowing:
//
// 1. **Entries are read from the central directory, not by scanning local
//    headers.** Streamed zips set flag bit 3 and write zeros for the sizes in
//    the local header, putting the real values in a trailing data descriptor.
//    A local-header scan reads those zeros and produces empty files. The
//    central directory always has the true values.
// 2. **Every entry's CRC is verified.** A silently truncated file is exactly
//    the sort of corruption that shows up later as an incomprehensible TeX
//    error, and the check costs microseconds.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;

const U32_MAX = 0xffffffff;

/* ── CRC-32 ──────────────────────────────────────────────────────────── */

let CRC_TABLE = null;

export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ── deflate ─────────────────────────────────────────────────────────── */

export const deflateSupported = typeof CompressionStream !== 'undefined';
export const inflateSupported = typeof DecompressionStream !== 'undefined';

async function through(bytes, stream) {
  if (bytes.length === 0) return new Uint8Array(0);
  const body = new Response(bytes.slice()).body.pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

const deflateRaw = (b) => through(b, new CompressionStream('deflate-raw'));
const inflateRaw = (b) => through(b, new DecompressionStream('deflate-raw'));

/* ── reading ─────────────────────────────────────────────────────────── */

/** The EOCD is at the end, but a trailing comment can push it up to 64 KB back. */
function findEocd(dv, len) {
  const earliest = Math.max(0, len - 22 - 0xffff);
  for (let p = len - 22; p >= earliest; p--) {
    if (dv.getUint32(p, true) === SIG_EOCD) return p;
  }
  throw new Error('Not a zip file (no end-of-central-directory record)');
}

function locateCentralDirectory(dv, len) {
  const eocd = findEocd(dv, len);
  let entries = dv.getUint16(eocd + 10, true);
  let offset = dv.getUint32(eocd + 16, true);

  // Zip64 only appears past 65535 entries or 4 GB, which no LaTeX project
  // reaches — but zips are sometimes produced by tools that use it anyway, and
  // failing on those with "not a zip file" would be a lie.
  if (entries === 0xffff || offset === U32_MAX) {
    const loc = eocd - 20;
    if (loc >= 0 && dv.getUint32(loc, true) === SIG_EOCD64_LOC) {
      const rec = Number(dv.getBigUint64(loc + 8, true));
      if (rec < 0 || rec + 56 > len || dv.getUint32(rec, true) !== SIG_EOCD64) {
        throw new Error('Damaged zip: the zip64 record is not where the locator says it is');
      }
      entries = Number(dv.getBigUint64(rec + 32, true));
      offset = Number(dv.getBigUint64(rec + 48, true));
    }
  }
  return { entries, offset };
}

/**
 * The zip64 extended-information extra field carries only those fields that
 * were 0xFFFFFFFF in the fixed header, in a fixed order and with no markers.
 * Which ones are present is therefore inferred from which overflowed.
 */
function readZip64Extra(dv, start, len, want) {
  const end = start + len;
  for (let p = start; p + 4 <= end;) {
    const id = dv.getUint16(p, true);
    const size = dv.getUint16(p + 2, true);
    if (id === 0x0001) {
      let q = p + 4;
      const out = {};
      if (want.uncompressed && q + 8 <= end) { out.uncompressed = Number(dv.getBigUint64(q, true)); q += 8; }
      if (want.compressed && q + 8 <= end) { out.compressed = Number(dv.getBigUint64(q, true)); q += 8; }
      if (want.offset && q + 8 <= end) { out.offset = Number(dv.getBigUint64(q, true)); q += 8; }
      return out;
    }
    p += 4 + size;
  }
  return {};
}

/**
 * Parse a zip.
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {Promise<Array<{path: string, bytes: Uint8Array}>>} files, no directories
 */
export async function readZip(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8.byteLength < 22) throw new Error('Not a zip file (too small)');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const { entries, offset } = locateCentralDirectory(dv, u8.byteLength);

  const out = [];
  let p = offset;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > u8.byteLength || dv.getUint32(p, true) !== SIG_CENTRAL) {
      throw new Error(`Damaged zip: central directory entry ${i + 1} of ${entries} is not where it should be`);
    }
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    let compressed = dv.getUint32(p + 20, true);
    let uncompressed = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));

    if (compressed === U32_MAX || uncompressed === U32_MAX || local === U32_MAX) {
      const z = readZip64Extra(dv, p + 46 + nameLen, extraLen, {
        uncompressed: uncompressed === U32_MAX,
        compressed: compressed === U32_MAX,
        offset: local === U32_MAX
      });
      if (z.uncompressed !== undefined) uncompressed = z.uncompressed;
      if (z.compressed !== undefined) compressed = z.compressed;
      if (z.offset !== undefined) local = z.offset;
    }
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;                       // directory marker
    if (flags & 0x0001) {
      throw new Error(`"${name}" is encrypted — Revery TeX cannot open password-protected zips`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`"${name}" uses compression method ${method}; only stored and deflate are supported`);
    }
    if (method === 8 && !inflateSupported) {
      throw new Error('This browser cannot decompress zips (no DecompressionStream)');
    }

    // The local header's name and extra lengths can differ from the central
    // directory's, so the data offset must be computed from the local header.
    if (local + 30 > u8.byteLength || dv.getUint32(local, true) !== SIG_LOCAL) {
      throw new Error(`Damaged zip: "${name}" does not start where the directory says`);
    }
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    if (start + compressed > u8.byteLength) throw new Error(`Damaged zip: "${name}" is truncated`);
    const raw = u8.subarray(start, start + compressed);

    const bytes = method === 0 ? raw.slice() : await inflateRaw(raw);
    if (bytes.length !== uncompressed) {
      throw new Error(`Damaged zip: "${name}" is ${bytes.length} bytes, the directory says ${uncompressed}`);
    }
    if (crc32(bytes) !== crc) throw new Error(`"${name}" failed its checksum — the zip is damaged`);

    out.push({ path: name, bytes });
  }
  return out;
}

/* ── writing ─────────────────────────────────────────────────────────── */

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    date: (((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff
  };
}

/**
 * Build a zip.
 *
 * Each entry is stored uncompressed when deflate does not actually shrink it,
 * which is common for the PNGs and PDFs in a LaTeX project and avoids spending
 * time to make the file bigger.
 *
 * @param {Array<{path: string, bytes: Uint8Array|string}>} files
 * @param {Date} [now] fixed clock, so tests can produce identical output
 * @returns {Promise<Uint8Array>}
 */
export async function writeZip(files, now = new Date()) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = enc.encode(file.path);
    const data = typeof file.bytes === 'string' ? enc.encode(file.bytes) : file.bytes;
    if (data.length > U32_MAX) throw new Error(`"${file.path}" is too large for a zip file`);

    let method = 0;
    let payload = data;
    if (data.length > 0 && deflateSupported) {
      const packed = await deflateRaw(data);
      if (packed.length < data.length) { method = 8; payload = packed; }
    }
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, SIG_LOCAL, true);
    local.setUint16(4, 20, true);          // version needed
    local.setUint16(6, 0x0800, true);      // names are UTF-8
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, payload.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, payload);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, SIG_CENTRAL, true);
    cd.setUint16(4, 0x031e, true);         // made by Unix, so the mode below is honoured
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, method, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, payload.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(38, 0o100644 << 16, true);   // regular file, rw-r--r--
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);

    offset += 30 + name.length + payload.length;
    if (offset > U32_MAX) throw new Error('Project is too large for a zip file');
  }

  const cdOffset = offset;
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, SIG_EOCD, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdOffset, true);

  const all = [...chunks, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
}

/* ── turning zip entries into a project ──────────────────────────────── */

const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/;

/**
 * Clean and reroot the paths from a zip.
 *
 * Zips of a project almost always wrap it in a folder, so `main.tex` arrives as
 * `thesis/main.tex`. Left alone, every `\input{chapters/one}` in the document
 * would resolve against the wrong root. A single shared leading directory is
 * therefore stripped.
 *
 * Names are also rejected if they climb out of the archive. Nothing here writes
 * to a real filesystem, so this is not the zip-slip hole it would be in a CLI
 * unzipper — but a path like `../../x` would still collide across projects in
 * the store, and there is no legitimate reason for one.
 */
export function normalizeZipEntries(entries) {
  const kept = [];
  for (const e of entries) {
    if (JUNK.test(e.path)) continue;
    const path = e.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (path === '' || /(^|\/)\.\.(\/|$)/.test(path) || /^[a-zA-Z]:/.test(path)) {
      throw new Error(`"${e.path}" points outside the archive; refusing to import it`);
    }
    kept.push({ path, bytes: e.bytes });
  }
  if (!kept.length) return kept;

  const first = kept[0].path;
  const slash = first.indexOf('/');
  if (slash <= 0) return kept;
  const root = first.slice(0, slash + 1);
  if (!kept.every(e => e.path.startsWith(root))) return kept;
  return kept.map(e => ({ path: e.path.slice(root.length), bytes: e.bytes }));
}
