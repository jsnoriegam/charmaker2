import { Router } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  getCharacterRow, getBaseRow, getVariantRow,
  createBase, updateBase, createVariant, updateVariant,
  upsertInpaint, getInpaintByVariantLabel,
  normSeed, inpaintSeed,
} from '../../db.js';
import {
  MODEL_DIR, PROJECT_ROOT, WIDTH, HEIGHT, ALLOWED_SIZES,
  FACE_DETECT_MODEL, INPAINT_REGIONS,
} from '../config.js';
import { httpError, itemDirs } from '../util.js';
import { promptData, buildPromptLayers, previewFor, draftFromBase, draftFromVariant, withIdentityPrompt } from '../prompts.js';
import { jobs, jobEvents, nextJobId, enqueueJob, cancelJob, getQueue, findActiveJob } from '../jobs.js';
import { resolveGenerationSettings, resolveSeed, resolveVariantSeed, inpaintRegionModel } from '../sdcli.js';
import { runBaseGeneration } from '../pipeline/base.js';
import { runVariantGeneration } from '../pipeline/variant.js';
import { runInpaintGeneration } from '../pipeline/inpaint.js';

const router = Router();

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

// ---------------------------------------------------------------------------
// Generación de base
// ---------------------------------------------------------------------------

router.post('/generate-base', (req, res) => {
  const body = req.body;
  const char = getCharacterRow(body.character);
  if (!char) return badRequest(res, `Unknown character: ${body.character}`);

  let row = null;
  if (body.baseId) {
    row = getBaseRow(parseInt(body.baseId, 10));
    if (!row) return badRequest(res, `Base no encontrada: ${body.baseId}`);
    if (row.character_id !== char.id) return badRequest(res, 'La base no pertenece a ese personaje');
    const active = findActiveJob('base', row.id);
    if (active) {
      return res.status(409).json({ error: `Ya hay una generación en curso para esta base (job ${active.id}).` });
    }
  }

  let settings;
  try {
    settings = resolveGenerationSettings(body, row);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }

  const modelPath = join(MODEL_DIR, settings.modelFile);
  if (!existsSync(modelPath)) {
    return badRequest(res, `Model not found: ${modelPath}`);
  }

  let draft;
  try {
    draft = draftFromBase(body, row);
    if (!promptData().FRAMINGS[draft.framingKey]) throw httpError(400, `Framing no encontrado: ${draft.framingKey}`);
    previewFor(draft);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }

  const resolvedSeed = resolveSeed(body);

  // La fila existe ANTES de generar (su id define el nombre de archivo).
  if (row) {
    row = updateBase(row.id, {
      clothing: draft.clothing, negativeExtra: draft.negativeExtra, framingKey: draft.framingKey,
      ...settings, rembg: body.rembg !== false,
    });
  } else {
    row = createBase({
      characterKey: char.key,
      clothing: draft.clothing, negativeExtra: draft.negativeExtra, framingKey: draft.framingKey,
      ...settings, rembg: body.rembg !== false,
    });
  }

  const jobId = nextJobId();
  const job = {
    id: jobId,
    kind: 'base',
    refId: row.id,
    status: 'pending',
    cancelled: false,
    currentProc: null,
    progress: { currentStep: 0, totalSteps: settings.steps, percent: 0, stage: 'Generando base...' },
    character: char.key,
    seed: resolvedSeed,
    createdAt: new Date().toISOString(),
  };
  jobs.set(jobId, job);

  res.json({ jobId, baseId: row.id, status: 'pending' });

  enqueueJob(() => runBaseGeneration({ job, char, row, settings, resolvedSeed, draft, body, modelPath }), jobId);
});

// ---------------------------------------------------------------------------
// Generación de variante (usa la base elegida como referencia de identidad)
// ---------------------------------------------------------------------------

