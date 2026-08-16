// The Legal page.
//
// Reachable from the Settings menu, and required rather than decorative: this
// app links an AGPL-3.0 component (texlyre_busytex.js), so the combined work is
// AGPL, and section 13 obliges a hosted copy to offer its corresponding source
// to everyone who loads it. The Source link below is that offer. The build
// stamp beside it is what makes the offer specific — "the source of what you are
// running", not "a repository that exists".
//
// The third-party inventory is data, not markup. Every entry here corresponds to
// something actually in the shipped bundle, and adding a dependency without
// adding a row is the mistake this shape is meant to make obvious.
//
// Licence texts: MIT and BSD oblige the permission notice to be reproduced, so
// those are inline in full. Apache, GPL and AGPL are satisfied by shipping the
// licence file itself — they are hundreds of lines each, and all four travel
// with every installer (electron-builder.yml `files:`, tauri.conf.json
// `resources`), so those rows point at the file rather than inlining it.

import { openModal } from './dialog.js';
import { setStatus } from './log_console.js';
import { VERSION, COMMIT, SOURCE_URL } from './build_info.js';

const CONTACT = 'contact@haraldrevery.com';

/** The MIT permission notice, which every MIT component must reproduce. */
const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy \
of this software and associated documentation files (the "Software"), to deal \
in the Software without restriction, including without limitation the rights to \
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of \
the Software, and to permit persons to whom the Software is furnished to do so, \
subject to the following condition: the above copyright notice and this \
permission notice shall be included in all copies or substantial portions of the \
Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS \
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, \
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.`;

/**
 * Everything third-party in the shipped bundle.
 *
 * `where` is the path inside the app, so a reader can verify each claim against
 * the files rather than taking this list on faith.
 */
const COMPONENTS = [
  {
    name: 'texlyre-busytex',
    version: '1.2.3',
    licence: 'AGPL-3.0-or-later',
    copyright: 'Copyright © Fares Abawi',
    where: 'www/jvscrpt_and_css_extra/texlyre_busytex.js',
    source: 'https://github.com/TeXlyre/texlyre-busytex',
    text: `The browser TeX engine wrapper. This component is imported directly \
into the application bundle, which is why Revery TeX as a whole is distributed \
under the AGPL-3.0-or-later. The full licence text is the LICENSE file shipped \
with this application, and an unmodified copy of the upstream distribution is \
kept in vendor/texlyre-busytex/ in the source repository.`
  },
  {
    name: 'TeX Live engines',
    version: '2026',
    licence: 'GPL-2.0-or-later, LPPL, Knuth licence',
    copyright: 'Copyright © the respective TeX Live contributors; TeX and Metafont © Donald E. Knuth',
    where: 'www/engine/dist/busytex.wasm',
    source: 'https://tug.org/texlive/',
    text: `pdfTeX, XeTeX, LuaHBTeX, bibtex8, makeindex and xdvipdfmx, compiled to \
WebAssembly. These are complete, unmodified programs, invoked across a Web Worker \
message boundary — the same relationship any LaTeX editor has to a TeX \
installation on the system PATH — and they are aggregated with this application \
rather than combined into it. Corresponding source: \
https://github.com/TeX-Live/texlive-source (texlive-2026.0), together with expat \
2.5.0 and fontconfig 2.13.96. The macro and font tree shipped alongside \
(texlive-slim-*.data) is a subset of the TeX Live texmf tree; individual packages \
and fonts carry their own licences — LPPL, GPL, the Knuth licence, SIL OFL and \
others — recorded in their own files within the distribution.`
  },
  {
    name: 'BusyTeX',
    licence: 'MIT',
    copyright: 'Copyright © Vadim Kantorov',
    where: 'the build the WebAssembly binaries derive from',
    source: 'https://github.com/busytex/busytex',
    text: MIT
  },
  {
    name: 'pdf.js',
    version: '4.10.38',
    licence: 'Apache-2.0',
    copyright: 'Copyright © Mozilla Foundation and contributors',
    where: 'www/jvscrpt_and_css_extra/pdfjs/',
    source: 'https://github.com/mozilla/pdf.js',
    text: `Renders the PDF preview. Licensed under the Apache License, Version \
