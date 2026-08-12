// Pick one of the things the document already has.
//
// A filter box over a strip of cards, in the modal shell from dialog.js. What a
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

import { openModal } from './dialog.js';

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
 * @param {(item: object) => void} opts.onPick
 * @param {string} [opts.empty]  shown instead of the strip when there is nothing
 */
export function openPicker({ title, items, text, label: labelOf = text, preview, onPick, empty = 'nothing to show' }) {
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
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return false;
      const cards = [...strip.querySelectorAll('.picker-card')].filter(c => !c.hidden);
      const i = cards.indexOf(document.activeElement);
      if (i < 0) return false;
      e.preventDefault();
      cards[Math.max(0, Math.min(cards.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))]?.focus();
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

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => modal.close();
  modal.foot.append(count, cancel);
  modal.panel.appendChild(modal.foot);

  filter.focus();
  return modal;
}