router.post('/generate-variant', (req, res) => {
  const body = req.body;
  const char = getCharacterRow(body.character);
  if (!char) return badRequest(res, `Unknown character: ${body.character}`);

  let row = null;
  if (body.variantId) {
    row = getVariantRow(parseInt(body.variantId, 10));
    if (!row) return badRequest(res, `Variante no encontrada: ${body.variantId}`);
    if (row.character_id !== char.id) return badRequest(res, 'La variante no pertenece a ese personaje');
    const active = findActiveJob('variant', row.id);
    if (active) {
      return res.status(409).json({ error: `Ya hay una generación en curso para esta variante (job ${active.id}).` });
    }
  }

  const baseId = body.baseId ?? row?.base_id;
  const base = baseId ? getBaseRow(parseInt(baseId, 10)) : null;
  if (!base) return badRequest(res, 'Variante requiere una base (baseId). Generá una base primero.');
  if (base.character_id !== char.id) return badRequest(res, 'La base no pertenece a ese personaje');

  let settings;
  try {
    settings = resolveGenerationSettings(body, row);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }

  let resolvedWidth = WIDTH;
  let resolvedHeight = HEIGHT;
  if (body.width !== undefined || body.height !== undefined) {
    const sizeKey = `${body.width}x${body.height}`;
    if (!ALLOWED_SIZES.has(sizeKey)) {
      return badRequest(res, `Tamaño no soportado: ${sizeKey}`);
    }
    resolvedWidth = body.width;
    resolvedHeight = body.height;
  } else if (row?.width && row?.height) {
    resolvedWidth = row.width;
    resolvedHeight = row.height;
  }

  const modelPath = join(MODEL_DIR, settings.modelFile);
  if (!existsSync(modelPath)) {
    return badRequest(res, `Model not found: ${modelPath}`);
  }

  const method = body.method ?? row?.method ?? 'none';
  if (!['none', 'photomaker', 'ipadapter'].includes(method)) {
    return badRequest(res, `Method desconocido: ${method}`);
  }
  const usePhotoMaker = method === 'photomaker';
  const useIpAdapter = method === 'ipadapter';
  if ((usePhotoMaker || useIpAdapter) && !FACE_DETECT_MODEL) {
    return badRequest(res, 'PhotoMaker/IP-Adapter requieren SD_AD_FACE_MODEL configurado en .env');
  }
  if (usePhotoMaker && !process.env.SD_PHOTOMAKER_PATH) {
    return badRequest(res, 'PhotoMaker requiere SD_PHOTOMAKER_PATH configurado en .env');
  }
  if (useIpAdapter && (!process.env.SD_IP_ADAPTER_PATH || !process.env.SD_CLIP_VISION_PATH)) {
    return badRequest(res, 'IP-Adapter requiere SD_IP_ADAPTER_PATH y SD_CLIP_VISION_PATH en .env');
  }

  let draft;
  try {
    draft = draftFromVariant(body, row);
    previewFor(draft);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }

  const pmStyleStrength = body.strength ?? row?.strength ?? undefined;
  if ((usePhotoMaker || useIpAdapter) && (pmStyleStrength === undefined || pmStyleStrength === null || pmStyleStrength === '')) {
    return badRequest(res, `${useIpAdapter ? 'IP-Adapter' : 'PhotoMaker'}: strength es obligatorio.`);
  }
  if (usePhotoMaker || useIpAdapter) {
    const s = parseFloat(pmStyleStrength);
    if (Number.isNaN(s)) {
      return badRequest(res, 'Strength inválido.');
    }
    if (useIpAdapter && !(s > 0 && s <= 1)) {
      return badRequest(res, 'IP-Adapter: strength debe ser mayor que 0 y hasta 1.');
    }
    if (usePhotoMaker && !(s > 0 && s <= 100)) {
      return badRequest(res, 'PhotoMaker: strength debe ser mayor que 0 y hasta 100.');
    }
  }
  const resolvedSeed = resolveVariantSeed(body, char.key, draft.clothing);

  const itemFields = {
    baseId: base.id,
    label: draft.label ?? body.label ?? row?.label ?? '',
    expression: draft.expression,
    clothing: draft.clothing,
    accessories: draft.accessories,
    negativeExtra: draft.negativeExtra,
    framingKey: draft.framingKey,
    method,
    strength: pmStyleStrength,
    seed: resolvedSeed,
    ...settings,
    width: resolvedWidth,
    height: resolvedHeight,
    rembg: body.rembg !== false,
  };

  if (row) {
    row = updateVariant(row.id, itemFields);
  } else {
    row = createVariant({ characterKey: char.key, ...itemFields });
  }

  const jobId = nextJobId();
  const job = {
    id: jobId,
    kind: 'variant',
    refId: row.id,
    status: 'pending',
    cancelled: false,
    currentProc: null,
    progress: { currentStep: 0, totalSteps: settings.steps, percent: 0, stage: '' },
    character: char.key,
    seed: resolvedSeed,
    createdAt: new Date().toISOString(),
  };
  jobs.set(jobId, job);

  res.json({ jobId, variantId: row.id, status: 'pending' });

  enqueueJob(() => runVariantGeneration({
    job, char, row, base, settings, resolvedSeed, draft, body, modelPath,
    method, usePhotoMaker, useIpAdapter, pmStyleStrength, resolvedWidth, resolvedHeight,
  }), jobId);
});

// ---------------------------------------------------------------------------
// Inpainting de variantes (región -> modelo detector, expresión vía adetailer)
// ---------------------------------------------------------------------------

