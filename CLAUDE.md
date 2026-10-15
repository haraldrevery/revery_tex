# Revery TeX — notes for AI assistants

Read `README.md` first; it covers architecture, build commands and the gotchas.
This file is only the things an assistant gets wrong.

## Run everything with one command

    npm run check

Starts both dev servers, runs unit → rust → gate → ui → web → electron, tears
them down. `npm run check gate ui` runs a subset. It refuses to start if
something is already on port 8777 or 8778, because **a long-lived
`node test/serve.js` does not pick up edits** and testing against a stale one
looks exactly like the change having broken something. Each suite has a
timeout, so a hang is reported rather than waited on forever.

The gate and UI suites need the sibling fixture repo (`../latex_project_tests/`,
or wherever `REVERY_TEX_FIXTURES` points). Missing, they are reported as FAIL,
not skipped; `REVERY_TEX_SKIP_FIXTURES=1` skips them on purpose, and says so.

### Known bugs are tests that are *meant* to fail

Open data-loss bugs are written as the correct assertion and wrapped in
`knownBug()` (node:test) or `knownBugCheck()` (the CDP harnesses) from
`test/known_bug.js`, each naming the phase of the fix plan that closes it. They
report as `todo` / `~` and do not fail the run — but only while they fail with
their own symptom. **When you fix one, its test turns red on purpose: remove the
wrapper so it becomes an ordinary test.** Never loosen a symptom or delete the
test to make it pass.

## The invariant

`npm run serve &` then `npm run gate` must pass **7/7**. It compiles six real
LaTeX projects, plus one that must *fail* by name. Any change that breaks it is
wrong. Run it before claiming anything works.

**Three of the six are pinned to an exact page count and three are not**, and
that split is deliberate rather than unfinished. A page count is a function of
font metrics and the texmf version, so it is only worth pinning where the
document is stable enough for a change in it to mean something. `homework` is
the reason the rule exists — see its comment in `test/serve.js`, and
`latex_stress_test/README.md` § The rules.

## Two abstractions — do not leak past them

- `www/jvscrpt_and_css_extra/tex_engine_wasm.js` is the only file allowed to know
  about BusyTeX, engine modes or data packages.
- `www/jvscrpt_and_css_extra/native_api.js` is the only file allowed to know
  which shell it is running in.

Callers **feature-detect by method presence**, never by environment name:
`if (NativeAPI.openFolder)`, not `if (isTauri)`.

This is load-bearing, not style. The Firefox/Safari backend has no `openFolder`
at all, because it cannot write back to the folder a project came from — the
missing method is what makes the UI offer Import instead of a Save that would
not have worked. Any new backend must omit what it cannot do rather than throw.

Four backends implement that surface and **nothing used to hold them to the same
behaviour**, so two of them drifted silently. `test/native_api_parity.test.js`
now diffs the two desktop impls (the only documented divergence is
`onCloseRequested`), and `test/backup_staleness.test.js` holds all four to the
crash-backup rule below.

### A crash backup is discarded only when it is safe to

**A file that cannot be read counts as stale, and its backup is offered.** Never
the reverse. Both browser backends had this inverted — they skipped the backup
when the read failed — which threw the work away in exactly the case the backup
exists for: the file is gone and this copy is the only one left. Deleting a file
after typing into it, or revoking the folder permission, lost the edits with
nothing said, and the recovery dialog's "this backup is the only copy" branch
could never fire outside the desktop.

The rule lives once, in `www/jvscrpt_and_css_extra/backup_rules.js`. The desktop
backends are in Node and Rust and cannot import it, so they are held to it by
test instead — `fs_core.js` reads into `''` on catch, `main.rs` uses
`unwrap_or_default()`.

