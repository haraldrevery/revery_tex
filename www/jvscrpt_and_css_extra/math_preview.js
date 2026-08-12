// Rendering maths in the UI, with KaTeX.
//
// KaTeX (MIT) is vendored into ./katex by build_tools/vendor_assets.js. It is
// loaded on first use, not at boot: ~300 KB that most sessions never need, and
// the app is offline-first so there is no CDN to lean on either way.
//
// **A preview is not the document.** KaTeX cannot see the preamble's packages,
// and its equation numbering is its own — so nothing here ever shows a number.
// Claiming "(3)" when the PDF might disagree is worse than showing no number at
// all. What it *can* be told is the document's own `\newcommand`s, which the
// index already collects; that is what stops the preview being wrong in exactly
// the documents that define their own notation.

const asset = (name) => new URL(`./katex/${name}`, import.meta.url).href;

let loading = null;

/** Load KaTeX and its stylesheet once. Resolves to the katex global. */
export function loadKatex() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.katex) return Promise.resolve(window.katex);
  if (loading) return loading;

  loading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = asset('katex.min.css');
    document.head.appendChild(css);

    const script = document.createElement('script');
    script.src = asset('katex.min.js');
    script.onload = () => (window.katex ? resolve(window.katex) : reject(new Error('KaTeX loaded but defined nothing')));
    script.onerror = () => { loading = null; reject(new Error('KaTeX failed to load')); };
    document.head.appendChild(script);
  });
  return loading;
}

/* ── what to render ──────────────────────────────────────────────────── */

/**
 * KaTeX's name for a maths environment, or null to render the body bare.
 *
 * `aligned` and `gathered` rather than `align` and `gather`: the starred forms
 * are what KaTeX supports inside display mode, and they do not number rows —
 * which is what we want anyway, since a number here would be KaTeX's and not
 * the document's. `eqnarray` becomes an `array{rcl}`, which is its column
 * structure exactly.
 */
const KATEX_ENV = {
  equation: null, 'equation*': null,
  align: 'aligned', 'align*': 'aligned',
  gather: 'gathered', 'gather*': 'gathered',
  multline: 'gathered', 'multline*': 'gathered',
  eqnarray: 'array', 'eqnarray*': 'array'
};

/**
 * The maths inside an indexed environment, ready for KaTeX.
 *
 * Pure, and tested in Node: the wrapper stripping is where this goes wrong, and
 * a preview that silently renders `\begin{equation}` as text looks like a KaTeX
 * bug rather than ours.
 */
export function mathSource(env) {
  if (!env || !env.source) return '';
  const name = env.env || 'equation';
  let inner = env.source
    .replace(new RegExp(`^\\s*\\\\begin\\{${name.replace('*', '\\*')}\\}`), '')
    .replace(new RegExp(`\\\\end\\{${name.replace('*', '\\*')}\\}\\s*$`), '')
    // A \label is document bookkeeping, not maths; KaTeX would render it as an
    // undefined control sequence in red.
    .replace(/\\label\s*\{[^}]*\}/g, '')
    .replace(/\\(?:nonumber|notag)\b/g, '')
    .trim();

  const wrap = KATEX_ENV[name];
  if (!wrap) return inner;
  if (wrap === 'array') return `\\begin{array}{rcl}${inner}\\end{array}`;
  return `\\begin{${wrap}}${inner}\\end{${wrap}}`;
}

/* ── rendering ───────────────────────────────────────────────────────── */

/**
 * Scale rendered maths down until it fits its container.
 *
 * A transform rather than a smaller font size: KaTeX lays out at the size it
 * was given, and re-rendering smaller would reflow every fraction and radical.
 * Scaling the finished layout keeps the proportions the reader needs to
 * recognise the equation. Never scales up — a two-symbol equation blown up to
 * fill a card looks like a different equation.
 */
function shrinkToFit(mount) {
  // The `.katex` span, not the `.katex-display` block around it: the block is
  // width:100% by definition, so measuring it says "already fits" for every
  // equation, however far the maths inside it runs past the edge.
  const el = mount.querySelector('.katex') || mount.firstElementChild;
  if (!el) return;
  el.style.transform = '';
  const boxW = mount.clientWidth, boxH = mount.clientHeight;
  if (!boxW || !boxH) return;
  const r = el.getBoundingClientRect();
  const scale = Math.min(boxW / (r.width || 1), boxH / (r.height || 1), 1);
  if (scale < 1) {
    el.style.transform = `scale(${Math.max(0.25, scale).toFixed(3)})`;
    el.style.transformOrigin = 'center';
  }
}

/**
 * Render `source` into `mount`.
 *
 * Never throws: a half-typed equation must show a red fragment where it went
 * wrong, not take down the dialog it is being typed into.
 *
 * @param {string} source
 * @param {HTMLElement} mount
 * @param {{macros?: object, display?: boolean, fit?: boolean}} [opts]
 *        `fit` scales the result down to the box it is in — a picker card is
 *        150 px wide and a real equation is not, and a clipped equation is
 *        exactly the one you cannot identify from its left third.
 */
export async function renderMath(source, mount, { macros = {}, display = true, fit = false } = {}) {
  let katex;
  try {
    katex = await loadKatex();
  } catch (err) {
    mount.textContent = source;
    mount.classList.add('math-plain');
    return false;
  }
  if (!mount.isConnected) return false;      // the dialog closed while loading
  try {
    katex.render(source, mount, {
      displayMode: display,
      throwOnError: false,
      errorColor: 'var(--err)',
      // KaTeX caches expansions *into* the object it is given, so it must get a
      // copy — otherwise the document index's macro table slowly fills with
      // KaTeX's internals.
      macros: { ...macros },
      strict: 'ignore',
      trust: false,
      maxExpand: 1000
    });
    if (fit) {
      shrinkToFit(mount);
      // KaTeX's own fonts arrive after this first layout, and an equation is a
      // different width once they do — so a scale computed now is computed from
      // the fallback font's metrics and still overflows. Measure again when the
      // real fonts are in.
      document.fonts?.ready.then(() => { if (mount.isConnected) shrinkToFit(mount); });
    }
    return true;
  } catch (err) {
    // throwOnError:false covers TeX errors; this is for the rest.
    mount.textContent = source;
    mount.classList.add('math-plain');
    return false;
  }
}
