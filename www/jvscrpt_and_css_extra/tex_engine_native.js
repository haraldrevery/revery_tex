// TexEngine over the user's own TeX installation.
//
// The whole point of the TexEngine interface: the app does not change. Same
// compile({files, mainFile, engine, passes, bibtex, makeindex}), same
// {success, pdf, log, pages, diagnostics, missingPackages} back.
//
// What it buys over the bundled WASM engine:
//   - **biber**, which no WASM build has
//   - the user's **full** TeX Live, so a package outside the 62 MB slim bundle
//     is not a failure
//   - system fonts by name, which WASM cannot do — it has no font database
//
// What it costs: the files must be on disk (this cannot compile the dev-server
// fixtures, which live only in memory), and it is desktop-only.
//
// Everything dangerous lives in the shell — argv, the program allowlist, the
// timeout, -no-shell-escape. This file names a tool and a main file. It cannot
// pass an argument even if it wanted to, which is the property that matters:
// the sandbox does not depend on this file being careful.

import { parseLatexLog, engineLimits } from './latex_log.js';

const ENGINE_TOOL = { pdftex: 'pdflatex', xetex: 'xelatex', luatex: 'lualatex' };

export class NativeTexEngine {
  /**
   * @param {object} opts
   * @param {(line:string, level:string)=>void} [opts.onLog]
   * @param {object} opts.api  NativeAPI, which must have detectTex and runTex
   */
  constructor({ onLog = () => {}, api } = {}) {
    this.id = 'system';
    this.onLog = onLog;
    this.api = api;
    this.tools = [];
    this.capabilities = {
      engines: [], bibtex: false, biber: false, makeindex: false,
      synctex: true, shellEscape: false, fullTexlive: true
    };
    this._cancelled = false;
  }

  /** True where a system TeX could exist at all — desktop with the commands. */
  static available(api) {
    return !!(api && api.detectTex && api.runTex);
  }

  async init() {
    if (!NativeTexEngine.available(this.api)) {
      throw new Error('A system TeX can only be used in the desktop app.');
    }
    this.tools = await this.api.detectTex();
    const has = (n) => this.tools.some(t => t.name === n);

    this.capabilities = {
      engines: [
        has('pdflatex') && 'pdflatex',
        has('xelatex') && 'xelatex',
        has('lualatex') && 'lualatex'
      ].filter(Boolean),
      bibtex: has('bibtex'),
      biber: has('biber'),
      makeindex: has('makeindex'),
      synctex: true,
      shellEscape: false,       // deliberately, and not configurable
      fullTexlive: true
    };

    if (!this.capabilities.engines.length) {
      throw new Error(
        'No LaTeX engine was found on your PATH. Install TeX Live or MiKTeX, ' +
        'or switch back to the bundled engine.'
      );
    }
    for (const t of this.tools) {
      this.onLog(`found ${t.name} — ${t.version || t.path}`, 'inf');
    }
    return this;
  }

  cancel() { this._cancelled = true; }
  dispose() { }

