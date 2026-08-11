// LaTeX editing behaviour for CodeMirror.
//
// Everything here works over document *text* rather than a parse tree, because
// the language is `stex` from @codemirror/legacy-modes — a StreamLanguage, which
// tokenises for colour but exposes no structure. That is a deliberate licence
// choice: Overleaf's lezer-latex grammar is AGPL-3.0. If a real grammar is
// adopted later, these sources can be reimplemented over the syntax tree without
// changing a single caller.

const CM = window.CM;

/* ── \begin{…} auto-close ─────────────────────────────────────────────── */

/**
 * Typing the closing brace of `\begin{foo}` inserts the matching `\end{foo}`
 * and leaves the cursor on a blank line between them.
 *
 * Skipped when an `\end{foo}` already follows with no intervening `\begin{foo}`,
 * so re-typing an existing line does not produce a duplicate.
 */
/**
 * The decision, separated from the CodeMirror plumbing so it can be tested
 * without synthesising key events.
 *
 * @returns {{changes: object, selection: object}|null} null = handle normally
 */
export function beginEndInsertion(state, from, to, text) {
  if (text !== '}') return null;

  const line = state.doc.lineAt(from);
  const before = line.text.slice(0, from - line.from);
  const m = /\\begin\{([A-Za-z*@]+)$/.exec(before);
  if (!m) return null;

  const env = m[1];
  const indent = /^[ \t]*/.exec(line.text)[0];

  // Look ahead for an unmatched \end{env}; if one is already there, this is a
  // re-edit of an existing block and a second \end would be wrong.
  const tail = state.doc.sliceString(to, Math.min(state.doc.length, to + 4000));
  const nextEnd = tail.indexOf(`\\end{${env}}`);
  const nextBegin = tail.indexOf(`\\begin{${env}}`);
  if (nextEnd !== -1 && (nextBegin === -1 || nextEnd < nextBegin)) return null;

  return {
    changes: { from, to, insert: `}\n${indent}\n${indent}\\end{${env}}` },
    selection: { anchor: from + 2 + indent.length },
    userEvent: 'input.complete'
  };
}

export function beginEndAutoClose() {
  return CM.EditorView.inputHandler.of((view, from, to, text) => {
    const spec = beginEndInsertion(view.state, from, to, text);
    if (!spec) return false;
    view.dispatch(spec);
    return true;
  });
}

/* ── project-aware completion ─────────────────────────────────────────── */

// A small, high-value command set. Not exhaustive by design: a wrong completion
// is worse than a missing one, and the useful completions are the project's own
// labels and citation keys, below.
const COMMANDS = [
  'begin', 'end', 'section', 'subsection', 'subsubsection', 'paragraph',
  'chapter', 'part', 'title', 'author', 'date', 'maketitle', 'tableofcontents',
  'label', 'ref', 'eqref', 'pageref', 'cite', 'citep', 'citet', 'footnote',
  'emph', 'textbf', 'textit', 'texttt', 'textsc', 'underline',
  'item', 'caption', 'centering', 'includegraphics', 'input', 'include',
  'usepackage', 'documentclass', 'newcommand', 'renewcommand', 'newenvironment',
  'frac', 'sqrt', 'sum', 'int', 'lim', 'infty', 'alpha', 'beta', 'gamma',
  'delta', 'epsilon', 'theta', 'lambda', 'mu', 'pi', 'sigma', 'phi', 'omega',
  'left', 'right', 'quad', 'qquad', 'hspace', 'vspace', 'newpage', 'clearpage',
  'bibliography', 'bibliographystyle', 'printbibliography', 'makeindex', 'index'
];

const ENVIRONMENTS = [
  'document', 'itemize', 'enumerate', 'description', 'figure', 'table',
  'tabular', 'tabularx', 'equation', 'equation*', 'align', 'align*', 'gather',
  'matrix', 'pmatrix', 'bmatrix', 'cases', 'abstract', 'quote', 'verbatim',
  'lstlisting', 'center', 'minipage', 'subfigure', 'theorem', 'proof',
  'definition', 'lemma', 'proposition', 'corollary', 'algorithm'
];

/**
 * Scan every text file in the project for things worth completing.
 * Cheap enough to redo per completion request for a normal project; cached by
 * a cheap signature so a big project is not rescanned on every keystroke.
 */
function scanProject(project) {
  const labels = new Set();
  const citations = new Set();
  const files = [];

  if (!project) return { labels: [], citations: [], files: [] };

  for (const [path, f] of project.files) {
    if (f.binary || typeof f.content !== 'string') {
      files.push(path);
      continue;
    }
    files.push(path);
    for (const m of f.content.matchAll(/\\label\{([^}]+)\}/g)) labels.add(m[1]);
    // BibTeX entries: @article{key, …
    for (const m of f.content.matchAll(/@\w+\s*\{\s*([^,\s}]+)/g)) citations.add(m[1]);
    // biblatex \bibitem{key}
    for (const m of f.content.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g)) citations.add(m[1]);
  }
  return { labels: [...labels].sort(), citations: [...citations].sort(), files: files.sort() };
}

let cache = { sig: null, data: null };
function projectIndex(project) {
  if (!project) return { labels: [], citations: [], files: [] };
  // Signature changes whenever any buffer changes length — good enough to keep
  // the index fresh without rescanning on every character.
  let sig = project.key + '|';
  for (const [p, f] of project.files) sig += p + (typeof f.content === 'string' ? f.content.length : 0) + ';';
  if (cache.sig !== sig) cache = { sig, data: scanProject(project) };
  return cache.data;
}

/**
 * @param {() => object|null} getProject  the app's current project
 */
