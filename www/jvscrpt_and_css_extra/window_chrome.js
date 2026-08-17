// The window controls, for a shell that draws no OS title bar.
//
// Both desktop shells run frameless — `frame:false` in electron/main.js and
// `"decorations": false` in tauri/tauri.conf.json — so the Minimize, Maximize
// and Close the operating system used to provide have to come from the page.
// #topbar is the drag handle in their place.
//
// Presence of the methods is the signal, as everywhere else: a browser has no
// `minimizeWindow`, so nothing below runs and #win-controls stays hidden by its
// own default. Nothing here asks which shell it is in.
//
// What is deliberately *not* here: dragging, and double-click-to-maximize. Both
// shells implement both themselves, from the drag region declared in
// index.html and theme.css. A dblclick listener would be a second maximize on
// top of the shell's own, and would toggle straight back.

import { NativeAPI } from './native_api.js';
import { $ } from './dom.js';

/**
 * Wire the three buttons and F11, or do nothing at all.
 *
 * Returns early rather than hiding the buttons on the way out: they start
 * hidden, and revealing them is what `.desktop-app` below is for. A backend
 * that cannot act on them never gets as far as showing them.
 */
export async function initWindowChrome() {
  if (!NativeAPI.minimizeWindow) return;

  document.body.classList.add('desktop-app');

  $('win-min').addEventListener('click', () => NativeAPI.minimizeWindow());
  $('win-max').addEventListener('click', () => NativeAPI.toggleMaximizeWindow());
  // No unsaved-changes question here. Each shell already asks its own way —
  // Electron from `will-prevent-unload` in the main process, Tauri by handing
  // the close back to the frontend guard in revery_tex_app.js — and both are
  // reached by this same call. Asking here as well would ask twice in one and
  // duplicate the wording in the other.
  $('win-close').addEventListener('click', () => NativeAPI.closeWindow());

  // Seeded from the shell rather than assumed false: a window can come up
  // fullscreen (a restored session, a window manager rule), and a flag that
  // started out wrong would hide the controls with no way to bring them back
  // short of pressing F11 twice.
  let full = false;
  try {
    full = !!(await NativeAPI.isFullscreen());
  } catch { /* an older shell without the command; false is the safe guess */ }
  document.body.classList.toggle('is-fullscreen', full);

  // F11, and Escape to leave — the pair every fullscreen viewer has. Not
  // scoped away from text-entry contexts the way Ctrl+S is: F11 means nothing
  // to an editor or an input, so there is nothing to contend with. Escape is,
  // which is why it only acts while actually fullscreen and otherwise falls
  // through to whatever wanted it.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'F11') {
      ev.preventDefault();
      setFullscreen(!full);
    } else if (ev.key === 'Escape' && full) {
      setFullscreen(false);
    }
  });

  /** Ask the shell, and only record it if the shell agreed. */
  async function setFullscreen(on) {
    try {
      await NativeAPI.setFullscreen(on);
      full = on;
      document.body.classList.toggle('is-fullscreen', on);
    } catch { /* refused by the window manager; leave the flag as it was */ }
  }
}
