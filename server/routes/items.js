import { Router } from 'express';
import { rmSync } from 'fs';
import { join } from 'path';
import {
  getBase, getBaseRow, updateBase, cloneBase, deleteBase, listBases,
  getVariant, getVariantRow, updateVariant, cloneVariant, deleteVariant, listVariants,
  getInpaintRow, updateInpaint, deleteInpaint, listInpaints, getVariantSuggestions,
  getCharacterRow,
} from '../../db.js';
import { PROJECT_ROOT } from '../config.js';
import { httpError, crud, copyItemImage, itemDirs } from '../util.js';

// Borra los archivos intermedios (_stages, raw/crop) que deja la generación de
// un item al eliminarlo.
function removeBaseStages(characterId, baseId) {
  const key = getCharacterRow(characterId)?.key;
  if (!key) return;
  const { basesDir } = itemDirs(key);
  rmSync(join(basesDir, `base_${baseId}_raw.png`), { force: true });
  rmSync(join(basesDir, `base_${baseId}_crop.png`), { force: true });
}

const router = Router();

// ---------------------------------------------------------------------------
// Bases y variantes de un personaje
// ---------------------------------------------------------------------------

router.get('/bases', crud((req) => {
  if (!req.query.character) throw httpError(400, 'Falta ?character=');
  return listBases(req.query.character);
}));

router.get('/variants', crud((req) => {
  if (!req.query.character) throw httpError(400, 'Falta ?character=');
  return listVariants(req.query.character);
}));

router.get('/suggestions', crud((req) => {
  if (!req.query.character) throw httpError(400, 'Falta ?character=');
  return getVariantSuggestions(req.query.character);
}));

router.post('/bases/:id/clone', crud((req, res) => {
  const cloned = cloneBase(parseInt(req.params.id, 10));
  if (!cloned) throw httpError(404, 'Base no encontrada');
  const imagePath = copyItemImage(cloned, 'base', cloned.id);
  if (imagePath) updateBase(cloned.id, { imagePath });
  res.status(201);
  return imagePath ? getBase(cloned.id) : cloned;
}));

router.put('/bases/:id', crud((req) => {
  const updated = updateBase(parseInt(req.params.id, 10), req.body);
  if (!updated) throw httpError(404, 'Base no encontrada');
  return updated;
}));

router.delete('/bases/:id', crud((req) => {
  const id = parseInt(req.params.id, 10);
  const row = getBaseRow(id);
  if (!row) throw httpError(404, 'Base no encontrada');
  if (!deleteBase(id)) throw httpError(404, 'Base no encontrada');
  if (row.image_path) rmSync(join(PROJECT_ROOT, row.image_path), { force: true });
  removeBaseStages(row.character_id, id);
  return { ok: true };
}));

router.post('/variants/:id/clone', crud((req, res) => {
  const cloned = cloneVariant(parseInt(req.params.id, 10));
  if (!cloned) throw httpError(404, 'Variante no encontrada');
  const imagePath = copyItemImage(cloned, 'variant', cloned.id);
  if (imagePath) updateVariant(cloned.id, { imagePath });
  res.status(201);
  return imagePath ? getVariant(cloned.id) : cloned;
}));

router.put('/variants/:id', crud((req) => {
  const updated = updateVariant(parseInt(req.params.id, 10), req.body);
  if (!updated) throw httpError(404, 'Variante no encontrada');
  return updated;
}));

router.delete('/variants/:id', crud((req) => {
  const id = parseInt(req.params.id, 10);
  const row = getVariantRow(id);
  if (!row) throw httpError(404, 'Variante no encontrada');
  // Las filas de inpaints caen por CASCADE; falta borrar sus imágenes y stages.
  const full = getVariant(id);
  if (full?.character) {
    const { stagesDir } = itemDirs(full.character);
    for (const inp of listInpaints(full.character)) {
      if (inp.variant_id !== id) continue;
      if (inp.image_path) rmSync(join(PROJECT_ROOT, inp.image_path), { force: true });
      rmSync(join(stagesDir, `inpaint_${inp.id}_source.png`), { force: true });
      rmSync(join(stagesDir, `inpaint_${inp.id}_raw.png`), { force: true });
    }
    rmSync(join(stagesDir, `variant_${id}_scene.png`), { force: true });
    rmSync(join(stagesDir, `variant_${id}_raw.png`), { force: true });
  }
  if (!deleteVariant(id)) throw httpError(404, 'Variante no encontrada');
  if (row.image_path) rmSync(join(PROJECT_ROOT, row.image_path), { force: true });
  return { ok: true };
}));

// ---------------------------------------------------------------------------
// Inpaints
// ---------------------------------------------------------------------------

router.get('/inpaints', crud((req) => {
  if (!req.query.character) throw httpError(400, 'Falta ?character=');
  return listInpaints(req.query.character);
}));

router.put('/inpaints/:id', crud((req) => {
  const id = parseInt(req.params.id, 10);
  const row = getInpaintRow(id);
  if (!row) throw httpError(404, 'Inpaint no encontrado');

  const label = String(req.body.label ?? '').trim().toLowerCase();
  if (!label) throw httpError(400, 'El identificador es obligatorio.');
  if (!/^[a-z0-9_-]+$/.test(label)) throw httpError(400, 'Identificador inválido: solo letras, números, _ y -.');

  const d = { ...req.body, label };
  if (d.denoise !== undefined) {
    const denoise = parseFloat(d.denoise);
    if (!Number.isFinite(denoise) || denoise < 0.05 || denoise > 0.95) {
      throw httpError(400, 'La intensidad (denoise) debe estar entre 0.05 y 0.95.');
    }
    d.denoise = denoise;
  }

  const updated = updateInpaint(id, d);
  if (!updated) throw httpError(404, 'Inpaint no encontrado');
  return updated;
}));

router.delete('/inpaints/:id', crud((req) => {
  const id = parseInt(req.params.id, 10);
  const row = getInpaintRow(id);
  if (!row) throw httpError(404, 'Inpaint no encontrado');
  const variant = getVariantRow(row.variant_id);
  const key = variant ? getCharacterRow(variant.character_id)?.key : null;
  if (!deleteInpaint(id)) throw httpError(404, 'Inpaint no encontrado');
  if (row.image_path) rmSync(join(PROJECT_ROOT, row.image_path), { force: true });
  if (key) {
    const { stagesDir } = itemDirs(key);
    rmSync(join(stagesDir, `inpaint_${id}_source.png`), { force: true });
    rmSync(join(stagesDir, `inpaint_${id}_raw.png`), { force: true });
  }
  return { ok: true };
}));

export default router;
