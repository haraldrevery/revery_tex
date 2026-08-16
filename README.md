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

# Installers for whatever OS you are on
npm run installers                # .deb + .rpm on Linux, .msi + .exe on Windows
```

**The engine binaries are committed** (`www/engine/dist/`, ~172 MB), so a fresh
clone runs immediately. You only need the 649 MB upstream release if you want to
rebuild the texmf bundle — see [Rebuilding the TeX distribution](#rebuilding-the-tex-distribution).

> **`www/` contains only what ships.** Every shell loads that folder, and Tauri
> embeds *all* of it into the binary with no whitelist — so anything placed
> there reaches every user. Build inputs live beside it (`engine_upstream/`),
> never inside. This is enforced by a 200 MB size ceiling in
> `test/frontend_payload.test.js` (`www/` is ~186 MB), because it has already
> gone wrong once: the upstream tree sat in `www/engine/busytex/` and the Tauri
> `.deb` came out at 471 MB instead of ~105 MB.

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
│    background_image.js          your own picture, resized into a data URL   │
│  image_assets/                  background photographs — proprietary        │
│    math_preview.js              KaTeX, loaded on first use                   │
│    katex/                       vendored — see build_tools/vendor_assets.js  │
│    settings.js                  one declarative table: load, apply, menu     │
│    menus.js                     dropdown component (radio, stepper, action)  │
│    settings_boot.js             pre-paint theme, so there is no flash        │
│    pdf_preview.js               pdf.js canvas renderer                       │
│    codemirror-bundle.js         generated — edit build_tools/cm_entry_tex.js  │
│  engine/dist/                   TeX Live WASM + texmf (~172 MB, committed)   │
└──────────────────────────────────────────────────────────────────────────────┘
        │                                    │
        │ TexEngine.compile()                │ NativeAPI.readTextFile() …
        ▼                                    ▼
   WASM TeX Live 2026            tauri/src/main.rs  ·  electron/fs_core.js
   (Web Worker)                  same 10 operations, same containment rule
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

**`NativeAPI`** (`native_api.js`) — touches the filesystem. Ten calls, four
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

`writeBinaryFile` is the tenth call, added for files dragged in from the
desktop. It is separate from `writeFile` rather than a flag on it: every other
caller passes a string and means UTF-8, and one function deciding which it was
handed by sniffing the argument is one coercion away from writing
`[object Object]` over someone's figure. It carries no `expect` stamp either —
a dropped file has no read-time identity that could have gone stale, so the
caller refuses an existing path instead of racing it.

### The Files panel

Drag a row onto a folder to move it; onto the panel background to move it to the
project root. Rename and drag are the same operation and share one
`moveEntry()`, because two copies of its guards is how a drop ends up able to
move the main file that rename refuses to touch. A folder dropped into its own
descendant is refused — it is the one move that silently destroys a subtree.

Files dragged in from the desktop are added to the project. Everywhere *else* on
the page, a drop is cancelled and nothing happens: with no handler at all the
browser navigates to the dropped file, and the app — with any unsaved work in it
— is simply gone.

**Moving a file that something `\include`s asks first.** The move is a
filesystem operation and the `\include{chapter/problem_5}` naming it is text;
nothing keeps the two in step, and **LaTeX treats a missing `\include` as a
warning, not an error** — so the document still compiles, shorter, with no
failure anywhere to say why. The only visible sign is a page count. The warning
names the referencing files and lets you go ahead; it never rewrites your
source, because those paths are the author's text and come in several
spellings. `referencesTo()` in `document_model.js` answers the question from the
same include graph the outline is built from, so "what the document reads" and
"what a move would break" cannot disagree.

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

`build_tools/build_slim_texmf.js` repacks the upstream busytex release into the
**~140 MB** of texmf the app ships. The source is `texlive-extra` — TeX Live
2026's scheme-basic plus the latex, latexrecommended, latexextra, xetex, luatex,
fontsrecommended and fontutils collections, 23,881 files and 516 MB of virtual
stream.

The selection is **policy-driven**: keep the tree, minus a blocklist that has to
be argued for.

1. **Macros**: everything under `/tex/{latex,generic,xelatex,plain}/`, minus
   ~29 blocked directories. The macro tree is 227 MB and violently top-heavy —
   `utfsym` 14 MB, `openmoji` 13 MB, `worldflags` 11 MB, and so on down through
   emoji, flag and icon sets. Blocking those, plus a few obsolete or
   external-tool-driven packages, removes 109 MB and leaves essentially every
   real LaTeX package.
2. **Fonts**: the whole `/fonts/` tree, minus `cm-super` (57 MB of Type 1 EC
   Computer Modern that Latin Modern supersedes) and `libertine` (17 MB for one
   family). Whole-tree rather than per-directory because fontconfig resolves a
   family by *scanning*, and never opens the files it rejects.
3. **BibTeX and makeindex**: kept whole. 2 MB.
4. Drop `.afm` (Type 1 metrics only `fontinst` reads), `/source/`, `/doc/`.
5. `/tex/context/`, `/tex/luatex/`, `/tex/lualatex/` and `/tex/latex-dev/` are
   excluded: no LuaTeX format ships, so they are unreachable code.

`build_tools/texmf_trace.json` — the 309 files the gate fixtures actually
opened — is still read, but it no longer selects anything. It is now an
assertion: the build fails if the policy would exclude a file the gate opens, or
if a blocked directory contains one. `COMMON_PACKAGES` works the same way, as a
regression check that the blocklist has not eaten something real.

**This replaced a trace-driven selection, and the reason is the point.** The
bundle used to be built from a trace of the five gate fixtures, and the gate
then compiled those same five fixtures — so 5/5 only ever proved the bundle
covered itself. It kept **87 of 2,270** LaTeX package directories whole and
shipped 10 more half-present: `amsmath` 9/18 files, `pgf` 200/481, `tools`
51/104, the LaTeX kernel's own `base/` 170/479. `beamer`, `koma-script`,
`memoir`, `polyglossia`, `glossaries-extra` and `tabularray` were absent
outright. A half-present package does not fail cleanly; it fails later, in
someone else's document.

Output is **seven data packages**, each under the 50 MB git limit — a logical
part over 45 MB of virtual bytes is split into `-1`, `-2`, … by
`splitPart()`. **All seven are preloaded**, and that is load-bearing rather than
lazy: see [Why everything is preloaded](#why-everything-is-preloaded).

The build is **deterministic** — rebuilding produces byte-identical output, so
committed binaries do not bloat history. It also deletes parts a previous build
wrote that this one did not, because part names come from the policy and Tauri
embeds all of `www/` with no whitelist.

### Why everything is preloaded

busytex supports a *catalog*: data packages fetched and mounted on demand
instead of at startup. The manifest still has the field. It is empty, and must
stay empty.

`busytex_pipeline.js` mounts a catalog package only when a document has at least
one **unresolved** `\usepackage`, and it finds those by matching lines that
*start with* `\usepackage` in the **main file only** — never `\documentclass`,
never `\RequirePackage`, never an `\include`d file. So a beamer deck whose
preamble has no `\usepackage` resolves cleanly to nothing, mounts nothing, and
fails on `beamer.cls` while `beamer.cls` sits in the bundle.

That is measured, not theorised: putting the macro tree in the catalog broke
`beamer`, `scrartcl` and `memoir` while every gate fixture stayed green, because
every gate fixture happens to have a `\usepackage`.

The same reasoning is why the `// \ProvidesPackage{…}` index at the head of each
data package is stripped. That index is what the resolver matches against; with
it absent nothing resolves and the pipeline's own "enable all" fallback does the
right thing. Restoring it — which looks like an obvious optimisation — switches
selectivity back on. `test/engine_catalog.test.js` fails if either mechanism
comes back.

