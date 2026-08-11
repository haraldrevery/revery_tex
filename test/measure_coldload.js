// Measures what a first-time visitor actually waits for.
//
//   node test/serve.js &
//   node test/measure_coldload.js
//
// Chrome runs in a throwaway profile, so the HTTP cache and the Emscripten
// IndexedDB package cache both start empty -- that is the cold case.
//
// Bytes are counted SERVER-SIDE (/api/netstats), which is authoritative. CDP's
// Network domain cannot see the engine's worker fetches reliably: the preload
// data packages complete before Network.enable lands on the child session, so
// the largest downloads go silently uncounted.
//
// Transfer time at a given bandwidth is COMPUTED from the measured byte count,
// not measured. Chrome's emulateNetworkConditions proved unusable for this
// workload -- applied to the page and worker sessions together it compounds (a
// 50 Mbit/s setting measured ~2 Mbit/s effective, six minutes for what should
// be a sixteen-second load), and applied to workers alone it had no effect at
// all. Arithmetic on an authoritative byte count beats an emulation that is
// silently wrong.

const { launch, sleep } = require('./cdp.js');

const URL = process.env.SMOKE_URL || 'http://localhost:8777/test/engine_smoke.html';
const PROJECT = process.env.COLD_PROJECT || 'cv';   // smallest: isolates engine cost from document cost
const ORIGIN = URL.replace(/\/test\/.*$/, '');

const fmtBytes = (b) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;
const fmtSecs = (s) => s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${s.toFixed(1)}s`;

const netstats = (reset) =>
  fetch(`${ORIGIN}/api/netstats${reset ? '?reset=1' : ''}`).then(r => r.json()).catch(() => null);

const runProject = (cdp) =>
  cdp.evaluate(`window.__reveryTex.run(${JSON.stringify({ project: PROJECT })})`);

async function measure() {
  const { cdp, cleanup, pageErrors } = await launch({ url: 'about:blank', port: 9400 });
  try {
    await netstats(true);

    const t0 = Date.now();
    await cdp.send('Page.navigate', { url: URL });
    await cdp.waitFor('window.__reveryTex && window.__reveryTex.ready === true',
      { timeoutMs: 900000, what: 'harness ready' });
    const tReady = (Date.now() - t0) / 1000;

    // First compile pays for engine init plus every preload data package.
    const c0 = Date.now();
    const cold = await runProject(cdp);
    const tCold = (Date.now() - c0) / 1000;
    if (!cold.ok) throw new Error(`cold compile failed: ${cold.status}`);

    // Second compile: engine already up.
    const w0 = Date.now();
    const warm = await runProject(cdp);
    const tWarm = (Date.now() - w0) / 1000;
    if (!warm.ok) throw new Error(`warm compile failed: ${warm.status}`);

    const serverCold = await netstats(true);

    // Reload: HTTP cache and the Emscripten IndexedDB package cache are both
    // populated now, so this is the returning-visitor case.
    const r0 = Date.now();
    await cdp.send('Page.navigate', { url: URL });
    await cdp.waitFor('window.__reveryTex && window.__reveryTex.ready === true',
      { timeoutMs: 900000, what: 'harness ready after reload' });
    await runProject(cdp);
    const tRevisit = (Date.now() - r0) / 1000;
    const serverRevisit = await netstats(false);

    const top = Object.entries(serverCold.byPath)
      .map(([p, e]) => [`${p}${e.n > 1 ? ` x${e.n}` : ''}`, e.bytes])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    return {
      bytes: serverCold.bytes,
      requests: serverCold.requests,
      revisitBytes: serverRevisit ? serverRevisit.bytes : 0,
      top, tReady, tCold, tWarm, tRevisit,
      pageErrors: [...new Set(pageErrors)].slice(0, 3)
    };
  } finally {
    cleanup();
    await sleep(300);
  }
}

async function main() {
  console.log(`cold-load measurement · project="${PROJECT}"`);
  console.log('fresh Chrome profile: empty HTTP cache, empty IndexedDB\n');

  let r;
  try {
    r = await measure();
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }

  console.log('════ measured ════');
  console.log(`  transferred                ${fmtBytes(r.bytes)} over ${r.requests} requests`);
  console.log(`  page ready                 ${fmtSecs(r.tReady)}`);
  console.log(`  engine init + 1st compile  ${fmtSecs(r.tCold)}  (CPU + decompress; no network constraint)`);
  console.log(`  2nd compile                ${fmtSecs(r.tWarm)}  (engine already up)`);
  console.log(`  revisit                    ${fmtSecs(r.tRevisit)}, ${fmtBytes(r.revisitBytes)} re-fetched`);

  console.log('\n  largest transfers:');
  for (const [name, n] of r.top) console.log(`    ${fmtBytes(n).padStart(9)}  ${name}`);

  console.log('\n════ computed time to first PDF ════');
  console.log('  transfer = measured bytes / bandwidth, plus the measured CPU cost above');
  const bands = [
    ['broadband  50 Mbit/s', 50e6],
    ['fast 4G    10 Mbit/s', 10e6],
    ['slow 4G     3 Mbit/s', 3e6],
    ['fast 3G   1.6 Mbit/s', 1.6e6]
  ];
  for (const [label, bps] of bands) {
    const transfer = (r.bytes * 8) / bps;
    console.log(`  ${label}   ${fmtSecs(transfer).padStart(8)} transfer  ->  ${fmtSecs(transfer + r.tCold).padStart(8)} total`);
  }

  console.log('\n  NOTE: the dev server sends Cache-Control: no-store, so the revisit figure is');
  console.log('  pessimistic — the .data packages came from IndexedDB but the wasm was re-fetched.');
  console.log('  With real cache headers a revisit should approach zero bytes.');

  if (r.pageErrors.length) {
    console.log('\n  browser errors:');
    for (const e of r.pageErrors) console.log(`    ${e}`);
  }
}

main();
