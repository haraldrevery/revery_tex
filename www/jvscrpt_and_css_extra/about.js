// The About page.
//
// Sibling of legal.js: same modal shell, same builders, same scroll container.
// Legal is what the licences oblige; this is what the application is.
//
// The "Safety by design" section states guarantees rather than aspirations, and
// every line of it was checked against both backends before being written here —
// tauri/src/tex_run.rs and electron/tex_run.js, which are kept identical by a
// test for exactly this reason. A claim on this page is the kind a reader may
// rely on, so it must not drift from what the code does. If the allowlist or the
// flags below change, this section changes with them.

import { openModal } from './dialog.js';
import { el, section, para, list } from './legal.js';
import { VERSION, COMMIT } from './build_info.js';

function what() {
  const s = section('Revery TeX');
  para(s, 'A local-first LaTeX editor. Write, compile and preview on your own ' +
    'machine — there is no server, no account and no network. It bundles TeX ' +
    'Live 2026 compiled to WebAssembly, so a full distribution is available ' +
    'without installing one, and it will use a system LaTeX instead when it ' +
    'finds one.');
  return s;
}

function version() {
  const s = section('Version');
  const p = el('p', 'legal-p legal-source');
  p.textContent = COMMIT && COMMIT !== 'unknown'
    ? `version ${VERSION}  ·  build ${COMMIT}`
    : `version ${VERSION}`;
  s.appendChild(p);
  para(s, 'The build identifier names the exact source this copy was built ' +
    'from. The Legal page carries the address it can be obtained at.');
  return s;
}

function safety() {
  const s = section('Safety by design');
  para(s, 'A LaTeX document is a program, and compiling one downloaded from ' +
    'elsewhere is the moment that matters. The compiler is started by the ' +
    'backend, never by the page, and it is held to the following:');
  list(s, [
    'Shell escape is disabled on every invocation. TeX\'s \\write18 can otherwise run shell commands from inside a document.',
    'latexmk is deliberately not available. It is the obvious tool for managing reruns, and it executes latexmkrc from the working directory as Perl — so a project directory could run code simply by being compiled.',
    'Only six programs can ever be started: pdflatex, xelatex, lualatex, bibtex, biber and makeindex. Anything else is refused by name.',
    'The command line is assembled in the backend. The editor names a tool and a file and cannot pass a flag, so the sandbox does not depend on the interface being careful.',
    'Programs are resolved by walking PATH by hand, never through a shell and never through which. Empty PATH entries — which mean "the current directory" — are skipped, so a file named pdflatex inside a project cannot become the compiler.',
    'Writes are refused outside the project directory, alongside the shell-escape flag rather than instead of it.',
    'Compiles run under a timeout, and output is capped, so a runaway document cannot exhaust the machine.'
  ]);
  para(s, 'Your files are written atomically, so a crash during a save cannot ' +
    'leave a truncated document, and a save is refused if the file changed on ' +
    'disk since it was opened rather than overwriting another program\'s work.');
  return s;
}

function rights() {
  const s = section('Copyright and licence');
  para(s, 'Copyright © 2026 Harald Mark Thirslund, Göteborg, Sweden.');
  para(s, 'Revery TeX is free software, licensed under the GNU Affero General ' +
    'Public License, version 3 or later. The typefaces, logo, icons and ' +
    'photographs are proprietary brand assets and are not covered by that ' +
    'licence, though you may keep and use them in place to build, run, ' +
    'distribute and fork this software.');
  para(s, 'The Legal page has the full terms, the source address, and the ' +
    'licences of every bundled component.');
  return s;
}

/** Open the About page. Bound to the logo menu. */
export function openAbout() {
  const modal = openModal({ title: 'About', className: 'dlg legal-dlg' });

  const scroll = el('div', 'legal-scroll');
  for (const build of [what, version, safety, rights]) scroll.appendChild(build());
  modal.body.appendChild(scroll);

  const close = el('button', null, 'Close');
  close.onclick = () => modal.close();
  modal.foot.appendChild(close);
  modal.panel.appendChild(modal.foot);
  close.focus();

  return modal;
}