Preloading costs nothing real, because the fallback already mounted everything
for any document that triggered a mount at all.

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
npm run installers                               # builds and verifies — see below
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
| `bibtex` | pdfLaTeX + bibtex8 | 1, and the citations must resolve |
| `missing-pkg` | — | must **fail**, naming `biblatex-apa.sty` |

The last two rows matter as much as the others. "Package not in the bundle" is a
failure users will hit, so the app naming it is a tested feature rather than an
error path.

`missing-pkg` uses `biblatex-apa` because that package is not in the busytex
source bundle *at all* (it is `collection-bibtexextra`), so no repacker policy
can make it appear. It used to name `pgfornament`, which the slim bundle merely
excluded — and when the selection widened, `pgfornament` started shipping and
the fixture would have quietly begun passing where it was supposed to fail.
A must-fail fixture has to name something structurally unreachable.

And `bibtex` is there because a page count is not always enough: a document with
no `.bst` still typesets, at the right length, with `[?]` where every citation
should be. So that row also asserts what the log must **not** contain
(`rejectLog` in `test/serve.js`) — no missing style file, no undefined citation.
It exists because classic BibTeX was broken in every shipped bundle and five
green page counts said nothing about it.

Fixtures live in `../latex_project_tests/`. `test/serve.js` applies a small
in-flight patch overlay to `homework` (EPS logo → PNG, system fonts → Latin
Modern) so those source files stay pristine; the patches are printed in the log.

### The coverage probe — the question the gate cannot ask

```bash
npm run serve &
node test/run_coverage.js
```

**Deliberately not part of `npm run check`.** The gate is a contract about five
specific documents; this asks the opposite question — does the bundle cover
LaTeX that nobody here wrote? It compiles beamer, koma-script, memoir,
polyglossia, TikZ libraries, siunitx, tabularray, glossaries-extra and
unicode-math, and asserts both that a PDF came out *and* that the log carries no
`Missing character`, no undefined font shape and no missing file.

