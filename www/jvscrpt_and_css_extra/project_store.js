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

/** Anything that means "this document is biblatex", whatever its backend. */
const BIBLATEX_RE =
  /\\(?:addbibresource|printbibliography)|\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{biblatex\}/;

/**
 * The `backend=` biblatex was given, or null if it never says.
 *
 * Two places carry it, and both turn up in real preambles: the package options
 * on `\usepackage[…]{biblatex}`, and a later `\ExecuteBibliographyOptions{…}`.
 * The package form is checked first because it is the common one — and because
 * it is the one the app's own stale-.bbl advice tells people to write.
 */
export function biblatexBackend(text) {
  // Stripped here as well as by the caller. Not belt-and-braces: `[^\]]*` stops
  // at the first `]` it meets, and real option lists carry comments like
  // "% Vancouver-style [1] [2] [3] citations" — with those still in place the
  // option group never closes and the backend reads as unset.
  const src = stripTexComments(text);
  const pkg = /\\(?:usepackage|RequirePackage)\[([^\]]*)\]\{biblatex\}/.exec(src);
  const exec = /\\ExecuteBibliographyOptions(?:\[[^\]]*\])?\{([^}]*)\}/.exec(src);
  for (const opts of [pkg?.[1], exec?.[1]]) {
    const m = opts && /\bbackend\s*=\s*(\w+)/.exec(opts);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Which bibliography tool a document needs, or null for none.
 *
 * A tool name rather than a boolean, because the two are not interchangeable:
 * biblatex builds its .bbl with biber, classic \bibliography with bibtex, and
 * running the wrong one fails in a way that reads as a broken document. Both
 * shapes are in the test fixtures — the book template is biblatex, homework is
 * classic — so guessing by "whichever is installed" is wrong for one of them.
 *
 * biblatex's backend is read rather than assumed. It used to be: any biblatex at
 * all reported 'biber', option string ignored — which made the app's own advice
 * a dead end. On a stale .bbl it prints "set \usepackage[backend=bibtex]
 * {biblatex}, which the bundled bibtex8 can build", and biblatex.bst really does
 * ship in the slim bundle; but a document that took the advice still reported
 * 'biber', so the app still refused to run anything and printed the same
 * suggestion again. Following it changed nothing.
 */
export function inferBibTool(src) {
  src = stripTexComments(src);
  if (BIBLATEX_RE.test(src)) {
    // bibtex8 is what the bundled engine actually runs for 'bibtex'; biblatex
    // names it either way, and both spellings mean the same backend here.
    const backend = biblatexBackend(src);
    return backend === 'bibtex' || backend === 'bibtex8' ? 'bibtex' : 'biber';
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

/* ── the include graph ───────────────────────────────────────────────── */
/* It lives here, not in document_model.js where it grew, because two things now
   need it and document_model.js already imports from this file — putting it the
   other way round would be a cycle, and a second copy of the walk is exactly
   what drifts. This module imports nothing, which is what makes it the floor. */

/** Every file `\input` or `\include` names in one source. */
export function includesIn(src) {
  // `\includegraphics` and `\includeonly` do not match: neither has `{`
  // directly after the command name.
  return [...stripTexComments(src).matchAll(/\\(?:input|include)\s*\{([^}]*)\}/g)]
    .map(m => m[1].trim());
}

/**
 * The file `\input{raw}` names, or null.
 *
 * TeX resolves relative to the working directory, which is the project root, so
 * that is tried first; the file's own directory is a fallback because people
 * write `\input{parts/a}` from `parts/b.tex` and expect it to work under
 * `\graphicspath`-style habits. The extension is optional in TeX and usually
 * omitted, so both spellings are tried.
 */
export function resolveInput(raw, fromFile, files) {
  const cleaned = raw.replace(/^\.\//, '').trim();
  if (!cleaned) return null;
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/') + 1) : '';
  for (const base of dir ? [cleaned, dir + cleaned] : [cleaned]) {
    for (const candidate of [base, `${base}.tex`]) {
      if (files.has(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The files the document actually reads, in the order it reads them.
 *
 * This matters more than it sounds. The book fixture ships a `main_legacy.tex`
 * — a complete alternative main file that nothing includes. Concatenating every
 * file's sections would put a second, contradictory copy of the whole book in
 * the outline. Walking from `main` is what makes the outline the *document's*
 * structure rather than the folder's.
 *
 * @param {(path: string) => string[]} includesOf  what each file pulls in.
 *        A callback because the two callers already differ: the project index
 *        has scanned every file and hands over the map it built, while
 *        `describe` reads them as it walks. One walk either way.
 */
export function documentOrder(main, files, includesOf) {
  const order = [];
  const seen = new Set();
  const walk = (path) => {
    if (!path || seen.has(path) || !files.has(path)) return;
    seen.add(path);                                  // before recursing: cycles
    order.push(path);
    for (const raw of includesOf(path) || []) walk(resolveInput(raw, path, files));
  };
  walk(main);
  return order;
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Everything derived from the document's source, in one place.
 *
 * The *document*, not the main file. This used to read `main.tex` alone, which
 * silently lost the index and the bibliography for every project that keeps its
 * preamble in an `\input`-ed file — a common enough layout, and one that failed
 * without a word, because as far as the app was concerned the document had never
 * asked for either.
 *
 * Files are walked from the main file rather than concatenated wholesale: a
 * folder often holds an alternative main file nobody includes (the book fixture
 * ships `main_legacy.tex`), and reading its preamble too would pick up settings
 * this document never asked for.
 *
 * Exported because this used to run exactly once, when the folder was read, and
 * nothing could revise it afterwards. Adding `\makeindex` or a `\bibliography{}`
 * mid-session therefore did nothing at all until the folder was reopened — and
 * unlike the engine, which at least has the topbar dropdown to overrule it,
 * neither of those has an override anywhere in the UI. The main file changing
 * has the same effect, since the whole walk starts from it.
 *
 * Safe to call repeatedly: it derives from the buffers and assigns, holding no
 * state of its own.
 *
 * **Only for projects that came from disk.** The dev-server fixtures declare
 * their metadata by hand in `test/serve.js`, deliberately — one pins
 * `bibtex: 'biber'` purely to exercise the no-biber path, another pins
 * `main: 'main_legacy.tex'`, and a serve-time patch rewrites the backend in the
 * source. Re-deriving those from the text would quietly dismantle exactly the
 * cases the compile gate is built on. Callers gate on `project.onDisk`.
 */
export function redescribeProject(project) {
  const srcOf = (path) => {
    const c = project.files.get(path)?.content;
    return typeof c === 'string' ? c : '';
  };
  const order = documentOrder(project.main, project.files, (p) => includesIn(srcOf(p)));
  // Comments are stripped per file, not once over the join, so a `%` at the end
  // of one file cannot comment out the start of the next. That guard is why the
  // homework fixture's commented-out `\bibliography{…}` does not run bibtex —
  // and widening the scan makes it matter more, not less.
  const src = order.map(p => stripTexComments(srcOf(p))).join('\n');

  project.engine = inferEngine(src);
  project.makeindex = /\\makeindex/.test(src);
  project.bibtex = inferBibTool(src);
  return project;
}

/**
 * Every file the project could reasonably be compiled from.
 *
 * A `.tex` carrying `\documentclass`; or, when nothing does, every `.tex` —
 * because a project whose preamble lives in an `\input`-ed file still has to be
 * compilable. Comments are stripped first: a parked
 * `% \documentclass{article}` is not a document.
 *
 * Computed from the buffers on demand rather than recorded at read time, so it
 * cannot go stale when a file is created, imported, renamed or deleted. Both
 * the initial guess and the document selector read it, which is what stops
 * those two from ever disagreeing about what the alternatives are.
 *
 * The current main is always included even if it would not otherwise qualify —
 * the list is a menu, and a menu that omits the thing it is currently set to
 * cannot show its own state.
 */
export function mainCandidates(project) {
  const tex = [...project.files.keys()].filter(p => /\.tex$/i.test(p));
  const withClass = tex.filter((p) => {
    const c = project.files.get(p)?.content;
    return typeof c === 'string' && /\\documentclass/.test(stripTexComments(c));
  });
  const list = withClass.length ? withClass : tex;
  if (project.main && !list.includes(project.main)) list.push(project.main);
  return list.sort((a, b) => a.localeCompare(b));
}

/**
 * The main file: a .tex containing \documentclass, preferring main.tex, then
 * anything at the top level over anything nested.
 *
 * A guess, and only ever a guess — `cv_template/` holds four `\documentclass`
 * files and no `main.tex`, so this picks one of them alphabetically and the
 * other three are documents the app would otherwise never compile. That is why
 * `mainCandidates` above is exported and the choice is offered in the UI rather
 * than being the end of the matter.
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
    } catch (err) {
      onWarn(`skipped ${f.path}: ${err}`);
    }
  }

  // Candidates come from the buffers now rather than from a list built in the
  // loop above: one definition, shared with the selector, so the guess and the
  // alternatives offered against it cannot describe different sets.
  project.main = pickMain(mainCandidates(project), texFiles.map(f => f.path));
  return redescribeProject(project);
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