2.0; the full text ships with this application as LICENSE-APACHE, and a copy \
also sits beside the library at www/jvscrpt_and_css_extra/pdfjs/LICENSE. You may \
obtain the licence at https://www.apache.org/licenses/LICENSE-2.0. Distributed on \
an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.

Ships with two data sets under separate terms, each carrying its own licence \
file: the CJK character maps in pdfjs/cmaps/ (Adobe, see cmaps/LICENSE), and the \
substitutes for the 14 base PDF fonts in pdfjs/standard_fonts/ — the Liberation \
fonts (SIL Open Font License, see LICENSE_LIBERATION) and fonts contributed by \
Foxit (see LICENSE_FOXIT).`
  },
  {
    name: 'CodeMirror 6',
    licence: 'MIT',
    copyright: 'Copyright © Marijn Haverbeke and others',
    where: 'www/jvscrpt_and_css_extra/codemirror-bundle.js',
    source: 'https://github.com/codemirror',
    text: `The editor. Includes @codemirror/legacy-modes, which provides the stex \
mode used for LaTeX syntax highlighting, under the same licence.\n\n${MIT}`
  },
  {
    name: 'KaTeX',
    version: '0.18.4',
    licence: 'MIT',
    copyright: 'Copyright © 2013–2020 Khan Academy and other contributors',
    where: 'www/jvscrpt_and_css_extra/katex/',
    source: 'https://github.com/KaTeX/KaTeX',
    text: `Renders the inline maths preview. Ships with its own web fonts, under \
the same licence.\n\n${MIT}`
  },
  {
    name: 'MiniLZ4',
    licence: 'MIT',
    copyright: 'Copyright © 2012 Pierre Curto',
    where: 'extracted at build time by build_tools/lz4_codec.js',
    source: 'https://github.com/pierrec/node-lz4',
    text: `Decompresses the TeX Live data packages. Based on node-lz4.\n\n${MIT}`
  }
];

/* ── small builders ──────────────────────────────────────────────────── */
/* Exported for about.js, which is the same kind of page and should not grow a
   second set of these. */

export function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function section(title) {
  const s = el('section', 'legal-section');
  s.appendChild(el('h4', 'legal-h', title));
  return s;
}

export function para(parent, text) {
  parent.appendChild(el('p', 'legal-p', text));
  return parent;
}

export function list(parent, items) {
  const ul = el('ul', 'legal-ul');
  for (const it of items) ul.appendChild(el('li', null, it));
  parent.appendChild(ul);
  return parent;
}

/**
 * A URL.
 *
 * Always rendered as the URL itself, never as friendly link text, because in
 * both desktop shells clicking it does nothing: Electron denies every window
 * open and blocks off-origin navigation (electron/main.js — "the app never acts
 * as a browser"), and the Tauri build ships no opener plugin. A label like
 * "our repository" would therefore be a dead end with no way to recover the
 * address. Spelled out, it can be read, selected and copied in every shell.
 *
 * The anchor is kept so the browser build stays clickable — it is a bonus where
 * it works, not the thing the page depends on.
 */
export function link(href, label) {
  const a = el('a', 'legal-link', label || href);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/**
 * Put `text` on the clipboard, reporting either way through the status line.
 *
 * Feature-detected exactly as editor_actions.js does: the API needs a secure
 * context, which the `revery://` scheme is registered as, but a browser can
 * still refuse it. Silence on failure would be the worst outcome here — the
 * caller is usually the AGPL source offer.
 */
async function copy(text, what) {
  if (!navigator.clipboard?.writeText) {
    setStatus(`${what} — copying is unavailable here; select the address to copy it`, 'warn');
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`${what} copied — ${text}`, 'ok');
    return true;
  } catch {
    setStatus(`${what} — could not copy; select the address to copy it`, 'warn');
    return false;
  }
}

/** A URL with a Copy button beside it. The affordance the desktop shells need. */
function copyableUrl(href, what) {
  const wrap = el('span', 'legal-url');
  wrap.appendChild(link(href));
  const btn = el('button', 'legal-copy', 'Copy');
  btn.title = `Copy ${what} to the clipboard`;
  btn.onclick = () => copy(href, what);
  wrap.appendChild(btn);
  return wrap;
}

/**
 * The source offer, as a menu action.
 *
 * Exported for the logo menu, where "Source code" cannot open a browser on
 * desktop and so copies the address instead.
 */
export function copySourceLink() {
  return copy(SOURCE_URL, 'Source code');
}

