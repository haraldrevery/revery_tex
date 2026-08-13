// Turning a folder or a fixture into a project.
//
// Everything here either computes something from source text or reads files
// through NativeAPI, and **returns** a project rather than assigning one. That
// is what lets it be a separate module at all: ES module bindings are read-only
// to the importer, so a module that assigned the app's `project` global could
// not exist. The app keeps ownership of the variable and the UI wiring; this
// owns the shape of what goes into it.
//
// It touches no DOM, which also makes it directly unit-testable.

/**
 * Files opened as text. Everything else is read as bytes and shown in the tree
 * but not editable.
 *
 * One list, not two. The app previously had two of these differing only by
 * `ltx`, so the same file was text when opened from disk and binary when it
 * came from the dev server.
 */
export const TEXT_EXT_RE = /\.(tex|bib|cls|sty|bbl|ind|def|cfg|txt|clo|ltx)$/i;

/**
 * Drop LaTeX comments before looking for commands.
 *
 * Without this, anything scanning the source reads code people have commented
 * out — and they comment out exactly the interesting lines. The homework
 * fixture carries a commented `\bibliography{…}`, which is enough to make an
 * unguarded scan run bibtex on a document that has no bibliography and compiles
 * fine today.
 *
 * A `%` starts a comment unless it is escaped, so an odd number of preceding
 * backslashes means it is literal.
 */
export function stripTexComments(src) {
  return String(src).replace(/(^|[^\\])((?:\\\\)*)%.*$/gm, '$1$2');
}

/**
 * Which engine a document wants.
 *
 * fontspec and unicode-math require XeTeX or LuaTeX — but a well-written
 * preamble loads them *conditionally*:
 *
 *     \ifPDFTeX \usepackage[utf8]{inputenc} \else \usepackage{fontspec} \fi
 *
 * Matching \usepackage{fontspec} anywhere therefore picks XeTeX for documents
 * designed to run under pdfLaTeX, which then fail on fonts the pdfTeX path
 * never needed. A document that branches on the engine runs under either, so
 * pdfLaTeX wins: it is faster and needs fewer font files.
 */
export function inferEngine(src) {
  src = stripTexComments(src);
  const branches = /\\(?:ifPDFTeX|ifpdftex|ifxetex|ifXeTeX|ifluatex|ifLuaTeX|RequirePackage\{iftex\}|usepackage\{iftex\})/.test(src);
  if (branches) return 'pdftex';
  return /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{(?:fontspec|unicode-math)\}/.test(src)
    ? 'xetex' : 'pdftex';
}

/**
 * Which bibliography tool a document needs, or null for none.
 *
 * A tool name rather than a boolean, because the two are not interchangeable:
 * biblatex builds its .bbl with biber, classic \bibliography with bibtex, and
 * running the wrong one fails in a way that reads as a broken document. Both
 * shapes are in the test fixtures — the book template is biblatex, homework is
 * classic — so guessing by "whichever is installed" is wrong for one of them.
 */
export function inferBibTool(src) {
  src = stripTexComments(src);
  if (/\\(?:addbibresource|printbibliography)|\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{biblatex\}/.test(src)) {
    return 'biber';
  }
  // \bibliography{} and nothing else. It is what writes \bibdata into the .aux,
  // and \bibdata is the only thing BibTeX can act on — without it the run ends
  // in "I found no \bibdata command".
  //
  // \bibliographystyle alone is not enough, and used to be accepted here. It is
  // inert on its own and people leave it behind: examensLatexv5 sets
  // \bibliographystyle{vancouver}, has \bibliography{kallor} commented out, and
  // hand-writes its bibliography in manuellreferens.tex. That document needs no
  // tool at all, and running one on it reported a citation failure for a
  // bibliography that was already correct.
  if (/\\bibliography\{/.test(src)) return 'bibtex';
  return null;
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Everything derived from the main file's source, in one place. */
function describe(project, mainSrc) {
  project.engine = inferEngine(mainSrc);
  project.makeindex = /\\makeindex/.test(stripTexComments(mainSrc));
  project.bibtex = inferBibTool(mainSrc);
  return project;
}

/**
 * The main file: a .tex containing \documentclass, preferring main.tex, then
 * anything at the top level over anything nested.
 */
function pickMain(candidates, fallback) {
  const list = candidates.length ? candidates : fallback;
  return [...list].sort((a, b) => {
    const score = (p) => (/^main\.tex$/i.test(p) ? 0 : p.includes('/') ? 2 : 1);
    return score(a) - score(b) || a.localeCompare(b);
  })[0];
}

/**
 * Read the open folder into a project.
 *
 * @param {object} api      NativeAPI
 * @param {string} root     display name of the folder
 * @param {{onWarn?: (msg:string)=>void}} [opts]  per-file read failures, which
 *        are skipped rather than fatal — one unreadable image should not stop
 *        a project opening.
 * @throws if the folder holds no .tex file at all
 */
export async function readProjectFromDisk(api, root, { onWarn = () => {} } = {}) {
  const entries = await api.readDirectory();
  const files = entries.filter(e => e.type === 'file');

  const texFiles = files.filter(f => /\.tex$/i.test(f.path));
  if (!texFiles.length) throw new Error('no .tex files in that folder');

  const project = {
    key: root.split('/').pop(), root, onDisk: true,
    engine: 'xetex', rerun: true, makeindex: false, bibtex: null,
    files: new Map()
  };

  const mainCandidates = [];
  for (const f of files) {
    const isText = TEXT_EXT_RE.test(f.path);
    try {
      let content, stamp = null;
      if (isText) {
        const r = await api.readTextFile(f.path);
        content = r.content;
        stamp = r.stamp;   // identity at read time; checked again before saving
      } else {
        content = await api.readBinaryFile(f.path);
      }
      project.files.set(f.path, { content, binary: !isText, dirty: false, stamp });
      if (isText && /\.tex$/i.test(f.path) && /\\documentclass/.test(content)) {
        mainCandidates.push(f.path);
      }
    } catch (err) {
      onWarn(`skipped ${f.path}: ${err}`);
    }
  }

  project.main = pickMain(mainCandidates, texFiles.map(f => f.path));
  return describe(project, project.files.get(project.main)?.content || '');
}

/**
 * Read a dev-server fixture into a project.
 *
 * Fixtures have no disk backing, so `onDisk` is false and the app refuses to
 * save them — that flag is a property of where a project came from, not of
 * which shell is running.
 *
 * @returns {{project: object, patchLog: string[]}}
 */
export async function readProjectFromFixture(key, fetchImpl = fetch) {
  const m = await fetchImpl(`/api/project/${key}`).then(r => r.json());

  const project = {
    key, main: m.main, engine: m.engine, rerun: m.rerun,
    makeindex: m.makeindex, bibtex: m.bibtex || null,
    onDisk: false, files: new Map()
  };
  for (const f of m.files) {
    const binary = f.encoding === 'base64' && !TEXT_EXT_RE.test(f.path);
    project.files.set(f.path, {
      content: binary ? b64ToBytes(f.content)
                      : (f.encoding === 'base64' ? atob(f.content) : f.content),
      binary,
      dirty: false
    });
  }
  return { project, patchLog: m.patchLog || [] };
}
