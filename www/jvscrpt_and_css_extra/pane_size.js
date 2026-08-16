// The − / + buttons on the editor and outline pane heads.
//
// Text size is already a setting for both panes — `editorSize` and
// `outlineSize` in the schema — and both already appear in the Settings menu as
// steppers. These buttons are a second way to reach the same two values, put
// where the text they change actually is, the way Revery Notebook's pane bars
// do it.
//
// A second control for a setting is exactly what the Auto button was, and it was
// removed. The difference is that these go through settings.step() rather than
// keeping any state of their own: there is nothing here to fall out of step with
// the menu, because there is nothing here to be out of step. `settings.onChange`
// fires for both paths, so the buttons re-evaluate whichever one moved the
// value — including Reset to defaults.
//
// Its own module rather than more code in the app shell, which is already 2000
// lines; the same reason outline.js and log_console.js are separate.

import { $ } from './dom.js';
import * as settings from './settings.js';

/** Which buttons drive which setting. The only thing this file knows. */
const PAIRS = [
  { key: 'editorSize', down: 'editorsizedown', up: 'editorsizeup' },
  { key: 'outlineSize', down: 'outlinesizedown', up: 'outlinesizeup' }
];

/**
 * Disable a button once its setting has nowhere further to go.
 *
 * Shown disabled rather than hidden, so the pair does not change width at the
 * ends of the range and shift the pane head under the pointer — the same
 * reasoning the menus use for an action that cannot run right now.
 */
function refresh() {
  for (const { key, down, up } of PAIRS) {
    const label = `${settings.settings[key]}%`;
    for (const [id, delta] of [[down, -1], [up, 1]]) {
      const b = $(id);
      if (!b) continue;
      b.disabled = settings.atEnd(key, delta);
      // The current value belongs somewhere findable, and the pane head has no
      // room to print it. The title is where the menu puts this kind of thing.
      b.title = `${delta < 0 ? 'Smaller' : 'Larger'} ${key === 'editorSize' ? 'editor' : 'outline'} text — ${label}`;
    }
  }
}

/** Wire the four buttons. Safe to call once, at boot. */
export function initPaneSizeButtons() {
  for (const { key, down, up } of PAIRS) {
    for (const [id, delta] of [[down, -1], [up, 1]]) {
      const b = $(id);
      if (!b) continue;
      b.onclick = () => settings.step(key, delta);
    }
  }
  // Not refresh() directly: onChange passes (key, value), and a listener that
  // took them would silently start ignoring the reset broadcast, which sends
  // nulls.
  settings.onChange(() => refresh());
  refresh();
}
