// The two desktop shells must offer the same methods.
//
// Callers feature-detect by method presence — `if (NativeAPI.openFolder)`, never
// a check on which shell is running — which is what lets a browser backend omit
// what it cannot do. The cost of that design is that a method added to one
// desktop shell and forgotten in the other is invisible: the row simply never
// appears there, on someone else's machine, with nothing logged.
//
// Nothing caught that before this file existed. It is a source parse rather than
// an import because native_api.js picks its backend at module scope from globals
// that only exist inside a real shell.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'www', 'jvscrpt_and_css_extra', 'native_api.js'), 'utf8');

/**
 * The source with every comment and string *body* blanked, keeping length and
 * newlines so offsets and line numbers still line up.
 *
 * Needed before counting a single brace. The first version of this file stripped
 * `//` comments with a regex, which cut
 * `listen('revery-tex://close-requested', handler)` in half at the `//` inside
 * the string — leaving an unclosed paren that threw the depth off for the rest
 * of the file and silently truncated tauriImpl to two thirds of its methods.
 * A parser that does not know what a string is cannot be trusted with a brace.
 */
function blanked(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i], next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      out += '  '; i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      // Quotes are kept so a key's shape is unchanged; only the contents go.
      out += c; i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      out += c; i++;
    } else {
      out += c; i++;
    }
  }
  return out;
}

const CLEAN = blanked(SRC);

/**
 * The method names one `const <name>Impl = … { … }` literal defines.
 *
 * Brace-counted from the opening `{` rather than regex-matched to the end,
 * because the bodies contain braces of their own — an arrow function's, an
 * inline argument object's — and a lazy match stops at the first one.
 */
function methodsOf(implName) {
  const start = CLEAN.indexOf(`const ${implName} =`);
  assert.ok(start >= 0, `${implName} not found`);
  const open = CLEAN.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < CLEAN.length; i++) {
    if (CLEAN[i] === '{') depth++;
    else if (CLEAN[i] === '}' && --depth === 0) { end = i; break; }
  }
  assert.ok(end > open, `${implName} is not brace-balanced`);

  // Keys at the literal's own depth only: a nested object's keys are not
  // methods of this backend.
  const names = new Set();
  let d = 0;
  for (const line of CLEAN.slice(open + 1, end).split('\n')) {
    if (d === 0) {
      const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
      if (m) names.add(m[1]);
    }
    for (const ch of line) {
      if (ch === '{' || ch === '[' || ch === '(') d++;
      else if (ch === '}' || ch === ']' || ch === ')') d--;
    }
  }
  return names;
}

// Present on Tauri and deliberately absent on Electron: that shell intercepts
// its own close in the main process and asks with a native dialog, so defining
// the listener too would ask twice. The guard in revery_tex_app.js requires both
// onCloseRequested and closeWindow, which is what makes the omission work.
const ALLOWED_DIVERGENCE = new Set(['onCloseRequested']);

test('the two desktop backends expose the same methods', () => {
  const tauri = methodsOf('tauriImpl');
  const electron = methodsOf('electronImpl');
  assert.ok(tauri.size > 15, `only ${tauri.size} keys parsed — the parse is wrong`);

  const missingFromElectron = [...tauri].filter(k => !electron.has(k) && !ALLOWED_DIVERGENCE.has(k));
  const missingFromTauri = [...electron].filter(k => !tauri.has(k) && !ALLOWED_DIVERGENCE.has(k));

  assert.deepEqual(missingFromElectron, [],
    'on Tauri but not Electron — add it there, or document it in ALLOWED_DIVERGENCE');
  assert.deepEqual(missingFromTauri, [],
    'on Electron but not Tauri — add it there, or document it in ALLOWED_DIVERGENCE');
});

// The divergence list is an escape hatch, and an escape hatch nobody prunes
// stops being one. If the reason disappears, so should the entry.
test('every documented divergence is still a real one', () => {
  const tauri = methodsOf('tauriImpl');
  const electron = methodsOf('electronImpl');
  for (const k of ALLOWED_DIVERGENCE) {
    assert.notEqual(tauri.has(k), electron.has(k),
      `${k} is no longer divergent — drop it from ALLOWED_DIVERGENCE`);
  }
});

// Every desktop method needs a transport, and Electron's is a preload bridge
// that is easy to forget: the impl calls window.electronAPI.x, and if x is not
// exposed the call is a TypeError at click time rather than a missing row.
test('every Electron method the impl calls is exposed by the preload bridge', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  const called = [...CLEAN.matchAll(/window\.electronAPI\.([\w$]+)/g)].map(m => m[1]);
  assert.ok(called.length > 15, `only ${called.length} bridge calls found`);
  for (const name of new Set(called)) {
    assert.match(preload, new RegExp(`\\b${name}\\s*:`), `preload.js does not expose ${name}`);
  }
});

// The mirror image: a browser has no folder to show, so the method must be
// absent there rather than present and throwing.
test('the browser backends do not claim to open a folder', () => {
  // webImpl by its own keys, not by grepping native_api.js — the desktop impls
  // live in that same file and would match.
  assert.ok(!methodsOf('webImpl').has('openContainingFolder'),
    'webImpl must not define openContainingFolder');

  for (const file of ['native_api_web.js', 'native_api_zip.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'www', 'jvscrpt_and_css_extra', file), 'utf8');
    assert.ok(!/openContainingFolder/.test(src),
      `${file} must not define openContainingFolder`);
  }
});