  /**
   * Compile.
   *
   * `files` is accepted for interface compatibility and deliberately ignored:
   * a system TeX reads the real files, so what compiles is what is on disk.
   * Callers must save first — the app does, and passing unsaved buffers here
   * would silently compile something different from what the user sees.
   */
  async compile({ mainFile, engine = 'pdftex', passes = true, bibtex = false, makeindex = false, timeoutSecs } = {}) {
    this._cancelled = false;
    const tool = ENGINE_TOOL[engine] || engine;
    if (!this.capabilities.engines.includes(tool)) {
      return this._fail(`${tool} is not installed. Available: ${this.capabilities.engines.join(', ') || 'none'}`);
    }

    const runs = [];
    const run = async (t, label) => {
      if (this._cancelled) return null;
      this.onLog(`— ${label}`, 'hdr');
      const r = await this.api.runTex(t, mainFile, timeoutSecs);
      runs.push(r);
      for (const line of (r.stdout || '').split('\n')) if (line) this.onLog(line, 'out');
      for (const line of (r.stderr || '').split('\n')) if (line) this.onLog(line, 'err');
      if (r.timedOut || r.timed_out) this.onLog(`${t} was stopped at the time limit`, 'err');
      if (r.truncated) this.onLog('output was truncated', 'wrn');
      return r;
    };

    let last = await run(tool, `${tool} pass 1`);
    if (!last) return this._fail('cancelled');

    // Bibliography and index between passes, exactly as one would by hand.
    //
    // `bibtex` names the tool the *document* needs — biblatex builds its .bbl
    // with biber, classic \bibliography with bibtex. They are not substitutes:
    // running biber on a classic document fails, and running bibtex on a
    // biblatex one produces a bibliography that is silently wrong. So the named
    // tool runs or nothing does, and the log says which was missing.
    if (bibtex) {
      if (this.capabilities[bibtex]) await run(bibtex, bibtex);
      else this.onLog(`this document needs ${bibtex}, which is not on your PATH — ` +
                      `the bibliography will be whatever the existing .bbl holds`, 'wrn');
    }
    if (makeindex && this.capabilities.makeindex) await run('makeindex', 'makeindex');

    if (passes || bibtex || makeindex) {
      last = await run(tool, `${tool} pass 2`) || last;
      // A third pass only when the log still asks for one, rather than always:
      // on a large document that is another full compile for nothing.
      if (last && /Rerun to get|Label\(s\) may have changed/.test(last.stdout || '')) {
        last = await run(tool, `${tool} pass 3`) || last;
      }
    }
    if (this._cancelled) return this._fail('cancelled');

    const log = runs.map(r => r.stdout || '').join('\n');
    // Limits go first here for the same reason as in the WASM engine: the Issues
    // tab must not disagree with itself depending on which engine ran. Most of
    // them cannot arise on a system TeX, but a stale .bbl can — biber only
    // rewrites it if biber is actually installed.
    const limits = engineLimits(log);
    const diagnostics = [...limits, ...parseLatexLog(log)];
    const missingPackages = [...new Set(
      [...log.matchAll(/(?:File|LaTeX Error: File)\s+`([^']+\.sty)'\s+not found/g)].map(m => m[1])
    )];

    // Success is a PDF on disk, never an exit code — the last pass's status
    // hides a fatal error in an earlier one, which is the same trap the WASM
    // wrapper sets.
    //
    // By basename, not beside the source. The shell pins cwd to the project
    // root and passes -output-directory=. , so every artefact lands at the root
    // however deep the main file sits — `src/main.tex` produces `main.pdf`, not
    // `src/main.pdf`. Reading beside the source found nothing and reported "the
    // compiler produced no PDF" over a log that had compiled cleanly. This is
    // also what bibtex and makeindex already assume, since their stems come
    // from the basename too.
    const stem = mainFile.split('/').pop().replace(/\.tex$/i, '');
    let pdf = null;
    try { pdf = await this.api.readBinaryFile(`${stem}.pdf`); } catch { /* none produced */ }

    if (!pdf || !pdf.length) {
      const first = diagnostics.find(d => d.severity === 'error');
      return {
        success: false, pdf: null, log, diagnostics, missingPackages, limits,
        error: missingPackages.length
          ? `missing package: ${missingPackages.join(', ')}`
          : (first ? first.message : 'the compiler produced no PDF — see the raw log'),
        pages: 0
      };
    }

    // Same root, same reason. Not fatal if absent — but say so, because a
    // silent miss here is click-to-source doing nothing with no explanation.
    let synctex = null;
    try {
      synctex = await this.api.readBinaryFile(`${stem}.synctex.gz`);
    } catch {
      this.onLog(`${stem}.synctex.gz was not written — click-to-source is unavailable ` +
                 `for this compile`, 'wrn');
    }

    return {
      success: true,
      pdf, synctex, log, diagnostics, missingPackages, limits,
      pages: countPages(pdf),
      error: null
    };
  }

  _fail(message) {
    this.onLog(message, 'err');
    return { success: false, pdf: null, log: '', diagnostics: [], missingPackages: [], limits: [], pages: 0, error: message };
  }
}

/** Page count without parsing the whole PDF — /Type /Page occurrences. */
function countPages(bytes) {
  const text = new TextDecoder('latin1').decode(bytes);
  const m = /\/Type\s*\/Pages[\s\S]{0,200}?\/Count\s+(\d+)/.exec(text);
  if (m) return Number(m[1]);
  return (text.match(/\/Type\s*\/Page[^s]/g) || []).length || 0;
}
