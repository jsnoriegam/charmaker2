import { Router } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  getCharacterRow, getBaseRow, getVariantRow,
  createBase, updateBase, createVariant, updateVariant,
  upsertInpaint, getInpaintByVariantLabel,
} from '../../db.js';
import {
  MODEL_DIR, PROJECT_ROOT, WIDTH, HEIGHT, ALLOWED_SIZES,
  FACE_DETECT_MODEL, INPAINT_REGIONS,
} from '../config.js';
import { httpError, itemDirs } from '../util.js';
import { promptData, buildPromptLayers, previewFor, draftFromBase, draftFromVariant, withIdentityPrompt } from '../prompts.js';
import { jobs, jobEvents, nextJobId, enqueueJob, cancelJob, getQueue, findActiveJob } from '../jobs.js';
import { resolveGenerationSettings, resolveSeed, inpaintRegionModel } from '../sdcli.js';
import { runBaseGeneration } from '../pipeline/base.js';
import { runVariantGeneration } from '../pipeline/variant.js';
import { runInpaintGeneration } from '../pipeline/inpaint.js';

const router = Router();

function badRequest(res, key, params) {
  return res.status(400).json({ error: key, params });
}

// ---------------------------------------------------------------------------
// Generación de base
// ---------------------------------------------------------------------------

router.post('/generate-base', (req, res) => {
  const body = req.body;
  const char = getCharacterRow(body.character);
  if (!char) return badRequest(res, 'errors.unknownCharacter', { key: body.character });

  let row = null;
  if (body.baseId) {
    row = getBaseRow(parseInt(body.baseId, 10));
    if (!row) return badRequest(res, 'errors.baseNotFoundId', { id: body.baseId });
    if (row.character_id !== char.id) return badRequest(res, 'errors.baseNotOfCharacter');
    const active = findActiveJob('base', row.id);
    if (active) {
      return res.status(409).json({ error: 'errors.generationInProgressBase', params: { id: active.id } });
    }
  }

  let settings;
  try {
    settings = resolveGenerationSettings(body, row);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.i18nKey || e.message, params: e.i18nParams });
  }

  const modelPath = join(MODEL_DIR, settings.modelFile);
  if (!existsSync(modelPath)) {
    return badRequest(res, 'errors.modelNotFound', { path: modelPath });
  }

  let draft;
  try {
    draft = draftFromBase(body, row);
    if (!promptData().FRAMINGS[draft.framingKey]) throw httpError(400, 'errors.framingNotFound', { key: draft.framingKey });
    previewFor(draft);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.i18nKey || e.message, params: e.i18nParams });
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
    progress: { currentStep: 0, totalSteps: settings.steps, percent: 0, stage: 'stages.base' },
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
  if (!char) return badRequest(res, 'errors.unknownCharacter', { key: body.character });

  let row = null;
  if (body.variantId) {
    row = getVariantRow(parseInt(body.variantId, 10));
    if (!row) return badRequest(res, 'errors.variantNotFoundId', { id: body.variantId });
    if (row.character_id !== char.id) return badRequest(res, 'errors.variantNotOfCharacter');
    const active = findActiveJob('variant', row.id);
    if (active) {
      return res.status(409).json({ error: 'errors.generationInProgressVariant', params: { id: active.id } });
    }
  }

  const baseId = body.baseId ?? row?.base_id;
  const base = baseId ? getBaseRow(parseInt(baseId, 10)) : null;
  if (!base) return badRequest(res, 'errors.variantRequiresBase');
  if (base.character_id !== char.id) return badRequest(res, 'errors.baseNotOfCharacter');

  let settings;
  try {
    settings = resolveGenerationSettings(body, row);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.i18nKey || e.message, params: e.i18nParams });
  }

  let resolvedWidth = WIDTH;
  let resolvedHeight = HEIGHT;
  if (body.width !== undefined || body.height !== undefined) {
    const sizeKey = `${body.width}x${body.height}`;
    if (!ALLOWED_SIZES.has(sizeKey)) {
      return badRequest(res, 'errors.sizeUnsupported', { size: sizeKey });
    }
    resolvedWidth = body.width;
    resolvedHeight = body.height;
  } else if (row?.width && row?.height) {
    resolvedWidth = row.width;
    resolvedHeight = row.height;
  }

  const modelPath = join(MODEL_DIR, settings.modelFile);
  if (!existsSync(modelPath)) {
    return badRequest(res, 'errors.modelNotFound', { path: modelPath });
  }

  const identityMethod = body.identityMethod ?? body.identity_method ?? body.method ?? row?.identity_method ?? 'none';
  if (!['none', 'photomaker', 'ipadapter'].includes(identityMethod)) {
    return badRequest(res, 'errors.methodUnknown', { method: identityMethod });
  }
  const usePhotoMaker = identityMethod === 'photomaker';
  const useIpAdapter = identityMethod === 'ipadapter';
  if ((usePhotoMaker || useIpAdapter) && !FACE_DETECT_MODEL) {
    return badRequest(res, 'errors.photomakerFaceModelMissing');
  }
  if (usePhotoMaker && !process.env.SD_PHOTOMAKER_PATH) {
    return badRequest(res, 'errors.photomakerPathMissing');
  }
  if (useIpAdapter && (!process.env.SD_IP_ADAPTER_PATH || !process.env.SD_CLIP_VISION_PATH)) {
    return badRequest(res, 'errors.ipadapterPathMissing');
  }

  let draft;
  try {
    draft = draftFromVariant(body, row);
    previewFor(draft);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.i18nKey || e.message, params: e.i18nParams });
  }

  const pmStyleStrength = body.strength ?? row?.strength ?? undefined;
  const strengthLabel = useIpAdapter ? 'IP-Adapter' : 'PhotoMaker';
  if ((usePhotoMaker || useIpAdapter) && (pmStyleStrength === undefined || pmStyleStrength === null || pmStyleStrength === '')) {
    return badRequest(res, 'errors.strengthRequired', { label: strengthLabel });
  }
  if (usePhotoMaker || useIpAdapter) {
    const s = parseFloat(pmStyleStrength);
    if (Number.isNaN(s)) {
      return badRequest(res, 'errors.strengthInvalid');
    }
    if (useIpAdapter && !(s > 0 && s <= 1)) {
      return badRequest(res, 'errors.ipadapterRange');
    }
    if (usePhotoMaker && !(s > 0 && s <= 100)) {
      return badRequest(res, 'errors.photomakerRange');
    }
  }
  // "Seed automático": seed nuevo (aleatorio) en cada generación; si el modal
  // trae un seed explícito, se respeta tal cual.
  const resolvedSeed = resolveSeed(body);

  const itemFields = {
    baseId: base.id,
    label: draft.label ?? body.label ?? row?.label ?? '',
    expression: draft.expression,
    clothing: draft.clothing,
    accessories: draft.accessories,
    negativeExtra: draft.negativeExtra,
    framingKey: draft.framingKey,
    identityMethod,
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
    identityMethod, usePhotoMaker, useIpAdapter, pmStyleStrength, resolvedWidth, resolvedHeight,
  }), jobId);
});