/* ── the sections ────────────────────────────────────────────────────── */

function ownership() {
  const s = section('Ownership, licensing and source');
  para(s, 'Revery TeX is designed and developed by Harald Mark Thirslund, ' +
    'Göteborg, Sweden. Copyright © 2026 Harald Mark Thirslund.');

  para(s, 'This application is licensed under the GNU Affero General Public ' +
    'License, version 3 or later. You may use, study, modify, redistribute and ' +
    'host it under that licence. If you distribute it, or make a modified ' +
    'version available to others over a network, you must pass on the same ' +
    'freedoms and make your complete corresponding source available.');

  para(s, 'It is AGPL rather than a permissive licence because the browser TeX ' +
    'engine wrapper it links (texlyre-busytex, listed below) is AGPL-3.0-or-later. ' +
    'The source files written by Harald Mark Thirslund are additionally ' +
    'available on their own under the Apache License 2.0 — see the LICENSE-APACHE ' +
    'file shipped with this application.');

  // AGPL section 13. This is the offer, and it must work in every shell — which
  // is why the address is spelled out with a Copy button rather than hidden
  // behind link text that the desktop builds refuse to open.
  const src = el('p', 'legal-p legal-source');
  src.appendChild(document.createTextNode('Complete source code: '));
  src.appendChild(copyableUrl(SOURCE_URL, 'Source code'));
  // Its own line: the Copy button makes the first line tall, and an inline
  // separator before this ends up dangling at the end of it.
  src.appendChild(el('span', 'legal-build',
    `version ${VERSION}${COMMIT && COMMIT !== 'unknown' ? ` · build ${COMMIT}` : ''}`));
  s.appendChild(src);

  para(s, 'Brand assets are not covered by the licences above. The Harald ' +
    'Revery typefaces, the Revery logo, the application icons and the ' +
    'background photographs remain the property of Harald Mark Thirslund. You ' +
    'may keep and use them, unmodified and in place, to build, run, distribute ' +
    'and fork this software — that permission is granted to every recipient and ' +
    'restricts nothing the AGPL gives you over the code. Using them in other ' +
    'projects or branding requires written permission. Full terms: the ' +
    'LICENSE-ASSETS file. The fonts inside the TeX Live tree — Computer Modern, ' +
    'Latin Modern, TeX Gyre and others — are third-party material under their ' +
    'own licences, not brand assets.');
  return s;
}

function terms() {
  const s = section('Terms of use');
  para(s, 'By using Revery TeX you agree to these terms. If you do not agree, ' +
    'please discontinue use.');
  list(s, [
    'Revery TeX is a document authoring tool. You may use it for any lawful purpose.',
    'You are solely responsible for the documents you create, store or export with it.',
    'You must not use it to create, store or distribute unlawful or infringing content.',
    'The software is provided "as is", without warranty of any kind, to the extent permitted by law. This does not affect any statutory rights you have as a consumer.'
  ]);
  para(s, 'These terms are governed by the laws of Sweden and, where ' +
    'applicable, of the European Union.');
  return s;
}

function storage() {
  const s = section('Where your work is stored');
  para(s, 'Revery TeX runs entirely on your own device. It has no server, no ' +
    'account and no network calls. Nothing you write is transmitted anywhere, ' +
    'and the developer has no access to any of it.');

  para(s, 'In the desktop application:');
  list(s, [
    'Your project — ordinary files in the folder you opened, written with crash-safe atomic saves. They are yours; nothing else touches them.',
    'Crash backups — kept in the application data directory while a file has unsaved changes, and removed once it no longer does.'
  ]);

  para(s, 'In the browser:');
  list(s, [
    'revery_tex_fs (IndexedDB) — your project files, when the browser cannot write back to a real folder and the project was imported instead.',
    'revery_tex_backup:… and revery_tex_zipbackup:… (localStorage) — the unsaved text of the file you are editing, so a closed tab does not lose it.',
    'revery_tex_settings, revery_tex_custom_bg, revery_tex_custom_font (localStorage) — your appearance and behaviour preferences, including a background image or editor font you supplied yourself.',
    'EM_PRELOAD_CACHE (IndexedDB) — the TeX Live distribution, cached after first use so compiling does not re-download roughly a hundred megabytes each session. This is by far the largest item, and it contains no personal data: it is the same public TeX Live data for every user.'
  ]);

  para(s, 'You can remove all of it at any time. Desktop projects are ordinary ' +
    'files you can delete like any others; in the browser, clearing this site\'s ' +
    'data removes every item listed above, the cached TeX distribution included.');
  return s;
}