router.post('/inpaint-variant', (req, res) => {
  const body = req.body;
  const variantId = parseInt(body.variantId, 10);
  const variantRow = Number.isFinite(variantId) ? getVariantRow(variantId) : null;
  if (!variantRow) return badRequest(res, 'Variante no encontrada');
  const char = getCharacterRow(variantRow.character_id);
  if (!char) return badRequest(res, 'Personaje no encontrado');

  const label = String(body.label ?? '').trim().toLowerCase();
  if (!label) return badRequest(res, 'El identificador es obligatorio (se añade al nombre de la variante).');
  if (!/^[a-z0-9_-]+$/.test(label)) return badRequest(res, 'Identificador inválido: solo letras, números, _ y -.');

  const region = body.region || 'face';
  if (!INPAINT_REGIONS[region]) return badRequest(res, `Región desconocida: ${region}`);
  const adModel = inpaintRegionModel(region);
  if (!adModel) {
    return badRequest(res, `La región ${INPAINT_REGIONS[region].label.toLowerCase()} requiere ${INPAINT_REGIONS[region].modelKey} configurado en .env.`);
  }

  let prompt = String(body.prompt ?? '').trim();
  if (!prompt) return badRequest(res, 'El prompt de inpainting es obligatorio.');
  let negative = String(body.negative ?? '').trim();

  const denoise = parseFloat(body.denoise);
  if (!Number.isFinite(denoise) || denoise < 0.05 || denoise > 0.95) {
    return badRequest(res, 'La intensidad (denoise) debe estar entre 0.05 y 0.95.');
  }

  // Anclaje de identidad para el rostro regenerado:
  //   'none'       → como antes, sin anclaje (libertad total, pero puede divergir).
  //   'prompt'     → antepone identity/face/hair del personaje al ad-prompt.
  //   'photomaker' → misma técnica que el pase de identidad de variantes.
  //   'ipadapter'  → ídem, vía IP-Adapter.
  const identityMode = body.identityMode ?? 'none';
  if (!['none', 'prompt', 'photomaker', 'ipadapter'].includes(identityMode)) {
    return badRequest(res, `Modo de identidad desconocido: ${identityMode}`);
  }
  if (identityMode === 'photomaker' && !(process.env.SD_PHOTOMAKER_PATH && FACE_DETECT_MODEL)) {
    return badRequest(res, 'PhotoMaker requiere SD_PHOTOMAKER_PATH y SD_AD_FACE_MODEL configurados en .env');
  }
  if (identityMode === 'ipadapter' && !(process.env.SD_IP_ADAPTER_PATH && process.env.SD_CLIP_VISION_PATH && FACE_DETECT_MODEL)) {
    return badRequest(res, 'IP-Adapter requiere SD_IP_ADAPTER_PATH, SD_CLIP_VISION_PATH y SD_AD_FACE_MODEL configurados en .env');
  }

  let identityStrength = null;
  if (identityMode === 'photomaker' || identityMode === 'ipadapter') {
    identityStrength = parseFloat(body.identityStrength);
    if (Number.isNaN(identityStrength)) return badRequest(res, 'Strength de identidad inválido.');
    if (identityMode === 'ipadapter' && !(identityStrength > 0 && identityStrength <= 1)) {
      return badRequest(res, 'IP-Adapter: strength debe ser mayor que 0 y hasta 1.');
    }
    if (identityMode === 'photomaker' && !(identityStrength > 0 && identityStrength <= 100)) {
      return badRequest(res, 'PhotoMaker: strength debe ser mayor que 0 y hasta 100.');
    }
  }

  // El modo 'prompt' no necesita la base ni sharp: la identidad se antepone
  // solo al generar. En la fila se guarda lo escrito en el formulario — si se
  // guardara ya concatenado, al reabrir y volver a generar se antepondría dos veces.
  let adPrompt = prompt;
  let adNegative = negative;
  if (identityMode === 'prompt') {
    ({ positive: adPrompt, negative: adNegative } = withIdentityPrompt(char, prompt, negative));
  }

  // photomaker/ipadapter necesitan una base con imagen generada, de donde sale
  // la referencia facial (igual que el pase de identidad de variantes).
  let identityBase = null;
  if (identityMode === 'photomaker' || identityMode === 'ipadapter') {
    identityBase = variantRow.base_id ? getBaseRow(variantRow.base_id) : null;
    if (!identityBase || !identityBase.image_path || !existsSync(join(PROJECT_ROOT, identityBase.image_path))) {
      return badRequest(res, 'La base del personaje todavía no tiene imagen generada — hace falta para anclar la identidad.');
    }
  }

  let settings;
  try {
    settings = resolveGenerationSettings({}, variantRow);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }
  const modelPath = join(MODEL_DIR, settings.modelFile);
  if (!existsSync(modelPath)) return badRequest(res, `Model not found: ${modelPath}`);

  const { stagesDir } = itemDirs(char.key);
  let scenePrompt;
  try {
    scenePrompt = buildPromptLayers(draftFromVariant({ character: char.key }, variantRow));
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.message });
  }

  // Fuente con fondo: raw (pase de identidad) > scene (pase principal) > final aplanada.
  let sourcePath = [
    join(stagesDir, `variant_${variantId}_raw.png`),
    join(stagesDir, `variant_${variantId}_scene.png`),
  ].find(p => existsSync(p)) ?? null;
  let sourceNote = null;
  if (!sourcePath && variantRow.image_path && existsSync(join(PROJECT_ROOT, variantRow.image_path))) {
    sourcePath = join(PROJECT_ROOT, variantRow.image_path);
    sourceNote = 'Usando la imagen final (si tenía fondo removido, se aplanará sobre blanco).';
  }
  if (!sourcePath) return badRequest(res, 'La variante origen todavía no tiene imagen generada.');

  const seed = normSeed(body.seed) ?? inpaintSeed(char.key, variantId, label);

  // El identificador es único por variante: regenerar con el mismo label
  // sobrescribe el inpaint existente (misma fila, misma imagen en disco) en
  // vez de crear otro. Así el nombre del descargable se mantiene estable.
  const existing = getInpaintByVariantLabel(variantId, label);
  if (existing) {
    const active = findActiveJob('inpaint', existing.id);
    if (active) {
      return res.status(409).json({ error: `Ya hay una generación en curso para este inpaint (job ${active.id}).` });
    }
  }

  const inpaintFields = {
    label,
    region,
    prompt,
    negative,
    denoise,
    seed,
    steps: settings.steps,
    cfg: settings.cfg,
    sampler: settings.sampler,
    schedule: settings.schedule,
    model: settings.model,
    rembg: body.rembg !== false,
    identityMode,
    identityStrength,
  };
  const { row } = upsertInpaint({ variantId, ...inpaintFields });

  const jobId = nextJobId();
  const job = {
    id: jobId,
    kind: 'inpaint',
    refId: row.id,
    variantId,
    status: 'pending',
    cancelled: false,
    currentProc: null,
    progress: { currentStep: 0, totalSteps: settings.steps, percent: 0, stage: '', note: sourceNote },
    character: char.key,
    seed,
    createdAt: new Date().toISOString(),
  };
  jobs.set(jobId, job);

  res.json({ jobId, inpaintId: row.id, status: 'pending' });

  enqueueJob(() => runInpaintGeneration({
    job, char, row, settings, seed, adModel, adPrompt, adNegative, denoise,
    identityMode, identityStrength, identityBase, scenePrompt, sourcePath, modelPath, body,
  }), jobId);
});

