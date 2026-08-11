// Loads the MiniLZ4 codec out of the engine's own busytex.js.
//
// The .data bundles are Emscripten -sLZ4 packages: a 2048-byte-chunked stream
// where each chunk is either LZ4-block-compressed or stored raw. Rather than
// vendoring a separate LZ4 implementation and hoping the framing matches, we
// extract the exact codec the runtime uses. That makes the repacker
// bit-compatible with the engine by construction, and it cannot drift when the
// engine is upgraded.
//
// MiniLZ4 is MIT (based on node-lz4, Copyright (c) 2012 Pierre Curto).

const fs = require('fs');

const START = 'LZ4.codec = (() => {';
const END = 'return MiniLZ4;';

function loadCodec(busytexJsPath) {
  const js = fs.readFileSync(busytexJsPath, 'utf8');

  const s = js.indexOf(START);
  if (s === -1) throw new Error(`MiniLZ4 codec not found in ${busytexJsPath}`);

  // The codec is an IIFE assigned to LZ4.codec; take from the arrow function
  // through the last `return MiniLZ4;` and close it ourselves.
  const bodyStart = js.indexOf('{', s + 'LZ4.codec = (()'.length);
  const lastReturn = js.indexOf(END, s);
  if (lastReturn === -1) throw new Error('MiniLZ4 tail not found');
  const bodyEnd = js.indexOf(';', lastReturn) + 1;

  const source = js.slice(bodyStart + 1, bodyEnd);

  // The codec body calls assert() and console.log(); supply both.
  const factory = new Function(
    'assert', 'console', 'module',
    `${source}\nreturn MiniLZ4;`
  );

  const quietConsole = { log() {}, warn() {}, error: console.error };
  const codec = factory(
    (cond, msg) => { if (!cond) throw new Error('MiniLZ4 assert: ' + (msg || '')); },
    quietConsole,
    { exports: {} }
  );

  if (typeof codec.uncompress !== 'function' || typeof codec.compressPackage !== 'function') {
    throw new Error('MiniLZ4 extracted but missing uncompress/compressPackage');
  }
  return codec;
}

module.exports = { loadCodec };
