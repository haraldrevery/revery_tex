# Homework / report template — browser-safe

A complete assignment report you can compile in Revery TeX with nothing
installed, then edit into your own. Everything it names — every package, every
font, every image — exists inside the bundled WASM TeX Live, so it builds in the
browser and on a desktop TeX Live from the same source.

The text and figures are placeholders. They are there so the PDF looks like a
finished report rather than an empty skeleton: a short numerical-methods write-up
with derivations, figures, tables, an algorithm, code listings and a
bibliography. Delete a chapter and write your own over its structure.

**Compile:** `xelatex main` twice — the second pass resolves `\cref`, the table
of contents and the figure/listing numbers. In the app, just press Compile; it
detects XeLaTeX from `fontspec` and reruns for you.

## Edit these first

Everything that makes the document *yours* is in one block at the top of
`main.tex`:

```latex
\newcommand{\AssignmentTitle}{Sample Report}
\newcommand{\AssignmentSubtitle}{Curves, Attractors and Iteration}
\newcommand{\AuthorName}{Your Name}
\newcommand{\AuthorID}{Student ID}
\newcommand{\CourseName}{Course Name}
\newcommand{\CourseCode}{ABC123}
\newcommand{\LogoPath}{graphs/rose_curves.png}
\newcommand{\Organisation}{Your University}
```

`\LogoPath` is wrapped in `\IfFileExists` on the title page, so pointing it at a
file that is not there leaves the space empty instead of breaking the build.
Drop your own PNG, JPG or PDF into `logo/` and name it here.

## The four constraints

Keep these in mind when editing, or the file stops being web-renderable:

| | |
|---|---|
| **XeLaTeX only** | No LuaLaTeX format ships in the browser engine. `fontspec` and `unicode-math` work; anything LuaTeX-specific does not. |
| **No system fonts** | WASM has no host font database, so `\setmainfont{Times New Roman}` cannot work — it stops the build rather than substituting. A font has to come from the TeX distribution itself. |
| **No EPS / PS** | Converting EPS needs Ghostscript, which is not there. Use PNG, JPG or PDF. Run `epstopdf` on anything you inherit. |
| **No biber** | Classic BibTeX (`\bibliography{}`) and `makeindex` both work. For biblatex, write `\usepackage[backend=bibtex]{biblatex}`. |

Two more that follow from the same place, and cost the most time when they bite:

- **No algorithm package.** `algorithm2e`, `algorithm` and `algpseudocode` are
  not in the bundle. `main.tex` therefore builds an `algorithm` float out of
  `float.sty`, which is bundled — see the block after `cleveref`, and
  `chapter/problem_3.tex` for it in use.
- **`\usepackage[swedish]{babel}` fails.** babel's core ships but its language
  files do not. Use `polyglossia` instead; the preamble shows the two lines.

## What is where

| Path | What it holds |
|---|---|
| `main.tex` | Variables, preamble, title page, and the `\include` list. The only file that loads a package. |
| `chapter/problem_1.tex` … `problem_4.tex` | Four worked problems — derivations, figures, tables, an algorithm float. |
| `chapter/problem_5.tex` | The cheat sheet: every element the template supports, once each, with a comment above it. Copy blocks out of here. |
| `chapter/appendix.tex` | Supplementary figures, showing the `S`-prefixed numbering that `\supplementarysection` turns on. |
| `chapter/code.tex` | Full source listing, with its own `S`-prefixed listing counter. |
| `reference/manuellreferens.tex` | The bibliography as a hand-written `thebibliography` — good up to ~10 sources. |
| `reference/references.bib` | The six sources this report cites, plus a sample entry of each common type, for when you outgrow the manual list. |
| `graphs/` | The eight placeholder plots. Swap your own in and update the `\includegraphics` paths. |
| `vancouver.bbx`, `vancouver.cbx` | The Vancouver style for biblatex — see below. Keep them here, beside `main.tex`. |
| `LICENSE-biblatex-vancouver.txt` | GPL-3.0, the licence those two files are under. |

## Vancouver references

