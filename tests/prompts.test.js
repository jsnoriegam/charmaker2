import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers.js';

useTempDb();
const db = await import('../db.js');
const prompts = await import('../server/prompts.js');

db.initDb();
db.saveCharacter('hero', { identity: '1girl, red eyes', face: 'freckles', hair: 'long black hair', body: 'slim', lighting: 'soft light', negative_identity: 'muscular' });
db.saveFramingOrAccessory('framings', 'portrait', { positive: 'upper body', negative: 'full body' });
db.saveFramingOrAccessory('accessories', 'hat', { positive: 'a hat', negative: 'bareheaded' });
db.setGlobal('positive', 'masterpiece');
db.setGlobal('negative', 'lowres');
prompts.invalidatePromptData();

test('buildPromptLayers arma todas las capas', () => {
  const { positive, negative } = prompts.buildPromptLayers({
    type: 'base', character: 'hero', framingKey: 'portrait',
    clothing: 'blue shirt', negativeExtra: 'torn', accessories: [],
  });
  assert.match(positive, /^masterpiece/);
  assert.match(positive, /1girl, red eyes/);
  assert.match(positive, /blue shirt/);
  assert.match(positive, /upper body/);
  assert.match(negative, /^lowres/);
  assert.match(negative, /muscular/);
  assert.match(negative, /torn/);
  assert.match(negative, /full body/);
});

test('buildPromptLayers con photomaker reescribe la identidad', () => {
  const { positive } = prompts.buildPromptLayers({
    type: 'variant', character: 'hero', method: 'photomaker', expression: 'smiling',
    framingKey: 'portrait', clothing: '', accessories: [],
  });
  assert.match(positive, /1girl img/);
  assert.match(positive, /smiling/);
});

test('buildPromptLayers rechaza personaje/framing/accesorio inexistentes', () => {
  assert.throws(() => prompts.buildPromptLayers({ type: 'base', character: 'ghost' }), /Personaje no encontrado/);
  assert.throws(() => prompts.buildPromptLayers({ type: 'base', character: 'hero', framingKey: 'nope' }), /Framing no encontrado/);
  assert.throws(() => prompts.buildPromptLayers({ type: 'base', character: 'hero', accessories: ['nope'] }), /Accesorio no encontrado/);
});

test('findConflicts detecta términos en ambos lados (normaliza pesos y loras)', () => {
  const conflicts = prompts.findConflicts('blue shirt, (cat:1.2), <lora:x:0.5>', 'lowres, Blue Shirt, cat');
  assert.deepEqual(conflicts, ['blue shirt', 'cat']);
});

test('draftFromBase mapea camelCase y snake_case con defaults', () => {
  assert.deepEqual(prompts.draftFromBase({ character: 'hero', clothing: 'x' }), {
    type: 'base', character: 'hero', framingKey: 'portrait', clothing: 'x', negativeExtra: '',
  });
  const row = { character: 'hero', framing_key: 'wide', clothing: 'c', negative_extra: 'n' };
  assert.equal(prompts.draftFromBase({}, row).framingKey, 'wide');
  assert.equal(prompts.draftFromBase({ negativeExtra: 'zz' }, row).negativeExtra, 'zz');
});

test('draftFromVariant parsea accessories de la fila y defaultea method none', () => {
  const row = { character: 'hero', label: 'L', framing_key: 'portrait', clothing: 'c', negative_extra: 'n', expression: 'e', accessories: '["hat"]', method: 'photomaker' };
  const d = prompts.draftFromVariant({}, row);
  assert.deepEqual(d.accessories, ['hat']);
  assert.equal(d.method, 'photomaker');
  assert.deepEqual(prompts.draftFromVariant({ character: 'hero' }).accessories, []);
  assert.equal(prompts.draftFromVariant({ character: 'hero' }).method, 'none');
});

test('previewFor devuelve positivo/negativo/conflicts', () => {
  const p = prompts.previewFor({ type: 'base', character: 'hero', framingKey: 'portrait', clothing: 'bareheaded', accessories: ['hat'] });
  assert.ok(p.positive && p.negative);
  assert.ok(p.conflicts.includes('bareheaded'));
});
