import { loadPromptData } from '../db.js';
import { httpError } from './util.js';

let promptCache = null;
export function promptData() {
  if (!promptCache) promptCache = loadPromptData();
  return promptCache;
}
export function invalidatePromptData() {
  promptCache = null;
}

export function getPromptSnapshot() {
  const d = promptData();
  const characters = {};
  for (const [key, c] of Object.entries(d.CHARACTERS)) {
    characters[key] = {
      identity: c.identity, face: c.face, hair: c.hair,
      body: c.body, lighting: c.lighting, negative_identity: c.negative_identity,
    };
  }
  return {
    characters,
    framings: d.FRAMINGS,
    accessories: d.ACCESSORIES,
    globals: { positive: d.GLOBAL_POSITIVE, negative: d.GLOBAL_NEGATIVE },
  };
}

// ---------------------------------------------------------------------------
// Armado de prompts por capas + detección de conflictos
//
// Capas:
//   globals      → positivo/negativo de calidad, siempre
//   character    → identidad, cara, pelo, cuerpo, lighting / negative_identity (rasgos)
//   item         → base/variante: expression + clothing / negative_extra
//   accessories  → positivo/negativo de cada accesorio
//   framing      → positivo/negativo del encuadre
// ---------------------------------------------------------------------------

export function buildPromptLayers(draft) {
  const { CHARACTERS, ACCESSORIES, FRAMINGS, GLOBAL_POSITIVE, GLOBAL_NEGATIVE } = promptData();

  const char = CHARACTERS[draft.character];
  if (!char) throw httpError(400, `Personaje no encontrado: ${draft.character}`);

  const framing = FRAMINGS[draft.framingKey || (draft.type === 'base' ? 'portrait' : 'three_quarters')];
  if (!framing) throw httpError(400, `Framing no encontrado: ${draft.framingKey}`);

  const accessories = (draft.accessories || []).map(key => {
    const acc = ACCESSORIES[key];
    if (!acc) throw httpError(400, `Accesorio no encontrado: ${key}`);
    return acc;
  });

  const usePhotoMaker = draft.type === 'variant' && draft.method === 'photomaker';
  const identity = usePhotoMaker
    ? char.identity.replace(/^(1girl|1woman|1man|1boy)/, '$1 img')
    : char.identity;

  const positiveParts = [
    GLOBAL_POSITIVE,
    identity, char.face, char.hair, char.body, char.lighting,
    draft.type === 'variant' ? draft.expression : '',
    draft.clothing,
    accessories.map(a => a.positive).join(', '),
    framing.positive,
  ];

  const negativeParts = [
    GLOBAL_NEGATIVE,
    char.negative_identity,
    draft.negativeExtra,
    framing.negative,
    accessories.map(a => a.negative).join(', '),
  ];

  const positive = positiveParts.filter(Boolean).join(', ');
  const negative = negativeParts.filter(Boolean).join(', ');

  return { positive, negative, character: char, framing };
}

// Términos que aparecen en ambos lados del prompt — candidatos a contradicción.
export function findConflicts(positive, negative) {
  const norm = (text) => new Set(
    text
      .replace(/<lora:[^>]*>/g, '')
      .replace(/\(([^()]+?)(?::[\d.]+)?\)/g, '$1')
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(t => t.length > 1)
  );
  const pos = norm(positive);
  const neg = norm(negative);
  return [...pos].filter(t => neg.has(t));
}

export function previewFor(draft) {
  const { positive, negative } = buildPromptLayers(draft);
  return { positive, negative, conflicts: findConflicts(positive, negative) };
}

// Modo de identidad 'prompt' del inpaint: antepone la identidad del personaje
// al texto escrito. Fuente única de verdad: la usan la ruta de generación y la
// galería; el front la replica en inpaintFinalPrompt().
export function withIdentityPrompt(char, prompt, negative) {
  const idParts = [char.identity, char.face, char.hair].filter(Boolean).join(', ');
  return {
    positive: [idParts, prompt].filter(Boolean).join(', '),
    negative: [char.negative_identity, negative].filter(Boolean).join(', '),
  };
}

export function draftFromBase(body, row = null) {
  return {
    type: 'base',
    character: body.character ?? row?.character,
    framingKey: body.framingKey ?? body.framing_key ?? row?.framing_key ?? 'portrait',
    clothing: body.clothing ?? row?.clothing ?? '',
    negativeExtra: body.negativeExtra ?? body.negative_extra ?? row?.negative_extra ?? '',
  };
}

export function draftFromVariant(body, row = null) {
  return {
    type: 'variant',
    character: body.character ?? row?.character,
    label: body.label ?? row?.label ?? '',
    framingKey: body.framingKey ?? body.framing_key ?? row?.framing_key ?? 'three_quarters',
    clothing: body.clothing ?? row?.clothing ?? '',
    negativeExtra: body.negativeExtra ?? body.negative_extra ?? row?.negative_extra ?? '',
    expression: body.expression ?? row?.expression ?? '',
    accessories: body.accessories ?? (row ? JSON.parse(row.accessories || '[]') : []),
    method: body.method ?? row?.method ?? 'none',
  };
}