function tracking() {
  const s = section('Cookies and tracking');
  para(s, 'Revery TeX uses no cookies, no tracking pixels, no analytics, no ' +
    'advertising and no third-party data collection of any kind. There is no ' +
    'profiling and no behavioural tracking. No data is shared with or sold to ' +
    'anyone, because none is collected.');
  return s;
}

function privacy() {
  const s = section('Privacy');

  s.appendChild(el('p', 'legal-sub', 'EU and EEA — GDPR'));
  para(s, 'Harald Mark Thirslund is the data controller under Regulation (EU) ' +
    '2016/679. Revery TeX processes no personal data on any server and collects ' +
    'no identifying information; the only data it handles is content you create ' +
    'yourself, stored solely on your own device. The principles of data ' +
    'minimisation and purpose limitation are therefore satisfied by design. You ' +
    'can exercise your rights of access, erasure, portability, restriction and ' +
    'objection by deleting your own files and clearing your own browser storage. ' +
    `Questions: ${CONTACT}.`);

  s.appendChild(el('p', 'legal-sub', 'North America — CCPA/CPRA, PIPEDA, Quebec Law 25'));
  para(s, 'No personal information is sold, rented or traded, and none is ' +
    'collected through this application. There is consequently no personal ' +
    'information held about California or Canadian residents that could be ' +
    'subject to an access, deletion or opt-out request.');

  s.appendChild(el('p', 'legal-sub', 'Australia — Privacy Act 1988 (Cth)'));
  para(s, 'Revery TeX does not collect, hold, use or disclose personal ' +
    'information as defined by the Privacy Act 1988 and the Australian Privacy ' +
    'Principles.');

  para(s, 'Revery TeX is not directed at children under 13. By using it you ' +
    'confirm you are of an age to agree to these terms.');
  return s;
}

function thirdParty() {
  const s = section('Third-party components');
  para(s, 'Revery TeX bundles the following. Each is used unmodified and is ' +
    'governed by its own licence. Licence texts referred to below ship with the ' +
    'application, beside this one.');

  const wrap = el('div', 'legal-libs');
  for (const c of COMPONENTS) {
    const card = el('div', 'legal-lib');

    const head = el('p', 'legal-lib-head');
    head.appendChild(el('strong', null, c.name + (c.version ? ` ${c.version}` : '')));
    head.appendChild(el('span', 'legal-lib-licence', `  ·  ${c.licence}`));
    card.appendChild(head);

    card.appendChild(el('p', 'legal-lib-meta', c.copyright));
    card.appendChild(el('p', 'legal-lib-text', c.text));

    const foot = el('p', 'legal-lib-meta');
    foot.appendChild(document.createTextNode(`${c.where} — `));
    foot.appendChild(link(c.source));
    card.appendChild(foot);

    wrap.appendChild(card);
  }
  s.appendChild(wrap);
  return s;
}

function contact() {
  const s = section('Contact');
  const p = el('p', 'legal-p');
  p.appendChild(document.createTextNode('Harald Mark Thirslund, Göteborg, Sweden — '));
  p.appendChild(link(`mailto:${CONTACT}`, CONTACT));
  p.appendChild(document.createTextNode(' — '));
  p.appendChild(link('https://haraldrevery.com'));
  s.appendChild(p);
  return s;
}

/* ── entry point ─────────────────────────────────────────────────────── */

/** Open the Legal page. Bound to the Settings menu and to the Source link. */
export function openLegal() {
  const modal = openModal({ title: 'Legal', className: 'dlg legal-dlg' });

  const scroll = el('div', 'legal-scroll');
  for (const build of [ownership, terms, storage, tracking, privacy, thirdParty, contact]) {
    scroll.appendChild(build());
  }
  modal.body.appendChild(scroll);

  // openModal builds the footer but leaves attaching it to the caller, so a
  // dialog that does not want one does not get an empty bar.
  const close = el('button', null, 'Close');
  close.onclick = () => modal.close();
  modal.foot.appendChild(close);
  modal.panel.appendChild(modal.foot);
  close.focus();

  return modal;
}