Backups are also keyed on a **project identity, never a project name**. Two
folders — or two zips — called `thesis` are two different projects; keyed on the
name, one project's unsaved text was offered as recovery for the other's, and
accepting it overwrote the file with no conflict, because the stamp belonged to
the file that was really open. web-fs uses `identify()`/`rootId`, the zip backend
a generated `projectId` stored in IndexedDB, and the desktop shells hash the
absolute path.

**A backup follows its file.** A move writes it at the new path before dropping
the old one, and a delete from the Files panel discards it. Left behind, a
renamed file's backup was offered on every open as "the only copy" of a file
that had only moved, and a deleted one's brought the file back on Restore. That
is not the rule above bent: a file that disappears *outside* the app is still
unreadable, and its backup is still offered. Only a file with unsaved edits
carries its backup on a move — a clean file's backup is a crash from an earlier
session that the user chose to keep for later.

Tauri keeps backups in the app **data** directory, as Electron keeps them in
userData. They were in the cache directory, which cleaners may empty. The old
directory is still listed and swept on discard (`backup_search_path`), so
nothing written there before is stranded or impossible to dismiss.

### A move keeps the file's stamp

`renameFile(from, to, expect)` refuses, with the ordinary CONFLICT, a file that
no longer matches the stamp it was read with, and otherwise returns the
destination's stamp, which `moveOne` adopts. The app used to *drop* the stamp on
every move — the browser backends rename by copying, so a kept stamp raised a
false conflict — and the next save then overwrote whatever another program had
done to the file since. Two things not to do instead: keep the old stamp
unconditionally (false conflicts in the browser), or re-stamp the destination
without the check (absorbs a change made *before* the move, then overwrites it).
On a conflict the app still moves the file — a rename cannot lose the change —
but keeps the old stamp, so the next save asks.

## `www/` contains only what ships

Every shell loads that folder, and **Tauri embeds all of it into the binary**
with no whitelist — so anything put there reaches every user. Build inputs live
beside it (`engine_upstream/`), never inside.

This is not hypothetical. The 649 MB upstream release sat in
`www/engine/busytex/` and rode into the Tauri binary: the `.deb` was 471 MB
instead of 53 MB, and the release build took 7m22s instead of 20s. It was
invisible because the directory is gitignored *and* the Tauri release build had
never completed. `test/frontend_payload.test.js` now enforces a size ceiling.

Electron survived it only because `electron-builder.yml` lists files explicitly.
Two packagers independently excluding the same thing is not a strategy.

## The subprocess layer

`tauri/src/tex_run.rs` and `electron/tex_run.js` run compilers **on a directory
the user may have downloaded**, so what they may run is the whole question. Do
not loosen any of this without a reason written down:

- **`latexmk` is not on the allowlist and must not be added.** It executes
  `latexmkrc` from the working directory as Perl.
- **`-no-shell-escape` on every invocation.** `\write18` runs shell commands
  from inside the document.
- **argv is built in the backend.** The renderer names a tool and a file; it
  cannot pass a flag. The sandbox must not depend on the UI being careful.
- **No shell, and no `which`.** PATH is walked by hand, skipping empty entries
  (which mean `.`), so a file named `pdflatex` inside a project cannot become
  the compiler.

The two implementations must stay identical — a test compares their argv and
allowlists, because a document that compiles in one shell and not the other is
undiagnosable.

### The one other place a process is started

`launch_file_manager` in `tauri/src/main.rs` and `launchFileManager` in
`electron/fs_core.js` — behind the `open_containing_folder` command, which is
the file panel's **Open containing folder** row. Not governed by the allowlist
above, and it does not need to be, because it is a different problem: it runs
**one program named as a literal in that file** (`xdg-open` / `explorer.exe` /
`open`) on **one absolute path the backend computed**, and reads nothing back.
Nothing in a project directory can be reached by it, which is the property the
allowlist exists to give `tex_run`.

What it must keep:

