// Both desktop shells are wired end to end: every call the renderer makes has
// something listening on the other side, with the arguments it expects.
//
// native_api_parity.test.js holds the two shells to the same *method names*.
// It cannot see one layer down, where each shell can fail on its own:
//
//   - Electron: preload.js sends on a channel, main.js must `handle()` it. A
//     missing handler rejects at click time with "No handler registered".
//   - Tauri: native_api.js invokes a command, main.rs must register it in
//     `generate_handler!` *and* receive the argument names it is sent. Tauri
//     maps the renderer's camelCase keys onto the command's snake_case
//     parameters, so `{ mainFile }` must meet `main_file`; a mismatch is a
//     runtime "missing required key" that no other test here would notice.
//
// A source parse, like the parity test, because both shells only load inside
// their real runtime.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

/** Split on commas at nesting depth zero — `State<'_, RootPath>` is one piece. */
function splitTopLevel(src) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of src) {
    if ('(<[{'.includes(ch)) depth++;
    else if (')>]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

const snake = (s) => s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);

/* ── Electron ─────────────────────────────────────────────────────────── */

test('every Electron channel the preload sends on has a handler, and none is orphaned', () => {
  const sent = new Set([...read('electron', 'preload.js').matchAll(/call\('([^']+)'/g)].map(m => m[1]));
  const handled = new Set([...read('electron', 'main.js').matchAll(/handle\('([^']+)'/g)].map(m => m[1]));
  assert.ok(sent.size > 15, `only ${sent.size} channels parsed — the parse is wrong`);
  assert.deepEqual([...sent].filter(c => !handled.has(c)), [], 'sent on, but nothing handles it');
  assert.deepEqual([...handled].filter(c => !sent.has(c)), [], 'handled, but nothing sends on it');
});

/* ── Tauri ────────────────────────────────────────────────────────────── */

/** `invoke('name', { a, b: x })` → Map(name → [argument keys]). */
function invokes() {
  const src = read('www', 'jvscrpt_and_css_extra', 'native_api.js');
  const out = new Map();
  for (const m of src.matchAll(/invoke\('([a-z_]+)'(?:,\s*\{([^}]*)\})?\)/g)) {
    const keys = m[2] === undefined ? [] :
      splitTopLevel(m[2]).map(part => /^([A-Za-z_$][\w$]*)/.exec(part)[1]);
    out.set(m[1], keys);
  }
  return out;
}

// Parameters Tauri injects itself rather than reading from the invoke payload.
const INJECTED = /^(tauri::)?(State|AppHandle|Window|WebviewWindow|Webview)\b/;

/** Every `#[tauri::command]` fn → its payload parameters, and which are optional. */
function commands() {
  const src = read('tauri', 'src', 'main.rs');
  const out = new Map();
  for (const m of src.matchAll(/#\[tauri::command[^\]]*\]\s*(?:async\s+)?fn\s+([a-z_]+)\s*\(/g)) {
    let depth = 1, i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    const params = splitTopLevel(src.slice(start, i - 1)).map((p) => {
      const [name, ...type] = p.split(':');
      return { name: name.trim(), type: type.join(':').trim() };
    }).filter(p => !INJECTED.test(p.type));
    out.set(m[1], params);
  }
  return out;
}

function registered() {
  const src = read('tauri', 'src', 'main.rs');
  const list = /generate_handler!\[([\s\S]*?)\]/.exec(src);
  assert.ok(list, 'generate_handler! could not be located');
  return new Set(list[1].split(',').map(s => s.trim()).filter(Boolean));
}

test('every Tauri command the renderer invokes is registered, and none is orphaned', () => {
  const called = invokes();
  const reg = registered();
  assert.ok(called.size > 15, `only ${called.size} invokes parsed — the parse is wrong`);
  assert.deepEqual([...called.keys()].filter(c => !reg.has(c)), [],
    'invoked, but not in generate_handler! — "command not found", on Tauri only');
  assert.deepEqual([...reg].filter(c => !called.has(c)), [],
    'registered, but nothing in the renderer invokes it');
});

test('every Tauri invoke sends exactly the arguments its command takes', () => {
  const called = invokes();
  const cmds = commands();
  const problems = [];
  for (const [name, keys] of called) {
    const params = cmds.get(name);
    if (!params) { problems.push(`${name}: no #[tauri::command] fn of that name`); continue; }
    const sent = new Set(keys.map(snake));
    for (const k of sent) {
      if (!params.some(p => p.name === k)) problems.push(`${name}: sends ${k}, which the command does not take`);
    }
    for (const p of params) {
      if (!sent.has(p.name) && !/^Option</.test(p.type)) {
        problems.push(`${name}: never sends ${p.name}, which is required`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
