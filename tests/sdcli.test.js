import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers.js';

useTempDb();
const db = await import('../db.js');
const { resolveSampler, resolveGenerationSettings, resolveSeed, resolveVariantSeed } = await import('../server/sdcli.js');

test('resolveSampler aplica alias históricos y listas reales', () => {
  assert.equal(resolveSampler('dpmpp_2m_sde'), 'dpm++2m_sde');
  assert.equal(resolveSampler('euler_a'), 'euler_a');
  assert.throws(() => resolveSampler('no-existe'), /Sampler desconocido/);
});

test('resolveGenerationSettings defaultea sobre la fila y el body manda', () => {
  const row = { sampler: 'euler', schedule: 'karras', cfg: 7, steps: 20, model: 'row_model.safetensors' };
  const s = resolveGenerationSettings({}, row);
  assert.equal(s.sampler, 'euler');
  assert.equal(s.cfg, 7);
  assert.equal(s.model, 'row_model.safetensors');
  const s2 = resolveGenerationSettings({ steps: '30', cfg: '5.5', sampler: 'heun', schedule: 'normal', model: 'b.safetensors' }, row);
  assert.equal(s2.steps, 30);
  assert.equal(s2.sampler, 'heun');
  assert.equal(s2.modelFile, 'b.safetensors');
});

test('resolveGenerationSettings rechaza sampler y scheduler desconocidos', () => {
  assert.throws(() => resolveGenerationSettings({ sampler: 'malo' }, null), statusCode400);
  assert.throws(() => resolveGenerationSettings({ schedule: 'malo' }, null), statusCode400);
});
function statusCode400(err) {
  return err.statusCode === 400 && /desconocido/i.test(err.message);
}

test('resolveSeed: explícito se parsea, vacío cae a random en rango', () => {
  assert.equal(resolveSeed({ seed: 42 }), 42);
  assert.equal(resolveSeed({ seed: '42' }), 42);
  for (let i = 0; i < 20; i++) {
    const s = resolveSeed({ seed: null });
    assert.ok(Number.isInteger(s) && s >= 0 && s < 2147483647);
  }
});

test('resolveVariantSeed: vacío → determinístico por personaje+ropa (case/espacios irrelevantes)', () => {
  assert.equal(resolveVariantSeed({ seed: null }, 'ana', 'Red Shirt'), db.variantSeed('ana', 'red shirt'));
  assert.equal(resolveVariantSeed({}, 'ana', '  RED SHIRT  '), resolveVariantSeed({}, 'ana', 'red shirt'));
  assert.equal(resolveVariantSeed({ seed: 7 }, 'ana', 'red shirt'), 7);
});
