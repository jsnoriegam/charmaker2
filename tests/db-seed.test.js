import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { useTempDb } from './helpers.js';

useTempDb();
const db = await import('../db.js');

db.initDb();
db.saveCharacter('ana', { identity: '1girl', negative_identity: '' });

const settings = { steps: 30, cfg: 5, sampler: 'euler', schedule: 'normal', model: 'm' };

test('normSeed normaliza vacíos y NaN', () => {
  assert.equal(db.normSeed(null), null);
  assert.equal(db.normSeed(undefined), null);
  assert.equal(db.normSeed(''), null);
  assert.equal(db.normSeed('abc'), null);
  assert.equal(db.normSeed('42'), 42);
  assert.equal(db.normSeed(7), 7);
});

test('variantSeed reproduce la fórmula histórica fnv1a(char|ropa)', () => {
  assert.equal(db.variantSeed('ana', 'Red Shirt'), db.fnv1a('ana|red shirt') % 2147483647);
});

test('createVariant sin seed genera uno determinístico', () => {
  const v = db.createVariant({ characterKey: 'ana', clothing: 'Red Shirt', ...settings });
  assert.equal(v.seed, db.variantSeed('ana', 'Red Shirt'));
});

test('createVariant con seed explícito lo respeta', () => {
  const v = db.createVariant({ characterKey: 'ana', clothing: 'X', seed: 12345, ...settings });
  assert.equal(v.seed, 12345);
});

test('updateVariant conserva seed existente si el body viene vacío', () => {
  const v = db.createVariant({ characterKey: 'ana', clothing: 'X', seed: 999, ...settings });
  assert.equal(db.updateVariant(v.id, { seed: null }).seed, 999);
  assert.equal(db.updateVariant(v.id, { seed: '' }).seed, 999);
});

test('updateVariant sobre fila legacy NULL + body vacío genera determinístico', () => {
  const v = db.createVariant({ characterKey: 'ana', clothing: 'Blue Jeans', ...settings });
  const raw = new DatabaseSync(join(process.cwd(), 'data', 'charmaker2.db'));
  raw.prepare('UPDATE variants SET seed = NULL WHERE id = ?').run(v.id);
  raw.close();
  const updated = db.updateVariant(v.id, { seed: null });
  assert.equal(updated.seed, db.variantSeed('ana', 'Blue Jeans'));
});

test('cloneVariant conserva el seed y completa NULL', () => {
  const v = db.createVariant({ characterKey: 'ana', clothing: 'C', seed: 555, ...settings });
  assert.equal(db.cloneVariant(v.id).seed, 555);
});

test('bases e inpaints siguen la misma regla', () => {
  const b = db.createBase({ characterKey: 'ana', clothing: 'Suit', ...settings });
  assert.equal(b.seed, db.baseSeed('ana', 'Suit'));
  assert.equal(db.updateBase(b.id, { seed: null }).seed, b.seed);
  const v = db.createVariant({ characterKey: 'ana', clothing: 'C', seed: 1, ...settings });
  const i = db.createInpaint({ variantId: v.id, label: 'fix', region: 'face', prompt: 'p', steps: 20 });
  assert.equal(i.seed, db.inpaintSeed('ana', v.id, 'fix'));
});
