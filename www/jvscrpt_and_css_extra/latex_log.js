// Reading a LaTeX log.
//
// Shared by both engines. The WASM engine and a system TeX Live produce the
// same log format, so parsing it twice would only mean two sets of diagnostics
// bugs — and the Issues tab would quietly disagree with itself depending on
// which engine was selected.
//
// Deliberately conservative: the raw log stays the source of truth and this is
// only an index into it. With a slim texmf the interesting failures are exactly
// the ones a parser drops, which is why the app never ships a parsed-only view.

/**
 * The column TeX flushes its log buffer at when `max_print_line` is unset.
 *
 * Both desktop shells set it to 1000 (electron/tex_run.js, tauri/src/tex_run.rs).
 * The bundled WASM engine has no environment to set it in — busytex builds its
 * own argv and env inside a generated file — so its log is always wrapped here.
 */
const WRAP_COLUMN = 79;

/**
 * The log as TeX *meant* it, with its two kinds of continuation joined.
 *
 * Everything below matches against `$`, and a diagnostic split across two
 * physical lines therefore lost whatever fell off the end — which for
 * `… on input line 40.` is the entire reason the Issues row is clickable. The
 * row did not look wrong when that happened; it silently stopped being a link.
 *
 * Two joins, both of them TeX's own doing:
 *
 *   - A line of *exactly* `max_print_line` characters is a buffer flush, not a
 *     line ending. Only applied when the log actually looks wrapped — a native
 *     log runs to 1000 columns, so a coincidental 79-character line in one must
 *     not glue the next line onto it. One line longer than the column is proof
 *     the wrapping is not happening, and a real log is full of them: the
 *     `(/usr/local/texlive/…/base/article.cls` lines alone settle it.
 *   - `(pkgname)` followed by two or more spaces is how LaTeX continues its own
 *     warnings, and it does that at *any* `max_print_line` — this is not
 *     wrapping, it is the format. `on input line N` lands on such a line 23
 *     times across the four projects in latex_project_tests, e.g.
 *
 *         Package hyperref Warning: Token not allowed in a PDF string (…):
 *         (hyperref)                removing `math shift' on input line 99.
 *
 *     The prefix is dropped rather than kept, so the message reads as one
 *     sentence. It cannot be confused with a file-open line: `(./main.tex` has
 *     no closing paren, and `(…/article.cls)` has no two spaces after one.
 *
 * The raw log is untouched and stays the source of truth — this is only what
 * the patterns below get to look at.
 */
function unwrapLogLines(log) {
  const lines = String(log || '').split('\n');
  const wrapped = !lines.some(l => l.length > WRAP_COLUMN);
  const out = [];
  // The length of the last *physical* segment, tracked separately because once
  // a join has happened the accumulated line is longer than the column and
  // testing it would swallow a third, unrelated line.
  let lastRaw = 0;

  for (const raw of lines) {
    const cont = /^\([A-Za-z][\w@-]*\)\s{2,}(\S.*)$/.exec(raw);
    if (out.length && cont) {
      out[out.length - 1] += ' ' + cont[1];
    } else if (out.length && wrapped && lastRaw === WRAP_COLUMN) {
      out[out.length - 1] += raw;
    } else {
      out.push(raw);
    }
    lastRaw = raw.length;
  }
  return out;
}

/**
 * Package names a compile complained were missing.
 *
 * With a slim texmf this is the most likely failure, so it must be named rather
 * than buried in 4000 lines of log — the gate has a fixture that must fail and
 * say `pgfornament.sty`. A system TeX rarely hits this, but it uses the same
 * parser so the message is identical either way.
 *
 * Reads the unwrapped log: a filename that fell across the 79-column flush was
 * unmatchable, which is the one failure mode this function exists to prevent.
 */
export function missingPackages(log) {
  const found = new Set();
  log = unwrapLogLines(log).join('\n');
  const patterns = [
    /(?:File|Package) [`'"]?([\w@.-]+\.(?:sty|cls|def|fd|cfg))['"`]? not found/gi,
    /! LaTeX Error: File [`'"]([^'"`]+)['"`] not found/gi,
    /Package fontspec Error:[\s\S]{0,80}?The font "([^"]+)" cannot be found/gi
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(log || ''))) found.add(m[1]);
  }
  return [...found];
}

/**
 * The first `! ...` line, which is usually the failure worth showing.
 *
 * Unwrapped, because this one becomes the status line: a message cut off at
 * column 79 is exactly the half a reader needs least.
 */
