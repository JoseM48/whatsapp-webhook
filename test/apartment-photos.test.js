'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { portadaUrl, galleryUrls } = require('../lib/pilot/apartment-photos');

test('portadaUrl returns the first gallery file for a known apartment', () => {
  assert.equal(portadaUrl('LF-210'), 'https://whatsapp-webhook-erom.onrender.com/media/photos/LF-210/01-portada.jpg');
  assert.equal(portadaUrl('LF-404'), 'https://whatsapp-webhook-erom.onrender.com/media/photos/LF-404/01-portada.jpg');
  assert.equal(portadaUrl('LF-1208'), 'https://whatsapp-webhook-erom.onrender.com/media/photos/LF-1208/01-portada.jpg');
});

test('portadaUrl returns null for an apartment with no photo set', () => {
  assert.equal(portadaUrl('LF-1109'), null); // LF-510 tiene fotos desde 2026-10-03
});

test('galleryUrls returns all six photos in order for a known apartment', () => {
  const urls = galleryUrls('LF-210');
  assert.equal(urls.length, 6);
  assert.equal(urls[0], 'https://whatsapp-webhook-erom.onrender.com/media/photos/LF-210/01-portada.jpg');
  assert.equal(urls[5], 'https://whatsapp-webhook-erom.onrender.com/media/photos/LF-210/06-tv.jpg');
});

test('galleryUrls returns an empty array for an apartment with no photo set', () => {
  assert.deepEqual(galleryUrls('LF-1109'), []);
});

test('2026-10-03: LF-510 y LF-904 tienen sus 6 fotos aprobadas y los archivos existen', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const { PHOTO_FILES } = require('../lib/pilot/apartment-photos');
  for (const code of ['LF-510', 'LF-904']) {
    assert.equal(PHOTO_FILES[code].length, 6);
    assert.equal(PHOTO_FILES[code][0], '01-portada');
    for (const slug of PHOTO_FILES[code]) assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'photos', code, `${slug}.jpg`)), `${code}/${slug}`);
  }
});
