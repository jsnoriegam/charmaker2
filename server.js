import 'dotenv/config';
import express from 'express';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { initDb, countCharacters, closeDb } from './db.js';
import { runSeed, loadCharacterData } from './seed.js';
import { jobs } from './server/jobs.js';
import { PORT, HOST, OUTPUT_DIR, MODEL_DIR, SD_BINARY, DEFAULT_MODEL_FILE, STAGES_TTL_HOURS } from './server/config.js';
import { pruneStages } from './server/util.js';
import { initRembg } from './server/rembg.js';
import { initSamplerOptions } from './server/sdcli.js';
import charactersRouter from './server/routes/characters.js';
import itemsRouter from './server/routes/items.js';
import galleryRouter from './server/routes/gallery.js';
import promptDataRouter from './server/routes/prompt-data.js';
import generateRouter from './server/routes/generate.js';
import metaRouter from './server/routes/meta.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const app = express();

app.use(express.json({ limit: '2mb' }));
app.use('/generated', express.static(OUTPUT_DIR));
// Assets del front con no-store: al ser un server local, evita que el navegador
// siga ejecutando un app.js/style.css viejo después de un cambio.
app.use(express.static(join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

app.use('/api/characters', charactersRouter);
app.use('/api', itemsRouter);
app.use('/api', galleryRouter);
app.use('/api', promptDataRouter);
app.use('/api', generateRouter);
app.use('/api', metaRouter);

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

// Avisos de configuración: mejor verlos al arrancar que al lanzar la primera
// generación (los defaults de config.js son solo un último recurso).
function warnConfig() {
  if (!process.env.SD_BINARY) console.warn(`SD_BINARY no definido en .env — usando ${SD_BINARY}`);
  if (!existsSync(SD_BINARY)) console.warn(`sd-cli no encontrado: ${SD_BINARY} (revisá SD_BINARY).`);
  if (!process.env.SD_MODEL_DIR) console.warn(`SD_MODEL_DIR no definido en .env — usando ${MODEL_DIR}`);
  if (!process.env.SD_DEFAULT_MODEL) console.warn(`SD_DEFAULT_MODEL no definido en .env — usando ${DEFAULT_MODEL_FILE}`);
  if (existsSync(MODEL_DIR) && !existsSync(join(MODEL_DIR, DEFAULT_MODEL_FILE))) {
    console.warn(`Modelo por defecto no encontrado: ${join(MODEL_DIR, DEFAULT_MODEL_FILE)} (revisá SD_DEFAULT_MODEL).`);
  }
}
warnConfig();

// Purga periódica de intermedios (_stages). Deshabilitada salvo que se fije
// SD_STAGES_TTL_HOURS > 0.
if (STAGES_TTL_HOURS > 0) {
  setInterval(() => {
    const removed = pruneStages(STAGES_TTL_HOURS * 60 * 60 * 1000);
    if (removed) console.log(`Limpieza de _stages: ${removed} archivo(s) eliminado(s).`);
  }, 60 * 60 * 1000).unref();
}

initDb();

if (countCharacters() === 0) {
  try {
    const mod = await loadCharacterData();
    const stats = runSeed(mod, { defaultModel: DEFAULT_MODEL_FILE });
    console.log(`Seed automático: ${stats.characters} personajes, ${stats.bases} bases, ${stats.variants} variantes importadas.`);
  } catch (err) {
    console.warn('No se pudo ejecutar el seed automático:', err.message);
  }
}

// Shutdown ordenado: mata los sd-cli en curso y cierra SQLite.
function shutdown() {
  for (const job of jobs.values()) {
    if (job.currentProc) {
      try { job.currentProc.kill('SIGKILL'); } catch { /* el proceso ya murió */ }
    }
  }
  try { closeDb(); } catch { /* la DB ya estaba cerrada */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await Promise.all([initRembg(), initSamplerOptions()]);
app.listen(PORT, HOST, () => {
  console.log(`CharMaker2 running at http://${HOST}:${PORT}`);
  console.log(`SD binary: ${SD_BINARY}`);
  console.log(`Model dir: ${MODEL_DIR}`);
  console.log(`Output dir: ${OUTPUT_DIR}`);
});
