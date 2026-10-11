import { test } from 'node:test';
import assert from 'node:assert/strict';

// i18n.js es un script clásico (sin exports): importarlo por efecto deja el
// motor en globalThis.i18n, igual que en el navegador.
await import('../public/i18n.js');
const i18n = globalThis.i18n;

test('los diccionarios es/en tienen exactamente las mismas claves', () => {
  const es = Object.keys(i18n.LOCALES.es).sort();
  const en = Object.keys(i18n.LOCALES.en).sort();
  const onlyEs = es.filter(k => !en.includes(k));
  const onlyEn = en.filter(k => !es.includes(k));
  assert.deepEqual(onlyEs, [], `claves sin traducir al inglés: ${onlyEs.join(', ')}`);
  assert.deepEqual(onlyEn, [], `claves sin traducir al español: ${onlyEn.join(', ')}`);
});

test('translate interpola parámetros y cae al default', () => {
  assert.equal(i18n.translate('es', 'characters.noMatch', { query: 'ana' }), 'Ningún personaje coincide con "ana".');
  assert.equal(i18n.translate('en', 'characters.noMatch', { query: 'ana' }), 'No character matches "ana".');
  // clave inexistente devuelve la clave
  assert.equal(i18n.translate('en', 'no.existe'), 'no.existe');
});

test('plurales por count (.one / .other)', () => {
  assert.equal(i18n.translate('es', 'characters.bases', { count: 1 }), '1 base');
  assert.equal(i18n.translate('es', 'characters.bases', { count: 3 }), '3 bases');
  assert.equal(i18n.translate('en', 'characters.variants', { count: 1 }), '1 variant');
  assert.equal(i18n.translate('en', 'characters.variants', { count: 2 }), '2 variants');
});

test('normalize acepta variantes tipo es-AR / EN', () => {
  assert.equal(i18n.normalize('es-AR'), 'es');
  assert.equal(i18n.normalize('EN_us'), 'en');
  assert.equal(i18n.normalize('fr'), null);
  assert.equal(i18n.normalize(''), null);
});

test('has reconoce claves del diccionario y rechaza desconocidas', () => {
  assert.equal(i18n.has('nav.characters'), true);
  assert.equal(i18n.has('errors.baseNotFound'), true);
  assert.equal(i18n.has('errors.noExiste'), false);
});

test('claves de error del server están traducidas en es y en', () => {
  const serverKeys = [
    'errors.characterNotFound', 'errors.baseNotFound', 'errors.variantNotFound',
    'errors.inpaintNotFound', 'errors.modelNotFound', 'errors.samplerUnknown',
    'errors.identifierInvalid', 'errors.denoiseRange',
  ];
  for (const key of serverKeys) {
    assert.ok(i18n.LOCALES.es[key], `falta ${key} en es`);
    assert.ok(i18n.LOCALES.en[key], `falta ${key} en en`);
  }
});
