// The table builder.
//
// The output has to compile, and the ways it can fail to are all silent: a `%`
// in a caption comments the rest of it away, a `\label` above its `\caption`
// numbers the wrong table, a column spec that disagrees with the row width
// throws "Extra alignment tab". Each of those is a test here.

const { test } = require('node:test');
const assert = require('node:assert');

let _mod;
const mod = async () => (_mod ??= await import('../www/jvscrpt_and_css_extra/table_builder.js'));

const build = async (spec) => (await mod()).tableBlock(spec);

/* ── structure ───────────────────────────────────────────────────────── */

test('a default table is a float around a tabular', async () => {
  const t = await build({ rows: 2, cols: 3, caption: 'Results', label: 'tab:results' });
  assert.match(t, /^\\begin\{table\}\[htbp\]\n/);
  assert.match(t, /\\end\{table\}$/);
  assert.match(t, /\\begin\{tabular\}\{\|l\|l\|l\|\}/);
  assert.equal((t.match(/\\\\/g) || []).length, 3, 'a header row plus two body rows');
});

test('the caption comes before the label', async () => {
  // \label takes the number of the most recent \caption. Above it, every \ref
  // to this table quietly points at the previous one — and it still compiles.
  const t = await build({ caption: 'C', label: 'tab:c' });
  assert.ok(t.indexOf('\\caption') < t.indexOf('\\label'), t);
  assert.ok(t.indexOf('\\label') < t.indexOf('\\begin{tabular}'), t);
});

test('a label with no caption still gets a caption to number from', async () => {
  const t = await build({ label: 'tab:x' });
  assert.match(t, /\\caption\{\}\n\s*\\label\{tab:x\}/);
});

test('no caption and no label means no caption line', async () => {
  const t = await build({});
  assert.ok(!t.includes('\\caption'), t);
  assert.ok(!t.includes('\\label'), t);
});

/* ── columns and rows ────────────────────────────────────────────────── */

test('every row has one fewer ampersand than there are columns', async () => {
  for (const cols of [1, 2, 5]) {
    const t = await build({ rows: 2, cols });
    for (const line of t.split('\n').filter(l => l.endsWith('\\\\'))) {
      assert.equal((line.match(/&/g) || []).length, cols - 1, `${cols} columns: ${line}`);
    }
  }
});

test('alignment can be per column, and is widened to fit', async () => {
  assert.match(await build({ cols: 4, align: 'lcr', rules: 'none' }), /\{tabular\}\{lcrr\}/);
  assert.match(await build({ cols: 3, align: 'c', rules: 'none' }), /\{tabular\}\{ccc\}/);
  // Anything else falls back rather than passing junk into the column spec.
  assert.match(await build({ cols: 2, align: 'p{3cm}', rules: 'none' }), /\{tabular\}\{ll\}/);
});

test('row and column counts are clamped, not trusted', async () => {
  const t = await build({ rows: 0, cols: 0 });
  assert.match(t, /\{tabular\}\{\|l\|\}/);
  assert.equal((t.match(/\\\\/g) || []).length, 2, 'header plus one row');
});

/* ── rules ───────────────────────────────────────────────────────────── */

test('booktabs uses its own rules and drops the vertical lines', async () => {
  const t = await build({ rows: 1, cols: 2, rules: 'booktabs' });
  assert.match(t, /\{tabular\}\{ll\}/);
  assert.ok(t.includes('\\toprule') && t.includes('\\midrule') && t.includes('\\bottomrule'));
  assert.ok(!t.includes('\\hline'), t);
});

test('booktabs is only offered when the document loads it', async () => {
  const { availableRules } = await mod();
  assert.deepEqual(availableRules(['geometry']).map(r => r.value), ['lines', 'none']);
  assert.deepEqual(availableRules(['geometry', 'booktabs']).map(r => r.value),
    ['lines', 'booktabs', 'none']);
});

test('no header means no middle rule', async () => {
  const t = await build({ rows: 2, cols: 2, header: false, rules: 'booktabs' });
  assert.ok(!t.includes('\\midrule'), t);
  assert.equal((t.match(/\\\\/g) || []).length, 2);
});
