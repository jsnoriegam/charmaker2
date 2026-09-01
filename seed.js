import { existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  initDb, replaceAllPromptData, countCharacters,
  createBase, createVariant,
  normalize,
} from './db.js';
import { cleanupOrphanImages } from './server/util.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const LOCAL_DATA_FILE = join(__dirname, 'character_data.local.js');

// Los datos personales no se versionan: van en character_data.local.js (ignorado
// por git) y tienen prioridad sobre el set genérico de character_data.js.
export function characterDataPath() {
  return existsSync(LOCAL_DATA_FILE) ? LOCAL_DATA_FILE : join(__dirname, 'character_data.js');
}

export async function loadCharacterData() {
  return existsSync(LOCAL_DATA_FILE)
    ? import('./character_data.local.js')
    : import('./character_data.js');
}

// Convierte los datos del formato viejo (character_data.js: expressions/outfits
// por personaje) al modelo nuevo:
//   - character  → identidad sin términos de ropa en negative_identity
//   - base       → outfit 'base' del personaje (ropa de la referencia facial)
//   - variantes  → una por outfit (sin repetir el de la base), todas con la
//     expresión neutra ('normal'); las otras expresiones se prueban editando
//     la variante, sin crear filas extra.
const DEFAULT_GEN = {
  steps: 35,
  cfg: 5.5,
  sampler: 'dpm++2m_sde',
  schedule: 'karras',
};

function splitTerms(text) {
  return String(text || '')
    .replace(/<lora:[^>]*>/g, '')
    .replace(/\(([^()]+?)(?::[\d.]+)?\)/g, '$1')
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
}

export function runSeed(mod, { defaultModel = 'zavychromaxl_v100.safetensors' } = {}) {
  const { CHARACTERS, ACCESSORIES, FRAMINGS, GLOBAL_POSITIVE, GLOBAL_NEGATIVE } = mod;

  // 1) Personajes + framings + accesorios + globales.
  const cleanCharacters = {};
  for (const [key, c] of Object.entries(CHARACTERS)) {
    // Toda la ropa que va a aparecer en positivo (base + variantes): los
    // términos del negative_identity que la contradigan se eliminan — la ropa
    // conflictiva ahora se maneja con negative_extra por ítem.
    const clothingTerms = new Set();
    for (const [oKey, raw] of Object.entries(c.outfits || {})) {
      const outfit = normalize(raw);
      if (oKey === 'base') continue;
      for (const t of splitTerms(outfit.positive)) clothingTerms.add(t);
    }
    const baseOutfit = normalize((c.outfits || {}).base ?? '');
    for (const t of splitTerms(baseOutfit.positive)) clothingTerms.add(t);

    const negativeIdentity = splitTerms(c.negative_identity)
      .filter(t => !clothingTerms.has(t))
      .join(', ');

    cleanCharacters[key] = {
      identity: c.identity ?? '',
      face: c.face ?? '',
      hair: c.hair ?? '',
      body: c.body ?? '',
      lighting: c.lighting ?? '',
      negative_identity: negativeIdentity,
    };
  }

  replaceAllPromptData({
    characters: cleanCharacters,
    framings: FRAMINGS,
    accessories: ACCESSORIES,
    globals: { positive: GLOBAL_POSITIVE, negative: GLOBAL_NEGATIVE },
  });

  // El seed reemplaza todo: borramos las imágenes de personajes que ya no existen.
  cleanupOrphanImages(Object.keys(cleanCharacters));

  // 2) Una base + una variante por outfit (expresión neutra, sin imagen: se generan on demand).
  let bases = 0;
  let variants = 0;
  for (const [key, c] of Object.entries(CHARACTERS)) {
    const outfitKeys = Object.keys(c.outfits || {});
    const baseKey = outfitKeys.includes('base') ? 'base' : (outfitKeys[0] ?? null);
    const baseOutfit = normalize(baseKey ? (c.outfits || {})[baseKey] : '');
    const base = createBase({
      characterKey: key,
      clothing: baseOutfit.positive,
      negativeExtra: baseOutfit.negative,
      framingKey: 'portrait',
      seed: null,
      ...DEFAULT_GEN,
      model: defaultModel,
      rembg: true,
    });
    bases++;

    const neutral = normalize((c.expressions || {}).normal ?? '');
    for (const oKey of outfitKeys) {
      if (oKey === baseKey) continue;
      const outfit = normalize((c.outfits || {})[oKey]);
      createVariant({
        characterKey: key,
        baseId: base.id,
        label: oKey,
        expression: neutral.positive,
        clothing: outfit.positive,
        accessories: [],
        negativeExtra: [neutral.negative, outfit.negative].filter(Boolean).join(', '),
        framingKey: 'three_quarters',
        method: 'photomaker',
        strength: null,
        seed: null,
        ...DEFAULT_GEN,
        model: defaultModel,
        width: 832,
        height: 1216,
        rembg: true,
      });
      variants++;
    }
  }

  return { characters: Object.keys(CHARACTERS).length, bases, variants };
}

// CLI: node seed.js [--force]
const isMain = process.argv[1] && process.argv[1].endsWith('seed.js');
if (isMain) {
  initDb();
  const force = process.argv.includes('--force');
  if (countCharacters() > 0 && !force) {
    console.log('La base ya tiene personajes. Usá --force para reemplazar todo desde character_data.js.');
    process.exit(0);
  }
  const mod = await loadCharacterData();
  const stats = runSeed(mod, { defaultModel: process.env.SD_DEFAULT_MODEL || 'zavychromaxl_v100.safetensors' });
  console.log(`Seed: ${stats.characters} personajes, ${stats.bases} bases, ${stats.variants} variantes (${characterDataPath()}).`);
}
