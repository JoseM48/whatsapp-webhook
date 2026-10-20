// PIE DE FOTO (instrucción 18 de José Manuel, 2026-10-17; lead 201): cada foto de
// Cami dice de qué unidad es.
const test = require('node:test');
const assert = require('node:assert');
const { photosForDelivery } = require('../lib/pilot/m0-closed-pilot');
const { galleryUrls } = require('../lib/pilot/apartment-photos');

test('galería de varias unidades: cada foto lleva su código y una etiqueta, sin contador (2026-10-19)', () => {
  const fotos = photosForDelivery({ message_kind: 'photos' }, { ui: { photo_target_codes: ['LF-510', 'LF-210'] } }, null);
  assert.ok(galleryUrls('LF-510').length > 1);
  assert.strictEqual(fotos[0].pie, 'LF-510 · Vista general', 'la portada primero');
  assert.strictEqual(fotos.filter((f) => f.code === 'LF-510')[2].pie, 'LF-510 · Cocina');
  assert.strictEqual(fotos.filter((f) => f.code === 'LF-210')[0].pie, 'LF-210 · Vista general');
  assert.ok(fotos.filter((f) => f.url).every((f) => f.pie && f.pie.startsWith(f.code) && !/\d+\/\d+/.test(f.pie)));
});

test('portadas: el pie es el código de la unidad', () => {
  const fotos = photosForDelivery({ message_kind: 'text' },
    { presentation: { mode: 'candidates', candidates: [{ code: 'LF-904' }], cover_codes: ['LF-904'] } }, null);
  assert.strictEqual(fotos[0].pie, 'LF-904');
});

test('zonas comunes: titulo y fotos con etiqueta neutra', () => {
  const fotos = photosForDelivery({ message_kind: 'photos' }, { ui: { photo_target_codes: ['EDIFICIO'] } }, null);
  assert.deepStrictEqual(fotos[0], { kind: 'header', code: 'EDIFICIO', text: 'Zonas comunes' });
  assert.strictEqual(fotos[1].pie, 'Zonas comunes · Fachada');
});

test('G: zonas comunes despues de los apartamentos (con paquete y por el texto del PMS sin paquete)', () => {
  const conPaquete = photosForDelivery({ message_kind: 'photos' }, { ui: { photo_target_codes: ['EDIFICIO', 'LF-404'] } }, null);
  const i = conPaquete.findIndex((f) => f.kind === 'header');
  assert.ok(conPaquete.slice(0, i).every((f) => f.code === 'LF-404'));
  assert.ok(conPaquete.slice(i + 1).every((f) => f.code === 'EDIFICIO'));
  const sinPaquete = photosForDelivery({ message_kind: 'photos', message_text: 'Aquí tienes más fotos de LF-404 y de las zonas comunes:' }, null, null);
  assert.deepStrictEqual([...new Set(sinPaquete.map((f) => f.kind))], ['gallery', 'header']);
  assert.strictEqual(sinPaquete.find((f) => f.kind === 'header').text, 'Zonas comunes');
  assert.strictEqual(sinPaquete.at(-1).pie, 'Zonas comunes · Parqueadero');
  const soloApto = photosForDelivery({ message_kind: 'photos', message_text: 'Aquí tienes más fotos de LF-404:' }, null, null);
  assert.ok(soloApto.every((f) => f.code === 'LF-404' && f.kind === 'gallery'));
});