Many courses ask for Vancouver, and it is the one style that looks impossible
here. There is no `vancouver.bst` to reach for — that file is not in TeX Live
at all, on any install; the copies in circulation come from journals. The
biblatex style that does exist, `biblatex-vancouver`, is in
`collection-bibtexextra`, which the browser engine does not build. It still
works, because of how the engine reads a project.

The engine compiles with *your project folder as the working directory*, and
TeX searches the working directory before anything else. So a style file
carried inside the project is found exactly as if it were installed. That is
why `vancouver.bbx` and `vancouver.cbx` sit next to `main.tex` — **not** in a
subfolder, which is not searched.

To switch on:

1. Uncomment these two lines in the preamble of `main.tex`:
   ```latex
   \usepackage[backend=bibtex, style=vancouver]{biblatex}
   \addbibresource{reference/references.bib}
   ```
2. In the References block further down, delete
   `\include{reference/manuellreferens}` and uncomment
   `\printbibliography[heading=bibintoc]`. The `heading=bibintoc` part is what
   keeps "References" in the table of contents.

The five sources the chapters cite are already in `reference/references.bib`,
so nothing else has to change. You get numbered references in citation order,
family name first, terse initials and compressed page ranges — real Vancouver.

`backend=bibtex` is not optional. biblatex defaults to `backend=biber`, and no
WebAssembly build of biber exists — it is a Perl program. Classic BibTeX is
compiled into the engine, and the app runs it as soon as it sees
`\printbibliography`.

The style's own `\RequireBiber[2]` line looks like it should stop this, and
does not: biblatex only refuses when a style demands a biber level *above* 2.

### What is different from a biber build

Three things, none of which stops the compile:

- `\DeclareSourcemap` normalises the punctuation of journal titles by regex.
  Source mapping is work biber does before typesetting, so your `.bib` entries
  are used exactly as written — abbreviate journal names yourself.
- The `[Accessed on: ...]` date after a URL can come out partial, because
  classic BibTeX parses dates far more crudely than biber does.
- **The log keeps asking you to re-run BibTeX, on every pass, forever** —
  `Please (re)run BibTeX` and `There were undefined references`. The
  bibliography is correct; the messages never clear. This is `sorting=none`,
  which is exactly what numbers the references in citation order, so for
  Vancouver it cannot be turned off. It is not this style's fault either:
  plain `style=numeric, sorting=none` on the BibTeX backend does the same, and
  every other sorting scheme is silent. The practical cost is that Revery TeX
  keeps running its full three passes rather than stopping when the document
  settles — the same three passes this template needs anyway.

Everything that makes it recognisably Vancouver — numbering in citation order,
family name first, terse initials, every author listed, compressed page ranges,
the punctuation — is applied while the page is typeset, and is unaffected.

Not an option here: the `citation-style-language` package with `vancouver.csl`.
It needs LuaLaTeX, and only the pdfLaTeX and XeLaTeX formats ship.

### Licence and credit

`vancouver.bbx` and `vancouver.cbx` are verbatim copies from the
**biblatex-vancouver** package by Agnibho Mondal
(<https://code.agnibho.com/biblatex-vancouver/>), Copyright © 2020, released
under the **GNU General Public License v3.0 or later**. Neither file has been
modified. The full licence text is in `LICENSE-biblatex-vancouver.txt`; if you
redistribute this template, keep both the notices in those files and that
licence copy alongside them. Parts of the style are adapted from
`biblatex-nejm`. The rest of this template is not affected by that licence.

## Fonts

The active block is TeX Gyre Termes / Heros / Cursor plus TeX Gyre Termes Math.
Those are metric clones of Times New Roman, Arial and Courier New — same advance
widths, same line breaks, same page count — so a "Times New Roman or Arial, 12pt"
course requirement is met by them, and side by side the difference is close to
invisible. All are SIL Open Font Licence and all ship with TeX Live, so the file
also builds unchanged on your desktop.

The preamble lists the other bundled alternatives (Latin Modern, TeX Gyre
Pagella / Bonum / Schola) and keeps the proprietary and non-bundled options
below a heading marking them desktop-only. Uncomment one block, comment out the
active one.