// ---------------------------------------------------------------------------
// Inpainting de variantes (región -> modelo detector, expresión vía adetailer)
// ---------------------------------------------------------------------------

router.post('/inpaint-variant', (req, res) => {
  const body = req.body;
  const variantId = parseInt(body.variantId, 10);
  const variantRow = Number.isFinite(variantId) ? getVariantRow(variantId) : null;
  if (!variantRow) return badRequest(res, 'errors.variantNotFound');
  const char = getCharacterRow(variantRow.character_id);
  if (!char) return badRequest(res, 'errors.characterNotFound');

  const label = String(body.label ?? '').trim().toLowerCase();
  if (!label) return badRequest(res, 'errors.identifierRequiredLong');
  if (!/^[a-z0-9_-]+$/.test(label)) return badRequest(res, 'errors.identifierInvalid');

  const region = body.region || 'face';
  if (!INPAINT_REGIONS[region]) return badRequest(res, 'errors.regionUnknown', { region });
  const adModel = inpaintRegionModel(region);
  if (!adModel) {
    return badRequest(res, 'errors.regionModelMissing', { region, model: INPAINT_REGIONS[region].modelKey });
  }

  let prompt = String(body.prompt ?? '').trim();
  if (!prompt) return badRequest(res, 'errors.promptRequired');
  let negative = String(body.negative ?? '').trim();

  const denoise = parseFloat(body.denoise);
  if (!Number.isFinite(denoise) || denoise < 0.05 || denoise > 0.95) {
    return badRequest(res, 'errors.denoiseRange');
  }

  // Anclaje de identidad para el rostro regenerado:
  //   'none'       → como antes, sin anclaje (libertad total, pero puede divergir).
  //   'prompt'     → antepone identity/face/hair del personaje al ad-prompt.
  //   'photomaker' → misma técnica que el pase de identidad de variantes.
  //   'ipadapter'  → ídem, vía IP-Adapter.
  const identityMethod = body.identityMethod ?? body.identity_method ?? body.identityMode ?? body.identity_mode ?? 'none';
  if (!['none', 'prompt', 'photomaker', 'ipadapter'].includes(identityMethod)) {
    return badRequest(res, 'errors.methodUnknown', { method: identityMethod });
  }
  if (identityMethod === 'photomaker' && !(process.env.SD_PHOTOMAKER_PATH && FACE_DETECT_MODEL)) {
    return badRequest(res, 'errors.photomakerConfig');
  }
  if (identityMethod === 'ipadapter' && !(process.env.SD_IP_ADAPTER_PATH && process.env.SD_CLIP_VISION_PATH && FACE_DETECT_MODEL)) {
    return badRequest(res, 'errors.ipadapterConfig');
  }

  let strength = null;
  if (identityMethod === 'photomaker' || identityMethod === 'ipadapter') {
    strength = parseFloat(body.strength ?? body.identityStrength);
    if (Number.isNaN(strength)) return badRequest(res, 'errors.strengthInvalid');
    if (identityMethod === 'ipadapter' && !(strength > 0 && strength <= 1)) {
      return badRequest(res, 'errors.ipadapterRange');
    }
    if (identityMethod === 'photomaker' && !(strength > 0 && strength <= 100)) {
      return badRequest(res, 'errors.photomakerRange');
    }
  }

  // El método 'prompt' no necesita la base ni sharp: la identidad se antepone
  // solo al generar. En la fila se guarda lo escrito en el formulario — si se
  // guardara ya concatenado, al reabrir y volver a generar se antepondría dos veces.
  let adPrompt = prompt;
  let adNegative = negative;
  if (identityMethod === 'prompt') {
    ({ positive: adPrompt, negative: adNegative } = withIdentityPrompt(char, prompt, negative));
  }

  // photomaker/ipadapter necesitan una base con imagen generada, de donde sale
  // la referencia facial (igual que el pase de identidad de variantes).
  let identityBase = null;
  if (identityMethod === 'photomaker' || identityMethod === 'ipadapter') {
    identityBase = variantRow.base_id ? getBaseRow(variantRow.base_id) : null;
    if (!identityBase || !identityBase.image_path || !existsSync(join(PROJECT_ROOT, identityBase.image_path))) {
      return badRequest(res, 'errors.baseNoImage');
    }
  }

  let settings;
  try {
    // El body puede sobrescribir los ajustes; si no vienen, se heredan de la
    // variante origen (modelo/steps/cfg/sampler/schedule).
    settings = resolveGenerationSettings(body, variantRow);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.i18nKey || e.message, params: e.i18nParams });
  }
  const modelPath = join(MODEL_DIR, settings.modelFile);
  if (!existsSync(modelPath)) return badRequest(res, 'errors.modelNotFound', { path: modelPath });

  const { stagesDir } = itemDirs(char.key);
  let scenePrompt;
  try {
    scenePrompt = buildPromptLayers(draftFromVariant({ character: char.key }, variantRow));
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.i18nKey || e.message, params: e.i18nParams });
  }

  // Fuente con fondo: raw (pase de identidad) > scene (pase principal) > final aplanada.
  let sourcePath = [
    join(stagesDir, `variant_${variantId}_raw.png`),
    join(stagesDir, `variant_${variantId}_scene.png`),
  ].find(p => existsSync(p)) ?? null;
  let sourceNote = null;
  if (!sourcePath && variantRow.image_path && existsSync(join(PROJECT_ROOT, variantRow.image_path))) {
    sourcePath = join(PROJECT_ROOT, variantRow.image_path);
    sourceNote = 'stages.sourceNote';
  }
  if (!sourcePath) return badRequest(res, 'errors.variantNoImage');

  // Igual que base/variante: seed explícito o uno nuevo aleatorio.
  const seed = resolveSeed(body);

  // El identificador es único por variante: regenerar con el mismo label
  // sobrescribe el inpaint existente (misma fila, misma imagen en disco) en
  // vez de crear otro. Así el nombre del descargable se mantiene estable.
  const existing = getInpaintByVariantLabel(variantId, label);
  if (existing) {
    const active = findActiveJob('inpaint', existing.id);
    if (active) {
      return res.status(409).json({ error: 'errors.generationInProgressInpaint', params: { id: active.id } });
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
    identityMethod,
    strength,
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
    identityMethod, strength, identityBase, scenePrompt, sourcePath, modelPath, body,
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
  if (!job) return res.status(404).json({ error: 'errors.jobNotFound' });
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
  if (!job) return res.status(404).json({ error: 'errors.jobNotFound' });

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
