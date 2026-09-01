import { Router } from 'express';
import { existsSync, readdirSync } from 'fs';
import {
  SD_BINARY, MODEL_DIR, LORA_MODEL_DIR, OUTPUT_DIR, DEFAULT_MODEL_FILE,
  DEFAULT_STEPS, DEFAULT_CFG, DEFAULT_SAMPLER, DEFAULT_SCHEDULE,
  DEFAULT_INPAINT_DENOISE, INPAINT_REGIONS, FACE_DETECT_MODEL,
} from '../config.js';
import { rembgBin, REMBG_MODEL } from '../rembg.js';
import { getSamplerOptions, getScheduleOptions } from '../sdcli.js';

const router = Router();

router.get('/config', (req, res) => {
  res.json({
    sdBinary: SD_BINARY,
    sdBinaryExists: existsSync(SD_BINARY),
    modelDir: MODEL_DIR,
    loraModelDir: LORA_MODEL_DIR,
    outputDir: OUTPUT_DIR,
    defaultModel: DEFAULT_MODEL_FILE,
    rembg: { available: !!rembgBin(), model: REMBG_MODEL },
    samplers: getSamplerOptions(),
    schedules: getScheduleOptions(),
    inpaint: {
      defaultDenoise: DEFAULT_INPAINT_DENOISE,
      regions: Object.entries(INPAINT_REGIONS).map(([key, spec]) => ({
        key,
        label: spec.label,
        available: !!process.env[spec.modelKey],
      })),
    },
    identityMethods: {
      photomaker: !!process.env.SD_PHOTOMAKER_PATH && !!FACE_DETECT_MODEL,
      ipadapter: !!process.env.SD_IP_ADAPTER_PATH && !!process.env.SD_CLIP_VISION_PATH && !!FACE_DETECT_MODEL,
    },
    defaults: { steps: DEFAULT_STEPS, cfg: DEFAULT_CFG, sampler: DEFAULT_SAMPLER, schedule: DEFAULT_SCHEDULE },
  });
});

router.get('/models', (req, res) => {
  if (!existsSync(MODEL_DIR)) return res.json([]);
  const files = readdirSync(MODEL_DIR);
  res.json(files.filter(f => f.endsWith('.safetensors') || f.endsWith('.gguf')));
});

export default router;
