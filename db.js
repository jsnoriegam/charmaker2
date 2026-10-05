import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'charmaker2.db');

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

let db = null;
let stmts = null;

export const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export const MAX_SEED = 2147483647;

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Devuelve el seed normalizado o null si viene vacío (''/null/undefined/NaN).
export function normSeed(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

// Seeds determinísticos: si una fila queda sin seed (creación sin generar,
// clon de fila huérfana, PUT con seed vacío), se deriva del personaje y su
// contexto. Las fórmulas son las mismas que usaba la generación, así que
// regenerar con los mismos datos reproduce el seed.
export function baseSeed(charKey, clothing) {
  return fnv1a(`base|${charKey}|${(clothing || '').trim().toLowerCase()}`) % MAX_SEED;
}

// Variante "auto": depende del personaje y la ropa, no de la expresión — así
// todas las expresiones de un mismo outfit comparten seed.
export function variantSeed(charKey, clothing) {
  return fnv1a(`${charKey}|${(clothing || '').trim().toLowerCase()}`) % MAX_SEED;
}

export function inpaintSeed(charKey, variantId, label) {
  return fnv1a(`inpaint|${charKey}|${variantId}|${label || ''}`) % MAX_SEED;
}

export function initDb() {
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // Identidad del personaje: SOLO rasgos. La ropa y su negativo viven en las
  // bases/variantes, nunca acá — así no se contradicen (ej: 'shirtless' en el
  // negative_identity con una base que pide shirtless).
  db.exec(`
    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      identity TEXT NOT NULL DEFAULT '',
      face TEXT NOT NULL DEFAULT '',
      hair TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      lighting TEXT NOT NULL DEFAULT '',
      negative_identity TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      clothing TEXT NOT NULL DEFAULT '',
      negative_extra TEXT NOT NULL DEFAULT '',
      framing_key TEXT NOT NULL DEFAULT 'portrait',
      seed INTEGER,
      steps INTEGER NOT NULL,
      cfg REAL NOT NULL,
      sampler TEXT NOT NULL,
      schedule TEXT NOT NULL,
      model TEXT NOT NULL,
      rembg INTEGER DEFAULT 1,
      image_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      base_id INTEGER REFERENCES bases(id) ON DELETE SET NULL,
      label TEXT NOT NULL DEFAULT '',
      expression TEXT NOT NULL DEFAULT '',
      clothing TEXT NOT NULL DEFAULT '',
      accessories TEXT NOT NULL DEFAULT '[]',
      negative_extra TEXT NOT NULL DEFAULT '',
      framing_key TEXT NOT NULL DEFAULT 'three_quarters',
      method TEXT NOT NULL DEFAULT 'photomaker',
      strength REAL,
      seed INTEGER,
      steps INTEGER NOT NULL,
      cfg REAL NOT NULL,
      sampler TEXT NOT NULL,
      schedule TEXT NOT NULL,
      model TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      rembg INTEGER DEFAULT 1,
      image_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS inpaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      variant_id INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT 'face',
      prompt TEXT NOT NULL DEFAULT '',
      negative TEXT NOT NULL DEFAULT '',
      denoise REAL NOT NULL DEFAULT 0.45,
      seed INTEGER,
      steps INTEGER,
      cfg REAL,
      sampler TEXT,
      schedule TEXT,
      model TEXT,
      rembg INTEGER DEFAULT 1,
      image_path TEXT,
      identity_mode TEXT NOT NULL DEFAULT 'none',
      identity_strength REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migración liviana: si la tabla ya existía de una versión anterior, le
  // faltan las columnas de identidad — se agregan sin tocar filas existentes.
  const inpaintCols = new Set(db.prepare('PRAGMA table_info(inpaints)').all().map(c => c.name));
  if (!inpaintCols.has('identity_mode')) {
    db.exec(`ALTER TABLE inpaints ADD COLUMN identity_mode TEXT NOT NULL DEFAULT 'none'`);
  }
  if (!inpaintCols.has('identity_strength')) {
    db.exec('ALTER TABLE inpaints ADD COLUMN identity_strength REAL');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS framings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      positive TEXT NOT NULL DEFAULT '',
      negative TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS accessories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      positive TEXT NOT NULL DEFAULT '',
      negative TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Segmentos globales de prompt (positivo/negativo aplicados a TODO prompt).
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_globals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      text TEXT NOT NULL DEFAULT ''
    )
  `);

  // Prepared statements cacheados para el hot path (personajes/bases/variantes).
  // framings/accessories/prompt_globals quedan con db.prepare() ad-hoc: son
  // operaciones de administración poco frecuentes y con nombre de tabla dinámico,
  // no vale la pena cachearlas.
  stmts = {
    getCharacterByKey: db.prepare('SELECT * FROM characters WHERE key = ?'),
    getCharacterById: db.prepare('SELECT * FROM characters WHERE id = ?'),
    insertCharacter: db.prepare(`
      INSERT INTO characters (key, identity, face, hair, body, lighting, negative_identity, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateCharacter: db.prepare(`
      UPDATE characters SET key = ?, identity = ?, face = ?, hair = ?, body = ?, lighting = ?, negative_identity = ?
      WHERE id = ?
    `),
    maxCharacterOrder: db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM characters'),
    deleteCharacterByKey: db.prepare('DELETE FROM characters WHERE key = ?'),
    countCharacters: db.prepare('SELECT COUNT(*) AS n FROM characters'),

    getBaseById: db.prepare('SELECT * FROM bases WHERE id = ?'),
    insertBase: db.prepare(`
      INSERT INTO bases (character_id, clothing, negative_extra, framing_key, seed, steps, cfg, sampler, schedule, model, rembg, image_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateBase: db.prepare(`
      UPDATE bases SET clothing = ?, negative_extra = ?, framing_key = ?, seed = ?, steps = ?, cfg = ?, sampler = ?, schedule = ?, model = ?, rembg = ?, image_path = ?
      WHERE id = ?
    `),
    deleteBaseById: db.prepare('DELETE FROM bases WHERE id = ?'),
    listBases: db.prepare(`
      SELECT b.*, c.key AS character_key
      FROM bases b JOIN characters c ON c.id = b.character_id
      WHERE b.character_id = ?
      ORDER BY b.created_at DESC, b.id DESC
    `),

    getVariantById: db.prepare('SELECT * FROM variants WHERE id = ?'),
    insertVariant: db.prepare(`
      INSERT INTO variants (character_id, base_id, label, expression, clothing, accessories, negative_extra, framing_key, method, strength, seed, steps, cfg, sampler, schedule, model, width, height, rembg, image_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateVariant: db.prepare(`
      UPDATE variants SET base_id = ?, label = ?, expression = ?, clothing = ?, accessories = ?, negative_extra = ?, framing_key = ?, method = ?, strength = ?, seed = ?, steps = ?, cfg = ?, sampler = ?, schedule = ?, model = ?, width = ?, height = ?, rembg = ?, image_path = ?
      WHERE id = ?
    `),
    deleteVariantById: db.prepare('DELETE FROM variants WHERE id = ?'),
    listVariants: db.prepare(`
      SELECT v.*, c.key AS character_key
      FROM variants v JOIN characters c ON c.id = v.character_id
      WHERE v.character_id = ?
      ORDER BY v.created_at DESC, v.id DESC
    `),
    countVariantsByBase: db.prepare('SELECT COUNT(*) AS n FROM variants WHERE base_id = ?'),
    getInpaintById: db.prepare('SELECT * FROM inpaints WHERE id = ?'),
    getInpaintByVariantLabel: db.prepare('SELECT * FROM inpaints WHERE variant_id = ? AND label = ?'),
    insertInpaint: db.prepare(`
      INSERT INTO inpaints (variant_id, label, region, prompt, negative, denoise, seed, steps, cfg, sampler, schedule, model, rembg, image_path, identity_mode, identity_strength)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateInpaint: db.prepare(`
      UPDATE inpaints SET label = ?, region = ?, prompt = ?, negative = ?, denoise = ?, seed = ?, steps = ?, cfg = ?, sampler = ?, schedule = ?, model = ?, rembg = ?, image_path = ?, identity_mode = ?, identity_strength = ?
      WHERE id = ?
    `),
    deleteInpaintById: db.prepare('DELETE FROM inpaints WHERE id = ?'),
    listInpaintsByCharacter: db.prepare(`
      SELECT i.*, c.key AS character_key
      FROM inpaints i
      JOIN variants v ON v.id = i.variant_id
      JOIN characters c ON c.id = v.character_id
      WHERE v.character_id = ?
      ORDER BY i.created_at DESC, i.id DESC
    `),
    suggestionVariants: db.prepare('SELECT expression, clothing, label, negative_extra FROM variants WHERE character_id = ?'),
    suggestionBases: db.prepare('SELECT clothing, negative_extra FROM bases WHERE character_id = ?'),
  };
}

// ---------------------------------------------------------------------------
// Lectura de datos de prompt (solo lo que ya no es por-personaje: framings,
// accesorios, globales) + identidad de personajes para cachear.
// ---------------------------------------------------------------------------

export function loadPromptData() {
  const CHARACTERS = {};
  for (const row of db.prepare('SELECT * FROM characters ORDER BY sort_order, key').all()) {
    CHARACTERS[row.key] = {
      id: row.id,
      identity: row.identity,
      face: row.face,
      hair: row.hair,
      body: row.body,
      lighting: row.lighting,
      negative_identity: row.negative_identity,
    };
  }

  const ACCESSORIES = {};
  for (const row of db.prepare('SELECT * FROM accessories ORDER BY sort_order, key').all()) {
    ACCESSORIES[row.key] = { positive: row.positive, negative: row.negative };
  }

  const FRAMINGS = {};
  for (const row of db.prepare('SELECT * FROM framings ORDER BY sort_order, key').all()) {
    FRAMINGS[row.key] = { positive: row.positive, negative: row.negative };
  }

  const globals = {};
  for (const row of db.prepare('SELECT key, text FROM prompt_globals').all()) {
    globals[row.key] = row.text;
  }

  return {
    CHARACTERS,
    ACCESSORIES,
    FRAMINGS,
    GLOBAL_POSITIVE: globals.positive ?? '',
    GLOBAL_NEGATIVE: globals.negative ?? '',
  };
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

const CHAR_FIELDS = ['identity', 'face', 'hair', 'body', 'lighting', 'negative_identity'];

export function getCharacterRow(keyOrId) {
  if (typeof keyOrId === 'number') {
    return stmts.getCharacterById.get(keyOrId) ?? null;
  }
  return stmts.getCharacterByKey.get(keyOrId) ?? null;
}

export function listCharacters() {
  return db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM bases b WHERE b.character_id = c.id) AS bases_count,
      (SELECT COUNT(*) FROM variants v WHERE v.character_id = c.id) AS variants_count,
      (SELECT b.image_path FROM bases b
        WHERE b.character_id = c.id AND b.image_path IS NOT NULL
        ORDER BY b.created_at DESC, b.id DESC LIMIT 1) AS thumb
    FROM characters c ORDER BY c.sort_order, c.key
  `).all();
}

export function saveCharacter(key, data) {
  const targetKey = (data.key && data.key !== key) ? data.key : key;
  if (!KEY_PATTERN.test(targetKey)) {
    throw Object.assign(new Error(`Clave inválida "${targetKey}": minúsculas, dígitos o _ (empezar con letra)`), { statusCode: 400 });
  }
  const vals = CHAR_FIELDS.map(f => data[f] ?? '');
  const existing = getCharacterRow(key);
  if (existing) {
    if (targetKey !== key && getCharacterRow(targetKey)) {
      throw Object.assign(new Error(`Ya existe un personaje con la clave "${targetKey}"`), { statusCode: 409 });
    }
    stmts.updateCharacter.run(targetKey, ...vals, existing.id);
  } else {
    if (getCharacterRow(targetKey)) {
      throw Object.assign(new Error(`Ya existe un personaje con la clave "${targetKey}"`), { statusCode: 409 });
    }
    const maxOrder = stmts.maxCharacterOrder.get().m;
    stmts.insertCharacter.run(targetKey, ...vals, maxOrder + 1);
  }
  return getCharacterRow(targetKey);
}

export function deleteCharacter(key) {
  // ON DELETE CASCADE se lleva bases y variantes por delante.
  const info = stmts.deleteCharacterByKey.run(key);
  return info.changes > 0;
}

// Cuando cambia la key de un personaje, los image_path guardados en bases/
// variantes (ej: /generated/viejo/bases/base_3.png) quedan apuntando a una
// carpeta que ya no existe. Esto los reescribe para que apunten a la key nueva
// — server.js es el que efectivamente mueve la carpeta en disco.
export function renameCharacterImagePaths(characterId, oldKey, newKey) {
  const oldPrefix = `/generated/${oldKey}/`;
  const newPrefix = `/generated/${newKey}/`;
  db.prepare(`
    UPDATE bases SET image_path = REPLACE(image_path, ?, ?)
    WHERE character_id = ? AND image_path IS NOT NULL
  `).run(oldPrefix, newPrefix, characterId);
  db.prepare(`
    UPDATE variants SET image_path = REPLACE(image_path, ?, ?)
    WHERE character_id = ? AND image_path IS NOT NULL
  `).run(oldPrefix, newPrefix, characterId);
  db.prepare(`
    UPDATE inpaints SET image_path = REPLACE(image_path, ?, ?)
    WHERE image_path IS NOT NULL AND image_path LIKE ?
  `).run(oldPrefix, newPrefix, `${oldPrefix}%`);
}

// ---------------------------------------------------------------------------
// Bases
// ---------------------------------------------------------------------------

function hydrateBase(row) {
  const char = getCharacterRow(row.character_id);
  return { ...row, rembg: !!row.rembg, character: char?.key ?? null };
}

export function createBase({ characterKey, ...d }) {
  const char = getCharacterRow(characterKey);
  if (!char) throw Object.assign(new Error(`Personaje no encontrado: ${characterKey}`), { statusCode: 404 });
  const info = stmts.insertBase.run(
    char.id, d.clothing ?? '', d.negativeExtra ?? d.negative_extra ?? '', d.framingKey ?? d.framing_key ?? 'portrait',
    normSeed(d.seed) ?? baseSeed(char.key, d.clothing ?? ''), d.steps, d.cfg, d.sampler, d.schedule, d.model, d.rembg === false ? 0 : 1, d.imagePath ?? d.image_path ?? null
  );
  return hydrateBase(getBaseRow(Number(info.lastInsertRowid)));
}

export function getBaseRow(id) {
  return stmts.getBaseById.get(id) ?? null;
}

export function getBase(id) {
  const row = getBaseRow(id);
  return row ? hydrateBase(row) : null;
}

export function updateBase(id, d) {
  const row = getBaseRow(id);
  if (!row) return null;
  const charKey = getCharacterRow(row.character_id)?.key ?? '';
  const clothing = d.clothing ?? row.clothing;
  stmts.updateBase.run(
    clothing,
    d.negativeExtra ?? d.negative_extra ?? row.negative_extra,
    d.framingKey ?? d.framing_key ?? row.framing_key,
    normSeed(d.seed) ?? normSeed(row.seed) ?? baseSeed(charKey, clothing),
    d.steps ?? row.steps, d.cfg ?? row.cfg, d.sampler ?? row.sampler,
    d.schedule ?? row.schedule, d.model ?? row.model,
    d.rembg === undefined ? row.rembg : (d.rembg ? 1 : 0),
    d.imagePath ?? d.image_path ?? row.image_path,
    id
  );
  return hydrateBase(getBaseRow(id));
}

export function cloneBase(id) {
  const row = getBaseRow(id);
  if (!row) return null;
  const info = db.prepare(`
    INSERT INTO bases (character_id, clothing, negative_extra, framing_key, seed, steps, cfg, sampler, schedule, model, rembg, image_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.character_id, row.clothing, row.negative_extra, row.framing_key,
    normSeed(row.seed) ?? baseSeed(getCharacterRow(row.character_id)?.key ?? '', row.clothing),
    row.steps, row.cfg, row.sampler, row.schedule, row.model, row.rembg, row.image_path);
  return hydrateBase(getBaseRow(Number(info.lastInsertRowid)));
}

export function deleteBase(id) {
  const info = stmts.deleteBaseById.run(id);
  return info.changes > 0;
}

export function listBases(characterKey) {
  const char = getCharacterRow(characterKey);
  if (!char) return [];
  return stmts.listBases.all(char.id).map(row => {
    const { character_key, ...rest } = row;
    return { ...rest, rembg: !!rest.rembg, character: character_key };
  });
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

function hydrateVariant(row) {
  const char = getCharacterRow(row.character_id);
  return {
    ...row,
    rembg: !!row.rembg,
    accessories: JSON.parse(row.accessories || '[]'),
    character: char?.key ?? null,
  };
}

export function createVariant({ characterKey, ...d }) {
  const char = getCharacterRow(characterKey);
  if (!char) throw Object.assign(new Error(`Personaje no encontrado: ${characterKey}`), { statusCode: 404 });
  let baseId = d.baseId ?? d.base_id ?? null;
  if (baseId !== null && !getBaseRow(baseId)) throw Object.assign(new Error(`Base no encontrada: ${baseId}`), { statusCode: 400 });
  const info = stmts.insertVariant.run(
    char.id, baseId, d.label ?? '', d.expression ?? '', d.clothing ?? '',
    JSON.stringify(d.accessories ?? []), d.negativeExtra ?? d.negative_extra ?? '',
    d.framingKey ?? d.framing_key ?? 'three_quarters', d.method ?? 'photomaker', d.strength ?? null,
    normSeed(d.seed) ?? variantSeed(char.key, d.clothing ?? ''), d.steps, d.cfg, d.sampler, d.schedule, d.model,
    d.width ?? null, d.height ?? null, d.rembg === false ? 0 : 1, d.imagePath ?? d.image_path ?? null
  );
  return hydrateVariant(getVariantRow(Number(info.lastInsertRowid)));
}

export function getVariantRow(id) {
  return stmts.getVariantById.get(id) ?? null;
}

export function getVariant(id) {
  const row = getVariantRow(id);
  return row ? hydrateVariant(row) : null;
}

export function updateVariant(id, d) {
  const row = getVariantRow(id);
  if (!row) return null;
  const charKey = getCharacterRow(row.character_id)?.key ?? '';
  const clothing = d.clothing ?? row.clothing;
  stmts.updateVariant.run(
    d.baseId ?? d.base_id ?? row.base_id,
    d.label ?? row.label, d.expression ?? row.expression, clothing,
    d.accessories === undefined ? row.accessories : JSON.stringify(d.accessories),
    d.negativeExtra ?? d.negative_extra ?? row.negative_extra,
    d.framingKey ?? d.framing_key ?? row.framing_key,
    d.method ?? row.method, d.strength ?? row.strength,
    normSeed(d.seed) ?? normSeed(row.seed) ?? variantSeed(charKey, clothing),
    d.steps ?? row.steps, d.cfg ?? row.cfg, d.sampler ?? row.sampler,
    d.schedule ?? row.schedule, d.model ?? row.model,
    d.width ?? row.width, d.height ?? row.height,
    d.rembg === undefined ? row.rembg : (d.rembg ? 1 : 0),
    d.imagePath ?? d.image_path ?? row.image_path,
    id
  );
  return hydrateVariant(getVariantRow(id));
}

export function cloneVariant(id) {
  const row = getVariantRow(id);
  if (!row) return null;
  const info = db.prepare(`
    INSERT INTO variants (character_id, base_id, label, expression, clothing, accessories, negative_extra, framing_key, method, strength, seed, steps, cfg, sampler, schedule, model, width, height, rembg, image_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.character_id, row.base_id, row.label, row.expression, row.clothing, row.accessories,
    row.negative_extra, row.framing_key, row.method, row.strength,
    normSeed(row.seed) ?? variantSeed(getCharacterRow(row.character_id)?.key ?? '', row.clothing),
    row.steps, row.cfg, row.sampler, row.schedule, row.model, row.width, row.height, row.rembg, row.image_path);
  return hydrateVariant(getVariantRow(Number(info.lastInsertRowid)));
}

export function deleteVariant(id) {
  const info = stmts.deleteVariantById.run(id);
  return info.changes > 0;
}

export function listVariants(characterKey) {
  const char = getCharacterRow(characterKey);
  if (!char) return [];
  return stmts.listVariants.all(char.id).map(row => {
    const { character_key, ...rest } = row;
    return {
      ...rest,
      rembg: !!rest.rembg,
      accessories: JSON.parse(rest.accessories || '[]'),
      character: character_key,
    };
  });
}

export function countVariantsByBase(baseId) {
  return stmts.countVariantsByBase.get(baseId).n;
}

// ---------------------------------------------------------------------------
// Inpaints (variantes derivadas por inpainting de región)
// ---------------------------------------------------------------------------

function hydrateInpaint(row) {
  return { ...row, rembg: !!row.rembg };
}

function inpaintCharKey(variantId) {
  const variant = variantId ? getVariantRow(variantId) : null;
  return variant ? (getCharacterRow(variant.character_id)?.key ?? '') : '';
}

export function createInpaint(d) {
  const variantId = d.variantId ?? d.variant_id;
  const info = stmts.insertInpaint.run(
    variantId, d.label ?? '', d.region ?? 'face',
    d.prompt ?? '', d.negative ?? '', d.denoise ?? 0.45,
    normSeed(d.seed) ?? inpaintSeed(inpaintCharKey(variantId), variantId, d.label ?? ''), d.steps ?? null, d.cfg ?? null, d.sampler ?? null,
    d.schedule ?? null, d.model ?? null,
    d.rembg === false ? 0 : 1,
    d.imagePath ?? d.image_path ?? null,
    d.identityMode ?? d.identity_mode ?? 'none',
    d.identityStrength ?? d.identity_strength ?? null
  );
  return hydrateInpaint(stmts.getInpaintById.get(Number(info.lastInsertRowid)));
}

export function getInpaintRow(id) {
  return stmts.getInpaintById.get(id) ?? null;
}

// El identificador (label) identifica al inpaint dentro de su variante: se usa
// para sobrescribir en vez de duplicar.
export function getInpaintByVariantLabel(variantId, label) {
  return stmts.getInpaintByVariantLabel.get(variantId, label) ?? null;
}

// Crea el inpaint o, si ya existe uno con el mismo identificador en la misma
// variante, lo sobrescribe. Devuelve { row, overwritten }.
export function upsertInpaint({ variantId, ...d }) {
  const existing = variantId != null ? getInpaintByVariantLabel(variantId, d.label ?? '') : null;
  if (existing) return { row: updateInpaint(existing.id, d), overwritten: true };
  return { row: createInpaint({ variantId, ...d }), overwritten: false };
}

export function getInpaint(id) {
  const row = getInpaintRow(id);
  return row ? hydrateInpaint(row) : null;
}

export function updateInpaint(id, d) {
  const row = stmts.getInpaintById.get(id);
  if (!row) return null;
  const label = d.label ?? row.label;
  stmts.updateInpaint.run(
    label, d.region ?? row.region,
    d.prompt ?? row.prompt, d.negative ?? row.negative,
    d.denoise ?? row.denoise,
    normSeed(d.seed) ?? normSeed(row.seed) ?? inpaintSeed(inpaintCharKey(row.variant_id), row.variant_id, label),
    d.steps ?? row.steps, d.cfg ?? row.cfg, d.sampler ?? row.sampler,
    d.schedule ?? row.schedule, d.model ?? row.model,
    d.rembg === undefined ? row.rembg : (d.rembg ? 1 : 0),
    d.imagePath ?? d.image_path ?? row.image_path,
    d.identityMode ?? d.identity_mode ?? row.identity_mode,
    d.identityStrength ?? d.identity_strength ?? row.identity_strength,
    id
  );
  return hydrateInpaint(stmts.getInpaintById.get(id));
}

export function deleteInpaint(id) {
  const info = stmts.deleteInpaintById.run(id);
  return info.changes > 0;
}

export function listInpaints(characterKey) {
  const char = getCharacterRow(characterKey);
  if (!char) return [];
  return stmts.listInpaintsByCharacter.all(char.id).map(row => {
    const { character_key, ...rest } = row;
    return { ...hydrateInpaint(rest), character: character_key };
  });
}

// Sugerencias para los datalist de los modales: valores ya usados en el personaje.
export function getVariantSuggestions(characterKey) {
  const char = getCharacterRow(characterKey);
  if (!char) return { expressions: [], clothing: [], labels: [], negatives: [] };
  const rows = stmts.suggestionVariants.all(char.id);
  const baseRows = stmts.suggestionBases.all(char.id);
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  return {
    expressions: uniq(rows.map(r => r.expression)),
    clothing: uniq([...rows.map(r => r.clothing), ...baseRows.map(r => r.clothing)]),
    labels: uniq(rows.map(r => r.label)),
    negatives: uniq([...rows.map(r => r.negative_extra), ...baseRows.map(r => r.negative_extra)]),
  };
}

// ---------------------------------------------------------------------------
// Framings / accessories / globals
// ---------------------------------------------------------------------------

export function saveFramingOrAccessory(table, key, data) {
  if (table !== 'framings' && table !== 'accessories') throw new Error(`Tabla desconocida: ${table}`);
  const targetKey = (data.key && data.key !== key) ? data.key : key;
  if (!KEY_PATTERN.test(targetKey)) {
    throw Object.assign(new Error(`Clave inválida "${targetKey}"`), { statusCode: 400 });
  }
  const positive = data.positive ?? (typeof data === 'string' ? data : '');
  const negative = data.negative ?? '';
  const existing = db.prepare(`SELECT * FROM ${table} WHERE key = ?`).get(key);
  if (existing) {
    if (targetKey !== key && db.prepare(`SELECT id FROM ${table} WHERE key = ?`).get(targetKey)) {
      throw Object.assign(new Error(`Ya existe una entrada con la clave "${targetKey}"`), { statusCode: 409 });
    }
    db.prepare(`UPDATE ${table} SET key = ?, positive = ?, negative = ? WHERE id = ?`)
      .run(targetKey, positive, negative, existing.id);
  } else {
    if (db.prepare(`SELECT id FROM ${table} WHERE key = ?`).get(targetKey)) {
      throw Object.assign(new Error(`Ya existe una entrada con la clave "${targetKey}"`), { statusCode: 409 });
    }
    const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM ${table}`).get().m;
    db.prepare(`INSERT INTO ${table} (key, positive, negative, sort_order) VALUES (?, ?, ?, ?)`)
      .run(targetKey, positive, negative, maxOrder + 1);
  }
  const row = db.prepare(`SELECT * FROM ${table} WHERE key = ?`).get(targetKey);
  return { key: row.key, positive: row.positive, negative: row.negative };
}

export function deleteFramingOrAccessory(table, key) {
  const info = db.prepare(`DELETE FROM ${table} WHERE key = ?`).run(key);
  return info.changes > 0;
}

export function setGlobal(key, text) {
  db.prepare(`
    INSERT INTO prompt_globals (key, text) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET text = excluded.text
  `).run(key, text ?? '');
}

// ---------------------------------------------------------------------------
// Import/export del set de datos global + personajes
// ---------------------------------------------------------------------------

function normalizePositiveNegative(raw) {
  if (typeof raw === 'string') return { positive: raw, negative: '' };
  if (raw && typeof raw === 'object') {
    return { positive: raw.positive ?? '', negative: raw.negative ?? '' };
  }
  return { positive: '', negative: '' };
}
export { normalizePositiveNegative as normalize };

// Reemplaza TODO el set de datos (usado por import JSON). Borra también bases
// y variantes porque cuelgan de personajes que dejan de existir.
export function replaceAllPromptData({ characters, framings, accessories, globals }) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM characters');
    db.exec('DELETE FROM framings');
    db.exec('DELETE FROM accessories');
    db.exec('DELETE FROM prompt_globals');
    let order = 0;
    for (const [key, char] of Object.entries(characters ?? {})) {
      if (!KEY_PATTERN.test(key)) {
        throw Object.assign(new Error(`Clave de personaje inválida "${key}"`), { statusCode: 400 });
      }
      db.prepare(`
        INSERT INTO characters (key, identity, face, hair, body, lighting, negative_identity, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(key, char.identity ?? '', char.face ?? '', char.hair ?? '', char.body ?? '', char.lighting ?? '', char.negative_identity ?? '', order++);
    }
    let fOrder = 0;
    for (const [key, val] of Object.entries(framings ?? {})) {
      const { positive, negative } = normalizePositiveNegative(val);
      db.prepare('INSERT INTO framings (key, positive, negative, sort_order) VALUES (?, ?, ?, ?)').run(key, positive, negative, fOrder++);
    }
    let aOrder = 0;
    for (const [key, val] of Object.entries(accessories ?? {})) {
      const { positive, negative } = normalizePositiveNegative(val);
      db.prepare('INSERT INTO accessories (key, positive, negative, sort_order) VALUES (?, ?, ?, ?)').run(key, positive, negative, aOrder++);
    }
    db.prepare('INSERT INTO prompt_globals (key, text) VALUES (?, ?)').run('positive', globals?.positive ?? '');
    db.prepare('INSERT INTO prompt_globals (key, text) VALUES (?, ?)').run('negative', globals?.negative ?? '');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function countCharacters() {
  return stmts.countCharacters.get().n;
}

// Cierra la conexión SQLite (shutdown ordenado).
export function closeDb() {
  if (!db) return;
  try { db.close(); } finally { db = null; stmts = null; }
}