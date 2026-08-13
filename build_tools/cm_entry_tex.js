// CodeMirror 6 bundle entry for Revery TeX.
//
// Built by build_cm.js into www/jvscrpt_and_css_extra/codemirror-bundle.js as an
// IIFE exposing the global `CM`. Self-hosted, no CDN, so the strict CSP holds.
//
// Deliberately NOT a copy of Revery Notebook's cm_entry_slim.js: that entry
// exists to highlight fenced code blocks inside markdown, and carries 23
// legacy-mode languages plus the lang-markdown/lezer-markdown stack. A LaTeX
// editor needs exactly one language, so all of that is dropped.
//
// stex comes from @codemirror/legacy-modes rather than a lezer grammar because
// Overleaf's lezer-latex is AGPL-3.0 and this project's licence is undecided.
// StreamLanguage highlighting is coarser than a real parser -- good enough for
// colouring, not enough for structural queries -- so anything needing structure
// (\label scanning, \begin/\end matching) is done over the document text
// instead, and can move to a parser later without touching callers.

export {
  EditorView, keymap, Decoration, ViewPlugin, WidgetType,
  drawSelection, placeholder, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, gutter, GutterMarker, tooltips
} from '@codemirror/view';

export {
  EditorState, StateField, StateEffect, Compartment, RangeSetBuilder,
  RangeSet, Prec, Facet, EditorSelection, Text
} from '@codemirror/state';

export {
  history, historyKeymap, defaultKeymap, indentWithTab,
  undo, redo, indentMore, indentLess, toggleComment
} from '@codemirror/commands';

// snippet* is what makes a completion insert a template with tab stops rather
// than bare text. `snippetKeymap` is not re-exported to be *used* — the snippet
// state installs its own binding at Prec.highest — but so the app can see what
// owns Tab while a snippet is active.
//
// `selectedCompletion` is needed because `selectOnOpen` is a global config with
// no per-result override: Enter can only be made safe (accept a label, insert a
// newline in prose) by looking at what is actually selected.
export {
  autocompletion, startCompletion, closeCompletion, completionStatus,
  moveCompletionSelection, acceptCompletion, completionKeymap,
  snippet, snippetCompletion, snippetKeymap,
  nextSnippetField, prevSnippetField, hasNextSnippetField, clearSnippet,
  selectedCompletion
} from '@codemirror/autocomplete';

export {
  searchKeymap, highlightSelectionMatches, openSearchPanel,
  closeSearchPanel, findNext, findPrevious, search, SearchQuery, setSearchQuery
} from '@codemirror/search';

export {
  syntaxHighlighting, defaultHighlightStyle, HighlightStyle,
  StreamLanguage, LanguageSupport, foldGutter, foldKeymap, codeFolding,
  foldService, indentUnit, syntaxTree, bracketMatching
} from '@codemirror/language';

export { tags } from '@lezer/highlight';

import { StreamLanguage, LanguageSupport } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';

/**
 * LaTeX language support.
 *
 * Wrapped in LanguageSupport rather than exported as a bare StreamLanguage:
 * a bare StreamLanguage has no `.language` property, and anything reading
 * `support.language` (as nested-parse consumers do) then fails at runtime.
 * Revery Notebook hit exactly this with its code-fence languages; the same
 * wrapper avoids it here.
 */
export const latex = () => new LanguageSupport(StreamLanguage.define(stex));

/** The raw StreamLanguage, for callers that need to compose extensions. */
export const latexLanguage = StreamLanguage.define(stex);
