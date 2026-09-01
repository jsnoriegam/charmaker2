import { spawn } from 'child_process';
import { existsSync } from 'fs';
import {
  SD_BINARY, LORA_MODEL_DIR, GENERATION_TIMEOUT_MS,
  VAE_ON_CPU, VAE_PATH, FORCE_SDXL_VAE_CONV_SCALE, DIFFUSION_FA,
  OFFLOAD_TO_CPU, VAE_TILING, CACHE_MODE, CACHE_OPTION, CPU_THREADS,
  FACE_DETECT_MODEL, FACE_PASS_EXTRA_ARGS, FACE_PASS_PROMPT, FACE_PASS_NEGATIVE_PROMPT, FACE_PASS_STEPS,
  DEFAULT_STEPS, DEFAULT_CFG, DEFAULT_SAMPLER, DEFAULT_SCHEDULE, DEFAULT_MODEL_FILE, INPAINT_REGIONS,
} from './config.js';
import { httpError } from './util.js';
import { emitJobUpdate } from './jobs.js';
import { normSeed, variantSeed } from '../db.js';

const SAMPLER_MAP = {
  // alias históricos (formato ComfyUI) usados en filas / seed viejos
  dpmpp_2m_sde: 'dpm++2m_sde',
  dpmpp_2m: 'dpm++2m',
  euler_a: 'euler_a',
  euler: 'euler',
  heun: 'heun',
};

// Listas de referencia por si no se puede leer sd-cli --help (se sobreescriben
// al arrancar con las opciones reales del binario vía initSamplerOptions).
const FALLBACK_SAMPLERS = [
  'euler', 'euler_a', 'heun', 'dpm2', 'dpm++2s_a', 'dpm++2m', 'dpm++2mv2',
  'ipndm', 'ipndm_v', 'lcm', 'ddim_trailing', 'tcd', 'res_multistep', 'res_2s',
  'er_sde', 'euler_cfg_pp', 'euler_a_cfg_pp', 'euler_ge', 'dpm++2m_sde',
  'dpm++2m_sde_bt', 'lms',
];
const FALLBACK_SCHEDULES = [
  'discrete', 'karras', 'exponential', 'ays', 'gits', 'sgm_uniform', 'simple',
  'smoothstep', 'kl_optimal', 'lcm', 'bong_tangent', 'logit_normal', 'flux',
  'flux2', 'ltx2', 'beta',
];

let SAMPLER_OPTIONS = FALLBACK_SAMPLERS;
let SCHEDULE_OPTIONS = ['normal', ...FALLBACK_SCHEDULES];
let SD_CPP_SAMPLERS = new Set(FALLBACK_SAMPLERS);

export function getSamplerOptions() {
  return SAMPLER_OPTIONS;
}

export function getScheduleOptions() {
  return SCHEDULE_OPTIONS;
}

// Extrae la lista "one of [a, b, c]" de una opción de sd-cli --help.
export function parseHelpChoices(flatHelp, flag) {
  const m = new RegExp(`(?:^|\\s)--${flag}(?=\\s)`).exec(flatHelp);
  if (!m) return null;
  const from = m.index + m[0].length;
  const rest = flatHelp.slice(from);
  const nextFlag = rest.search(/\s--\w/);
  const desc = nextFlag === -1 ? rest : rest.slice(0, nextFlag);
  const list = desc.match(/one of \[([^\]]+)\]/);
  if (!list) return null;
  return list[1].split(',').map(s => s.trim()).filter(Boolean);
}

