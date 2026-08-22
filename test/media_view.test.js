// What the editor pane does with a file it cannot open.
//
// Only the pure half is testable here — kindOf, the MIME map and the size
// formatter. showMedia() and clearMedia() touch the DOM and pdf.js, and are
// covered from the browser in run_ui.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { kindOf, extOf, humanSize, MIME } from '../www/jvscrpt_and_css_extra/media_view.js';

test('raster images and svg are previewed as images', () => {
  for (const p of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.bmp', 'f.webp', 'g.svg', 'h.avif']) {
    assert.equal(kindOf(p), 'image', p);
  }
});

test('a pdf gets the pdf.js branch, not an <img>', () => {
  assert.equal(kindOf('main.pdf'), 'pdf');
  assert.equal(kindOf('FIGURES/Plot.PDF'), 'pdf');
});

// A broken-image glyph says less than a card naming the format, and no browser
// this ships in decodes TIFF in an <img> — so having a MIME type is not enough
// to be previewable, and the two lists are deliberately not the same list.
test('tiff has a mime type and is still not previewed as an image', () => {
  assert.equal(MIME.tiff, 'image/tiff');
  assert.equal(kindOf('scan.tiff'), 'other');
});

test('anything else falls through to the card', () => {
  for (const p of ['font.otf', 'data.dat', 'archive.zip', 'noextension']) {
    assert.equal(kindOf(p), 'other', p);
  }
});

test('the kind is decided by the extension, not the path', () => {
  assert.equal(kindOf('png/notes.dat'), 'other');
  assert.equal(kindOf('a.pdf/b.png'), 'image');
});

test('extOf lowercases and takes the last segment', () => {
  assert.equal(extOf('A.TAR.GZ'), 'gz');
  assert.equal(extOf('plain'), 'plain');
});

test('sizes read as sizes', () => {
  assert.equal(humanSize(0), '0 bytes');
  assert.equal(humanSize(1), '1 byte');
  assert.equal(humanSize(999), '999 bytes');
  assert.equal(humanSize(1024), '1.0 KB');
  assert.equal(humanSize(1536), '1.5 KB');
  assert.equal(humanSize(20 * 1024), '20 KB');
  assert.equal(humanSize(5 * 1024 * 1024), '5.0 MB');
});

// Every extension the preview claims to render must have a type to render it
// with, or the Blob falls back to application/octet-stream and the <img> shows
// nothing.
test('every previewable image extension has a mime type', () => {
  for (const p of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.bmp', 'a.webp', 'a.svg', 'a.avif', 'a.ico']) {
    const ext = extOf(p);
    assert.equal(kindOf(p), 'image');
    assert.ok(MIME[ext], `no MIME entry for ${ext}`);
  }
});
