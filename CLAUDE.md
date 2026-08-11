# Revery TeX — notes for AI assistants

Read `README.md` first; it covers architecture, build commands and the gotchas.
This file is only the things an assistant gets wrong.

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
which WebKitGTK does not implement. Screenshot the window instead:

```bash
WID=$(xwininfo -root -tree | grep '"Revery TeX"' | grep -oE '0x[0-9a-f]+' | head -1)
import -window "$WID" /tmp/shot.png
```

Launch straight into a project with `REVERY_TEX_OPEN=/path npm run start:tauri`.
**Always point it at a scratch copy, never at the real `latex_project_tests/`.**

## Reference repos are read-only

`../revery_notebook_reference/` and `../website_reference/` are inspiration and
source material. Copy *from* them; never write *into* them.
