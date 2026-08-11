// TexEngine — browser (WASM) implementation.
//
// The one abstraction the rest of Revery TeX is allowed to talk to. Nothing
// outside this file may reference BusyTexRunner, engineMode, data packages, or
// any other texlyre-busytex concept -- swapping the underlying wrapper (for an
// MIT one, or for a native compiler on desktop) must be a single-file change.
//
// It exists because Phase 0 found five sharp edges in the underlying API:
//
//   1. No onLog callback. Live output only reaches runner.logger.debug(), so a
//      compile appears frozen until it finishes. We replace the logger.
//   2. exitCode is the *last* pass's. A fatal error in pass 1 followed by a
//      no-op final pass reports exitCode 0 with an empty PDF. A non-empty PDF
//      is the only proof of success.
//   3. preload vs catalog is load-bearing and easy to get backwards: preload is
//      always mounted, catalog is searched on demand. Put everything in preload
//      and unresolved packages fail even though the bundle contains them.
//   4. engineMode accepts 'pdftex'/'xetex'/'luahbtex' but the asset release
//      ships only the combined build, so those 404. Capabilities must reflect
//      what is actually on disk.
//   5. Missing packages fail opaquely. With a slim texmf that is the single
//      most likely failure, so it has to name the package.

// Vendored INTO www/ deliberately: Tauri bundles only frontendDist, so anything
// imported from outside www/ simply is not there at runtime. The copy under
// vendor/texlyre-busytex/ stays as the provenance record (AGPL-3.0), mirroring
// Revery Notebook's third_party_sources/ convention.
import { BusyTexRunner, PdfLatex, XeLatex, LuaLatex, clearAllPackageCache }
  from './texlyre_busytex.js';

const TOOLS = { pdflatex: PdfLatex, xelatex: XeLatex, lualatex: LuaLatex };

// Engine -> the driver the underlying pipeline needs. Kept here so callers
// speak in LaTeX terms ('xelatex') rather than pipeline terms.
const DRIVER = {
  pdflatex: 'pdftex_bibtex8',
  xelatex: 'xetex_bibtex8_dvipdfmx',
  lualatex: 'luahbtex_bibtex8'
};

function firstTexError(log) {
  const m = /^! (.+)$/m.exec(log || '');
  return m ? m[1].trim() : null;
}