export function sdCliHelp() {
  return new Promise((resolve) => {
    try {
      const proc = spawn(SD_BINARY, ['--help'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      proc.stdout.on('data', (c) => { out += c; });
      proc.on('error', () => resolve(null));
      proc.on('close', () => resolve(out || null));
    } catch {
      resolve(null);
    }
  });
}

export async function initSamplerOptions() {
  const help = await sdCliHelp();
  if (!help) {
    console.warn('No se pudo leer sd-cli --help — se usan las listas fijas de samplers/schedulers.');
    return;
  }
  const flat = help.replace(/\s+/g, ' ');
  const samplers = parseHelpChoices(flat, 'sampling-method');
  const schedules = parseHelpChoices(flat, 'scheduler');
  if (samplers?.length) {
    SAMPLER_OPTIONS = samplers;
    SD_CPP_SAMPLERS = new Set(samplers);
  }
  if (schedules?.length) {
    SCHEDULE_OPTIONS = schedules.includes('discrete')
      ? ['normal', ...schedules.filter(s => s !== 'normal')]
      : schedules;
  }
  console.log(`Samplers (${SAMPLER_OPTIONS.length}) y schedulers (${SCHEDULE_OPTIONS.length}) leídos de sd-cli.`);
}

export function resolveSampler(rawSampler) {
  if (rawSampler in SAMPLER_MAP) return SAMPLER_MAP[rawSampler];
  if (SD_CPP_SAMPLERS.has(rawSampler)) return rawSampler;
  throw new Error(`Sampler desconocido "${rawSampler}".`);
}

export function resolveGenerationSettings(body, row) {
  let mappedSampler;
  try {
    mappedSampler = resolveSampler(body.sampler || row?.sampler || DEFAULT_SAMPLER);
  } catch (e) {
    throw httpError(400, e.message);
  }
  const modelFile = body.model || row?.model || DEFAULT_MODEL_FILE;
  const schedule = body.schedule || row?.schedule || DEFAULT_SCHEDULE;
  if (!SCHEDULE_OPTIONS.includes(schedule)) {
    throw httpError(400, `Scheduler desconocido "${schedule}".`);
  }
  // shape de fila DB (createBase/createVariant/updateBase/updateVariant)
  return {
    model: modelFile,
    sampler: mappedSampler,
    schedule,
    cfg: body.cfg ? parseFloat(body.cfg) : (row?.cfg ?? DEFAULT_CFG),
    steps: body.steps ? parseInt(body.steps, 10) : (row?.steps ?? DEFAULT_STEPS),
    modelFile,
  };
}

export function resolveSeed(body) {
  return body.seed !== null && body.seed !== undefined && body.seed !== ''
    ? parseInt(body.seed, 10)
    : Math.floor(Math.random() * 2147483647);
}

// Seed determinístico para variantes "auto": depende del personaje y la ropa,
// no de la expresión — así todas las expresiones de un mismo outfit comparten
// seed y solo cambia el prompt de expresión.
export function resolveVariantSeed(body, charKey, clothing) {
  const explicit = normSeed(body.seed);
  return explicit ?? variantSeed(charKey, clothing);
}

export function commonSdArgs() {
  const args = [];
  if (VAE_ON_CPU) args.push('--vae-on-cpu');
  if (VAE_PATH) args.push('--vae', VAE_PATH);
  if (FORCE_SDXL_VAE_CONV_SCALE) args.push('--force-sdxl-vae-conv-scale');
  if (DIFFUSION_FA) args.push('--diffusion-fa');
  if (OFFLOAD_TO_CPU) args.push('--offload-to-cpu');
  if (VAE_TILING) args.push('--vae-tiling');
  if (LORA_MODEL_DIR) args.push('--lora-model-dir', LORA_MODEL_DIR);
  if (CACHE_MODE) {
    args.push('--cache-mode', CACHE_MODE);
    if (CACHE_OPTION) args.push('--cache-option', CACHE_OPTION);
  }
  return args;
}

export function buildFacePassArgs({ modelPath, inputImagePath, outputPath, positive, negative, settings,
  usePhotoMaker, photoMakerModel, pmIdImagesDir, pmStyleStrength,
  useIpAdapter, ipAdapterModel, clipVisionModel, ipAdapterRefPath, ipAdapterStrength }) {
  if (!FACE_DETECT_MODEL) {
    throw new Error('SD_AD_FACE_MODEL no está configurado en .env — requerido para PhotoMaker/IP-Adapter.');
  }

  const args = [
    '-M', 'adetailer',
    '-m', modelPath,
    '-i', inputImagePath,
    '-p', positive,
    '-n', negative,
    '--ad-model', FACE_DETECT_MODEL,
    '--extra-ad-args', FACE_PASS_EXTRA_ARGS,
    '--cfg-scale', String(settings.cfg),
    '--steps', String(FACE_PASS_STEPS ?? settings.steps),
    '--sampling-method', settings.sampler,
    '--scheduler', settings.schedule,
    '-t', String(CPU_THREADS),
    '-o', outputPath,
    ...commonSdArgs(),
  ];

  if (FACE_PASS_PROMPT) args.push('--ad-prompt', FACE_PASS_PROMPT);
  if (FACE_PASS_NEGATIVE_PROMPT) args.push('--ad-negative-prompt', FACE_PASS_NEGATIVE_PROMPT);

  if (usePhotoMaker) {
    args.push('--photo-maker', photoMakerModel, '--pm-id-images-dir', pmIdImagesDir);
    if (pmStyleStrength) args.push('--pm-style-strength', String(pmStyleStrength));
  }

  if (useIpAdapter) {
    args.push('--clip_vision', clipVisionModel, '--ip-adapter', ipAdapterModel, '--ip-adapter-image', ipAdapterRefPath);
    args.push('--ip-adapter-strength', String(ipAdapterStrength || 0.5));
  }

  return args;
}

export function inpaintRegionModel(region) {
  const spec = INPAINT_REGIONS[region];
  if (!spec) return null;
  return process.env[spec.modelKey] || null;
}

// args: argv de sd-cli. job: objeto de jobs.js (status/progress/currentProc).
export function runSdCli(args, job, { timeoutMs = GENERATION_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (!existsSync(SD_BINARY)) {
      reject(new Error(`sd-cli not found at: ${SD_BINARY}`));
      return;
    }
    if (job.cancelled) {
      job.status = 'cancelled';
      emitJobUpdate(job.id);
      reject(new Error('CANCELLED'));
      return;
    }

    const proc = spawn(SD_BINARY, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    job.currentProc = proc;
    let stderrBuf = '';
    let generateImageCount = 0;

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      job.status = 'error';
      job.error = `Timeout (${timeoutMs}ms)`;
      emitJobUpdate(job.id);
      reject(new Error(job.error));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const genMatch = text.match(/generate_image (\d+)x(\d+)/);
      const adMatch = text.match(/ADetailer applied (\d+) mask/);
      let changed = false;

      if (genMatch) {
        generateImageCount++;
        const [, w, h] = genMatch;
        job.progress.stage = generateImageCount === 1 ? 'Generación principal' : `Pase de cara — imagen #${generateImageCount}`;
        job.progress.resolution = `${w}x${h}`;
        changed = true;
      }
      if (adMatch) {
        job.progress.adetailerMasks = parseInt(adMatch[1], 10);
        changed = true;
      }

      const match = text.match(/(\d+)\/(\d+)\s*-\s*[\d.]+\s*(?:it\/s|s\/it)/);
      if (match) {
        const current = parseInt(match[1], 10);
        const total = parseInt(match[2], 10);
        job.progress.currentStep = current;
        job.progress.totalSteps = total;
        job.progress.percent = Math.round((current / total) * 100);
        changed = true;
      }

      if (changed) emitJobUpdate(job.id);
    });

    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      // Cota de memoria: sd-cli puede loguear mucho; solo usamos el final.
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      job.currentProc = null;
      job.status = 'error';
      job.error = err.message;
      emitJobUpdate(job.id);
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      job.currentProc = null;
      if (code !== 0) {
        if (job.cancelled) {
          job.status = 'cancelled';
          job.error = null;
          emitJobUpdate(job.id);
          reject(new Error('CANCELLED'));
          return;
        }
        const stderrExcerpt = stderrBuf.trim().slice(-800);
        job.status = 'error';
        job.error = stderrExcerpt
          ? `sd-cli exited with code ${code}: ${stderrExcerpt}`
          : `sd-cli exited with code ${code}`;
        emitJobUpdate(job.id);
        reject(new Error(job.error));
        return;
      }
      resolve();
    });
  });
}
