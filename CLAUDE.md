# Revery TeX — notes for AI assistants

Read `README.md` first; it covers architecture, build commands and the gotchas.
This file is only the things an assistant gets wrong.

## Run everything with one command

    npm run check

Starts both dev servers, runs unit → rust → gate → ui → web → electron, tears
them down. `npm run check gate ui` runs a subset. It refuses to start if
something is already on port 8777, because **a long-lived `node test/serve.js`
does not pick up edits** and testing against a stale one looks exactly like the
change having broken something.

## The invariant

`npm run serve &` then `npm run gate` must pass **5/5**. It compiles four real
LaTeX projects and asserts exact page counts, plus one that must *fail* by name.
Any change that breaks it is wrong. Run it before claiming anything works.

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

`tauri/src/tex_run.rs` and `electron/tex_run.js` are the only code that starts a
process, and they run on a directory the user may have downloaded. Do not
loosen any of this without a reason written down:

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

## Generated files — never edit directly

- `www/jvscrpt_and_css_extra/codemirror-bundle.js` → edit `build_tools/cm_entry_tex.js`
- `www/engine/dist/**` → `node build_tools/build_slim_texmf.js`
- `www/jvscrpt_and_css_extra/texlyre_busytex.js` → copied from `vendor/`

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
