# latex_stress_test

Purpose-built LaTeX projects for the test suite. **Inside the project root, on
purpose** — the older fixtures live in a sibling repo at
`../latex_project_tests`, and everything below is a reaction to what that cost.

These do not replace those. Real-world documents catch things nobody would think
to write down: proprietary fonts, EPS logos needing Ghostscript, a `.bbl` from a
biblatex two versions old. Purpose-built fixtures only ever test what somebody
thought of. Both are worth having; this directory is the half that can be
*relied* on.

## Why these are more reliable than a sibling repo

Each of these is a failure that actually happened, not a hypothetical.

- **They version with the code that reads them.** A fixture and the test that
  asserts on it can be one commit, so `git bisect` means something. When the
  book templates shipped a committed `main.bbl`, the fixture and the test
  disagreed for as long as they did partly because no single history contained
  both.
- **They are always present, so nothing silently skips.** `bib_detect.test.js`
  guards on `fs.existsSync(FIXTURES)`. On a machine without the sibling repo
  those tests do not fail — they vanish, and the suite reports green while
  proving less. Nothing here can do that.
- **They need no patching to compile.** `test/serve.js` rewrites the `homework`
  fixture's fonts and logo *in flight* before it will build, which means the
  thing under test is not the thing on disk. Everything here compiles exactly as
  committed, on the bundled engine.
- **They are small.** The sibling repo is 193 MB, most of it committed PDFs, an
  EPS logo and zip archives of itself. This directory is a few tens of KB.
  Structural complexity comes from text, never from megabyte assets.
- **Nothing here is asserted by page count.** See below — this is the big one.

## The rules

**No build output, ever.** `.aux`, `.bbl`, `.ind`, `.log`, `.pdf`, `.toc` and
friends are gitignored here. A committed `.bbl` is not a shortcut, it is a
time bomb: bibtex8 rebuilds it on every compile, so the committed copy only goes
stale, and biblatex *rejects* a `.bbl` written by a different version outright —
every citation silently becomes undefined. That is exactly what went wrong with
the book templates.

**Compile in a scratch copy, never in place.** The gate is safe by construction:
it reads these into a manifest and compiles in the engine's in-memory VFS,
touching nothing on disk. A system-TeX run is not — it writes beside the
sources. That is how the sibling repo ended up with a tracked `main.pdf` and
`main.aux` permanently modified. Copy out, then compile.

**Assert on invariants you authored, not on what a compile happens to produce.**
A page count is a function of font metrics and the texmf version, not of
correctness. `homework` in the sibling repo was pinned at 27, its own comment
recorded a 28-page reference build, and it produces 26 — three numbers, none of
them wrong, none of them a bug, and one red gate. It is unpinned now, and the
cause is worth knowing because it is the general case: a figure was deleted from
`chapter/problem_5.tex` without its prose, so three `\cref`s point at labels
nothing defines. The page count was the *symptom*; no page count could have said
that. So nothing here is pinned by page count.
What is asserted instead: file counts, nesting depth, include-chain length,
which bibliography tool is inferred, whether a citation resolved, and which
*line* a diagnostic points at.

**Bundle-safe packages only.** No system fonts, no EPS, no shell-escape. If it
does not build on the slim texmf the app ships, it does not belong here.

**`\usepackage{lmodern}` before `[T1]{fontenc}`.** Not a preference — a bundle
constraint, and one these fixtures found. `[T1]{fontenc}` on pdflatex reaches
for cm-super, whose `cm-super-t1.enc` is not in the slim texmf, so every fixture
here died with `cannot open encoding file` on the bundled engine while compiling
perfectly on a full system TeX Live. Nothing in the sibling repo had exercised
that combination, so nothing had ever caught it. Latin Modern supplies T1 Type1
fonts and does ship. **Verify on the bundled engine, not only on your own TeX** —
a system TeX Live is a far bigger installation than what the app carries.

**The line after a `STRESS-*` marker is the line the tool must report.** That
contract is what makes the failure fixtures assertable without hardcoding line
numbers that break every time someone edits a comment.

## The fixtures

| Directory | Compiles? | What it stresses |
|---|---|---|
| `deep_structure/` | yes | 67 files, 20 directory levels, a 40-chapter `\include` chain, a three-deep `\input` chain, and a filename containing spaces |
| `bib_and_index/` | yes | biblatex on `backend=bibtex` (bibtex8, since no WASM build has biber) plus `makeindex` — two tools that each write a file the next pass reads back |
| `bib_classic/` | yes | classic `\bibliographystyle`/`\bibliography`, the other branch `inferBibTool` has to tell apart |
| `broken_on_purpose/main.tex` | **no, by design** | one undefined control sequence, so the reported line can be checked against the source |
| `broken_on_purpose/undefined_reference.tex` | yes | an undefined reference and an undefined citation — warnings, not errors, which is the distinction a log parser most often gets wrong |
| `encoding/main.tex` | yes | UTF-8 across Nordic, continental, punctuation and maths |
| `encoding/latin1.tex` | not input | genuinely non-UTF-8 bytes, for the refusal path |

`deep_structure/` is deliberately 20 levels deep. `readDirectory` in both
desktop backends stops at 16 and says nothing, so the four levels past the cap
are there to make that truncation visible instead of theoretical.

## Running them

Structural and encoding assertions are plain unit tests and always run:

    npm test

The ones that need a real compile go through the gate by name. They are
deliberately *not* in the gate's default set — that list is a fixed contract:

    node test/serve.js &
    npm run gate:stress
