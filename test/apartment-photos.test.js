'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { portadaUrl, galleryUrls, PHOTO_FILES, BUILDING_CODE, PHOTO_VERSION } = require('../lib/pilot/apartment-photos');

const BASE = 'https://whatsapp-webhook-erom.onrender.com/media/photos';

test('portadaUrl returns the first gallery file for a known apartment, versioned', () => {
  assert.equal(portadaUrl('LF-210'), `${BASE}/LF-210/01-portada.jpg?v=${PHOTO_VERSION}`);
  assert.equal(portadaUrl('LF-404'), `${BASE}/LF-404/01-portada.jpg?v=${PHOTO_VERSION}`);
  assert.equal(portadaUrl('LF-1208'), `${BASE}/LF-1208/01-portada.jpg?v=${PHOTO_VERSION}`);
});

test('portadaUrl returns null for an apartment with no photo set', () => {
  assert.equal(portadaUrl('LF-999'), null);
});

test('galleryUrls returns all six photos in order for a known apartment', () => {
  const urls = galleryUrls('LF-210');
  assert.equal(urls.length, 6);
  assert.equal(urls[0], `${BASE}/LF-210/01-portada.jpg?v=${PHOTO_VERSION}`);
  assert.equal(urls[5], `${BASE}/LF-210/06-cocina.jpg?v=${PHOTO_VERSION}`);
});

test('galleryUrls returns an empty array for an apartment with no photo set', () => {
  assert.deepEqual(galleryUrls('LF-999'), []);
});

test('2026-10-04: los 6 apartamentos y el edificio tienen 6 fotos definitivas y los archivos existen', () => {
  for (const code of ['LF-210', 'LF-404', 'LF-510', 'LF-904', 'LF-1109', 'LF-1208', BUILDING_CODE]) {
    assert.equal(PHOTO_FILES[code].length, 6, code);
    for (const slug of PHOTO_FILES[code]) assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'photos', code, `${slug}.jpg`)), `${code}/${slug}`);
  }
  for (const code of Object.keys(PHOTO_FILES).filter((c) => c !== BUILDING_CODE)) assert.equal(PHOTO_FILES[code][0], '01-portada', code);
});

test('2026-10-04: no quedan archivos huerfanos de juegos anteriores en public/photos', () => {
  const dir = path.join(__dirname, '..', 'public', 'photos');
  for (const code of fs.readdirSync(dir)) {
    const esperados = new Set((PHOTO_FILES[code] || []).map((s) => `${s}.jpg`));
    for (const f of fs.readdirSync(path.join(dir, code))) assert.ok(esperados.has(f), `${code}/${f} no esta en PHOTO_FILES`);
  }
});

test('2026-10-04: el edificio nunca es portada de una propuesta', () => {
  assert.equal(portadaUrl(BUILDING_CODE), null);
  assert.equal(galleryUrls(BUILDING_CODE).length, 6);
});