// A slim texmf makes "package not in the bundle" the most likely failure, so
// it must be named rather than buried in 4000 lines of log.
function missingPackages(log) {
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

// Structured diagnostics for the Issues tab. Deliberately conservative: the
// raw log stays the source of truth, this is only the index into it.
function parseDiagnostics(log) {
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

  // dedupe — multi-pass compiles repeat every diagnostic
  const seen = new Set();
  return out.filter(d => {
    const k = `${d.severity}|${d.package}|${d.message}|${d.line ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function pagesFromLog(log) {
  const m = /Output written on [^(]*\((\d+) pages?/.exec(log || '');
  return m ? Number(m[1]) : null;
}

export class WasmTexEngine {
  /** Absolute URL, no trailing slash, relative to the document. */
  static resolve(p) {
    if (/^[a-z]+:/i.test(p)) return p.replace(/\/+$/, '');
    const base = (typeof document !== 'undefined' && document.baseURI) || location.href;
    return new URL(p, base).href.replace(/\/+$/, '');
  }

  constructor({ basePath, texmfPath, onLog } = {}) {
    this.id = 'wasm-busytex';
    // Runtime and texmf both live in engine/dist/ -- it is entirely build
    // output, which is what makes it committable (engine/busytex/ is the
    // gitignored 649 MB upstream release).
    //
    // Resolved to absolute URLs, which is not cosmetic: these paths are posted
    // into the Web Worker, and a relative path is re-resolved there against the
    // worker's own location (already inside engine/dist/), producing
    // engine/dist/engine/dist/busytex.js. Absolute URLs are also what makes
    // this work unchanged under Tauri's custom protocol origin.
    this.basePath = WasmTexEngine.resolve(basePath || './engine/dist');
    this.texmfPath = WasmTexEngine.resolve(texmfPath || './engine/dist');
    this.onLog = onLog || (() => {});
    this._runner = null;
    this._manifest = null;
    this._assets = null;
    this._busy = false;

    this.capabilities = {
      engines: [],          // filled by init() from what is actually present
      bibtex: true,
      biber: false,         // no WASM biber exists; ship a prebuilt .bbl
      makeindex: true,
      synctex: true,
      shellEscape: false,   // untrusted .tex from zip import; keep \write18 off
      fullTexlive: false    // slim bundle — desktop has the full distribution
    };
  }

  _log(level, message) {
    for (const line of String(message).split('\n')) this.onLog(line, level);
  }

  async init() {
    if (this._runner) return this;

    // Which engines are actually available is a question about files on disk,
    // not about what the enum allows.
    this._manifest = await fetch(`${this.texmfPath}/texlive-slim.manifest.json`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
    if (!this._manifest) {
      throw new Error(`No texmf manifest at ${this.texmfPath}. Run: node build_tools/build_slim_texmf.js`);
    }

    // The bundle's engine setting records which format files were included.
    const built = this._manifest.engine || 'both';
    this.capabilities.engines = built === 'both'
      ? ['pdflatex', 'xelatex']
      : built === 'pdftex' ? ['pdflatex'] : ['xelatex'];
    // lualatex needs texlive-recommended-level packages the slim bundle omits.
    this.capabilities.fullTexlive = false;

    const preload = this._manifest.preload.map(f => `${this.texmfPath}/${f}`);
    const catalog = this._manifest.catalog.map(f => `${this.texmfPath}/${f}`);

    this._runner = new BusyTexRunner({
      busytexBasePath: this.basePath,
      engineMode: 'combined',     // the only build the asset release ships
      verbose: true,
      preloadDataPackages: preload,
      catalogDataPackages: catalog,
      onDownloadProgress: (p) => this._log('info', `loading texmf ${p.percent}%`)
    });

    // (1) There is no onLog callback; live output only reaches logger.debug().
    this._runner.logger = {
      debug: (m, ...a) => this._log('debug', a.length ? `${m} ${a.join(' ')}` : m),
      info: (m, ...a) => this._log('info', a.length ? `${m} ${a.join(' ')}` : m),
      warn: (m, ...a) => this._log('warn', a.length ? `${m} ${a.join(' ')}` : m),
      error: (m, ...a) => this._log('error', a.length ? `${m} ${a.join(' ')}` : m)
    };

    const t0 = performance.now();
    this._log('info', `initializing engine · preload=[${this._manifest.preload.join(', ')}] catalog=[${this._manifest.catalog.join(', ')}]`);
    await this._runner.initialize(true);
    this._log('info', `engine ready in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    return this;
  }

  /**
   * @param {{files: Array<{path:string, content:string|Uint8Array}>,
   *          mainFile: string, engine?: string, passes?: boolean,
   *          bibtex?: boolean, makeindex?: boolean,
   *          onLog?: (line:string, level:string)=>void}} opts
   */
  async compile(opts) {
    const {
      files, mainFile, engine = 'xelatex',
      passes = true, bibtex = false, makeindex = false, onLog
    } = opts;

    if (this._busy) throw new Error('a compile is already running');
    if (!this._runner) await this.init();
    if (!this.capabilities.engines.includes(engine)) {
      throw new Error(`engine "${engine}" unavailable; this bundle has: ${this.capabilities.engines.join(', ')}`);
    }

    const prevOnLog = this.onLog;
    if (onLog) this.onLog = onLog;
    this._busy = true;

    const t0 = performance.now();
    try {
      const main = files.find(f => f.path === mainFile);
      if (!main) throw new Error(`main file "${mainFile}" is not in the file list`);

      const Tool = TOOLS[engine];
      const tool = new Tool(this._runner, true);

      this._log('info', `compiling ${mainFile} with ${engine} (passes=${passes}, bibtex=${bibtex}, makeindex=${makeindex})`);

      const result = await tool.compile({
        input: typeof main.content === 'string'
          ? main.content
          : new TextDecoder().decode(main.content),
        mainTexPath: mainFile,
        additionalFiles: files.filter(f => f.path !== mainFile),
        driver: DRIVER[engine],
        bibtex,
        makeindex,
        rerun: passes,
        verbose: 'info',
        shellEscape: false          // never enable: untrusted document input
      });

      const seconds = (performance.now() - t0) / 1000;
      const log = result.log || '';

      // (2) Trust the artifact, not the exit code.
      const pdf = result.pdf && result.pdf.length > 0 ? result.pdf : null;
      const success = !!pdf;
      if (result.success && !pdf) {
        this._log('warn', 'wrapper reported success but produced no PDF — treating as failure');
      }

      const missing = success ? [] : missingPackages(log);
      if (missing.length) {
        this._log('warn', `not in this texmf bundle: ${missing.join(', ')}`);
        this._log('warn', 'the desktop app carries the full TeX Live distribution');
      }

      return {
        success,
        pdf,
        synctex: result.synctex && result.synctex.length ? result.synctex : null,
        log,
        pages: pagesFromLog(log),
        seconds,
        error: success ? null : (firstTexError(log) || `compile failed (exit ${result.exitCode})`),
        missingPackages: missing,
        diagnostics: parseDiagnostics(log)
      };
    } finally {
      this._busy = false;
      this.onLog = prevOnLog;
    }
  }

  get busy() { return this._busy; }

  async cancel() {
    // The underlying pipeline has no cooperative cancel; terminating the worker
    // is the only way to stop a runaway compile. Next compile re-initialises.
    if (!this._runner) return;
    this._runner.terminate();
    this._runner = null;
    this._busy = false;
    this._log('warn', 'compile cancelled — engine worker terminated');
  }

  async clearCache() {
    await clearAllPackageCache();
    await this.cancel();
  }

  async dispose() {
    if (this._runner) this._runner.terminate();
    this._runner = null;
  }
}

export default WasmTexEngine;
