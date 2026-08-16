// Choosing, starting and replacing the TeX engine.
//
// The compile *flow* stays in the app shell — it coordinates the editor, the
// save path, SyncTeX, the PDF pane and the log, and pulling that out would mean
// injecting most of the app back into it. What is genuinely separable is the
// engine's lifecycle: which one to use, starting it, falling back when a system
// TeX turns out not to work, and throwing the old one away on a switch.
//
// This owns the engine instance so the app shell does not, and it is the only
// place that decides between bundled and system.

import { WasmTexEngine } from './tex_engine_wasm.js';
import { NativeTexEngine } from './tex_engine_native.js';

/**
 * @param {object} opts
 * @param {object} opts.api              NativeAPI
 * @param {object} opts.settings         the settings module
 * @param {(line:string, level:string)=>void} opts.onLog
 * @param {(text:string, cls?:string)=>void} opts.onStatus
 * @param {() => boolean} opts.projectIsOnDisk  a system TeX reads real files,
 *        so it cannot compile a project that exists only in memory
 */
export function createEngineHost({ api, settings, onLog, onStatus, projectIsOnDisk }) {
  let engine = null;
  let source = null;

  /**
   * A system TeX was asked for, tried, and could not start.
   *
   * Without this the fallback below is undone on the very next compile.
   * `acquire()` would set `source = 'bundled'` while `wanted()` still answered
   * 'system', so every subsequent compile saw `source !== want`, disposed a
   * perfectly good engine, re-probed the system TeX that had already failed,
   * and paid a **full WASM re-initialisation** — worker, texmf data packages
   * and all — to arrive back exactly where it started. The fallback is supposed
   * to be a one-time cost, and this is what makes it one.
   *
   * Deliberately not cleared by `dispose()`: switching projects must not turn a
   * known-broken installation back into something worth several seconds of
   * probing. Only `resetEngineChoice()` clears it, and only the user asking for
   * a system TeX again calls that.
   */
  let systemUnavailable = false;

  // Engine log levels are not the panel's; map once, here, rather than at each
  // construction site.
  const log = (line, level) =>
    onLog({ debug: 'dbg', info: 'inf', warn: 'wrn', error: 'err', out: 'dbg', hdr: 'hdr' }[level] || 'dbg', line);

  /**
   * Which engine to use, narrowed to what can actually run.
   *
   * A system TeX needs two things the bundled engine does not: a shell that can
   * start a process, and files on disk. The fixtures live only in memory, so
   * falling back is better than a compile that reads whatever stale copy
   * happens to be on disk — that would be worse than failing, because it would
   * look like it worked.
   */
  function wanted() {
    if (settings.settings.engineSource !== 'system') return 'bundled';
    if (!NativeTexEngine.available(api)) return 'bundled';
    if (!projectIsOnDisk()) return 'bundled';
    // Already tried and already failed — see systemUnavailable.
    if (systemUnavailable) return 'bundled';
    return 'system';
  }

  const build = (which) => which === 'system'
    ? new NativeTexEngine({ onLog: log, api })
    : new WasmTexEngine({ onLog: log });

  /** The engine to compile with, started and ready. */
  async function acquire() {
    const want = wanted();

    // Switching source throws the old engine away rather than keeping both: the
    // WASM heap is ~500 MB, and holding it for an engine nobody is using is the
    // difference between a comfortable machine and a swapping one.
    if (engine && source !== want) { dispose(); }
    if (engine) return engine;

    engine = build(want);
    source = want;
    onStatus(want === 'system' ? 'looking for your TeX installation…' : 'starting engine…', 'warn');

    try {
      await engine.init();
    } catch (err) {
      // A missing or broken system TeX must not leave the app with no engine at
      // all; say so and fall back to the one that is always there.
      if (want !== 'system') { engine = null; source = null; throw err; }
      log(String(err.message || err), 'error');
      log('falling back to the bundled engine', 'warn');
      // Remembered, so the next compile does not throw this engine away to
      // re-probe an installation that has already said no.
      systemUnavailable = true;
      engine = build('bundled');
      source = 'bundled';
      await engine.init();
    }
    return engine;
  }

  function dispose() {
    if (!engine) return;
    try { engine.dispose(); } catch { /* already gone */ }
    engine = null;
    source = null;
  }

  /**
   * Ask the live engine to stop.
   *
   * What that means differs by engine and the caller has to be able to say so,
   * which is why `source` is readable alongside this:
   *
   *   - **bundled** — the worker is terminated outright. The engine object stays
   *     and re-initialises itself on the next `compile()`, so nothing is dropped
   *     here; the cost is paid then, and it is a real one.
   *   - **system** — only a flag. It is checked between passes, and there is no
   *     IPC to kill a running child, so the `pdflatex` already executing runs to
   *     completion and only the passes after it are skipped.
   *
   * Neither settles the promise the caller is awaiting — the vendored wrapper
   * holds its own 180 s timeout and rejects only then — so the caller must stop
   * awaiting on its own rather than treating this as the end of the compile.
   */
  async function cancel() {
    if (!engine) return null;
    try { await engine.cancel?.(); } catch { /* already gone */ }
    return source;
  }

  return {
    acquire,
    dispose,
    cancel,

    /**
     * Forget that a system TeX failed, so the next compile tries it again.
     *
     * The app calls this when `engineSource` changes. Choosing System LaTeX is
     * how someone says "I have installed it now" — or "try again, I fixed my
     * PATH" — and that has to be able to overrule the memo, or the setting
     * would be permanently dead after one bad probe.
     */
    resetEngineChoice() { systemUnavailable = false; },

    /**
     * Whether offering to switch to a system LaTeX would actually help.
     *
     * Both halves of `wanted()`'s narrowing, and for the same reasons. Method
     * presence — never an environment name — so the offer cannot appear in the
     * browser backends, which have no `detectTex`. And `projectIsOnDisk()`,
     * because `wanted()` already refuses a system TeX for an in-memory project:
     * offering a switch that would silently fall back to the bundled engine is
     * worse than not offering one, since the user would read the unchanged
     * failure as "switching didn't help" rather than "switching didn't happen".
     *
     * `systemUnavailable` is the third case and the same argument: an
     * installation that has already failed to start would fall back again, so
     * the offer would be a button that changes nothing.
     */
    canOfferSystem: () =>
      NativeTexEngine.available(api) && projectIsOnDisk() && !systemUnavailable,

    /** What the last acquire actually produced — 'bundled' | 'system' | null. */
    get source() { return source; }
  };
}
