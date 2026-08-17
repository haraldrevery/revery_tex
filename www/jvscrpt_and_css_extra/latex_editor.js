// LaTeX editing behaviour for CodeMirror.
//
// Everything here works over document *text* rather than a parse tree, because
// the language is `stex` from @codemirror/legacy-modes — a StreamLanguage, which
// tokenises for colour but exposes no structure. That is a deliberate licence
// choice: Overleaf's lezer-latex grammar is AGPL-3.0. If a real grammar is
// adopted later, these sources can be reimplemented over the syntax tree without
// changing a single caller.

// The one index — see document_model.js. This file used to own a private
// scanner, but every new feature needed the same data, so it moved out.
import { projectIndex } from './document_model.js';
// The catalogue, as data. Kept out of this file so the templates can be checked
// in Node instead of by typing into the editor and looking at what appears.
import { COMMANDS, ENVIRONMENTS } from './latex_commands.js';

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

// Environments whose contents are typeset verbatim. Completing inside one is
// not merely useless, it is destructive: accepting `figure` would drop six
// lines of LaTeX into a code listing that is supposed to show them as written.
const VERBATIM_ENVS = ['verbatim', 'Verbatim', 'lstlisting', 'minted', 'alltt', 'comment'];

/**
 * Is the cursor somewhere completion must keep quiet — a comment, or inside a
 * verbatim-like block?
 *
 * Answered over document text because `stex` is a StreamLanguage and there is
 * no syntax tree to ask (see the file header). Scanning backwards from the
 * cursor for the nearest `\begin`/`\end` of a verbatim environment is enough:
 * these environments do not nest.
 *
 * Bounded rather than exhaustive. A cursor more than 200 lines inside a listing
 * is treated as ordinary text, which is the wrong answer for a pathological
 * document and costs nothing on a real one — the alternative is rescanning the
 * whole buffer on every keystroke.
 */
export function suppressCompletion(state, pos) {
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);

  // A comment, unless the % is escaped. Everything after it is prose to TeX.
  for (let i = 0; i < before.length; i++) {
    if (before[i] === '%' && (i === 0 || before[i - 1] !== '\\')) return true;
  }

  const from = Math.max(1, line.number - 200);
  for (let n = line.number; n >= from; n--) {
    const t = state.doc.line(n).text;
    const m = /\\(begin|end)\{(\w+\*?)\}/.exec(t);
    if (!m || !VERBATIM_ENVS.includes(m[2])) continue;
    // The nearest one decides: a \begin above with no \end between it and the
    // cursor means we are inside.
    return m[1] === 'begin';
  }
  return false;
}

/** A completion that inserts a template, or plain text when there is none. */
const fromEntry = (entry, label, type) => (entry.template
  ? CM.snippetCompletion(entry.template, { label, type, detail: entry.detail })
  : { label, type, detail: entry.detail });

/**
 * How a label reads in the dropdown: the key, then what it actually labels.
 *
 * `eq:euler — Euler's identity` is the difference between picking a reference
 * from the list and keeping the PDF open in another window to check which one
 * `eq:3` was.
 */
function labelOption(info, boostEq) {
  const what = info.title
    ? `${info.kind || 'label'} — ${info.title}`
    : (info.kind || 'label');
  return {
    label: info.label,
    type: 'variable',
    detail: what.length > 60 ? what.slice(0, 57) + '…' : what,
    // \eqref exists to reference equations; float the equations to the top of
    // its list rather than making the user scroll past every figure.
    boost: boostEq && info.kind === 'equation' ? 1 : 0
  };
}

/**
 * @param {() => object|null} getProject  the app's current project
 */
