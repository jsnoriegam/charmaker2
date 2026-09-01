import { Router } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  listCharacters, listBases, listVariants, listInpaints,
  getCharacterRow, getVariantRow, getBaseRow, getInpaintRow,
} from '../../db.js';
import { PROJECT_ROOT } from '../config.js';
import { crud } from '../util.js';
import { promptData, buildPromptLayers, draftFromBase, draftFromVariant, withIdentityPrompt } from '../prompts.js';

const router = Router();

function fileExists(relPath) {
  return relPath ? existsSync(join(PROJECT_ROOT, relPath)) : false;
}

function safeLayers(draft) {
  try {
    const { positive, negative } = buildPromptLayers(draft);
    return { positive, negative };
  } catch {
    return null;
  }
}

// Todas las imágenes generadas (bases, variantes e inpaints) con sus metadatos.
// El prompt final NO se arma acá: es lo caro y solo hace falta al abrir el
// modal, así que se resuelve on-demand con GET /gallery/:kind/:id.
router.get('/gallery', crud(() => {
  const items = [];

  for (const c of listCharacters()) {
    const key = c.key;

    for (const b of listBases(key)) {
      if (!fileExists(b.image_path)) continue;
      items.push({
        kind: 'base',
        id: b.id,
        character: key,
        title: `base ${b.id} · ${b.clothing || 'sin ropa'}`,
        created_at: b.created_at,
        image_path: b.image_path,
        origin: null,
        meta: {
          clothing: b.clothing, framing_key: b.framing_key, negative_extra: b.negative_extra,
          seed: b.seed, steps: b.steps, cfg: b.cfg, sampler: b.sampler,
          schedule: b.schedule, model: b.model, rembg: b.rembg,
        },
      });
    }

    for (const v of listVariants(key)) {
      if (!fileExists(v.image_path)) continue;
      const baseRow = v.base_id ? getBaseRow(v.base_id) : null;
      items.push({
        kind: 'variant',
        id: v.id,
        character: key,
        title: `${v.label || `variante ${v.id}`}${v.expression ? ` · ${v.expression}` : ''}`,
        created_at: v.created_at,
        image_path: v.image_path,
        origin: baseRow && fileExists(baseRow.image_path)
          ? { kind: 'base', id: baseRow.id, title: `base ${baseRow.id}`, image_path: baseRow.image_path }
          : null,
        meta: {
          label: v.label, expression: v.expression, clothing: v.clothing,
          accessories: v.accessories, negative_extra: v.negative_extra,
          framing_key: v.framing_key, method: v.method, strength: v.strength,
          seed: v.seed, steps: v.steps, cfg: v.cfg, sampler: v.sampler,
          schedule: v.schedule, model: v.model, width: v.width, height: v.height, rembg: v.rembg,
          base_id: v.base_id,
        },
      });
    }

    for (const ip of listInpaints(key)) {
      if (!fileExists(ip.image_path)) continue;
      const sourceRow = getVariantRow(ip.variant_id);
      items.push({
        kind: 'inpaint',
        id: ip.id,
        character: key,
        title: `inpaint ${ip.label}`,
        created_at: ip.created_at,
        image_path: ip.image_path,
        origin: sourceRow && fileExists(sourceRow.image_path)
          ? {
            kind: 'variant', id: sourceRow.id,
            title: sourceRow.label || `variante ${sourceRow.id}`,
            image_path: sourceRow.image_path,
          }
          : null,
        meta: {
          label: ip.label, region: ip.region, prompt: ip.prompt, negative: ip.negative,
          denoise: ip.denoise, identity_mode: ip.identity_mode, identity_strength: ip.identity_strength,
          seed: ip.seed, steps: ip.steps, cfg: ip.cfg, sampler: ip.sampler,
          schedule: ip.schedule, model: ip.model, rembg: ip.rembg,
          variant_id: ip.variant_id,
          source_label: sourceRow?.label || null,
        },
      });
    }
  }

  items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return items;
}));

// Prompt resuelto de un solo item (para el modal). No recorre toda la galería.
router.get('/gallery/:kind/:id', crud((req) => {
  const id = parseInt(req.params.id, 10);
  const kind = req.params.kind;

  if (kind === 'base') {
    const b = getBaseRow(id);
    if (!b) return null;
    const key = getCharacterRow(b.character_id)?.key;
    return { prompts: safeLayers(draftFromBase({ character: key }, b)) };
  }

  if (kind === 'variant') {
    const v = getVariantRow(id);
    if (!v) return null;
    const key = getCharacterRow(v.character_id)?.key;
    return { prompts: safeLayers(draftFromVariant({ character: key }, v)) };
  }

  if (kind === 'inpaint') {
    const ip = getInpaintRow(id);
    if (!ip) return null;
    const sourceRow = getVariantRow(ip.variant_id);
    const key = sourceRow ? getCharacterRow(sourceRow.character_id)?.key : '';
    const scene = sourceRow ? safeLayers(draftFromVariant({ character: key }, sourceRow)) : null;
    let ad = { positive: ip.prompt, negative: ip.negative };
    if (ip.identity_mode === 'prompt' && key) {
      const char = promptData().CHARACTERS[key];
      if (char) ad = withIdentityPrompt(char, ip.prompt, ip.negative);
    }
    return { prompts: ad, scene };
  }

  return null;
}));

export default router;
