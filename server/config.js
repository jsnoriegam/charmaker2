import { join } from 'path';
import { fileURLToPath } from 'url';

// __filename de este archivo es <root>/server/config.js — el raíz del proyecto es dos niveles más arriba.
const PROJECT_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
export { PROJECT_ROOT };

export const PORT = process.env.SERVER_PORT || 3002;
// Por defecto solo localhost: expone jobs de GPU y borrado de datos sin auth.
// Para acceso desde la LAN, fijar SERVER_HOST=0.0.0.0 (bajo tu responsabilidad).
export const HOST = process.env.SERVER_HOST || '127.0.0.1';

export const SD_BINARY = process.env.SD_BINARY || join(PROJECT_ROOT, 'stable-diffusion.cpp', 'build', 'bin', 'sd-cli');
export const MODEL_DIR = process.env.SD_MODEL_DIR || join(PROJECT_ROOT, 'models');
export const LORA_MODEL_DIR = process.env.SD_LORA_MODEL_DIR || process.env.SD_LORA_DIR || null;
export const OUTPUT_DIR = join(PROJECT_ROOT, 'generated');
export const DEFAULT_MODEL_FILE = process.env.SD_DEFAULT_MODEL || 'zavychromaxl_v100.safetensors';
export const HISTORY_KEEP = process.env.SD_HISTORY_KEEP ? parseInt(process.env.SD_HISTORY_KEEP, 10) : 5;
// Limpieza opcional de intermedios (_stages: raw/scene/source de cada item).
// Los inpaints los prefieren como fuente (evita aplanar el fondo removido), así
// que purgarlos degrada un poco eso a cambio de espacio. 0 = deshabilitado.
export const STAGES_TTL_HOURS = process.env.SD_STAGES_TTL_HOURS ? parseInt(process.env.SD_STAGES_TTL_HOURS, 10) : 0;

export const WIDTH = 832;
export const HEIGHT = 1216;
export const BASE_WIDTH = 800;
export const BASE_HEIGHT = 800;

export const ALLOWED_SIZES = new Set([
  '1024x1024',
  '832x1216', '896x1152', '768x1344', '640x1536',
  '1216x832', '1152x896', '1344x768', '1536x640',
]);

export const VAE_ON_CPU = process.env.SD_VAE_ON_CPU === '1';
export const VAE_PATH = process.env.SD_VAE_PATH || null;
export const FORCE_SDXL_VAE_CONV_SCALE = process.env.SD_FORCE_SDXL_VAE_CONV_SCALE === '1';
export const DIFFUSION_FA = process.env.SD_DIFFUSION_FA === '1';
export const OFFLOAD_TO_CPU = process.env.SD_OFFLOAD_TO_CPU === '1';
export const VAE_TILING = process.env.SD_VAE_TILING === '1';
export const CACHE_MODE = process.env.SD_CACHE_MODE || null;
export const CACHE_OPTION = process.env.SD_CACHE_OPTION || null;
export const CPU_THREADS = process.env.SD_THREADS || '-1';
export const GENERATION_TIMEOUT_MS = process.env.SD_TIMEOUT_MS ? parseInt(process.env.SD_TIMEOUT_MS, 10) : 300_000;

export const FACE_DETECT_MODEL = process.env.SD_AD_FACE_MODEL || null;
export const FACE_PASS_DEFAULT_EXTRA_ARGS = 'denoising_strength=0.6,inpaint_padding=32,mask_blur=4';
export const FACE_PASS_EXTRA_ARGS = process.env.SD_AD_FACE_EXTRA_ARGS || FACE_PASS_DEFAULT_EXTRA_ARGS;
export const FACE_PASS_PROMPT = process.env.SD_AD_FACE_PROMPT || null;
export const FACE_PASS_NEGATIVE_PROMPT = process.env.SD_AD_FACE_NEGATIVE_PROMPT || null;
// Steps del 2º pase (adetailer de cara). Si no se fija, usa los steps de la fila.
export const FACE_PASS_STEPS = process.env.SD_AD_FACE_STEPS ? parseInt(process.env.SD_AD_FACE_STEPS, 10) : null;

// Regiones disponibles para inpainting: label visible + modelo detector.
// Agregar regiones (ej. manos) = una entrada + su variable de modelo.
export const INPAINT_REGIONS = {
  face: { label: 'Cara', modelKey: 'SD_AD_FACE_MODEL' },
};
export const DEFAULT_INPAINT_DENOISE = 0.45;

export const DEFAULT_STEPS = 35;
export const DEFAULT_CFG = 5.5;
export const DEFAULT_SAMPLER = 'dpm++2m_sde';
export const DEFAULT_SCHEDULE = 'karras';