export function latexCompletionSource(getProject) {
  return (ctx) => {
    if (suppressCompletion(ctx.state, ctx.pos)) return null;

    const project = getProject();
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);

    // \ref{…}, \eqref{…}, \pageref{…} → labels defined in the project
    let m = /\\(eq|page|c|C|auto|name|v|V)?ref\{([^}]*)$/.exec(before);
    if (m) {
      const idx = projectIndex(project);
      const boostEq = m[1] === 'eq';
      // labelInfo is the same set as labels, with context attached. Fall back
      // to the bare keys if an older index somehow lacks it.
      const options = idx.labelInfo?.length
        ? idx.labelInfo.map(i => labelOption(i, boostEq))
        : idx.labels.map(l => ({ label: l, type: 'variable', detail: 'label' }));
      return { from: ctx.pos - m[2].length, options, validFor: /^[^}]*$/ };
    }

    // \cite{…} → keys from .bib files and \bibitem
    m = /\\cite[a-zA-Z]*(?:\[[^\]]*\])*\{([^}]*)$/.exec(before);
    if (m) {
      const { citations, bib } = projectIndex(project);
      // \cite takes a comma-separated list, so completion starts after the last
      // comma. Anchoring at the opening brace — as this used to — means typing
      // a second key replaces every key already there.
      const typed = m[1];
      const keyStart = typed.lastIndexOf(',') + 1;
      const byKey = new Map(bib.map(b => [b.key, b]));
      return {
        from: ctx.pos - (typed.length - keyStart),
        options: citations.map(c => {
          const e = byKey.get(c);
          const detail = e && (e.title || e.author)
            ? [e.author, e.year].filter(Boolean).join(', ') || e.title
            : 'citation';
          return { label: c, type: 'constant', detail: detail.slice(0, 60) };
        }),
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

    // \begin{…} → the environment, its closing brace, and a body worth having.
    // \end{…} gets names only: there is nothing to scaffold, and a template
    // there would write a second \end.
    m = /\\(begin|end)\{([A-Za-z*@]*)$/.exec(before);
    if (m) {
      const opening = m[1] === 'begin';
      return {
        from: ctx.pos - m[2].length,
        options: ENVIRONMENTS.map(e => (opening
          ? fromEntry(e, e.name, 'class')
          : { label: e.name, type: 'class', detail: e.detail })),
        validFor: /^[A-Za-z*@]*$/
      };
    }

    // \command
    m = /\\([A-Za-z@]*)$/.exec(before);
    if (m) {
      return {
        from: ctx.pos - m[1].length - 1,
        options: [
          ...COMMANDS.map(c => fromEntry(c, '\\' + c.name, 'keyword')),
          // \begin and \end are not in the catalogue: their argument is what
          // matters, so they complete straight into the environment dropdown.
          CM.snippetCompletion('\\begin{#{}}', { label: '\\begin', type: 'keyword' }),
          { label: '\\end', type: 'keyword' }
        ],
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
    // Markers follow the text they are about. This half was always here and
    // always right — the bug was that it had no counterpart: the Issues panel
    // kept the log's raw number, so after an edit the dot was in one place and
    // clicking the row sent the cursor to another.
    //
    // diagnostic_positions.js is that counterpart. It maps the *same*
    // ChangeSets from the *same* baseline, so the two cannot disagree; this is
    // the per-frame path, and that one is what survives a file switch, since a
    // state that has been swapped out carries no mapping forward. Neither is
    // redundant, and removing either brings the divergence back.
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

/* ── accepting a completion ───────────────────────────────────────────── */

// Completions whose whole point is to pick one item from a closed list. Inside
// `{…}`, where all of these live, a newline is never what Enter was for.
const CLOSED_SET = new Set(['variable', 'constant', 'file', 'class']);

/**
 * Enter accepts a completion only when the selected one comes from a closed set.
 *
 * `selectOnOpen` is a global config with no per-result override, so turning it
 * on — which is what makes a `\ref{` dropdown usable without pressing Down
 * first — also arms Enter over the command list, where it would swallow the
 * newline after every half-typed `\se`. Gating on what is actually selected
 * gives references the behaviour people expect from Overleaf and TexStudio
 * without making Enter unpredictable in prose.
 *
 * Tab is the unconditional accept key and is bound separately; this only
 * decides whether Enter is a second way in.
 */
export function acceptClosedSetCompletion(view) {
  const sel = CM.selectedCompletion(view.state);
  if (!sel || !CLOSED_SET.has(sel.type)) return false;
  return CM.acceptCompletion(view);
}

/**
 * The completion keys, owned here rather than left to `autocompletion()`.
 *
 * `autocompletion()` installs `completionKeymap` itself at `Prec.highest`, and
 * that binding includes Enter → acceptCompletion unconditionally. Gating Enter
 * from a lower-precedence keymap is therefore impossible — it never runs. So
 * the default is switched off (`defaultKeymap: false` below) and the same keymap
 * is re-installed here with Enter replaced.
 *
 * Tab lives here too, at the same precedence, so all three Tab claimants resolve
 * in one place:
 *
 *   1. this — accept the selected completion, false when none is selected
 *   2. the snippet keymap, appended at Prec.highest when a snippet starts —
 *      move to the next field, false when no snippet is active
 *   3. `indentWithTab` in the app's own keymap — indent
 */
export function latexCompletionKeymap() {
  return CM.Prec.highest(CM.keymap.of([
    ...CM.completionKeymap.filter(b => b.key !== 'Enter'),
    { key: 'Enter', run: acceptClosedSetCompletion },
    { key: 'Tab', run: CM.acceptCompletion }
  ]));
}

/** Everything above, as one extension array. */
export function latexEditingExtensions(getProject) {
  return [
    beginEndAutoClose(),
    CM.syntaxHighlighting(latexHighlightStyle()),
    diagnosticsGutter(),
    CM.autocompletion({
      override: [latexCompletionSource(getProject)],
      // Preselect, so Tab accepts and a reference dropdown is one keystroke
      // rather than Down-then-Enter. Safe because Tab falls through to indent
      // when nothing is open, and Enter is gated by acceptClosedSetCompletion.
      selectOnOpen: true,
      icons: false,
      activateOnTyping: true,
      defaultKeymap: false        // see latexCompletionKeymap
    }),
    latexCompletionKeymap()
  ];
}
