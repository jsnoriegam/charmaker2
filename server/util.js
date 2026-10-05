import { mkdirSync, existsSync, readdirSync, renameSync, rmSync, copyFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { OUTPUT_DIR, PROJECT_ROOT, HISTORY_KEEP } from './config.js';

export function httpError(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}

export function crud(handler) {
  // async/await deliberado: soporta handlers sincrónicos y futuros async.
  return async (req, res) => {
    try {
      const result = await handler(req, res);
      if (result !== undefined) res.json(result);
    } catch (err) {
      const status = err.statusCode || 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return;
      res.status(status).json({ error: err.message });
    }
  };
}

// Borra imágenes de personajes que ya no están en la DB (import JSON / seed).
// Recorre generated/<key>/ y las referencias de PhotoMaker/IP-Adapter; no toca
// data/. Devuelve cuántas entradas eliminó.
export function cleanupOrphanImages(validKeys) {
  const valid = new Set(validKeys);
  let removed = 0;
  const drop = (path) => {
    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
      removed++;
    }
  };

  if (existsSync(OUTPUT_DIR)) {
    for (const entry of readdirSync(OUTPUT_DIR)) {
      if (entry.startsWith('_')) continue;
      if (!valid.has(entry)) drop(join(OUTPUT_DIR, entry));
    }
  }

  for (const refDir of ['_photomaker_ref', '_ipadapter_ref']) {
    const full = join(OUTPUT_DIR, refDir);
    if (!existsSync(full)) continue;
    for (const entry of readdirSync(full)) {
      const key = entry.split('_base')[0];
      if (!valid.has(key)) drop(join(full, entry));
    }
  }

  return removed;
}

// El timestamp en el nombre (${nameWithoutExt}_${ISO}) ordena cronológicamente
// como string, así que un sort() alfabético alcanza para saber qué es más viejo.
export function pruneHistory(historyDir, baseName) {
  if (!existsSync(historyDir)) return;
  const prefix = `${baseName}_`;
  const files = readdirSync(historyDir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.png'))
    .sort();
  const excess = files.length - HISTORY_KEEP;
  if (excess <= 0) return;
  for (const f of files.slice(0, excess)) {
    try {
      rmSync(join(historyDir, f), { force: true });
    } catch (err) {
      console.warn(`No se pudo purgar historial ${f}:`, err.message);
    }
  }
}

export function moveToHistory(filePath, historyDir) {
  if (!existsSync(filePath)) return null;
  const basename = filePath.split('/').pop();
  const nameWithoutExt = basename.replace('.png', '');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const historyPath = join(historyDir, `${nameWithoutExt}_${timestamp}.png`);
  renameSync(filePath, historyPath);
  pruneHistory(historyDir, nameWithoutExt);
  return historyPath;
}

export function itemDirs(character) {
  const charDir = join(OUTPUT_DIR, character);
  const basesDir = join(charDir, 'bases');
  const variantsDir = join(charDir, 'variants');
  const inpaintsDir = join(charDir, 'inpaints');
  const historyDir = join(charDir, '_history');
  const stagesDir = join(charDir, '_stages');
  for (const d of [charDir, basesDir, variantsDir, inpaintsDir, historyDir, stagesDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  return { charDir, basesDir, variantsDir, inpaintsDir, historyDir, stagesDir };
}

// El clon copia también la imagen al nombre de su propio id: si compartieran
// archivo, borrar el clon dejaría sin imagen al original (y viceversa).
export function copyItemImage(item, kind, id) {
  if (!item.image_path) return null;
  const rel = `/generated/${item.character}/${kind === 'base' ? 'bases' : 'variants'}/${kind}_${id}.png`;
  const src = join(PROJECT_ROOT, item.image_path);
  const dest = join(PROJECT_ROOT, rel);
  if (existsSync(src)) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return rel;
  }
  return null;
}

// Purga los intermedios (_stages) más viejos que ttlMs. Están pensados para
// reutilizarse como fuente en inpaints; con TTL se sacrifica eso por espacio.
// ttlMs <= 0 lo deshabilita (default). Ver STAGES_TTL_HOURS en config.js.
export function pruneStages(ttlMs) {
  if (!(ttlMs > 0) || !existsSync(OUTPUT_DIR)) return 0;
  const cutoff = Date.now() - ttlMs;
  let removed = 0;
  for (const entry of readdirSync(OUTPUT_DIR)) {
    if (entry.startsWith('_')) continue;
    const stages = join(OUTPUT_DIR, entry, '_stages');
    if (!existsSync(stages)) continue;
    for (const file of readdirSync(stages)) {
      const full = join(stages, file);
      try {
        if (statSync(full).mtimeMs < cutoff) {
          rmSync(full, { force: true });
          removed++;
        }
      } catch { /* el archivo ya no está */ }
    }
  }
  return removed;
}
