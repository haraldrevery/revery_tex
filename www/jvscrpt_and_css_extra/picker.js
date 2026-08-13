// Pick one of the things the document already has.
//
// A filter box over a grid of cards, in the modal shell from dialog.js. What a
// card *shows* is a callback, so the same component serves "insert this image"
// and "reference this figure" without either knowing about the other.
//
// Two things it is careful about, both of which bite on the homework fixture
// with its 30-odd graphs:
//
//   - **Cards render lazily.** An IntersectionObserver builds a card's contents
//     the first time it scrolls into view. Building 30 thumbnails to show six
//     is work nobody asked for, and it happens on the click that opens the
//     picker, where it is felt.
//   - **Blob URLs are revoked on close.** Each one pins the image bytes in
//     memory until the page reloads. Thirty leaked photographs is a real leak,
//     not a theoretical one.
//
// The grid is sized by one custom property, --picker-card, stepped by − / + in
// the footer. Everything else — column count, thumbnail height — is derived
// from it in CSS, so the size control sets a single value and nothing here has
// to know how many cards fit a row.

import { openModal } from './dialog.js';
import * as settings from './settings.js';

/**
 * How big a card is, smallest first. The middle of the ladder is what the
 * picker has always been; the ends are for the two real cases — thirty
 * thumbnails to scan at once, and one dense equation to actually read.
 */
const SIZES = [
  { label: 'XS', rem: 7 },
  { label: 'S', rem: 9.5 },
  { label: 'M', rem: 13 },
  { label: 'L', rem: 17.5 },
  { label: 'XL', rem: 23 }
];
const DEFAULT_SIZE = 1;

/**
 * Remembered layout, not a preference with choices — so it lives in the same
 * store as the pane widths, without a settings-menu row. Same call as
 * log_console.js makes for the collapsed log panel.
 *
 * Clamped on the way out: the store is hand-editable, survives across versions,
 * and this ladder may be a different length in the next one.
 */
