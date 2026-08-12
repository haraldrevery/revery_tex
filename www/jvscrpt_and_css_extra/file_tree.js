// Paths in, a tree out.
//
// The sidebar used to group files by their immediate directory into a flat
// list, so `chapters/a.tex` and `a/b/c/d.tex` looked equally deep and nothing
// showed what contained what. This builds the real structure, and it is pure —
// no DOM, no project object — so the nesting can be tested in `npm test`
// rather than by looking at a screenshot.

/**
 * @typedef {object} Entry
 * @property {string} path     project-relative, `/` separated
 * @property {boolean} [binary]
 */

/**
 * Build a nested tree from a flat list of paths.
 *
 * Directories come before files at each level, then case-insensitive name
 * order — the convention every file manager uses, and the one that puts a
 * project's `chapters/` above its loose `main.tex`.
 *
 * @param {Iterable<Entry>} entries
 * @returns {Array<object>} nodes: {type:'dir'|'file', name, path, depth, children?}
 */
export function buildTree(entries) {
  const root = { type: 'dir', name: '', path: '', depth: -1, children: [], index: new Map() };

  for (const entry of entries) {
    // Segments are dropped when they name nothing — empty, or only spaces.
    // Names are not otherwise touched: a file really called `a .tex` opens by
    // the path it came with.
    const parts = String(entry.path || '').split('/').filter(p => p.trim());
    if (!parts.length) continue;
    let node = root;
    // `dir: true` means the path names a directory itself — a folder that has
    // just been created and holds nothing yet. Without it there would be no
    // way to show one, since a directory otherwise only exists because a file
    // inside it does.
    const upto = entry.dir ? parts.length : parts.length - 1;
    // Every segment but the last is a directory, created once and reused.
    for (let i = 0; i < upto; i++) {
      const name = parts[i];
      let dir = node.index.get(name);
      if (!dir || dir.type !== 'dir') {
        dir = {
          type: 'dir', name, depth: node.depth + 1,
          path: node.path ? `${node.path}/${name}` : name,
          children: [], index: new Map()
        };
        node.index.set(name, dir);
        node.children.push(dir);
      }
      node = dir;
    }
    if (entry.dir) continue;              // the loop above already made it
    const name = parts[parts.length - 1];
    const file = { ...entry, type: 'file', name, depth: node.depth + 1, path: entry.path };
    node.index.set(name, file);
    node.children.push(file);
  }

  sort(root);
  return root.children;
}

function sort(dir) {
  dir.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  delete dir.index;                       // build-time bookkeeping, not output
  for (const child of dir.children) if (child.type === 'dir') sort(child);
}

/**
 * Flatten a tree into display order, skipping what is inside a collapsed
 * directory.
 *
 * Rendering wants a list, not a recursion: one row per element, each carrying
 * its own depth, so the DOM stays flat and a click handler does not have to
 * walk anything.
 *
 * @param {Array<object>} nodes
 * @param {Set<string>} collapsed  directory paths that are folded shut
 */
export function flattenTree(nodes, collapsed = new Set()) {
  const out = [];
  const walk = (list) => {
    for (const node of list) {
      out.push(node);
      if (node.type !== 'dir') continue;
      // A collapsed directory still shows itself — it is how you open it again.
      if (collapsed.has(node.path)) continue;
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** Every directory path in a tree, for "collapse all" and for validation. */
export function directoryPaths(nodes) {
  const out = [];
  const walk = (list) => {
    for (const node of list) {
      if (node.type !== 'dir') continue;
      out.push(node.path);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Normalise a path typed by a person into one the project can hold.
 *
 * Returns null for anything that would escape the project or name nothing:
 * `..` segments, absolute paths, and Windows drive letters. The backends check
 * this again — this is so the UI can refuse before asking them to.
 */
export function normalizePath(raw, parent = '') {
  let s = String(raw ?? '').trim().replace(/\\/g, '/');
  if (!s) return null;
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null;
  if (parent) s = `${parent}/${s}`;
  const parts = [];
  for (const part of s.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;       // never resolve upward, refuse
    parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}