export function firstTexError(log) {
  for (const line of unwrapLogLines(log)) {
    const m = /^! (.+)$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Structured errors and warnings, in log order, deduped.
 *
 * One ordered walk rather than the four independent `matchAll` passes this used
 * to be. The passes could not see each other, and TeX puts the single most
 * useful fact about an error — the line it was reading — on the line *after* it:
 *
 *     ! Undefined control sequence.
 *     l.1 \section
 *                 {Conclusion}
 *
 * Nothing read `l.NNN`, so under the bundled engine (which passes no
 * `-file-line-error`) errors carried no line at all and the Issues panel would
 * not make them clickable — while warnings, which do say `on input line N`,
 * were. Errors are the rows a reader wants to click, so that was backwards.
 *
 * A walk also means the output is in log order instead of grouped by which pass
 * happened to find it, which is what a reader scanning down the panel expects.
 */
export function parseLatexLog(log) {
  const out = [];
  // The last error still waiting for its `l.NNN`. Cleared by anything else, so
  // a context line can only ever attach to the error directly above it.
  let pending = null;

  for (const line of unwrapLogLines(log)) {
    const ctx = /^l\.(\d+)(?:\s|$)/.exec(line);
    if (ctx) {
      if (pending && pending.line == null) pending.line = Number(ctx[1]);
      pending = null;
      continue;
    }

    // -file-line-error puts the location first, and is the only shape that
    // names a file: main.tex:12: Undefined control sequence
    let m = /^([^\s:]+\.tex):(\d+):\s*(.+)$/.exec(line);
    if (m) {
      out.push({ severity: 'error', package: null, message: m[3].trim(), line: Number(m[2]), file: m[1] });
      pending = null;   // it already has a line; the l.NNN below it adds nothing
      continue;
    }

    // `! LaTeX Error:` / `! Package foo Error:`, then a bare `! Emergency stop.`
    // These two are tried in order rather than independently: a line like
    // `! Undefined Error: x` satisfies both, and as separate passes it produced
    // two rows for one error with two different messages.
    m = /^! (?:LaTeX|Package|Class)?\s*(?:([\w@-]+) )?[Ee]rror:?\s*(.*)$/.exec(line);
    if (m) {
      pending = { severity: 'error', package: m[1] || null, message: (m[2] || '').trim() || 'LaTeX error', line: null };
      out.push(pending);
      continue;
    }
    m = /^! (?!(?:LaTeX|Package|Class)).+$/.exec(line);
    if (m) {
      pending = { severity: 'error', package: null, message: m[0].slice(2).trim(), line: null };
      out.push(pending);
      continue;
    }

    m = /^(?:(LaTeX|Package|Class) ([\w@-]+)? ?)?Warning: (.*?)(?: on input line (\d+))?\.?$/.exec(line);
    if (m && m[3]) {
      out.push({ severity: 'warning', package: m[2] || null, message: m[3].trim(), line: m[4] ? Number(m[4]) : null });
      pending = null;
      continue;
    }
  }

  // Multi-pass compiles repeat every diagnostic.
  //
  // `file` is part of the key. Without it the same message at the same line
  // number in two different chapters collapsed to one row and the second file's
  // real error was dropped — silently, and most likely in exactly the projects
  // where it matters, since sibling chapters share a preamble and a shape. It
  // does not weaken the multi-pass dedupe it was written for: a diagnostic
  // repeated across passes carries the same file each time.
  const seen = new Set();
  return out.filter(d => {
    const k = `${d.severity}|${d.package}|${d.file ?? ''}|${d.line ?? ''}|${d.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Page count as the engine reported it, or null if the log does not say. */
export function pagesFromLog(log) {
  const m = /Output written on [^(]*\((\d+) pages?/.exec(log || '');
  return m ? Number(m[1]) : null;
}

/**
 * Walls the bundled engine cannot get past, named and explained.
 *
 * These are the failures where the honest answer is "this engine will never do
 * that" rather than "your document is wrong", and each one is a real report:
 *
 *   - `cannot open encoding file` — \usepackage[T1]{fontenc} with default
 *     Computer Modern routes to the EC fonts, and pdftex.map maps every one of
 *     them to cm-super outlines, which the bundle omits because they are 60 MB
 *     and do not compress. The document typesets perfectly and dies while the
 *     PDF is being written, which makes the raw pdfTeX line especially unhelpful.
 *   - `wrong format version` — a prebuilt .bbl from a different biblatex. No
 *     WASM build has biber, so projects ship a .bbl; when its format is stale
 *     biblatex typesets the raw database as body text and still exits 0. That is
 *     why this is an *error* despite a PDF being produced.
 *   - a missing .cls/.sty that is not in the source bundle at all — journal
 *     classes and the collections busytex never built.
 *
 * `systemWouldFix` is what lets the shell offer the switch only when switching
 * would actually help. It is true for a stale .bbl: this said the opposite —
 * "a system TeX compiles the same wrong file" — and that was wrong about our own
 * code. The native engine runs biber when the document asks for it
 * (tex_engine_native.js), which regenerates the .bbl; that is the whole reason
 * it exists. The offer was suppressed on the one limit a system TeX fixes most
 * reliably. Where biber is *not* on the PATH the native engine names it and
 * carries on, which is a better outcome than never mentioning the option.
 *
 * Returns [] for a clean log, so callers can spread it unconditionally.
 */
export function engineLimits(log) {
  const text = log || '';
  const out = [];

  if (/cannot open encoding file/i.test(text) || /Font\b[^\n]*\bnot loadable/i.test(text)) {
    out.push({
      severity: 'error',
      package: null,
      kind: 'missing-font-outlines',
      systemWouldFix: true,
      message: 'T1 with Computer Modern needs the cm-super fonts, which this bundle omits. ' +
               'Add \\usepackage{lmodern} — same encoding, ships here — or use a system LaTeX.'
    });
  }

  // Two traps in one short line, both of them real:
  //
  //   `[\d.]+` would greedily absorb the sentence's own full stop and report
  //   "expected 3.3.". And TeX hard-wraps its log at 79 columns, so the version
  //   genuinely arrives split — `expected 3.` / `3.` — which is why `\s*` sits
  //   inside the version rather than around it. The capture is then squeezed.
  const stale = /File ['"`]?([\w.-]+)['"`]? is wrong format version - expected (\d+(?:\.\s*\d+)*)/i.exec(text);
  if (stale) {
    const version = stale[2].replace(/\s+/g, '');
    out.push({
      severity: 'error',
      package: 'biblatex',
      kind: 'stale-bbl',
      systemWouldFix: true,
      message: `${stale[1]} was built by a different biblatex (this one expects ${version}). ` +
               'Its entries will not typeset — regenerate it with biber, or set ' +
               '\\usepackage[backend=bibtex]{biblatex}, which the bundled bibtex8 can build.'
    });
  }

  return out;
}