function storedSize() {
  const i = Math.round(Number(settings.settings.pickerCardSize));
  return Number.isFinite(i) ? Math.max(0, Math.min(i, SIZES.length - 1)) : DEFAULT_SIZE;
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {Array<object>} opts.items
 * @param {(item: object) => string} opts.text       what the filter matches, and
 *        the card's tooltip — the full path, for figures
 * @param {(item: object) => string} [opts.label]     what the card *says*,
 *        defaulting to `text`. Split from it because the distinguishing part of
 *        `graphs/2025may07-091651_stm_spectroscopy33.png` is the end, and a
 *        card wide enough to show all of it fits three to a screen
 * @param {(item: object, mount: HTMLElement, ctx: {blobUrl: (bytes, type) => string}) => void}
 *        [opts.preview]  fills in the visual half of a card, lazily
 * @param {(item: object, mount: HTMLElement) => void} [opts.onResize]  called for
 *        every already-painted card when the size steps. Only previews that
 *        measured their box need it — an <img> re-fits itself in CSS, rendered
 *        maths carries a scale computed against the old box and does not. The
 *        picker stays ignorant of which is which, the same way `preview` lets it
 *        serve images and equations without knowing what either one is
 * @param {(item: object) => void} opts.onPick
 * @param {string} [opts.empty]  shown instead of the grid when there is nothing
 */
export function openPicker({ title, items, text, label: labelOf = text, preview, onResize, onPick, empty = 'nothing to show' }) {
  // Every URL this picker hands out, so close() can take them all back.
  const urls = [];
  const blobUrl = (bytes, type) => {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    urls.push(url);
    return url;
  };

  const modal = openModal({
    title,
    className: 'dlg picker',
    onClose: () => { for (const u of urls) URL.revokeObjectURL(u); urls.length = 0; },
    onKey: (e) => {
      const STEP = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 0, ArrowUp: 0 };
      if (!(e.key in STEP)) return false;
      const cards = [...strip.querySelectorAll('.picker-card')].filter(c => !c.hidden);
      const i = cards.indexOf(document.activeElement);
      if (i < 0) return false;
      // Up and down move by a row. The column count comes from the browser's
      // own auto-fill result rather than being recomputed from the card size,
      // so it stays right at every step of the ladder and every dialog width.
      const cols = getComputedStyle(strip).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
      const delta = e.key === 'ArrowDown' ? cols : e.key === 'ArrowUp' ? -cols : STEP[e.key];
      e.preventDefault();
      cards[Math.max(0, Math.min(cards.length - 1, i + delta))]?.focus();
      return true;
    }
  });

  const filter = document.createElement('input');
  filter.type = 'text';
  filter.className = 'picker-filter';
  filter.placeholder = 'filter';
  modal.body.appendChild(filter);

  const strip = document.createElement('div');
  strip.className = 'picker-strip';
  modal.body.appendChild(strip);

  const count = document.createElement('span');
  count.className = 'picker-count';

  // One observer for the whole strip. Per-card observers would be 30 objects
  // doing the same job.
  const seen = new WeakSet();
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || seen.has(entry.target)) continue;
      seen.add(entry.target);
      const mount = entry.target.querySelector('.picker-thumb');
      if (mount && preview) preview(entry.target._item, mount, { blobUrl });
      io.unobserve(entry.target);
    }
  }, { root: strip, rootMargin: '200px' });

  if (!items.length) {
    const note = document.createElement('div');
    note.className = 'picker-empty';
    note.textContent = empty;
    strip.appendChild(note);
  }

  for (const item of items) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'picker-card';
    card._item = item;

    const thumb = document.createElement('div');
    thumb.className = 'picker-thumb';
    const caption = document.createElement('span');
    caption.className = 'picker-caption';
    caption.textContent = labelOf(item);
    card.append(thumb, caption);
    card.title = text(item);
    card.onclick = () => { modal.close(); onPick(item); };

    strip.appendChild(card);
    if (preview) io.observe(card); else seen.add(card);
  }

  const shown = () => [...strip.querySelectorAll('.picker-card')].filter(c => !c.hidden).length;
  const updateCount = () => { count.textContent = `${shown()} of ${items.length}`; };

  filter.oninput = () => {
    const q = filter.value.trim().toLowerCase();
    for (const card of strip.querySelectorAll('.picker-card')) {
      card.hidden = !!q && !text(card._item).toLowerCase().includes(q);
    }
    updateCount();
  };
  updateCount();

  /* ── card size ─────────────────────────────────────────────────────── */

  let at = storedSize();

  const sizer = document.createElement('div');
  sizer.className = 'picker-size';
  const sizeValue = document.createElement('span');
  sizeValue.className = 'picker-size-value';
  const step = (delta) => {
    const next = at + delta;
    if (next < 0 || next >= SIZES.length) return;
    at = next;
    settings.settings.pickerCardSize = at;
    settings.save();
    applySize();
  };
  const [smaller, larger] = [[-1, '−', 'Smaller previews'], [1, '+', 'Larger previews']]
    .map(([delta, glyph, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = glyph;
      b.setAttribute('aria-label', label);
      b.title = label;
      b.onclick = () => step(delta);
      return b;
    });
  sizer.append(smaller, sizeValue, larger);

  function applySize() {
    modal.panel.style.setProperty('--picker-card', `${SIZES[at].rem}rem`);
    sizeValue.textContent = SIZES[at].label;
    smaller.disabled = at === 0;
    larger.disabled = at === SIZES.length - 1;
    // Only the cards the observer has actually built. An unpainted mount has
    // nothing to re-fit, and calling the hook would not make one — it would
    // just measure an empty box and cache a scale for it.
    if (!onResize) return;
    for (const card of strip.querySelectorAll('.picker-card')) {
      if (seen.has(card)) onResize(card._item, card.querySelector('.picker-thumb'));
    }
  }
  applySize();

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => modal.close();
  modal.foot.append(count, sizer, cancel);
  modal.panel.appendChild(modal.foot);

  filter.focus();
  return modal;
}
