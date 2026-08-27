# Professional Letter Template — Revery TeX edition

An elegant, print-ready business letter that compiles in the Revery TeX
web app (busytex WASM engine) and unchanged on a desktop TeX Live.

## Files

```
letter_template/
├── main.tex     ← the whole letter (letterhead + body)
├── logo/        ← drop logo.jpg here (optional)
└── README.md
```

## Quick start

1. Open `main.tex` and edit the **LETTER METADATA** block at the top
   (sender, recipient, subject, references).
2. Overwrite the sample body paragraphs.
3. Compile — **one pass is enough** (a letter has no TOC/bibliography/index):

   ```
   xelatex main
   ```

   In Revery TeX this happens automatically when you open the project.

## Design

| Element      | Choice                                              |
|--------------|-----------------------------------------------------|
| Text font    | TeX Gyre Pagella (Palatino metrics, SIL OFL)        |
| Accent       | Deep navy `#1F3A5F`, light grey rules               |
| Layout       | Block style (no indent, spaced paragraphs), 1.05 leading |
| Page 1       | Letterhead, no header/footer                        |
| Page 2+      | Italic header (name · subject), centred page number |

## Customisation (all inside main.tex)

- **Paper format** — `\PaperChoice`: `A4` (default) or `USLetter`.
  Margins for each live in the `\GeomOpts` lines just below it.
- **Font size** — `\RootFontSize`: `10pt`, `11pt` (default) or `12pt`.
- **Alternative fonts** — commented blocks for TeX Gyre Termes, Schola,
  Bonum and Latin Modern. Uncomment one, comment the active block.
- **Line spacing** — `\setstretch` options in TYPOGRAPHY.
- **Letter spacing** — `LetterSpace` inside the `\setmainfont` block
  (units of 1/1000 em; 0 = font default).
- **Colours / black-only printing** — `AccentColor`, `RuleColor`,
  `MutedText` in COLOURS, with a commented black-only switch.
- **Logo** — put a PNG/JPG/PDF in `logo/` and point `\LogoPath` at it.
  A missing file is not an error: a placeholder rule is shown instead.

## Optional extras

- `\SubjectPrefix` — the marker before the subject line (`Re:` by
  default; `Ärende:`, `Betreff:` … or empty `{}` for a bare subject —
  see `letter_guide.md`).
- `\OurReference` / `\YourReference` — reference lines by the date.
- `\Enclosures{...}` / `\CopiesTo{...}` — footnotes at the end.
- `\LetterDate` — defaults to `\today`; hard-code e.g. `{24 August 2026}`.

New to letters? **`letter_guide.md`** in this folder explains what every
part is for, what differs between US and European conventions, and what
is universal.

**Every metadata field can be left empty `{}`** — the line (and its gap)
simply disappears from the letter and the file still compiles. This is
handled by the template's `\IfNonEmpty` guard, so you never need to
delete the layout code itself.

## Web-app constraints (why some things are the way they are)

- **XeLaTeX only** — no LuaLaTeX format ships in the browser engine.
- **No system fonts** — the WASM engine has no host font database, so
  `\setmainfont{Times New Roman}` stops the build. TeX Gyre fonts ship
  with the engine and are metric clones of the classic faces.
- **Swedish/other languages** — use polyglossia, not babel (commented
  example in the LANGUAGE section of main.tex).
- **No EPS/PS artwork** — convert to PDF/PNG/JPG first.