It exists because that question had no answer for a long time, and the answer
turned out to be bad. The texmf bundle was selected from a kpathsea trace of the
gate's own fixtures, so a green gate only ever proved the bundle covered itself;
`beamer`, `scrartcl` and `memoir` could not compile at all while every suite was
green. Both halves of each assertion are load-bearing — a missing glyph produces
a PDF of exactly the right length.

No test framework. `node:test` and a hand-rolled CDP client (`test/cdp.js`), to
match Revery Notebook's zero-test-dependency convention.

---

## Building installers

```bash
npm run installers                # every installer this machine can build
```

Both shells, then a verification pass. What comes out depends on the OS you run
it on:

| Host | Shell | Artifacts |
|---|---|---|
| Linux | Tauri | `tauri/target/release/bundle/deb/`, `.../rpm/` |
| Linux | Electron | `dist-electron/*.deb`, `dist-electron/*.rpm` |
| Windows | Tauri | `tauri/target/release/bundle/msi/`, `.../nsis/` |
| Windows | Electron | `dist-electron/*.msi`, `dist-electron/*Setup*.exe` |

The `.exe` is an NSIS installer — there is no bundler target named `exe`. It is
not one-click: 200 MB deserves a progress bar and a directory choice. It
installs per-user, so it needs no elevation.

Narrow it to one shell when you only want the one:

```bash
npm run installers -- tauri       # ~105 MB deb; www/ embedded in the binary
npm run installers -- electron    # ~200 MB deb; www/ as files beside the exe
npm run verify:installers         # re-check what is already built
```

Three things about the command are deliberate.

**It is host-native.** Tauri needs the MSVC toolchain to produce a Windows
binary and cannot cross-build to one, so Windows installers come from a Windows
machine or a Windows CI runner. There is no flag to fake it — a command that
appeared to work and emitted an installer nobody could run would be worse than
not having one. macOS exits with a message rather than a build; there is no
`mac:` block in `electron-builder.yml` to build against.

**It builds one shell at a time.** `rpmbuild` on this payload peaks around
2.3 GB and runs multithreaded. A Tauri release build alongside it has taken the
machine down. Tauri goes first, so a failure surfaces before the slow half.

**It checks the version before it starts.** The version lives in four files that
no tool keeps in agreement (`package.json`, `tauri.conf.json`, `Cargo.toml`,
`Cargo.lock`) and `npm run version:set 0.2.0` is what moves them together. The
moment before packaging is the last one where drift is still cheap; after it,
it is an installer, a window title and an about box claiming three numbers.

Verification is `test/verify_installers.js`: no upstream busytex tree, engine
actually present, no source maps or tarballs, size in range. On Linux it reads
the real file list out of the package. On Windows it can only check size — an
NSIS installer carries the app as a nested archive, so there is no listing to
assert against, and size is what catches both a package that grew by a whole
directory and one that lost the engine.

The target lists live in `build_tools/build_installers.js`; `test/build_installers.test.js`
pins both halves, because on any given machine only one of them ever runs.

---

## Using your own LaTeX installation

Settings → **LaTeX engine → System LaTeX (TeX Live or MiKTeX)**, on the desktop
only. It closes the two things the bundled engine cannot do: **biber**, which no
WASM build has, and packages outside the bundle — see Known limits for what is
genuinely unreachable.

**The app offers this rather than waiting to be found.** On desktop it runs
detection once, and if a LaTeX installation is on PATH it says so in the standing
bar with a button to switch; declining is remembered (`systemTexAsked`) so it is
not asked again. And when a compile hits a wall the bundled engine cannot pass —
a class that is not in the distribution, or fonts it omits — the failure names
the setting that clears it and offers the switch inline.

That offer is feature-detected like everything else: `canOfferSystem()` in
`engine_host.js` requires both the shell methods (`detectTex`, `runTex`) and a
project on disk, because a system TeX cannot compile a project that exists only
in memory. In a browser it can never appear, which `npm run test:web` asserts.

