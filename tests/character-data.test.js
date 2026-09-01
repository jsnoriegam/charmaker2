import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers.js';

useTempDb();
const { KEY_PATTERN, normalize } = await import('../db.js');
const { CHARACTERS, ACCESSORIES, FRAMINGS, GLOBAL_POSITIVE, GLOBAL_NEGATIVE } = await import('../character_data.js');

// No ejecutamos runSeed acá: borra generated/<key> de personajes ausentes. Solo
// validamos que el set genérico versionado sea consumible por el seed.

test('el set genérico tiene personajes válidos con base y expresión normal', () => {
  const keys = Object.keys(CHARACTERS);
  assert.ok(keys.length > 0, 'debe haber al menos un personaje genérico');
  for (const key of keys) {
    assert.match(key, KEY_PATTERN);
    const c = CHARACTERS[key];
    assert.ok(c.identity, `${key} sin identity`);
    assert.ok(c.expressions?.normal, `${key} sin expresión normal`);
    assert.ok(c.outfits && Object.keys(c.outfits).length > 0, `${key} sin outfits`);
    assert.ok(Object.keys(c.outfits).includes('base'), `${key} sin outfit base`);
  }
});

test('framings y accesorios genéricos incluyen lo que el seed usa por defecto', () => {
  assert.ok(FRAMINGS.portrait, 'falta framing portrait (base)');
  assert.ok(FRAMINGS.three_quarters, 'falta framing three_quarters (variante)');
  for (const [key, val] of Object.entries({ ...FRAMINGS, ...ACCESSORIES })) {
    assert.match(key, KEY_PATTERN);
    assert.equal(typeof normalize(val).positive, 'string');
  }
});

test('los globales genéricos son strings no vacíos', () => {
  assert.equal(typeof GLOBAL_POSITIVE, 'string');
  assert.equal(typeof GLOBAL_NEGATIVE, 'string');
  assert.ok(GLOBAL_POSITIVE.length > 0 && GLOBAL_NEGATIVE.length > 0);
});
