// PIE DE FOTO (instrucción 18 de José Manuel, 2026-10-17; lead 201): cada foto de
// Cami dice de qué unidad es.
const test = require('node:test');
const assert = require('node:assert');
const { photosForDelivery } = require('../lib/pilot/m0-closed-pilot');
const { galleryUrls } = require('../lib/pilot/apartment-photos');

test('galería de varias unidades: cada foto lleva su código y su número', () => {
  const fotos = photosForDelivery({ message_kind: 'photos' }, { ui: { photo_target_codes: ['LF-510', 'LF-210'] } }, null);
  const n510 = galleryUrls('LF-510').length;
  assert.ok(n510 > 1);
  assert.strictEqual(fotos[0].pie, `LF-510 · 1/${n510}`);
  assert.strictEqual(fotos.filter((f) => f.code === 'LF-210')[0].pie, `LF-210 · 1/${galleryUrls('LF-210').length}`);
  assert.ok(fotos.filter((f) => f.url).every((f) => f.pie && f.pie.startsWith(f.code)));
});

test('portadas: el pie es el código de la unidad', () => {
  const fotos = photosForDelivery({ message_kind: 'text' },
    { presentation: { mode: 'candidates', candidates: [{ code: 'LF-904' }], cover_codes: ['LF-904'] } }, null);
  assert.strictEqual(fotos[0].pie, 'LF-904');
});

test('zonas comunes', () => {
  const fotos = photosForDelivery({ message_kind: 'photos' }, { ui: { photo_target_codes: ['EDIFICIO'] } }, null);
  assert.match(fotos[0].pie, /^Zonas comunes · 1\/\d+$/);
});
