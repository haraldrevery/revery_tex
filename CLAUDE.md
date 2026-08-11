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
