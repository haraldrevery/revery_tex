// The completion catalogue and its snippet templates.
//
// A template is only ever seen after it has been inserted, so the failures it
// can hide are exactly the ones nobody notices until a document will not
// compile: an environment whose \end does not match its \begin, an unbalanced
// brace, or a placeholder that survives untouched and gets typeset as prose.
// All three are decidable from the template text alone.

const { test } = require('node:test');
const assert = require('node:assert');

let _mod;
const mod = async () => (_mod ??= await import('../www/jvscrpt_and_css_extra/latex_commands.js'));

/** Braces outside a \{ or \} escape, ignoring the ones TeX escapes. */
function balanced(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }          // \{ \} \\ — skip the pair
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}

test('every command template starts with the command it completes', async () => {
  const { COMMANDS } = await mod();
  for (const c of COMMANDS) {
    if (!c.template) continue;
    assert.ok(c.template.startsWith('\\' + c.name),
      `${c.name}: template is ${JSON.stringify(c.template)}`);
  }
});

test('command templates have balanced braces once the stops are filled', async () => {
  const { COMMANDS, expandTemplate } = await mod();
  for (const c of COMMANDS) {
    if (!c.template) continue;
    assert.ok(balanced(expandTemplate(c.template)),
      `${c.name}: ${JSON.stringify(expandTemplate(c.template))}`);
  }
});

test('environment templates close the environment they open', async () => {
  // \begin{align} … \end{aligned} compiles as far as the \end, then fails with
  // a message naming neither. This is the check that would have caught it.
  const { ENVIRONMENTS, envOfTemplate } = await mod();
  for (const e of ENVIRONMENTS) {
    if (!e.template) continue;
    assert.equal(envOfTemplate(e.template), e.name,
      `${e.name}: template opens ${envOfTemplate(e.template)}`);
    assert.ok(e.template.endsWith(`\\end{${e.name}}`),
      `${e.name}: template ends ${JSON.stringify(e.template.slice(-30))}`);
  }
});

test('environment templates are balanced once the stops are filled', async () => {
  const { ENVIRONMENTS, expandTemplate } = await mod();
  for (const e of ENVIRONMENTS) {
    if (!e.template) continue;
    // The template is the tail after `\begin{`, so put the head back before
    // counting — otherwise every one of them looks short a brace.
    assert.ok(balanced('\\begin{' + expandTemplate(e.template)),
      `${e.name}: ${JSON.stringify(expandTemplate(e.template))}`);
  }
});

test('environment templates indent with tabs, never spaces', async () => {
  // CodeMirror expands each leading tab to one indent unit and prefixes the
  // insertion point's own indentation. Leading spaces are copied literally and
  // stack on top of that, so a figure inserted inside an indented block walks
  // to the right a little further every time.
  const { ENVIRONMENTS } = await mod();
  for (const e of ENVIRONMENTS) {
    if (!e.template) continue;
    for (const line of e.template.split('\n')) {
      assert.ok(!/^ /.test(line), `${e.name}: line indented with spaces: ${JSON.stringify(line)}`);
    }
  }
});

test('anything left in an untouched tab stop is valid LaTeX, not a prompt word', async () => {
  // Tab stops are abandoned the moment the user clicks away, and whatever was
  // in them stays in the document. A stop pre-filled with "caption" would be
  // typeset as the word caption; one holding [htbp] or 0.8\textwidth is a real
  // default and is fine to leave.
  const { COMMANDS, ENVIRONMENTS, expandTemplate } = await mod();
  // `cmd` and `env` are names, not prompts: `\newcommand{\cmd}{}` compiles, and
  // an empty stop there would expand to `\newcommand{\}{}` instead — an escaped
  // brace, and unbalanced.
  const ALLOWED = /^(htbp|0\.8\\textwidth|0\.48\\textwidth|cc|XX|1em|11pt|article|plain|Python|cmd|env)$/;
  for (const entry of [...COMMANDS, ...ENVIRONMENTS]) {
    if (!entry.template) continue;
    for (const m of entry.template.matchAll(/[#$]\{((?:\\[{}]|[^{}])*)\}/g)) {
      if (!m[1]) continue;                      // an empty stop leaves nothing
      assert.match(m[1], ALLOWED,
        `${entry.name}: stop ${JSON.stringify(m[1])} would be left in the document`);
    }
    assert.ok(expandTemplate(entry.template).length > 0);
  }
});

test('no tab stop is digits alone', async () => {
  // `#{1}` is parsed as tab stop *number* one, not as a default of "1": the
  // digits vanish and the surrounding stops are renumbered around it.
  const { COMMANDS, ENVIRONMENTS } = await mod();
  for (const entry of [...COMMANDS, ...ENVIRONMENTS]) {
    if (!entry.template) continue;
    assert.ok(!/[#$]\{\d+\}/.test(entry.template),
      `${entry.name}: ${entry.template}`);
  }
});

test('expandTemplate strips the markers and keeps the defaults', async () => {
  const { expandTemplate } = await mod();
  assert.equal(expandTemplate('\\frac{#{}}{#{}}'), '\\frac{}{}');
  assert.equal(expandTemplate('\\hspace{#{1em}}'), '\\hspace{1em}');
  assert.equal(expandTemplate('a#{x}b#{}c'), 'axbc');
});

test('names are unique within each list', async () => {
  const { COMMANDS, ENVIRONMENTS } = await mod();
  for (const [what, list] of [['command', COMMANDS], ['environment', ENVIRONMENTS]]) {
    const seen = new Set();
    for (const e of list) {
      assert.ok(!seen.has(e.name), `duplicate ${what} ${e.name}`);
      seen.add(e.name);
    }
  }
});

test('the catalogue still covers what the old inline list did', async () => {
  // The two arrays this replaced lived in latex_editor.js. Losing an entry in
  // the move would be invisible — a completion that simply stops being offered.
  const { COMMANDS, ENVIRONMENTS } = await mod();
  const cmds = new Set(COMMANDS.map(c => c.name));
  const envs = new Set(ENVIRONMENTS.map(e => e.name));
  for (const c of ['section', 'subsection', 'label', 'ref', 'eqref', 'cite', 'citep',
    'citet', 'emph', 'textbf', 'textit', 'texttt', 'caption', 'includegraphics',
    'input', 'include', 'usepackage', 'documentclass', 'newcommand', 'frac',
    'sqrt', 'sum', 'int', 'lim', 'alpha', 'beta', 'omega', 'left', 'quad',
    'hspace', 'vspace', 'newpage', 'clearpage', 'bibliography', 'index']) {
    assert.ok(cmds.has(c), `\\${c} was dropped`);
  }
  for (const e of ['document', 'itemize', 'enumerate', 'figure', 'table', 'tabular',
    'equation', 'equation*', 'align', 'align*', 'gather', 'matrix', 'pmatrix',
    'bmatrix', 'cases', 'abstract', 'quote', 'verbatim', 'lstlisting', 'center',
    'minipage', 'subfigure', 'theorem', 'proof', 'definition', 'lemma',
    'proposition', 'corollary', 'algorithm']) {
    assert.ok(envs.has(e), `${e} was dropped`);
  }
});
