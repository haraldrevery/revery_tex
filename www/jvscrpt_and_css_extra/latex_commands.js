// The command and environment catalogue behind completion.
//
// Data plus pure helpers: no CodeMirror import, no DOM, so the templates can be
// checked in Node rather than by typing into the editor and looking. The thin
// adapter that turns these into completions lives in latex_editor.js, the same
// way latex_snippets.js sits behind editor_actions.js.
//
// Named latex_commands.js and not folded into latex_snippets.js because that
// file already owns a different meaning of "snippet" — the pure text transforms
// the Toolbox and the right-click menu apply to a selection — and toolbox.js
// imports it. Two unrelated things called snippets in one file is how the next
// person picks the wrong one.
//
// ── Template syntax ──────────────────────────────────────────────────────
// `#{}` is a tab stop. `#{text}` is a tab stop pre-filled with `text`, selected
// so typing replaces it. Both are consumed by CodeMirror's snippet parser and
// never reach the document as written.
//
// Two rules, and both are load-bearing:
//
//   Indent with TABS. CodeMirror re-indents continuation lines by expanding
//   each leading tab to one indent unit and prefixing the insertion point's own
//   indentation. Spaces are copied literally and stack on top of that, so a
//   figure inserted inside an already-indented block marches to the right.
//
//   A pre-filled stop must be text that COMPILES. Tab stops are abandoned the
//   moment the user clicks elsewhere, leaving whatever was in them. `[htbp]` and
//   `0.8\textwidth` are real defaults and are fine to leave; a caption or a
//   label key is not, so those stops are empty rather than holding the word
//   "caption" for LaTeX to typeset.

/** `\command` with no arguments — completes to itself, no tab stops. */
const BARE = [
  ['maketitle'], ['tableofcontents'], ['centering'], ['item'],
  ['newpage'], ['clearpage'], ['noindent'], ['bigskip'], ['medskip'], ['smallskip'],
  ['quad'], ['qquad'], ['ldots'], ['dots'], ['hline'], ['toprule'], ['midrule'], ['bottomrule'],
  ['infty', '∞'], ['times', '×'], ['cdot', '·'], ['leq', '≤'], ['geq', '≥'], ['neq', '≠'],
  ['approx', '≈'], ['equiv', '≡'], ['pm', '±'], ['partial', '∂'], ['nabla', '∇'],
  ['alpha', 'α'], ['beta', 'β'], ['gamma', 'γ'], ['delta', 'δ'], ['epsilon', 'ε'],
  ['varepsilon', 'ε'], ['zeta', 'ζ'], ['eta', 'η'], ['theta', 'θ'], ['kappa', 'κ'],
  ['lambda', 'λ'], ['mu', 'μ'], ['nu', 'ν'], ['xi', 'ξ'], ['rho', 'ρ'], ['sigma', 'σ'],
  ['tau', 'τ'], ['phi', 'φ'], ['varphi', 'φ'], ['chi', 'χ'], ['psi', 'ψ'], ['omega', 'ω'],
  ['Gamma', 'Γ'], ['Delta', 'Δ'], ['Theta', 'Θ'], ['Lambda', 'Λ'], ['Xi', 'Ξ'],
  ['Pi', 'Π'], ['Sigma', 'Σ'], ['Phi', 'Φ'], ['Psi', 'Ψ'], ['Omega', 'Ω']
];

/**
 * Commands worth completing, with the braces the editor should write for you.
 *
 * Kept short on purpose — the principle this list inherited from the old inline
 * array is that **a wrong completion is worse than a missing one**, and the
 * completions that actually earn their place are the project's own labels and
 * citation keys, which are computed rather than listed.
 *
 * `detail` is what the dropdown shows to the right of the name. It is the only
 * thing distinguishing `\citep` from `\citet` for someone who does not already
 * know, so it is not decoration.
 *
 * @type {Array<{name: string, template?: string, detail?: string}>}
 */
