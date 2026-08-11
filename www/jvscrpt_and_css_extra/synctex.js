// SyncTeX — map between source lines and positions in the compiled PDF.
//
// The engine emits a gzipped .synctex file alongside the PDF. It is a flat text
// format: a header, a table of input files, then per-page records giving the
// source tag and line for boxes and glyphs, in scaled points.
//
// Only what a viewer needs is parsed. The format also carries box nesting and
// depth, which matter for precise highlighting but not for "jump to roughly
// here", so nesting is flattened and the records are kept as a plain list.

const SP_PER_PT = 65536;          // TeX scaled points per point
const TEX_PT_PER_INCH = 72.27;    // TeX pt
const PDF_PT_PER_INCH = 72;       // PDF bp

/** scaled points → PDF points */
const spToPdf = (sp) => (sp / SP_PER_PT) * (PDF_PT_PER_INCH / TEX_PT_PER_INCH);

async function gunzip(bytes) {
  // Gzip is what the engine emits; a plain file would start with "SyncTeX".
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) {
    return new TextDecoder().decode(bytes);
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/**
 * @typedef {{page:number, tag:number, line:number, x:number, y:number}} SyncRecord
 *   x, y in PDF points from the top-left of the page.
 */

export class SyncTex {
  constructor() {
    this.files = new Map();     // tag -> path as TeX saw it
    this.records = [];          // SyncRecord[]
    this.byLine = new Map();    // `${tag}:${line}` -> SyncRecord[]
    this.projectFiles = [];
    this.ready = false;
  }

  /** @param {Uint8Array} bytes raw (gzipped) .synctex contents */
  async parse(bytes) {
    this.files.clear();
    this.records.length = 0;
    this.byLine.clear();
    this.ready = false;
    if (!bytes || !bytes.length) return this;

    const text = await gunzip(bytes);

    let unit = 1, magnification = 1000, xOffset = 0, yOffset = 0;
    let page = 0;

    for (const raw of text.split('\n')) {
      const line = raw.trimEnd();
      if (!line) continue;
      const c = line[0];

      // ── header / input table ──
      if (c === 'I' && line.startsWith('Input:')) {
        const m = /^Input:(\d+):(.*)$/.exec(line);
        if (m) this.files.set(Number(m[1]), m[2]);
        continue;
      }
      if (c === 'U' && line.startsWith('Unit:')) { unit = Number(line.slice(5)) || 1; continue; }
      if (c === 'M' && line.startsWith('Magnification:')) { magnification = Number(line.slice(14)) || 1000; continue; }
      if (c === 'X' && line.startsWith('X Offset:')) { xOffset = Number(line.slice(9)) || 0; continue; }
      if (c === 'Y' && line.startsWith('Y Offset:')) { yOffset = Number(line.slice(9)) || 0; continue; }

      // ── page boundaries ──
      if (c === '{') { page = Number(line.slice(1)) || 0; continue; }
      if (c === '}') { page = 0; continue; }
      if (!page) continue;

      // ── positioned records ──
      // [ vbox  ( hbox  h/v/x/k/g/$ glyphs, kerns, rules
      if (!'[(hvxkg$'.includes(c)) continue;

      const body = line.slice(1);
      // tag,line:x,y   (further fields — width, height, depth — are ignored)
      const m = /^(\d+),(\d+)(?::(-?\d+),(-?\d+))?/.exec(body);
      if (!m || m[3] === undefined) continue;

      const scale = unit * (magnification / 1000);
      const rec = {
        page,
        tag: Number(m[1]),
        line: Number(m[2]),
        x: spToPdf((Number(m[3]) + xOffset) * scale),
        y: spToPdf((Number(m[4]) + yOffset) * scale)
      };
      this.records.push(rec);

      const key = `${rec.tag}:${rec.line}`;
      let bucket = this.byLine.get(key);
      if (!bucket) this.byLine.set(key, (bucket = []));
      bucket.push(rec);
    }

    this.ready = this.records.length > 0;
    return this;
  }

  /**
   * Resolve a project-relative path to a SyncTeX tag.
   * TeX records paths as it saw them — often "./chapters/x.tex" or absolute —
   * so match on suffix rather than equality.
   */
  tagForFile(path) {
    const want = path.replace(/^\.\//, '');
    for (const [tag, recorded] of this.files) {
      const norm = recorded.replace(/^\.\//, '');
      if (norm === want || norm.endsWith('/' + want) || want.endsWith('/' + norm)) return tag;
    }
    return null;
  }

  /**
   * Project-relative paths for the app to open.
   * TeX records paths inside its own VFS ("/home/web_user/project_dir/./main.tex"),
   * which means nothing to the caller. Given the project's own file list we can
   * map back by suffix; without it, the raw path is returned.
   */
  setProjectFiles(paths) {
    this.projectFiles = [...paths];
    return this;
  }

  fileForTag(tag) {
    const raw = this.files.get(tag);
    if (!raw) return null;
    const norm = raw.replace(/^\.\//, '').replace(/\/\.\//g, '/');
    for (const p of this.projectFiles || []) {
      if (norm === p || norm.endsWith('/' + p)) return p;
    }
    return norm;
  }

  /**
   * Source → PDF. Returns the best position for a line, or null.
   * If the exact line produced no output (blank lines, comments, preamble),
   * the nearest following line that did is used — jumping slightly late reads
   * as correct, jumping to page 1 does not.
   */
  fromSource(path, line) {
    if (!this.ready) return null;
    const tag = this.tagForFile(path);
    if (tag == null) return null;

    for (let probe = line, tries = 0; tries < 200; probe++, tries++) {
      const bucket = this.byLine.get(`${tag}:${probe}`);
      if (bucket && bucket.length) {
        // Topmost record on the earliest page wins.
        return bucket.reduce((best, r) =>
          r.page < best.page || (r.page === best.page && r.y < best.y) ? r : best);
      }
    }
    return null;
  }

  /**
   * PDF → source. `x`/`y` are PDF points from the top-left of `page`.
   * Nearest record by Euclidean distance, with vertical distance weighted
   * higher: lines are wide and short, so being on the right line matters more
   * than being at the right column.
   */
  fromPdf(page, x, y) {
    if (!this.ready) return null;
    let best = null, bestDist = Infinity;
    // Records that merely *start* where the previous construct ended share its
    // coordinates exactly — the box for \newpage sits on top of the paragraph
    // above it. Ties therefore go to the lower line number, which is the text
    // actually visible at that point rather than whatever follows it.
    const EPS = 4;   // PDF points, roughly a character
    for (const r of this.records) {
      if (r.page !== page) continue;
      const dx = r.x - x, dy = (r.y - y) * 3;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist - EPS || (d < bestDist + EPS && best && r.line < best.line)) {
        bestDist = Math.min(d, bestDist);
        best = r;
      }
    }
    if (!best) return null;
    return { file: this.fileForTag(best.tag), line: best.line, page: best.page };
  }
}

export default SyncTex;