export function latexCompletionSource(getProject) {
  return (ctx) => {
    const project = getProject();
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);

    // \ref{…}, \eqref{…}, \pageref{…} → labels defined in the project
    let m = /\\(?:eq|page|c|C)?ref\{([^}]*)$/.exec(before);
    if (m) {
      const { labels } = projectIndex(project);
      return {
        from: ctx.pos - m[1].length,
        options: labels.map(l => ({ label: l, type: 'variable', detail: 'label' })),
        validFor: /^[^}]*$/
      };
    }

    // \cite{…} → keys from .bib files and \bibitem
    m = /\\cite[a-zA-Z]*(?:\[[^\]]*\])*\{([^}]*)$/.exec(before);
    if (m) {
      const { citations } = projectIndex(project);
      return {
        from: ctx.pos - m[1].length,
        options: citations.map(c => ({ label: c, type: 'constant', detail: 'citation' })),
        validFor: /^[^},]*$/
      };
    }

    // \input{…}, \include{…}, \includegraphics{…} → real files in the project
    m = /\\(?:input|include|includegraphics)(?:\[[^\]]*\])?\{([^}]*)$/.exec(before);
    if (m) {
      const { files } = projectIndex(project);
      const isGraphic = /includegraphics/.test(before);
      const wanted = isGraphic
        ? files.filter(f => /\.(png|jpe?g|pdf|eps)$/i.test(f))
        : files.filter(f => /\.tex$/i.test(f));
      return {
        from: ctx.pos - m[1].length,
        // \input drops the extension by convention; \includegraphics keeps it
        options: wanted.map(f => ({
          label: isGraphic ? f : f.replace(/\.tex$/i, ''),
          type: 'file'
        })),
        validFor: /^[^}]*$/
      };
    }

    // \begin{…} / \end{…} → environment names
    m = /\\(?:begin|end)\{([A-Za-z*@]*)$/.exec(before);
    if (m) {
      return {
        from: ctx.pos - m[1].length,
        options: ENVIRONMENTS.map(e => ({ label: e, type: 'class', detail: 'environment' })),
        validFor: /^[A-Za-z*@]*$/
      };
    }

    // \command
    m = /\\([A-Za-z@]*)$/.exec(before);
    if (m) {
      return {
        from: ctx.pos - m[1].length - 1,
        options: COMMANDS.map(c => ({ label: '\\' + c, type: 'keyword' })),
        validFor: /^\\[A-Za-z@]*$/
      };
    }

    return null;
  };
}

/* ── highlighting ─────────────────────────────────────────────────────── */

/**
 * stex tags commands as `keyword`/`tagName`, braces as `bracket`, maths as
 * `atom`/`number`, comments as `comment`. The CodeMirror default styles those
 * for a programming language; this reads them as TeX, using the theme's own
 * custom properties so all four themes work without a second definition.
 */
export function latexHighlightStyle() {
  const t = CM.tags;
  return CM.HighlightStyle.define([
    { tag: t.comment, color: 'var(--text-dim)', fontStyle: 'italic' },
    { tag: t.keyword, color: 'var(--tex-command)' },
    { tag: t.tagName, color: 'var(--tex-command)' },
    { tag: t.controlKeyword, color: 'var(--tex-command)' },
    { tag: t.bracket, color: 'var(--text-dim)' },
    { tag: t.brace, color: 'var(--text-dim)' },
    { tag: t.atom, color: 'var(--tex-math)' },
    { tag: t.number, color: 'var(--tex-math)' },
    { tag: t.string, color: 'var(--tex-arg)' },
    { tag: t.literal, color: 'var(--tex-arg)' },
    { tag: t.variableName, color: 'var(--text)' },
    { tag: t.typeName, color: 'var(--tex-env)' },
    { tag: t.className, color: 'var(--tex-env)' },
    { tag: t.emphasis, fontStyle: 'italic' },
    // The brand face has no real bold; underline is the house treatment.
    { tag: t.strong, fontWeight: '400', textDecoration: 'underline' }
  ]);
}

/* ── compile diagnostics in the gutter ────────────────────────────────── */

export const setDiagnostics = CM.StateEffect.define();

class DiagMarker extends CM.GutterMarker {
  constructor(sev) { super(); this.sev = sev; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-diag cm-diag-' + this.sev;
    s.textContent = this.sev === 'error' ? '●' : '▲';
    return s;
  }
}

const diagField = CM.StateField.define({
  create: () => CM.RangeSet.empty,
  update(set, tr) {
    for (const e of tr.effects) {
      if (!e.is(setDiagnostics)) continue;
      const doc = tr.state.doc;
      const marks = [];
      // Diagnostics arrive as 1-based line numbers from the TeX log; anything
      // out of range is dropped rather than clamped, since a wrong marker is
      // more misleading than no marker.
      for (const d of e.value) {
        if (!d.line || d.line < 1 || d.line > doc.lines) continue;
        marks.push({ line: doc.line(d.line).from, sev: d.severity });
      }
      marks.sort((a, b) => a.line - b.line);
      return CM.RangeSet.of(
        marks.map(m => new DiagMarker(m.sev).range(m.line)),
        true
      );
    }
    return tr.docChanged ? set.map(tr.changes) : set;
  }
});

export function diagnosticsGutter() {
  return [
    diagField,
    CM.gutter({
      class: 'cm-diaggutter',
      markers: (view) => view.state.field(diagField),
      initialSpacer: () => new DiagMarker('warning')
    })
  ];
}

/** Everything above, as one extension array. */
export function latexEditingExtensions(getProject) {
  return [
    beginEndAutoClose(),
    CM.syntaxHighlighting(latexHighlightStyle()),
    diagnosticsGutter(),
    CM.autocompletion({
      override: [latexCompletionSource(getProject)],
      selectOnOpen: false,
      icons: false,
      activateOnTyping: true
    })
  ];
}
