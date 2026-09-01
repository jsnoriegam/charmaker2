import { Router } from 'express';
import {
  saveFramingOrAccessory, deleteFramingOrAccessory,
  setGlobal, replaceAllPromptData,
} from '../../db.js';
import { httpError, crud, cleanupOrphanImages } from '../util.js';
import { promptData, invalidatePromptData, getPromptSnapshot, previewFor } from '../prompts.js';

const router = Router();

router.get('/framings', crud(() => Object.entries(promptData().FRAMINGS).map(([key, val]) => ({ key, ...val }))));
router.get('/accessories', crud(() => Object.entries(promptData().ACCESSORIES).map(([key, val]) => ({ key, ...val }))));

function collectionItem(router, table, path, current) {
  router.post(path, crud((req, res) => {
    const { key, ...rest } = req.body;
    if (!key) throw httpError(400, 'Falta la clave');
    if (current()[key]) throw httpError(409, `Ya existe una entrada con la clave "${key}"`);
    const created = saveFramingOrAccessory(table, key, rest);
    invalidatePromptData();
    res.status(201);
    return created;
  }));
  router.put(`${path}/:key`, crud((req) => {
    if (!current()[req.params.key]) throw httpError(404, 'No encontrado');
    const updated = saveFramingOrAccessory(table, req.params.key, req.body);
    invalidatePromptData();
    return updated;
  }));
  router.delete(`${path}/:key`, crud((req) => {
    if (!deleteFramingOrAccessory(table, req.params.key)) throw httpError(404, 'No encontrado');
    invalidatePromptData();
    return { ok: true };
  }));
}
collectionItem(router, 'framings', '/framings', () => promptData().FRAMINGS);
collectionItem(router, 'accessories', '/accessories', () => promptData().ACCESSORIES);

router.put('/globals', crud((req) => {
  const { positive, negative } = req.body;
  if (typeof positive !== 'string' || typeof negative !== 'string') throw httpError(400, 'Se esperan positive y negative como strings');
  setGlobal('positive', positive);
  setGlobal('negative', negative);
  invalidatePromptData();
  return { positive, negative };
}));

router.get('/prompt-data', crud(() => getPromptSnapshot()));

// Import del JSON completo: reemplaza TODO (personajes incluidos → se pierden
// bases/variantes de personajes que ya no existen).
router.put('/prompt-data', crud((req) => {
  const { characters, framings, accessories, globals } = req.body;
  if (!characters || typeof characters !== 'object') throw httpError(400, 'El JSON importado necesita un objeto "characters"');
  replaceAllPromptData({ characters, framings, accessories, globals });
  invalidatePromptData();
  cleanupOrphanImages(Object.keys(characters));
  return getPromptSnapshot();
}));

// Preview del prompt para un BORRADOR del modal (no toca la DB).
router.post('/preview', crud((req) => {
  const { type, ...draft } = req.body;
  return previewFor({ type: type === 'base' ? 'base' : 'variant', ...draft });
}));

export default router;
