import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { useTempDb } from './helpers.js';

// Crea una DB con el esquema viejo (variants.method / inpaints.identity_mode /
// inpaints.identity_strength) ANTES de initDb, para verificar la migración.
useTempDb();
const db = await import('../db.js');

const raw = new DatabaseSync(join(process.cwd(), 'data', 'charmaker2.db'));
raw.exec(`
  CREATE TABLE characters (
    id INTEGER PRIMARY KEY, key TEXT UNIQUE,
    identity TEXT DEFAULT '', face TEXT DEFAULT '', hair TEXT DEFAULT '',
    body TEXT DEFAULT '', lighting TEXT DEFAULT '', negative_identity TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE variants (
    id INTEGER PRIMARY KEY, character_id INTEGER, base_id INTEGER,
    label TEXT DEFAULT '', expression TEXT DEFAULT '', clothing TEXT DEFAULT '',
    accessories TEXT DEFAULT '[]', negative_extra TEXT DEFAULT '',
    framing_key TEXT DEFAULT 'three_quarters',
    method TEXT NOT NULL DEFAULT 'photomaker', strength REAL,
    seed INTEGER, steps INTEGER, cfg REAL, sampler TEXT, schedule TEXT, model TEXT,
    width INTEGER, height INTEGER, rembg INTEGER DEFAULT 1, image_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE inpaints (
    id INTEGER PRIMARY KEY, variant_id INTEGER, label TEXT DEFAULT '',
    region TEXT DEFAULT 'face', prompt TEXT DEFAULT '', negative TEXT DEFAULT '',
    denoise REAL DEFAULT 0.45, seed INTEGER, steps INTEGER, cfg REAL, sampler TEXT,
    schedule TEXT, model TEXT, rembg INTEGER DEFAULT 1, image_path TEXT,
    identity_mode TEXT NOT NULL DEFAULT 'none', identity_strength REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO characters (id, key) VALUES (1, 'ana');
  INSERT INTO variants (id, character_id, label, method, strength) VALUES (10, 1, 'casual', 'ipadapter', 0.5);
  INSERT INTO inpaints (id, variant_id, label, identity_mode, identity_strength) VALUES (20, 10, 'smile', 'photomaker', 25);
`);
raw.close();

db.initDb();

test('migra variants.method → identity_method conservando datos', () => {
  const v = db.listVariants('ana')[0];
  assert.equal(v.identity_method, 'ipadapter');
  assert.equal(v.strength, 0.5);
  const cols = new DatabaseSync(join(process.cwd(), 'data', 'charmaker2.db'));
  const names = cols.prepare('PRAGMA table_info(variants)').all().map(c => c.name);
  assert.ok(names.includes('identity_method'));
  assert.ok(!names.includes('method'));
  cols.close();
});

test('migra inpaints identity_mode/identity_strength → identity_method/strength', () => {
  const i = db.listInpaints('ana')[0];
  assert.equal(i.identity_method, 'photomaker');
  assert.equal(i.strength, 25);
  const cols = new DatabaseSync(join(process.cwd(), 'data', 'charmaker2.db'));
  const names = cols.prepare('PRAGMA table_info(inpaints)').all().map(c => c.name);
  assert.ok(names.includes('identity_method') && names.includes('strength'));
  assert.ok(!names.includes('identity_mode') && !names.includes('identity_strength'));
  cols.close();
});

test('acepta los nombres viejos al escribir (backward-compat)', () => {
  const v = db.createVariant({
    characterKey: 'ana', clothing: 'c', method: 'photomaker', strength: 20,
    steps: 30, cfg: 5, sampler: 'euler', schedule: 'normal', model: 'm',
  });
  assert.equal(v.identity_method, 'photomaker');
  assert.equal(v.strength, 20);
});
