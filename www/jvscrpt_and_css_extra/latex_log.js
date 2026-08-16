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
 * Package names a compile complained were missing.
 *
 * With a slim texmf this is the most likely failure, so it must be named rather
 * than buried in 4000 lines of log — the gate has a fixture that must fail and
 * say `pgfornament.sty`. A system TeX rarely hits this, but it uses the same
 * parser so the message is identical either way.
 */
export function missingPackages(log) {
  const found = new Set();
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

/** The first `! ...` line, which is usually the failure worth showing. */
export function firstTexError(log) {
  const m = /^! (.+)$/m.exec(log || '');
  return m ? m[1].trim() : null;
}

/** Structured errors and warnings, deduped across passes. */
export function parseLatexLog(log) {
  const out = [];
  const text = log || '';

  for (const m of text.matchAll(/^! (?:LaTeX|Package|Class)?\s*(?:([\w@-]+) )?[Ee]rror:?\s*(.*)$/gm)) {
    out.push({ severity: 'error', package: m[1] || null, message: (m[2] || '').trim() || 'LaTeX error' });
  }
  for (const m of text.matchAll(/^! (?!(?:LaTeX|Package|Class)).+$/gm)) {
    out.push({ severity: 'error', package: null, message: m[0].slice(2).trim() });
  }
  for (const m of text.matchAll(/^(?:(LaTeX|Package|Class) ([\w@-]+)? ?)?Warning: (.*?)(?: on input line (\d+))?\.?$/gm)) {
    if (!m[3]) continue;
    out.push({ severity: 'warning', package: m[2] || null, message: m[3].trim(), line: m[4] ? Number(m[4]) : null });
  }
  // -file-line-error puts the location first: main.tex:12: Undefined control sequence
  for (const m of text.matchAll(/^([^\s:]+\.tex):(\d+):\s*(.+)$/gm)) {
    out.push({ severity: 'error', package: null, message: m[3].trim(), line: Number(m[2]), file: m[1] });
  }

  // Multi-pass compiles repeat every diagnostic.
  const seen = new Set();
  return out.filter(d => {
    const k = `${d.severity}|${d.package}|${d.message}|${d.line ?? ''}`;
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