- **The path is decided by `containing_dir`, never by the renderer**, which
  sends a project-relative path and nothing else. `containing_dir` goes through
  `safe_path_inside`, so a symlink out of the project is refused before anything
  launches. That split also exists so the decision is testable — the launch is
  the one function in the tree a test must never call, because it would open a
  file manager on whatever machine ran the suite.
- **No shell, no inherited stdio, and no reading of the exit status.**
  `explorer.exe` returns 1 on success; a file manager may take seconds to
  appear. Only failure to *launch* is reported.
- **The child is disowned, never awaited.** Waiting on the caller's thread would
  block the webview until the user closed their file manager. Rust reaps it on a
  thread of its own, because dropping a `Child` unwaited leaves a zombie for the
  life of the app; Node gets the same effect from `detached` + `unref()`. Node
  reports a missing program on the `error` event and success on `spawn`, which
  is why neither shell has to wait for an exit code to tell the two apart.

**Electron spawns rather than using its own `shell` module, and that is not an
oversight.** `shell.openPath()` returns a promise that never settles on a Linux
desktop — measured, headed and headless: six seconds, no resolution, no file
manager — so an awaited call hangs the IPC reply forever, which is exactly how
this shipped broken the first time. `shell.showItemInFolder()` does work but
*selects* the item, which for a folder row opens its parent instead. Spawning
gives both shells the same behaviour and no hang. If you are tempted back to
`shell`, measure it first.

**No Tauri capability is granted for any of this** — `capabilities/default.json`
stays shut and the reveal is reachable only through our own validating command.
Adding `tauri-plugin-opener` instead would put URL-opening in the binary; see
the licence section below for why that is not a free change.

## The project root moves in one place

Every backend resolves a project-relative path against the root that is open
**when the call lands**. Moving the root while a save, a crash backup or a
folder move was still on its way sent the rest of it into the other folder —
and a switch that failed after moving the root left the old project on screen
saving into the new one. So:

- **Change project only through `switchProject()`** in `revery_tex_app.js`. The
  app's `NativeAPI` is the gated one from `root_gate.js`, and it *refuses* the
  root-moving methods (`openFolder`, `openFolderPath`, `importZip`, …) so a new
  caller cannot bypass the switch. The switch itself uses `backend`.
- **A Files-panel operation that makes several disk calls is `gate.task(…)`** at
  its entry point, so a switch waits for it instead of cutting it in half. A new
  one that is not registered is the next instance of this bug.
- **A failed open must leave the old project exactly as it was, or nothing
  open** (`closeProject`) — never the old project over the new folder. Desktop
  goes back with `openFolderPath(prev.root)`; web-fs with `revertOpen`, which
  must restore all four of the handle, its id, the file-handle map and the
  remembered folder. Restoring the handle alone still sends a save to the failed
  folder's file of the same name — the web harness checks exactly that.

### The one place the renderer names a root

`open_folder_path` (Tauri) / `fs:openFolderPath` (Electron), behind the Project
drop-down's recent-projects rows. Until it existed, only the OS folder dialog
could set a project root; this is the one command that takes a path from the
renderer and makes it the root.

That matters more than it looks, because **the root is also the working
directory `tex_run` compiles in**. So the vetting is not tidiness:

- `vet_project_root` in `tauri/src/main.rs` and `vetProjectRoot` in
  `electron/fs_core.js` are twins and must stay twins — a folder that reopens in
  one desktop shell and not the other is undiagnosable. Six tests each, in
  `main.rs`'s own `mod tests` and in `test/fs_core.test.js`.
- It canonicalises (so `safe_path_inside` keeps comparing real paths), requires
  a directory that exists, and **refuses a filesystem root and `$HOME` itself**.
  Do not drop that last one to make some path work.
- **The folder dialog and the launch path (`REVERY_TEX_OPEN`, argv) go through
  the same vetting** (`vet_project_dir` / `vetProjectRoot`). That is what lets a
  failed switch reopen the previous folder by path: a root the vetting would
  refuse could be opened but never gone back to.