export const COMMANDS = [
  // Structure
  { name: 'documentclass', template: '\\documentclass[#{11pt}]{#{article}}', detail: 'class' },
  { name: 'usepackage', template: '\\usepackage{#{}}', detail: 'package' },
  { name: 'title', template: '\\title{#{}}' },
  { name: 'author', template: '\\author{#{}}' },
  { name: 'date', template: '\\date{#{}}' },
  { name: 'part', template: '\\part{#{}}' },
  { name: 'chapter', template: '\\chapter{#{}}' },
  { name: 'section', template: '\\section{#{}}' },
  { name: 'subsection', template: '\\subsection{#{}}' },
  { name: 'subsubsection', template: '\\subsubsection{#{}}' },
  { name: 'paragraph', template: '\\paragraph{#{}}' },
  { name: 'appendix' },

  // Cross-references. \ref and friends get their own dropdown of real labels as
  // soon as the brace is open — see latexCompletionSource.
  { name: 'label', template: '\\label{#{}}' },
  { name: 'ref', template: '\\ref{#{}}', detail: 'reference' },
  { name: 'eqref', template: '\\eqref{#{}}', detail: 'equation reference' },
  { name: 'pageref', template: '\\pageref{#{}}', detail: 'page reference' },
  { name: 'autoref', template: '\\autoref{#{}}', detail: 'typed reference' },
  { name: 'cite', template: '\\cite{#{}}', detail: 'citation' },
  { name: 'citep', template: '\\citep{#{}}', detail: 'citation, parenthetical' },
  { name: 'citet', template: '\\citet{#{}}', detail: 'citation, textual' },
  { name: 'footnote', template: '\\footnote{#{}}' },

  // Text
  { name: 'emph', template: '\\emph{#{}}', detail: 'emphasis' },
  { name: 'textbf', template: '\\textbf{#{}}', detail: 'bold' },
  { name: 'textit', template: '\\textit{#{}}', detail: 'italic' },
  { name: 'texttt', template: '\\texttt{#{}}', detail: 'monospace' },
  { name: 'textsc', template: '\\textsc{#{}}', detail: 'small caps' },
  { name: 'underline', template: '\\underline{#{}}' },
  { name: 'caption', template: '\\caption{#{}}' },

  // Files and graphics
  { name: 'includegraphics', template: '\\includegraphics[width=#{0.8\\textwidth}]{#{}}', detail: 'image' },
  { name: 'input', template: '\\input{#{}}' },
  { name: 'include', template: '\\include{#{}}' },

  // Maths
  { name: 'frac', template: '\\frac{#{}}{#{}}', detail: 'fraction' },
  { name: 'sqrt', template: '\\sqrt{#{}}', detail: 'square root' },
  { name: 'sum', template: '\\sum_{#{}}^{#{}}', detail: 'sum' },
  { name: 'prod', template: '\\prod_{#{}}^{#{}}', detail: 'product' },
  { name: 'int', template: '\\int_{#{}}^{#{}}', detail: 'integral' },
  { name: 'lim', template: '\\lim_{#{}}', detail: 'limit' },
  { name: 'text', template: '\\text{#{}}', detail: 'text in maths' },
  { name: 'mathbf', template: '\\mathbf{#{}}' },
  { name: 'mathrm', template: '\\mathrm{#{}}' },
  { name: 'left', template: '\\left( #{} \\right)', detail: 'sized delimiters' },

  // Definitions. Two traps here, both found by the tests:
  //
  // The macro-name stop is pre-filled rather than empty. Empty expands to
  // `\newcommand{\}{}`, where `\}` is an escaped brace and the braces stop
  // balancing — a template that is broken LaTeX the moment anyone tabs past it.
  //
  // And no `[#{1}]` for the argument count: a stop whose whole content is
  // digits is parsed as a tab-stop *number*, not a default, so it inserts `[]`
  // and renumbers the stops around it.
  { name: 'newcommand', template: '\\newcommand{\\#{cmd}}{#{}}' },
  { name: 'renewcommand', template: '\\renewcommand{\\#{cmd}}{#{}}' },
  { name: 'newenvironment', template: '\\newenvironment{#{env}}{#{}}{#{}}' },

  // Spacing and bibliography
  { name: 'hspace', template: '\\hspace{#{1em}}' },
  { name: 'vspace', template: '\\vspace{#{1em}}' },
  { name: 'bibliography', template: '\\bibliography{#{}}' },
  { name: 'bibliographystyle', template: '\\bibliographystyle{#{plain}}' },
  { name: 'printbibliography' },
  { name: 'index', template: '\\index{#{}}' },
  { name: 'makeindex' },

  ...BARE.map(([name, detail]) => (detail ? { name, detail } : { name }))
];

/**
 * Environments, and the body worth writing out with them.
 *
 * The template completes the name, closes the brace and adds the matching
 * `\end` — so it deliberately overlaps `beginEndInsertion` in latex_editor.js.
 * They are not redundant: this fires when an environment is *chosen from the
 * dropdown* and gives the whole scaffold, while typing the closing brace by hand
 * still gets the minimal two-line version. Neither can produce a stray `\end`,
 * because the completion replaces the name only up to the cursor and the
 * document has no `}` there yet.
 *
 * @type {Array<{name: string, template?: string, detail?: string}>}
 */
