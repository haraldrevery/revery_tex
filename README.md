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
npm install --prefix build_tools  # esbuild, CodeMirror, pdf.js

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
  | tar xz -C www/engine                      # 649 MB, gitignored
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
npm run serve &                                  # required by the gate
npm run gate                                     # the invariant: must stay 5/5
npm test                                         # fs_core (18) + zip_core (13)
cargo test --manifest-path tauri/Cargo.toml      # tauri/src/main.rs (19)

# The browser build, on a server that behaves like a real static host
REVERY_TEX_STATIC=1 PORT=8778 npm run serve &    # /api/* returns 404
node test/run_web_backends.js                         # import → edit → compile → export
```

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

## Known limits

- **No biber.** No WASM build has it. Ship a prebuilt `.bbl`; `makeindex` works.
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
| `www/engine/busytex/` | 649 MB upstream release, gitignored |
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
- **pdf.js**, **CodeMirror** — Apache-2.0 and MIT.
- **Harald Revery fonts, logo and icons** — proprietary, not covered by
  Apache-2.0. See `font/FONT-LICENSE.txt`.
- Do **not** copy Overleaf's `lezer-latex` grammar; it is AGPL-3.0. The editor
  uses `stex` from `@codemirror/legacy-modes` for exactly this reason, which is
  why structural features work over document text rather than a parse tree.

A `NOTICE` covering the GPL and AGPL components must land before distribution.
