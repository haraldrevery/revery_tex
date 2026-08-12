# Revery TeX

A local-first LaTeX editor. Edit, compile and preview entirely on your own
machine — no server, no account, no network. LaTeX is compiled by a real TeX Live
2026 built to WebAssembly, so the same engine runs in the browser and in the
desktop app.

Sibling project to [Revery Notebook](https://haraldrevery.com), and deliberately
built the same way: vanilla JavaScript, no framework, no runtime bundler, no CDN.

---

## Quick start

```bash
git clone <repo> && cd revery_tex
npm install                       # Tauri CLI
npm install --prefix build_tools  # esbuild, CodeMirror, pdf.js, KaTeX

# Browser (fastest loop — has test fixtures built in)
npm run serve                     # http://localhost:8777/www/index.html

# Desktop — Tauri (small bundle, WebKitGTK) or Electron (Chromium)
npm run start:tauri               # first Rust build takes ~1 min
npm run start:electron
REVERY_TEX_OPEN=/path/to/project npm run start:tauri   # open straight into a folder
```

**The engine binaries are committed** (`www/engine/dist/`, 97 MB), so a fresh
clone runs immediately. You only need the 649 MB upstream release if you want to
rebuild the texmf bundle — see [Rebuilding the TeX distribution](#rebuilding-the-tex-distribution).

> **`www/` contains only what ships.** Every shell loads that folder, and Tauri
> embeds *all* of it into the binary with no whitelist — so anything placed
> there reaches every user. Build inputs live beside it (`engine_upstream/`),
> never inside. This is enforced by a size ceiling in
> `test/frontend_payload.test.js`, because it has already gone wrong once: the
> upstream tree sat in `www/engine/busytex/` and the Tauri `.deb` came out at
> 471 MB instead of ~120 MB.

### Prerequisites

- **Node 22+**
- **Rust** and **WebKitGTK 4.1 dev headers** (desktop only)
  `sudo apt install libwebkit2gtk-4.1-dev build-essential curl file libssl-dev libayatana-appindicator3-dev librsvg2-dev`

---

## How it works

```
┌──────────── www/ ── the whole app; browser, Tauri and Electron all load this ─┐
│                                                                              │
│  index.html                     app shell                                    │
│  jvscrpt_and_css_extra/                                                      │
│    revery_tex_app.js            UI: editor, tree, compile, log console        │
│    tex_engine_wasm.js           TexEngine  ── the only file that knows TeX    │
│    native_api.js                NativeAPI  ── the only file that knows shells │
│    native_api_web.js            File System Access backend (Chromium)        │
│    native_api_zip.js            IndexedDB backend (Firefox, Safari)          │
│    zip_core.js                  zip reader/writer, no dependencies           │
│    project_store.js             folder/fixture → project; no DOM             │
│    engine_host.js               picks, starts and replaces the TeX engine    │
│    log_console.js               Issues, Raw log and the status line          │
│    latex_editor.js              CodeMirror behaviour: completion, auto-close │
│    document_model.js            the one index — nothing else scans the text  │
│    latex_snippets.js            pure text transforms (wrap, insert, label)   │
│    editor_actions.js            snippet → CodeMirror edit; shared menu rows  │
│    outline.js                   sections → its own pane, in \include order  │
│    toolbox.js                   what the Toolbox and right-click menus offer │
│    table_builder.js             grid → tabular; pure, no DOM                 │
│    dialog.js                    modal shell + form with a live preview       │
│    picker.js                    lazy card strip: figures, by thumbnail       │
│    file_tree.js                 paths → a nested tree; pure, no DOM          │
│  image_assets/                  background photographs — proprietary        │
│    math_preview.js              KaTeX, loaded on first use                   │
│    katex/                       vendored — see build_tools/vendor_assets.js  │
│    settings.js                  one declarative table: load, apply, menu     │
│    menus.js                     dropdown component (radio, stepper, action)  │
│    settings_boot.js             pre-paint theme, so there is no flash        │
│    pdf_preview.js               pdf.js canvas renderer                       │
│    codemirror-bundle.js         generated — edit build_tools/cm_entry_tex.js  │
│  engine/dist/                   TeX Live WASM + slim texmf (97 MB, committed) │
└──────────────────────────────────────────────────────────────────────────────┘
        │                                    │
        │ TexEngine.compile()                │ NativeAPI.readTextFile() …
        ▼                                    ▼
   WASM TeX Live 2026            tauri/src/main.rs  ·  electron/fs_core.js
   (Web Worker)                  same 9 operations, same containment rule
```

### Two abstractions, and the rule they share

Everything platform-specific lives behind one of two objects, and **callers
feature-detect by method presence, never by environment name**. No file outside
these two ever writes `window.__TAURI__` or names a TeX engine.

**`TexEngine`** (`tex_engine_wasm.js`) — compiles LaTeX.

```js
const engine = new WasmTexEngine({ onLog: (line, level) => … });
await engine.init();
const r = await engine.compile({
  files: [{ path: 'main.tex', content: '…' }],
  mainFile: 'main.tex',
  engine: 'xelatex',        // capabilities.engines says what is available
  passes: true, bibtex: false, makeindex: false
});
// r → { success, pdf, synctex, log, pages, diagnostics, missingPackages, error }
```

Swapping the WASM backend for a native one (Tectonic, a system TeX Live) is a
single-file change.

**`NativeAPI`** (`native_api.js`) — touches the filesystem. Nine calls, four
backends, and the UI hides whatever a backend cannot do:

```js
if (NativeAPI.openFolder) { /* show the Open button */ }
```

| Backend | Where | Saving goes to |
|---|---|---|
| `tauri` | Tauri window | real files, via Rust |
| `electron` | Electron window | real files, via `fs_core.js` |
| `web-fs` | Chromium | real files, via the File System Access API |
| `web-zip` | Firefox, Safari | IndexedDB — import a zip, export a zip |
| `web` | no storage at all | nothing; the UI says so |

`web-zip` deliberately has **no `openFolder`**. Those browsers cannot write back
to the folder a project came from, and a method by that name which cannot save
is exactly the half-truth that loses someone's work. The app offers Import
instead, and shows a standing bar saying where the work is being kept.

### Settings are a table, not a variable each

`settings.js` holds one `SCHEMA` array. Loading, validating, persisting,
applying and building the menu are all derived from it, so a new setting is one
entry and cannot end up persisted-but-never-applied:

```js
{ key: 'uiSize', label: 'UI size', def: 100, ui: 'stepper',
  options: PERCENT(80, 160, 10),
  css: '--ui-scale', format: (v) => String(v / 100) }
```

Two rules keep it honest. **Values that are not among the declared options are
discarded** — `localStorage` is hand-editable and survives across versions, so
an option removed in a later release would otherwise persist as a setting
nothing knows how to apply. And **font stacks live in the stylesheet**, keyed off
`[data-editor-font]`, so `settings_boot.js` can apply the stored theme before
first paint without knowing what any value means — there is no second copy of
the font list to drift.

Revery Notebook's equivalent is ~3400 lines with a module-level `let` per
setting, each wired by hand into five places. The visual idiom is copied; the
structure deliberately is not.

### Why the engine is the shape it is

`TexEngine` is not a thin pass-through. It exists because the underlying
`texlyre-busytex` wrapper has sharp edges that would otherwise leak everywhere:

| Underlying behaviour | What `TexEngine` does |
|---|---|
| No log callback — output only reaches an internal logger | Real `onLog(line, level)`, streamed live |
| `exitCode` is the *last* pass's, so a fatal error in pass 1 reports success | Success means a non-empty PDF, nothing else |
| Preload vs catalog data packages are load-bearing and easy to invert | Owns the split; callers never see it |
| `engineMode` accepts values whose assets do not exist | `capabilities.engines` reflects what is on disk |
| Missing packages fail opaquely | Names the package, points at the fuller distribution |

---

## The TeX distribution

Full TeX Live is 908 MB uncompressed. Shipping it is not an option, so
`build_tools/build_slim_texmf.js` repacks it down to **62 MB** by keeping only
what documents actually need.

The selection is **trace-driven, not guesswork**: `build_tools/texmf_trace.json`
lists the 309 files real compiles actually opened, extracted from kpathsea debug
output. From there:

1. Every traced file, always.
2. Drop `.afm` (32 MB of Type1 metrics that only `fontinst` reads), `/source/`, `/doc/`.
3. Macro directories get **whole-directory closure** — packages have
   interdependent files and a partial directory fails in strange ways.
4. Font directories **also** get whole-directory closure. This is not symmetry:
   fontconfig resolves a family by *scanning* the directory, and never opens the
   files it rejects, so `\setsansfont{Latin Modern Sans}` needs a font present
   that no trace will ever mention.
5. A curated list of common packages absent from the test documents.

Output is four data packages, each under the 50 MB git limit, plus the ~21 MB
ICU data XeTeX cannot start without. The build is **deterministic** — rebuilding
produces byte-identical output, so committed binaries do not bloat history.

### Rebuilding the TeX distribution

```bash
curl -L https://github.com/TeXlyre/texlyre-busytex/releases/download/assets-v1.2.3/busytex-assets.tar.gz \
  | tar xz -C engine_upstream                     # 649 MB, gitignored
node build_tools/extract_traces.js            # logs → texmf_trace.json
node build_tools/build_slim_texmf.js --report # dry run: sizes, no writes
node build_tools/build_slim_texmf.js          # writes www/engine/dist/
npm run gate                                  # must still pass 5/5
```

The repacker reads the LZ4 chunk format using **the engine's own MiniLZ4 codec,
extracted from `busytex.js` at build time** (`build_tools/lz4_codec.js`) rather
than a third-party LZ4. That makes it bit-compatible by construction and immune
to drift when the engine is upgraded. Every file it writes is read back and
compared byte-for-byte before the build is called a success.

---

## Testing

```bash
npm run check                                    # all six suites, servers and all
```

Individually, when you want the detail:

```bash
npm run serve &                                  # required by the gate
npm run gate                                     # the invariant: must stay 5/5
npm test                                         # fs_core (18) + zip_core (13)
cargo test --manifest-path tauri/Cargo.toml      # tauri/src/main.rs (19)

# The browser build, on a server that behaves like a real static host
npm run serve:static &                           # /api/* returns 404
npm run test:web                                 # web-fs, web-zip and web (33)
npm run test:ui                                  # settings menu, end to end (25)

# The subprocess layer. The live cases are skipped without a system TeX.
node --test test/tex_run.test.js                 # allowlist, argv, \write18, timeout (13)

# The Electron shell, over the real IPC
npm run test:electron                            # open → save → conflict → compile (14)
REVERY_TEX_BIN=dist-electron/linux-unpacked/revery-tex npm run test:electron
```

`test:electron` is the only automated proof that the desktop save path works.
Pointed at `REVERY_TEX_BIN` it runs against the **packaged** app rather than the
repo checkout, which is what catches a file the installer's whitelist dropped.

```bash
npm run build:tauri && npm run build:electron
npm run verify:installers                        # no upstream tree, engine present, size sane
npm run test:tauri:engine                        # release build compiles over tauri://localhost
```

`test:tauri:engine` deserves a note. WebKitGTK has no DevTools protocol, so
there is no driver and no way to click Compile. It instead builds a variant
whose window opens `engine_check.html?autorun=1` — a self-contained page that
compiles an inline document and prints a verdict — and screenshots it. Look for
`✓ PASS · 2 PAGES`. The variant is a `--config` override, so no production code
carries test scaffolding, but **it leaves the release binary as the self-check
variant**; re-run `npm run build:tauri` afterwards.

This matters because `tauri dev` serves the frontend from a local http server
while a release build serves it from `tauri://localhost` with everything
embedded in the binary. Only the second is what users get, and until this
existed only the first had ever been exercised.

The two desktop backends are held to the **same** cases — path traversal,
symlink escape, creating through an escaping symlink, atomic overwrite, repeated
saves leaving no junk. Two shells writing to disk differently is two sets of
bugs.

**The gate is the project's contract.** It drives real Chrome over the DevTools
Protocol and compiles four real LaTeX projects, asserting exact page counts:

| Target | Engine | Pages |
|---|---|---|
| `cv` | pdfLaTeX | 2 |
| `book-legacy` | XeLaTeX | 14 |
| `book` | XeLaTeX + makeindex | 49 |
| `homework` | XeLaTeX | 27 |
| `missing-pkg` | — | must **fail**, naming `pgfornament.sty` |

That last row matters as much as the others: with a slim texmf, "package not in
the bundle" is the most likely failure, so the app naming it is a tested feature
rather than an error path.

Fixtures live in `../latex_project_tests/`. `test/serve.js` applies a small
in-flight patch overlay to `homework` (EPS logo → PNG, system fonts → Latin
Modern) so those source files stay pristine; the patches are printed in the log.

No test framework. `node:test` and a hand-rolled CDP client (`test/cdp.js`), to
match Revery Notebook's zero-test-dependency convention.

---

## Using your own TeX Live or MiKTeX

Settings → **LaTeX engine → System TeX Live**, on the desktop only. It closes
the two things the bundled engine cannot do: **biber**, which no WASM build has,
and packages outside the 62 MB slim bundle.

The bundled engine stays the default because it always works — no install, no
PATH, the same result on every machine.

This is the only code in the project that starts a process, and it runs on a
directory the user may have downloaded from anywhere. The rules, all tested:

| | |
|---|---|
| **Never `latexmk`** | It reads `latexmkrc` **from the working directory** and executes it as Perl. Opening someone else's project would run their code before a page was typeset. The engines are driven directly instead — more work, and the only safe version. |
| **Always `-no-shell-escape`** | `\write18` runs shell commands from inside the document. Restricted mode is the usual default; "usually" is not a security property. |
| **Fixed allowlist** | `pdflatex`, `xelatex`, `lualatex`, `bibtex`, `biber`, `makeindex`. A name, never a path — the frontend cannot ask for anything else. |
| **argv built in the backend** | The renderer names a tool and a file. It cannot pass a flag even if it wanted to, so the sandbox does not depend on the UI being careful. |
| **No shell anywhere** | PATH is searched by hand; an empty `PATH` entry (meaning `.`) is skipped, so a file named `pdflatex` in the project cannot become the compiler. |
| **Contained** | cwd pinned to the validated project root, `openout_any=p`, `openin_any=p`, hard timeout, output capped at 4 MB, stdin closed. |

Both shells implement this identically (`tauri/src/tex_run.rs`,
`electron/tex_run.js`) and a test asserts their argv and allowlists match, since
a document that compiles in one shell and not the other is undiagnosable.

## Known limits

- **No biber in the bundled engine.** No WASM build has it — ship a prebuilt
  `.bbl`, or switch to a system TeX Live on the desktop. `makeindex` works.
- **Fonts must be referenced by file, not by system name** — WASM has no host
  font database. `\setmainfont{Times New Roman}` cannot work.
- **No EPS.** That needs Ghostscript. Convert to PDF or PNG first.
- **Slim bundle**: a package outside it fails, by name, with a pointer to the
  fuller distribution. Widen `COMMON_PACKAGES` in the repacker and re-run the gate.
- **SyncTeX** is wired both ways (click the PDF, Ctrl+click the source) but has
  no highlighting of the matched region — it places the cursor and flashes a
  marker. Box nesting is parsed but discarded; restoring it is what a precise
  highlight would need.
- **Firefox and Safari cannot save to your files.** They have no File System
  Access API, so a project is imported from a zip into browser storage and
  exported back out as a zip. Browser storage can be cleared by the browser;
  the app requests persistence and says so in a standing bar, but Export is the
  only durable way out.
- **One project at a time in the zip backend.** Importing replaces what is
  stored, after a confirmation.
- **Tauri has no headless driver.** Our CDP client speaks Chrome's protocol,
  which WebKitGTK does not implement, so Tauri is verified by screenshot.
  Electron *does* speak CDP (`--remote-debugging-port`), and the full app —
  compile and save through the real IPC — is driven end to end there.

---

## Gotchas worth knowing before you change things

Each of these cost real debugging time:

- **`'wasm-unsafe-eval'` must be in every CSP** — `www/index.html`,
  `www/engine_check.html` and `tauri/tauri.conf.json`. Without it the engine
  simply refuses to start. Revery Notebook's configs omit it because they run no
  WASM; do not copy them verbatim.
- **Paths handed to the Web Worker must be absolute.** A relative path is
  re-resolved against the worker's own location, which is already inside
  `engine/dist/`, producing `engine/dist/engine/dist/busytex.js`.
- **Anything the app imports must live inside `www/`.** Tauri bundles only
  `frontendDist`; a file in `vendor/` is simply not there at runtime.
- **pdf.js `getDocument` detaches the buffer you give it.** Copy the bytes first
  if you still need them.
- **Never `pkill -f <pattern>`.** The pattern matches the invoking shell's own
  command line and kills your session. Resolve a PID and check it first.
- **VS Code terminals export `ELECTRON_RUN_AS_NODE=1`**, under which
  `electron .` boots as plain Node and every Electron API is `undefined`. The
  npm script unsets it; `main.js` also fails with the fix rather than a
  `Cannot read properties of undefined`.
- **Electron must serve the app over a custom protocol**, not `loadFile()`.
  Chromium refuses `fetch()` on `file://`, and the engine fetches its wasm and
  every data package, so a `file://` window cannot start the compiler at all.
- **`tauri build` (release) is memory-hungry** — LTO over 425 crates while
  embedding 97 MB. Use `tauri build --debug --no-bundle` and run nothing else.

---

## Layout

| Path | |
|---|---|
| `www/` | the entire app — every shell loads this folder |
| `www/engine/dist/` | TeX Live WASM + slim texmf, committed build output |
| `engine_upstream/busytex/` | 649 MB upstream release, gitignored — **outside `www/` on purpose** |
| `build_tools/` | texmf repacker, CodeMirror bundler, LZ4 codec extractor |
| `tauri/` | desktop shell; `src/main.rs` is the whole backend |
| `test/` | dev server, the gate, CDP client |
| `vendor/` | provenance copies of third-party source |
| `font/` | Harald Revery typefaces — **proprietary**, see below |

---

## Licensing

The code is **Apache-2.0**, but the shipped bundle is not homogeneous, and this
must be settled before any public release:

- **TeX Live binaries** (`busytex.wasm`) — pdfTeX, XeTeX and LuaTeX are **GPL-2+**.
  Invoked at arm's length across a Web Worker message boundary, the same
  relationship TeXstudio has to a TeX installation.
- **`texlyre-busytex`** wrapper — **AGPL-3.0**. Currently vendored. `TexEngine`
  exists partly so it can be replaced with an MIT wrapper over
  [`busytex/busytex`](https://github.com/busytex/busytex) if the licence matters.
- **pdf.js**, **CodeMirror**, **KaTeX** — Apache-2.0, MIT and MIT. Vendored
  into `www/` by `npm run vendor`; `npm test` fails if the copies drift from
  the versions in `build_tools/`.
- **Harald Revery fonts, logo and icons** — proprietary, not covered by
  Apache-2.0. See `font/FONT-LICENSE.txt`.
- **`www/image_assets/`** — the background photographs, also proprietary. They
  are the same brand assets Revery Notebook ships under its `LICENSE-ASSETS`,
  which permits use only within that software; they are here with the copyright
  holder's intent, and are not covered by Apache-2.0 either.
- Do **not** copy Overleaf's `lezer-latex` grammar; it is AGPL-3.0. The editor
  uses `stex` from `@codemirror/legacy-modes` for exactly this reason, which is
  why structural features work over document text rather than a parse tree.

A `NOTICE` covering the GPL and AGPL components must land before distribution.
