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