**The recents list itself is deliberately not persisted here.** It lives in
`www/jvscrpt_and_css_extra/recent_projects.js`, in shared JS, for the reason the
parity tests exist: a list implemented once in Rust and once in Node is two
implementations that drift. The shells supply only the half a browser cannot do.
Entries are keyed on a **project identity** — the canonical absolute path — never
on `project.key`, which is only the folder's name; same rule as the crash
backups, and for the same reason.

## Project text is UTF-8, strictly

Every backend's `readTextFile` refuses a file that is not UTF-8, and the loader
(`readProjectFromDisk`) keeps it as bytes — `binary: true` plus `textError`,
read-only, compiled and exported as it is. So:

- **Never decode project files leniently** — no `file.text()`, no
  `readFileSync(…, 'utf8')` for project text, no default `TextDecoder`. Use
  `{ fatal: true, ignoreBOM: true }`. Lenient decoding is what turned Latin-1
  files into U+FFFD on the next save; the default decoder also strips a BOM,
  which rewrote the first three bytes of every file that had one.
- The only lenient decodes left are the crash-backup staleness readers, which
  must not throw — and even those keep the BOM, or every backup of such a file
  looks stale.
- **Bytes go to the engine as bytes.** `tex_engine_wasm.js` used to decode the
  main file on its way in; `test/wasm_engine_bytes.test.js` and the web
  harness's `MARK:` check hold it to passing it through.
- `scannable()` in `project_store.js` reads held bytes one character per byte,
  **for the ASCII scanners only** (`\documentclass`, `\input`,
  `\bibliography`). Never show, edit or save what it returns.

## Generated files — never edit directly

- `www/jvscrpt_and_css_extra/codemirror-bundle.js` → edit `build_tools/cm_entry_tex.js`
- `www/engine/dist/**` → `node build_tools/build_slim_texmf.js`
- `www/jvscrpt_and_css_extra/texlyre_busytex.js` → copied from `vendor/`
- `www/jvscrpt_and_css_extra/build_info.js` → `node build_tools/sync_version.js`
- `www/jvscrpt_and_css_extra/{katex,pdfjs}/**` → `node build_tools/vendor_assets.js`

## The licence is AGPL, and that is load-bearing

`texlyre_busytex.js` is AGPL-3.0-or-later and is `import`ed directly, so the whole
application is AGPL-3.0-or-later — not Apache, whatever older comments say. Two
things follow that are easy to break by accident:

- **The logo menu is not decoration, and it belongs at the far left.** AGPL §13
  obliges a hosted copy to offer its source to every user, and `Source code` is
  the first row of that menu for exactly that reason. `#topbar` clips from the
  right rather than wrapping, so its last item is the first one lost — Settings
  and Toolbox already vanish below ~1130px. First in the bar is the only
  position that survives every width down to the 640px `minWidth`, and
  `test/run_ui.js` asserts it at three widths. Do not move it rightwards to
  tidy the toolbar.
- **`Source code` copies rather than opens.** Neither desktop shell will open a
  browser — `electron/main.js` denies every window open and blocks off-origin
  navigation, and the Tauri build ships no opener plugin. A menu row or link
  that navigated would be silently dead on the desktop and fine in every browser
  test, which is how it went unnoticed once already. The Legal page spells every
  URL out as text for the same reason. `test/run_electron.js` checks this in the
  shell where it actually matters.

  Note the exact shape of that rule, because **Open containing folder** looks
  like a counter-example and is not. The app will show you a folder; it still
  will not open a browser. The reveal hands one validated path to a file
  manager through the main process, and can neither navigate the webview nor
  give a URL to anything. This is why that feature is a hand-written command
  rather than `tauri-plugin-opener`: the plugin exists to "open files **and
  URLs**", and pulling it in would put into the binary the one capability the
  Legal page's whole design assumes is absent. A test asserts it is not in
  `tauri/Cargo.toml`.
