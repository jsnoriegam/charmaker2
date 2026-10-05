import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers.js';

useTempDb();
const db = await import('../db.js');

db.initDb();
db.saveCharacter('ana', { identity: '1girl', negative_identity: '' });

const settings = { steps: 30, cfg: 5, sampler: 'euler', schedule: 'normal', model: 'm' };
const variant = db.createVariant({ characterKey: 'ana', clothing: 'C', seed: 1, ...settings });

function createInpaintInput(overrides = {}) {
  return {
    variantId: variant.id,
    label: 'fix',
    region: 'face',
    prompt: 'p',
    steps: 20,
    ...overrides,
  };
}

test('upsertInpaint crea el primero y usa el seed determinístico', () => {
  const { row, overwritten } = db.upsertInpaint(createInpaintInput());
  assert.equal(overwritten, false);
  assert.equal(row.label, 'fix');
  assert.equal(row.seed, db.inpaintSeed('ana', variant.id, 'fix'));
});

test('upsertInpaint con el mismo identificador sobrescribe la misma fila', () => {
  const before = db.getInpaintByVariantLabel(variant.id, 'fix');
  const { row, overwritten } = db.upsertInpaint(createInpaintInput({
    prompt: 'otro', steps: 25, seed: 777,
  }));
  assert.equal(overwritten, true);
  assert.equal(row.id, before.id);
  assert.equal(row.prompt, 'otro');
  assert.equal(row.steps, 25);
  assert.equal(row.seed, 777);
  // No se duplicó.
  assert.equal(db.listInpaints('ana').filter(i => i.label === 'fix').length, 1);
});

test('upsertInpaint distingue identificadores y variantes', () => {
  const { row: a } = db.upsertInpaint(createInpaintInput({ label: 'fix2' }));
  const otherVariant = db.createVariant({ characterKey: 'ana', clothing: 'D', seed: 2, ...settings });
  const { row: b } = db.upsertInpaint({ ...createInpaintInput({ label: 'fix2' }), variantId: otherVariant.id });
  assert.notEqual(a.id, b.id);
  assert.equal(db.listInpaints('ana').filter(i => i.label === 'fix2').length, 2);
});