Both packagers build `deb` and `rpm` on Linux and `msi` and `exe` on Windows —
see [Building installers](#building-installers). The lookup is the same
hand-walked PATH search in either shell, so it finds a TeX Live or a MiKTeX
wherever the platform puts it; on Windows it accepts `.exe` and nothing else,
matching `tauri/src/tex_run.rs`, so a `.bat` or `.cmd` on PATH cannot become the
compiler.

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

- **No biber in the bundled engine.** No WASM build has it, because biber is
  Perl. Three ways round it, and the app names all three in the log: ship a
  prebuilt `.bbl`, set `\usepackage[backend=bibtex]{biblatex}` so bundled
  bibtex8 builds it (weaker sorting, name handling and UTF-8 — it is biblatex's
  legacy backend), or switch to a system LaTeX on the desktop. Classic
  BibTeX and `makeindex` both work as they are.
- **Fonts must be referenced by file, not by system name** — WASM has no host
  font database. `\setmainfont{Times New Roman}` cannot work.
- **`\usepackage[T1]{fontenc}` with default Computer Modern needs `lmodern`.**
  T1 routes to the EC fonts, and `pdftex.map` maps all 396 `ec*` entries to
  cm-super outlines, which the bundle omits — 409 Type 1 files, 57 MiB, and
  measured to compress at **ratio 0.996**, so they would cost the full 60 MB,
  more than the entire 2,000-package macro tree. Nothing redirects `ec*` to Latin
  Modern: the `ec-lm*` map entries are Latin Modern's own EC-encoded fonts under
  different TFM names, reachable only when a document loads `lmodern`.

  The document typesets completely and dies while the PDF is being written, so
  the raw error (`cannot open encoding file`) points nowhere useful. The app
  recognises it and says what to do: add `\usepackage{lmodern}` — same encoding,
  ships here — or switch to a system LaTeX.
- **A prebuilt `.bbl` from a different biblatex corrupts the document silently.**
  With no biber, projects ship a `.bbl`; if its format version does not match the
  bundled biblatex, biblatex typesets the raw database as body text
  (`family=Einstein, giveni=A. M., author1hash=…`) and **still exits 0**. The
  `book` fixture does exactly this and the gate calls it PASS at 49 pages,
  because corrupt text does not move a page boundary. `engineLimits()` in
  `latex_log.js` reports it as an error despite the successful compile.
- **No EPS.** That needs Ghostscript. Convert to PDF or PNG first.
- **Some packages are not in the upstream source bundle at all**, so no
  repacker policy can ship them. busytex builds scheme-basic plus the latex,
  latexrecommended, latexextra, xetex, luatex, fontsrecommended and fontutils
  collections — nothing from `collection-mathscience`, `collection-bibtexextra`,
  `collection-publishers` or any `collection-lang*`. In practice that means:
  - `physics`, `mhchem`, `chemformula`, `algorithm2e`, `algorithms`,
    `algorithmicx`. These sat in `COMMON_PACKAGES` for a long time, advertised
    in the shipped manifest, matching zero files and saying nothing.
  - **babel's language files.** `\usepackage[ngerman]{babel}` fails with
    `Unknown option`, because `babel-german` and its siblings are
    `collection-langgerman` and friends. Babel's core is present, so this looks
    like a broken option rather than a missing package. **Use `polyglossia` with
    XeLaTeX instead** — it ships complete, including `gloss-german.ldf`.
  - Journal classes: `revtex`, `IEEEtran`, `acmart`, `elsarticle`.

  These are listed in `NOT_IN_SOURCE_BUNDLE` in the repacker, which fails the
  build if one of them ever does turn up. Adding them means teaching the
  repacker a second source bundle.
- **Missing characters are a font question, not a bundle question.** A glyph the
  document's chosen font lacks is dropped with a `Missing character` line in the
  log and no error — the `book` fixture loses `Ω № İ ƒ ¾ ⅔ ⅛ ⅓ ®` to Latin
  Modern this way, and widening the font set does not change it, because the
  document still asks for Latin Modern. The app does not currently surface these
  on a successful compile.
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
- **`'unsafe-inline'` must be in none of them except `engine_check.html`**, which
  is a self-contained page with a real inline `<script type="module">` that
  Tauri hashes at bundle time. `index.html` has no inline script and no inline
  handler — it carried the grant anyway, which meant the browser build ran with
  its main XSS protection off while the desktop build did not. The three CSPs
  drifting apart is only ever visible at runtime, in one shell.
- **`dragDropEnabled` is `false` in `tauri.conf.json`, deliberately.** With it on
  — which is Tauri's default, and what this config was copied with — Tauri
  installs its own drag-and-drop handler on the webview and emits a Rust-side
  event instead. Nothing in `tauri/src/` ever listened for that event, so
  dropping a file on the window did nothing at all, *and* the handler competed
  with the HTML5 drag-and-drop the file tree is built on. Turning it off gives
  the webview its native behaviour back. Do not turn it on again without adding
  a Rust listener that does something.
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
  embedding ~172 MB. Use `tauri build --debug --no-bundle` and run nothing else.

---

## Layout

| Path | |
|---|---|
| `www/` | the entire app — every shell loads this folder |
| `www/engine/dist/` | TeX Live WASM + slim texmf, committed build output |
| `engine_upstream/busytex/` | 649 MB upstream release, gitignored — **outside `www/` on purpose** |
| `build_tools/` | texmf repacker, CodeMirror bundler, LZ4 codec extractor, installer build |
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
