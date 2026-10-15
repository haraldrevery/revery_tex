// Every directory walk skips the same folders.
//
// There are three: fs_core.js (Electron), main.rs (Tauri) and native_api_web.js
// (Chromium's File System Access). Only the browser one used to skip
// `node_modules`, so the same project opened as a few dozen files in Chrome and
// as tens of thousands — each read into memory — on the desktop. The rule cannot
// be shared code, since one twin is Rust, so all three are held to one list
// instead: this file checks the two JavaScript ones, and main.rs's tests read
// the same JSON for its own.

const { test } = require('node:test');
const assert = require('node:assert');
const core = require('../electron/fs_core.js');
const CASES = require('./walk_skip_cases.json');

let _web;
const web = async () => (_web ??= await import('../www/jvscrpt_and_css_extra/native_api_web.js'));

for (const [label, skippedDir] of [
  ['fs_core.js', async () => core.skippedDir],
  ['native_api_web.js', async () => (await web()).skippedDir]
]) {
  test(`${label} skips exactly the folders on the shared list`, async () => {
    const skip = await skippedDir();
    for (const name of CASES.skipped) assert.equal(skip(name), true, `${name} should be skipped`);
    for (const name of CASES.kept) assert.equal(skip(name), false, `${name} should be walked`);
  });
}