// ---------------------------------------------------------------------------
// Estado / SSE / cancelación de jobs
// ---------------------------------------------------------------------------

// Jobs activos (pending/running) para rehidratar el seguimiento tras un refresh.
router.get('/jobs', (req, res) => {
  const active = [...jobs.values()]
    .filter(j => j.status === 'pending' || j.status === 'running')
    .map(j => {
      const { currentProc, ...rest } = j;
      return { ...rest, queuePosition: rest.status === 'pending' ? (getQueue().indexOf(rest.id) + 1 || null) : null };
    });
  res.json({ jobs: active, queued: getQueue() });
});

router.get('/generate/:id', (req, res) => {
  const job = jobs.get(parseInt(req.params.id, 10));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { currentProc, ...jobData } = job;
  res.json(jobData);
});

router.post('/generate/:id/cancel', (req, res) => {
  const result = cancelJob(parseInt(req.params.id, 10));
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

router.get('/generate/:id/stream', (req, res) => {
  const jobId = parseInt(req.params.id, 10);
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (current) => {
    res.write(`data: ${JSON.stringify({
      status: current.status,
      progress: current.progress,
      outputPath: current.outputPath,
      error: current.error,
      seed: current.seed,
      kind: current.kind,
      refId: current.refId,
      queuePosition: current.queuePosition ?? null,
    })}\n\n`);
  };

  send(job);

  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
    res.end();
    return;
  }

  const onUpdate = (current) => {
    send(current);
    if (current.status === 'done' || current.status === 'error' || current.status === 'cancelled') {
      cleanup();
    }
  };

  function cleanup() {
    jobEvents.off(`job:${jobId}`, onUpdate);
    res.end();
  }

  jobEvents.on(`job:${jobId}`, onUpdate);
  req.on('close', cleanup);
});

export default router;
