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
  assert.equal(portadaUrl('LF-510'), null);
});

test('galleryUrls returns all six photos in order for a known apartment', () => {
  const urls = galleryUrls('LF-210');
  assert.equal(urls.length, 6);
  assert.equal(urls[0], 'https://whatsapp-webhook-erom.onrender.com/media/photos/LF-210/01-portada.jpg');
  assert.equal(urls[5], 'https://whatsapp-webhook-erom.onrender.com/media/photos/LF-210/06-tv.jpg');
});

test('galleryUrls returns an empty array for an apartment with no photo set', () => {
  assert.deepEqual(galleryUrls('LF-904'), []);
});