export const ENVIRONMENTS = [
  { name: 'document' },
  { name: 'abstract' },
  { name: 'itemize', template: 'itemize}\n\t\\item #{}\n\\end{itemize}', detail: 'bulleted list' },
  { name: 'enumerate', template: 'enumerate}\n\t\\item #{}\n\\end{enumerate}', detail: 'numbered list' },
  { name: 'description', template: 'description}\n\t\\item[#{}] #{}\n\\end{description}' },
  {
    name: 'figure', detail: 'figure',
    template: 'figure}[#{htbp}]\n\t\\centering\n\t\\includegraphics[width=#{0.8\\textwidth}]{#{}}\n\t\\caption{#{}}\n\t\\label{fig:#{}}\n\\end{figure}'
  },
  {
    name: 'table', detail: 'table',
    template: 'table}[#{htbp}]\n\t\\centering\n\t\\caption{#{}}\n\t\\label{tab:#{}}\n\t\\begin{tabular}{#{cc}}\n\t\t#{} \\\\\n\t\\end{tabular}\n\\end{table}'
  },
  { name: 'tabular', template: 'tabular}{#{cc}}\n\t#{} \\\\\n\\end{tabular}' },
  { name: 'tabularx', template: 'tabularx}{\\textwidth}{#{XX}}\n\t#{} \\\\\n\\end{tabularx}' },
  {
    name: 'equation', detail: 'numbered equation',
    template: 'equation}\n\t#{}\n\t\\label{eq:#{}}\n\\end{equation}'
  },
  { name: 'equation*', template: 'equation*}\n\t#{}\n\\end{equation*}', detail: 'unnumbered equation' },
  { name: 'align', template: 'align}\n\t#{} &= #{} \\\\\n\t\\label{eq:#{}}\n\\end{align}', detail: 'aligned equations' },
  { name: 'align*', template: 'align*}\n\t#{} &= #{}\n\\end{align*}' },
  { name: 'gather', template: 'gather}\n\t#{}\n\\end{gather}' },
  { name: 'cases', template: 'cases}\n\t#{} & \\text{#{}} \\\\\n\\end{cases}' },
  { name: 'matrix', template: 'matrix}\n\t#{} & #{} \\\\\n\\end{matrix}' },
  { name: 'pmatrix', template: 'pmatrix}\n\t#{} & #{} \\\\\n\\end{pmatrix}' },
  { name: 'bmatrix', template: 'bmatrix}\n\t#{} & #{} \\\\\n\\end{bmatrix}' },
  { name: 'center', template: 'center}\n\t#{}\n\\end{center}' },
  { name: 'quote', template: 'quote}\n\t#{}\n\\end{quote}' },
  { name: 'verbatim', template: 'verbatim}\n#{}\n\\end{verbatim}' },
  { name: 'lstlisting', template: 'lstlisting}[language=#{Python}]\n#{}\n\\end{lstlisting}' },
  { name: 'minipage', template: 'minipage}{#{0.48\\textwidth}}\n\t#{}\n\\end{minipage}' },
  { name: 'theorem', template: 'theorem}\n\t#{}\n\\end{theorem}' },
  { name: 'proof', template: 'proof}\n\t#{}\n\\end{proof}' },
  { name: 'definition', template: 'definition}\n\t#{}\n\\end{definition}' },
  { name: 'lemma', template: 'lemma}\n\t#{}\n\\end{lemma}' },
  { name: 'proposition' }, { name: 'corollary' }, { name: 'algorithm' }, { name: 'subfigure' }
];

/**
 * The environment name a `\begin{…}` template completes to.
 *
 * Templates are written as the *tail* after `\begin{`, because that is what the
 * completion replaces — so the name has to be read back off the front rather
 * than assumed to equal `entry.name`. Used by the tests to prove the two agree;
 * a template whose head does not match its name silently produces
 * `\begin{align}…\end{aligned}`.
 */
export function envOfTemplate(template) {
  const m = /^([A-Za-z*@]+)\}/.exec(template);
  return m ? m[1] : null;
}

/**
 * Strip the tab-stop markers from a template, leaving what would land in the
 * document if every stop were tabbed past untouched.
 *
 * This is the thing worth asserting about a template: braces balance, and
 * nothing that survives is a placeholder word LaTeX would typeset.
 */
export function expandTemplate(template) {
  return template.replace(/[#$]\{(?:\d+(?::([^{}]*))?|((?:\\[{}]|[^{}])*))\}/g,
    (_, named, bare) => (named ?? bare ?? '').replace(/\\([{}])/g, '$1'));
}