- **The arm's-length boundary in `tex_engine_wasm.js` is a licence boundary too.**
  The GPL TeX engines stay outside the licence calculation only because they are
  separate programs across a Worker message boundary. Linking them differently
  would change what the project may be distributed as.

Replacing the wrapper with an MIT one over `busytex_pipeline.js` would return the
project to Apache-2.0. Until someone does, assume AGPL. See README § Licensing.

## Dangerous commands

- **Never `pkill -f <pattern>` or `killall`.** The pattern matches the invoking
  shell's own command line and kills the session (exit 144). This has happened.
  Resolve a PID, confirm it is not `$$` or `$PPID`, then kill it.
- **Never `cd` into a sibling reference repo** and leave it — the working
  directory persists across commands and later relative writes land in the wrong
  project. Use absolute paths.
- `tauri build` (release) is memory-hungry enough to kill the machine when run
  alongside browser automation. Use `--debug --no-bundle`, alone.
- **Kill the Electron binary, not `node_modules/electron/cli.js`.** cli.js is a
  Node wrapper that spawns Electron as a child, so killing the PID `spawn`
  returns leaves Electron alive holding the debug port. The next run then
  attaches to the *previous* run's window, whose project directory has since
  been deleted — which surfaces as a baffling ENOENT from inside the app.
  `require('electron')` gives the real binary path; spawn `detached` and kill
  the negative PID.
- **One heavy build at a time.** `rpmbuild` on this payload peaks around 2.3 GB
  and runs multithreaded; a Tauri build beside it is what killed the machine
  before.
- No long foreground `sleep`; use a backgrounded `until` loop.

## Verifying UI work

Chrome: drive `test/cdp.js` against `http://localhost:8777/www/index.html` and
call `window.__reveryTexApp.compile(key)`.

The browser build has three backends and Chrome would only ever pick one of
them, so force the others:

```bash
REVERY_TEX_STATIC=1 PORT=8778 node test/serve.js &   # /api/* → 404, like a real host
node test/run_web_backends.js                        # web-fs, web-zip and web
```

`?backend=zip|none` is honoured only by `native_api.js`, and only for the
browser backends — a desktop shell has real files and nothing to fall back to.

**Answer dialogs when driving the app.** It uses `confirm()` for anything that
discards work, and `beforeunload` fires on navigation with unsaved edits. An
unanswered dialog blocks headless Chrome forever, and the run looks like a hang
with no output. Listen for `Page.javascriptDialogOpening` and reply.

**Never pipe a long test through `head`/`tail`.** They buffer until EOF, so a
run killed by a timeout prints nothing at all — the failure looks like a hang.
Redirect to a file and read it.

Tauri: there is **no headless driver** — our CDP client speaks Chrome's protocol,
which WebKitGTK does not implement. For the engine, use
`npm run test:tauri:engine`: it builds a variant whose window opens
`engine_check.html?autorun=1` and screenshots the verdict, so nothing has to be
clicked. It leaves the release binary as that variant — re-run
`npm run build:tauri` afterwards.

**Never send synthetic keystrokes blind.** XTEST types into whatever window has
focus, which on this machine is the user's editor, not ours. If input is truly
needed, verify focus is on the target window first (`test/run_tauri.js` does,
and is opt-in behind `REVERY_TEX_ALLOW_INPUT=1`).

Otherwise, screenshot the window:

```bash
WID=$(xwininfo -root -tree | grep '"Revery TeX"' | grep -oE '0x[0-9a-f]+' | head -1)
import -window "$WID" /tmp/shot.png
```

Launch straight into a project with `REVERY_TEX_OPEN=/path npm run start:tauri`.
**Always point it at a scratch copy, never at the real `latex_project_tests/`.**

## Reference repos are read-only

`../revery_notebook_reference/` and `../website_reference/` are inspiration and
source material. Copy *from* them; never write *into* them.
