import { Router } from 'express';
import { existsSync, readdirSync, renameSync } from 'fs';
import { join } from 'path';
import {
  getCharacterRow, saveCharacter, deleteCharacter, listCharacters,
  renameCharacterImagePaths, listBases, listVariants, listInpaints, KEY_PATTERN,
} from '../../db.js';
import { OUTPUT_DIR, PROJECT_ROOT } from '../config.js';
import { httpError, crud, cleanupOrphanImages } from '../util.js';
import { invalidatePromptData } from '../prompts.js';
import { buildBundleEntries, sanitizeName } from '../bundle.js';
import { streamZip } from '../zip.js';

const router = Router();

router.get('/', crud(() => listCharacters()));

// Descarga todas las imágenes generadas del personaje en un .zip.
router.get('/:key/bundle', (req, res) => {
  const char = getCharacterRow(req.params.key);
  if (!char) return res.status(404).json({ error: 'Personaje no encontrado' });

  const key = char.key;
  const withFile = (row) => row.image_path && existsSync(join(PROJECT_ROOT, row.image_path));
  const variants = listVariants(key);
  const bases = listBases(key).filter(withFile);
  const variantsWithImage = variants.filter(withFile);
  const inpaints = listInpaints(key).filter(withFile);

  if (!bases.length && !variantsWithImage.length && !inpaints.length) {
    return res.status(404).json({ error: 'El personaje no tiene imágenes generadas.' });
  }

  const variantLabels = new Map(variants.map(v => [v.id, v.label]));
  const entries = buildBundleEntries(key, {
    bases, variants: variantsWithImage, inpaints, variantLabels,
  }).map(({ name, item }) => ({ name, path: join(PROJECT_ROOT, item.image_path) }));

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="charmaker2_${sanitizeName(key)}.zip"`);
  streamZip(res, entries).catch((err) => {
    console.error('Error generando bundle:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy();
  });
});

router.get('/:key', crud((req) => {
  const row = getCharacterRow(req.params.key);
  if (!row) throw httpError(404, 'Personaje no encontrado');
  return row;
}));

router.post('/', crud((req, res) => {
  const { key } = req.body;
  if (!key || !KEY_PATTERN.test(key)) throw httpError(400, 'Clave inválida: minúsculas, dígitos o _ (empezar con letra)');
  if (getCharacterRow(key)) throw httpError(409, `Ya existe un personaje con la clave "${key}"`);
  const created = saveCharacter(key, req.body);
  invalidatePromptData();
  res.status(201);
  return created;
}));

router.put('/:key', crud((req) => {
  const existing = getCharacterRow(req.params.key);
  if (!existing) throw httpError(404, 'Personaje no encontrado');
  const oldKey = existing.key;
  const targetKey = (req.body.key && req.body.key !== req.params.key) ? req.body.key : req.params.key;
  const renaming = targetKey !== oldKey;

  const oldDir = join(OUTPUT_DIR, oldKey);
  const newDir = join(OUTPUT_DIR, targetKey);

  // Validamos el estado en disco ANTES de tocar la DB: si la carpeta destino
  // ya existe, abortamos sin dejar la key cambiada y las imágenes rotas.
  if (renaming && existsSync(oldDir) && existsSync(newDir)) {
    throw httpError(409, `Ya existe una carpeta generated/${targetKey}/ — no se puede renombrar sin perder imágenes. Movela o borrala primero.`);
  }

  const updated = saveCharacter(req.params.key, req.body);
  invalidatePromptData();

  if (renaming && existsSync(oldDir)) {
    try {
      renameSync(oldDir, newDir);
    } catch (err) {
      // Rollback de la key para no dejar la DB apuntando a una carpeta que no existe.
      saveCharacter(updated.key, { ...existing, key: oldKey });
      invalidatePromptData();
      throw httpError(500, `No se pudo renombrar generated/${oldKey}/: ${err.message}`);
    }
  }

  if (updated.key !== oldKey) {
    renameCharacterImagePaths(updated.id, oldKey, updated.key);

    // Best-effort: las referencias de PhotoMaker/IP-Adapter quedan con la key
    // vieja en el nombre de carpeta/archivo. No rompen nada (se regeneran en
    // el próximo pase de identidad), pero las renombramos para prolijidad.
    for (const [dir, sep] of [[join(OUTPUT_DIR, '_photomaker_ref'), '_base'], [join(OUTPUT_DIR, '_ipadapter_ref'), '_base']]) {
      if (!existsSync(dir)) continue;
      try {
        for (const entry of readdirSync(dir)) {
          if (entry.startsWith(`${oldKey}${sep}`)) {
            renameSync(join(dir, entry), join(dir, entry.replace(`${oldKey}${sep}`, `${updated.key}${sep}`)));
          }
        }
      } catch (err) {
        console.warn(`No se pudo renombrar refs en ${dir}:`, err.message);
      }
    }
  }

  return updated;
}));

router.delete('/:key', crud((req) => {
  if (!deleteCharacter(req.params.key)) throw httpError(404, 'Personaje no encontrado');
  invalidatePromptData();
  // Borra la carpeta del personaje y sus refs de identidad huérfanas.
  cleanupOrphanImages(listCharacters().map(c => c.key));
  return { ok: true };
}));

export default router;
