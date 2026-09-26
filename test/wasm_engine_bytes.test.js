// What the bundled engine is handed, when a source file is not UTF-8.
//
// A project may hold .tex files in Latin-1 or another 8-bit encoding — older
// documents with \usepackage[latin1]{inputenc} are the usual case. Those are
// kept as bytes (project_store.js), and bytes are what TeX has to read. The
// engine used to decode the *main* file to a string on its way in, with a
// lenient UTF-8 decoder, so every accented byte reached TeX as U+FFFD. Every
// other file already went through untouched; only the main one was converted.
//
// The runner is stubbed, so this checks the one boundary that matters — what
// crosses into BusyTeX — without a 30 MB engine.

const { test } = require('node:test');
const assert = require('node:assert');

let _engine;
const engineModule = async () =>
  (_engine ??= await import('../www/jvscrpt_and_css_extra/tex_engine_wasm.js'));

const LATIN1_MAIN = Uint8Array.from(Buffer.from(
  '\\documentclass{article}\\usepackage[latin1]{inputenc}\\begin{document}Caf\xe9\\end{document}\n',
  'latin1'));

/** An engine whose runner records what it was given and compiles nothing. */
async function stubbedEngine() {
  const { WasmTexEngine } = await engineModule();
  const eng = new WasmTexEngine({ basePath: 'http://engine.test/dist', texmfPath: 'http://engine.test/dist' });
  const seen = {};
  eng._runner = {
    isInitialized: () => true,
    getConfig: () => ({ engineMode: 'combined' }),
    compile: async (files, mainTexPath) => {
      seen.files = files;
      seen.main = mainTexPath;
      return { success: false, pdf: null, log: '', exitCode: 1 };
    }
  };
  eng.capabilities.engines = ['pdflatex', 'xelatex'];
  return { eng, seen };
}

test('a main file held as bytes reaches the engine byte for byte', async () => {
  const { eng, seen } = await stubbedEngine();
  await eng.compile({
    files: [{ path: 'main.tex', content: LATIN1_MAIN }],
    mainFile: 'main.tex', engine: 'pdflatex', passes: false
  });
  const main = seen.files.find(f => f.path === 'main.tex');
  assert.ok(main, 'the main file was not passed at all');
  const got = typeof main.content === 'string' ? Buffer.from(main.content, 'utf8') : Buffer.from(main.content);
  assert.deepStrictEqual([...got], [...LATIN1_MAIN],
    'the main file was re-encoded on its way to TeX');
});

test('a main file held as text is passed as that text', async () => {
  const { eng, seen } = await stubbedEngine();
  const src = '\\documentclass{article}\\begin{document}Café\\end{document}\n';
  await eng.compile({
    files: [{ path: 'main.tex', content: src }, { path: 'x.png', content: Uint8Array.of(1, 2, 3) }],
    mainFile: 'main.tex', engine: 'pdflatex', passes: false
  });
  assert.equal(seen.main, 'main.tex');
  assert.equal(seen.files.find(f => f.path === 'main.tex').content, src);
  assert.deepStrictEqual([...seen.files.find(f => f.path === 'x.png').content], [1, 2, 3]);
});
