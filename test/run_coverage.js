// Drives test/coverage_probe.html in headless Chrome and reports the verdict.
//
//   node test/serve.js &
//   node test/run_coverage.js
//
// Not part of `npm run check`. See the comment at the top of coverage_probe.html
// for why this is a separate question from the gate.
//
// Exits non-zero if any document failed to produce a PDF, or if any produced one
// with degradation warnings in its log. The second half matters as much as the
// first: "compiled, but the glyphs are missing" is the failure users actually
// report, and it is invisible to a page count.

const { launch, sleep } = require('./cdp.js');

const URL = process.env.COVERAGE_URL || 'http://localhost:8777/test/coverage_probe.html';
const TIMEOUT_MS = Number(process.env.COVERAGE_TIMEOUT_MS || 900000);

async function main() {
  const { cdp, cleanup, pageErrors } = await launch({ url: URL, port: 9344 });

  const deadline = Date.now() + TIMEOUT_MS;
  let printed = '';
  let done = false;

  // Stream the page's own output as it goes. A compile can take 20s and a run
  // is a dozen of them; a silent terminal for five minutes reads as a hang.
  while (Date.now() < deadline && !done) {
    try {
      done = !!(await cdp.evaluate('!!(window.__probe && window.__probe.done)', false));
      const txt = (await cdp.evaluate('document.getElementById("out").textContent', false)) || '';
      if (txt.length > printed.length) {
        process.stdout.write(txt.slice(printed.length));
        printed = txt;
      }
    } catch { /* module still evaluating */ }
    if (!done) await sleep(2000);
  }

  const probe = JSON.parse((await cdp.evaluate('JSON.stringify(window.__probe || null)', false)) || 'null');

  // A page error is not automatically a failure — the dev server has no favicon
  // — but an uncaught exception means the probe never ran and "0 failures" would
  // be a lie.
  const real = (pageErrors || []).filter(e => !/favicon/i.test(e));
  if (real.length) {
    console.error('\npage errors:\n  ' + real.slice(0, 6).join('\n  '));
  }

  cleanup();

  if (!probe || !probe.done) {
    console.error(`\n✗ probe did not finish within ${Math.round(TIMEOUT_MS / 1000)}s`);
    process.exit(2);
  }

  const failed = probe.results.filter(([, ok]) => !ok).map(([k]) => k);
  const dirty = probe.results.filter(([, ok, bad]) => ok && bad).map(([k]) => k);

  console.log(`\n════ coverage ════`);
  console.log(`  compiled   ${probe.ok}/${probe.total}`);
  if (failed.length) console.log(`  FAILED     ${failed.join(', ')}`);
  if (dirty.length) console.log(`  degraded   ${dirty.join(', ')}  (produced a PDF, log says otherwise)`);

  process.exit(failed.length || dirty.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
