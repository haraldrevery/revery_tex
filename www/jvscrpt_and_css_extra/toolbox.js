// What the Toolbox button offers.
//
// The menu *spec* lives here rather than in the app shell, so adding an insert
// action is a change to this file and not to the 850-line shell. The shell only
// says which button it hangs off and how to reach the editor and the project.
//
// Everything here reads the one index and writes through editor_actions, so no
// feature in this menu scans project text or touches CodeMirror directly.

import { projectIndex, environmentsOfKind } from './document_model.js';
import { formattingRows, insertBlockAtCursor, insertReference } from './editor_actions.js';
import { tableBlock, availableRules } from './table_builder.js';
import { slug, uniqueLabel } from './latex_snippets.js';
import { openDialog } from './dialog.js';

/** One line of an environment's source, for the tooltip on a reference row. */
function snippet(env, lines = 3) {
  return env.source.split('\n').slice(0, lines).join('\n').slice(0, 300);
}

/** How a table is named in a list: its caption, falling back to its label. */
export function tableRowLabel(env) {
  const caption = (env.caption || '').replace(/\s+/g, ' ').trim();
  const shown = caption || env.label || '(untitled)';
  return shown.length > 44 ? `${shown.slice(0, 43)}…` : shown;
}

function insertTableDialog(view, project) {
  const ix = projectIndex(project());
  const rules = availableRules(ix.packages);
  // True once the label box has been typed in: after that the caption stops
  // overwriting it, or every keystroke in the caption would undo the edit.
  let labelEdited = false;

  openDialog({
    title: 'Insert table',
    fields: [
      { key: 'rows', label: 'Rows', type: 'number', def: 3, min: 1, max: 60 },
      { key: 'cols', label: 'Columns', type: 'number', def: 3, min: 1, max: 20 },
      { key: 'header', label: 'Header row', type: 'check', def: true },
      {
        key: 'align', label: 'Align', type: 'choice', def: 'l',
        options: [{ value: 'l', label: 'Left' }, { value: 'c', label: 'Centre' }, { value: 'r', label: 'Right' }]
      },
      // Booktabs appears only when the document already loads it — see
      // table_builder.js. The menu never offers what would need a new
      // \usepackage line.
      { key: 'rules', label: 'Rules', type: 'choice', def: rules[0].value, options: rules },
      { key: 'caption', label: 'Caption', type: 'text', def: '', placeholder: 'optional' },
      { key: 'label', label: 'Label', type: 'text', def: '', placeholder: 'tab:…' }
    ],
    onChange: (v, key) => {
      if (key === 'label') { labelEdited = true; return null; }
      if (key !== 'caption' || labelEdited) return null;
      // The label follows the caption, deduplicated against the whole project:
      // two \label{tab:results} make every \ref to them ambiguous, and LaTeX
      // only warns about it.
      return { label: v.caption ? uniqueLabel(`tab:${slug(v.caption)}`, ix.labels) : '' };
    },
    preview: (v) => tableBlock(v),
    onSubmit: (v) => insertBlockAtCursor(view(), tableBlock(v))
  });
}

/** The reference-a-table submenu: existing tables, by caption and label. */
function tableReferenceRow(view, project) {
  const tables = environmentsOfKind(project(), 'table');
  const labelled = tables.filter(t => t.label);

  if (!tables.length) return { type: 'note', label: 'no tables to reference yet' };
  if (!labelled.length) {
    // A \ref to an unlabelled table cannot be written, and offering rows that
    // insert \ref{} would be worse than saying why the list is empty.
    return { type: 'note', label: `${tables.length} table(s), none labelled` };
  }

  return {
    type: 'submenu',
    label: 'Reference a table',
    hint: String(labelled.length),
    actions: labelled.map(t => ({
      label: tableRowLabel(t),
      title: `${t.label} — ${t.file}:${t.startLine}\n\n${snippet(t)}`,
      run: () => insertReference(view(), 'table', t.label)
    }))
  };
}

/**
 * The insert half of the menu — everything that puts new LaTeX in the document.
 *
 * @param {{view: () => object, project: () => object|null}} ctx
 */
export function insertRows({ view, project }) {
  return [
    { type: 'action', label: 'Insert table…', run: () => insertTableDialog(view, project) },
    tableReferenceRow(view, project)
  ];
}

/** The Toolbox button's menu: inserting first, since that is why it is there. */
export function toolboxRows(ctx) {
  return [
    ...insertRows(ctx),
    { type: 'divider' },
    { type: 'note', label: 'Formatting applies to the selection.' },
    ...formattingRows(ctx.view)
  ];
}

/**
 * The right-click menu: the same rows, formatting first.
 *
 * It only opens over a selection (see the app shell), and with text selected
 * the likely intent is to format it — so that half goes on top. Both menus are
 * built from the same two pieces, which is what stops them drifting into
 * offering different things.
 */
export function contextRows(ctx) {
  return [
    ...formattingRows(ctx.view),
    { type: 'divider' },
    ...insertRows(ctx)
  ];
}
