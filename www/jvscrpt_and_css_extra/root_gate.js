// The open project's root, and the work that depends on it.
//
// Every backend resolves a project-relative path against the root that is open
// **when the call lands**, not the one that was open when it was issued. So the
// moment the root moves, anything still on its way — the rest of a save, a
// crash backup, the second half of a folder move — lands in the other folder.
//
// This is the one place that knows which calls those are. The app talks to the
// backend through `gate.api`, which has the same methods as the backend, and a
// project switch moves the root only inside `lock()`: it waits for the work in
// flight to finish against the old root, then holds every root call issued
// meanwhile until it knows whether the old project is still the open one.
//
// Pure, and no DOM: test/root_gate.test.js drives it with a fake backend.

/** Calls whose path is relative to the open root. */
export const ROOT_CALLS = new Set([
  'readDirectory', 'readTextFile', 'readBinaryFile', 'readAll',
  'writeFile', 'writeBinaryFile', 'deleteFile', 'renameFile',
  'openContainingFolder', 'writeBackup', 'listStaleBackups', 'discardBackup',
  'runTex'
]);

/**
 * Calls that move the root. Only a project switch may make them, through the
 * backend itself — the gated api refuses them, so a new caller cannot move the
 * root from under the work this module exists to protect.
 *
 * `currentRoot` is here because on both browser backends it is not only a
 * question: with nothing open, it adopts the folder or store remembered from
 * last time.
 */
export const ROOT_MOVES = new Set([
  'openFolder', 'openFolderPath', 'reopenRemembered', 'revertOpen',
  'currentRoot', 'importZip', 'createProject'
]);

/**
 * Not waited for before the root moves.
 *
 * A system TeX pass runs for up to 180 s, and cancelling one means "after this
 * pass". Waiting would keep a folder picker from opening for minutes. It is
 * safe not to: both desktop backends fix the working directory when the
 * command starts, and the argv they build names nothing else.
 */
const UNDRAINED = new Set(['runTex']);

/** What a held call rejects with when the project it belonged to is gone. */
export const MOVED = 'The project was switched before this could run.';

/**
 * @param {object} backend  a NativeAPI implementation
 */
export function createRootGate(backend) {
  const calls = new Set();      // root calls in flight
  const tasks = new Set();      // operations made of several root calls
  let locked = false;           // from the start of lock() until its release
  let hold = null;              // while the root is moving: { settled: Promise<boolean> }

  async function rootCall(key, args) {
    // A loop, not an `if`: nothing stops a second switch starting between the
    // release of one and the moment this continuation runs.
    while (hold) {
      if (!(await hold.settled)) throw new Error(MOVED);
    }
    // Called synchronously, so a switch that starts after this line waits for
    // it; `new Promise` so a backend that throws instead of rejecting is still
    // one rejected promise to the caller.
    const p = new Promise((resolve) => resolve(backend[key](...args)));
    if (!UNDRAINED.has(key)) {
      calls.add(p);
      const done = () => calls.delete(p);
      p.then(done, done);
    }
    return p;
  }

  // Same method presence as the backend, because presence is how every caller
  // decides what the backend can do. Looked up at call time rather than bound
  // here, so a test that replaces a backend method is still heard.
  const api = {};
  for (const [key, value] of Object.entries(backend)) {
    if (typeof value !== 'function') api[key] = value;
    else if (ROOT_MOVES.has(key)) {
      api[key] = () => Promise.reject(new Error(
        `${key} moves the project root — only a project switch may call it`));
    } else if (ROOT_CALLS.has(key)) api[key] = (...args) => rootCall(key, args);
    else api[key] = (...args) => backend[key](...args);
  }

  return {
    api,

    /** True from `lock()` until its release. */
    get moving() { return !!hold; },

    /**
     * Mark `promise` as one operation on the root.
     *
     * For work that is several calls long — a move, a delete, a drop — where
     * stopping between two of them would leave the tree describing a folder
     * that is neither the old one nor the new one. A switch waits for it to
     * finish rather than cutting it in half.
     *
     * @template T
     * @param {Promise<T>} promise
     * @returns {Promise<T>} the same promise
     */
    task(promise) {
      tasks.add(promise);
      const done = () => tasks.delete(promise);
      promise.then(done, done);
      return promise;
    },

    /**
     * Get ready to move the root.
     *
     * Waits for every task, then for every call still in flight, and from that
     * point holds new root calls until the returned `release` is called:
     * `release(true)` lets them run (the switch was cancelled, or the old
     * project was put back), `release(false)` refuses them (it is gone).
     *
     * Tasks are waited for while calls still flow — a task *is* calls, and
     * holding them first would wait for it forever.
     *
     * @returns {Promise<(kept: boolean) => void>}
     */
    async lock() {
      if (locked) throw new Error('A project switch is already in progress.');
      locked = true;
      while (tasks.size) await Promise.allSettled([...tasks]);
      let settle;
      hold = { settled: new Promise((resolve) => { settle = resolve; }) };
      while (calls.size) await Promise.allSettled([...calls]);
      let released = false;
      return (kept) => {
        if (released) return;
        released = true;
        hold = null;
        locked = false;
        settle(!!kept);
      };
    }
  };
}
