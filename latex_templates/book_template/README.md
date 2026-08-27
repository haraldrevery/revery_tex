# Professional Book Template — Revery TeX edition

A sleek, print-ready book that compiles in the Revery TeX web app
(busytex WASM engine) and unchanged on a desktop TeX Live.

## Files

```
book_template/
├── main.tex            ← design + metadata + structure (edit the METADATA block first)
├── chapter/
│   ├── intro.tex       ← demo: text, lists, cross-references, citations, index
│   ├── chapter1.tex    ← demo: mathematics + theorems/proofs
│   ├── chapter2.tex    ← demo: figures & tables (longtable, multirow, wrapfig)
│   ├── code.tex        ← demo: source-code listings
│   ├── examples.tex    ← demo: quotes, verse, epigraphs, citation flavours
│   └── appendix.tex    ← appendix (numbered "Appendix A")
├── graphs/             ← drop plots here
├── illustrations/      ← drop artwork here
├── references/
│   └── reference.bib   ← your sources
├── logo/               ← optional emblem for the title page
└── README.md
```

## Quick start

1. Open `main.tex` and edit the **BOOK METADATA** block at the top:
   title, subtitle, author, year, publisher, ISBN, tags.
2. Write your chapters in `chapter/` and keep the `\include` lines in
   MAIN MATTER up to date.
3. Compile — **five passes are needed** because of TOC, bibliography
   and index:

   ```
   xelatex main → bibtex main → xelatex main → makeindex main → xelatex main
   ```

   In Revery TeX just press Compile — the app reads the preamble and
   drives every pass itself.

## Design

| Element     | Choice                                              |
|-------------|-----------------------------------------------------|
| Body font   | TeX Gyre Pagella (Palatino metrics, SIL OFL)        |
| Headings    | TeX Gyre Heros (Helvetica metrics), deep navy       |
| Accent      | Navy `#1F3A5F`, light grey rules                    |
| Layout      | twoside, chapters open recto, folios on outer edge  |
| Page numbers | roman in front matter, arabic from Chapter 1       |
| Back matter | numeric bibliography (citation order) + index       |

## Customisation (all inside main.tex)

- **Paper format** — `\PaperChoice`: `A4` (default), `B5`, `A5`,
  `USTrade`, `Letter`. Margins for each live in the `\GeomOpts`
  lines of the format dispatch just below it.
- **Font size** — `\RootFontSize`: `10pt`, `11pt` (default) or `12pt`.
- **Cross-references** — cleveref is loaded (after hyperref, as it
  requires): `\cref{label}` prints "fig. 4", "table 2", "chapter 3"
  with the type word included. `\Cref` capitalises; a Swedish-wording
  option is commented next to the load line in main.tex.
- **Letter spacing** — `LetterSpace` inside the font block
  (units of 1/1000 em; 0 = font default).
- **Line spacing** — `\setstretch` options in TYPOGRAPHY
  (default = the font's own leading).
- **Margins / binding gutter** — `\GeomOpts` per paper size;
  `bindingoffset` line commented in PAGE GEOMETRY.
- **Colours / black-only printing** — `AccentColor`, `RuleColor`
  in COLOURS, with a commented black-only switch.
- **Crop marks / bleed** — commented block in PAGE GEOMETRY;
  off by default, which most presses want.

## Print readiness

The book is built print-ready by default: correct recto/verso parity,
blank versos kept clean (`emptypage`), widow/orphan protection,
embedded fonts, PDF metadata filled from the METADATA block, and a
pre-flight checklist at the end of `main.tex`.

## Web-app constraints (why some things are the way they are)

- **XeLaTeX only** — no LuaLaTeX format ships in the browser engine.
- **No system fonts** — `\setmainfont{Times New Roman}` stops the
  build. TeX Gyre fonts ship with the engine; custom fonts work when
  loaded *by file* (`Path=./`) from beside `main.tex`.
- **No biber** — biblatex must use `backend=bibtex`, as configured.
  Delete any stale `main.bbl` if you change backends on desktop.
- **makeidx, not imakeidx** — the engine runs one plain makeindex pass.
- **Other languages** — use polyglossia (commented example in
  LANGUAGE & TYPOGRAPHY); babel's non-English language files do not ship.
- **No EPS/PS artwork** — convert to PNG/JPG/PDF first.
- **Harmless warning you can ignore:** every build ends with
  `Please (re)run BibTeX …` / `There were undefined references.`
  With `sorting=none` biblatex always asks once more; nothing is
  actually missing when the bibliography prints complete.
