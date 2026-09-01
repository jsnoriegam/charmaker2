import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers.js';

useTempDb();
const db = await import('../db.js');
const prompts = await import('../server/prompts.js');

db.initDb();

const initial = {
  characters: {
    ana: { identity: '1girl', face: 'f', hair: 'h', body: 'b', lighting: 'l', negative_identity: 'n' },
    bob: { identity: '1boy', face: 'f2', hair: 'h2', body: 'b2', lighting: 'l2', negative_identity: 'n2' },
  },
  framings: { portrait: { positive: 'upper body', negative: 'full body' } },
  accessories: { hat: { positive: 'a hat', negative: 'bareheaded' } },
  globals: { positive: 'masterpiece', negative: 'lowres' },
};

db.replaceAllPromptData(initial);
prompts.invalidatePromptData();

test('replaceAllPromptData + getPromptSnapshot hacen round-trip', () => {
  const snap = prompts.getPromptSnapshot();
  assert.deepEqual(Object.keys(snap.characters).sort(), ['ana', 'bob']);
  assert.equal(snap.characters.ana.identity, '1girl');
  assert.deepEqual(snap.framings.portrait, { positive: 'upper body', negative: 'full body' });
  assert.deepEqual(snap.accessories.hat, { positive: 'a hat', negative: 'bareheaded' });
  assert.equal(snap.globals.positive, 'masterpiece');
  assert.equal(snap.globals.negative, 'lowres');
});

test('withIdentityPrompt antepone identity/face/hair y el negativo', () => {
  const { positive, negative } = prompts.withIdentityPrompt(
    prompts.promptData().CHARACTERS.ana, 'smiling', 'sad'
  );
  assert.equal(positive, '1girl, f, h, smiling');
  assert.equal(negative, 'n, sad');
});

test('replaceAllPromptData reemplaza por completo el set anterior', () => {
  db.replaceAllPromptData({ characters: { solo: { identity: 'x' } } });
  prompts.invalidatePromptData();
  assert.deepEqual(Object.keys(prompts.getPromptSnapshot().characters), ['solo']);
});

test('saveCharacter rechaza una clave duplicada con 409', () => {
  db.saveCharacter('dup', { identity: 'a' });
  assert.throws(
    () => db.saveCharacter('otro', { identity: 'b', key: 'dup' }),
    (err) => err.statusCode === 409
  );
});

test('replaceAllPromptData valida claves inválidas', () => {
  assert.throws(
    () => db.replaceAllPromptData({ characters: { 'Bad Key': { identity: 'x' } } }),
    (err) => err.statusCode === 400
  );
});
