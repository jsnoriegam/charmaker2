import { existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { updateBase } from '../../db.js';
import { OUTPUT_DIR, BASE_WIDTH, BASE_HEIGHT, CPU_THREADS } from '../config.js';
import { moveToHistory, itemDirs } from '../util.js';
import { buildPromptLayers } from '../prompts.js';
import { emitJobUpdate } from '../jobs.js';
import { runSdCli, commonSdArgs } from '../sdcli.js';
import { removeBackground } from '../rembg.js';

// ctx: { job, char, row, settings, resolvedSeed, draft, body, modelPath }
export async function runBaseGeneration(ctx) {
  const { job, char, row, settings, resolvedSeed, draft, body, modelPath } = ctx;
  const jobId = job.id;
  if (job.cancelled) { job.status = 'cancelled'; emitJobUpdate(jobId); return; }
  try {
    job.status = 'running';
    emitJobUpdate(jobId);

    const { basesDir } = itemDirs(char.key);
    const { positive, negative } = buildPromptLayers(draft);

    const rawOutputPath = join(basesDir, `base_${row.id}_raw.png`);
    const croppedPath = join(basesDir, `base_${row.id}_crop.png`);
    const finalOutputPath = join(basesDir, `base_${row.id}.png`);
    if (existsSync(finalOutputPath)) moveToHistory(finalOutputPath, join(OUTPUT_DIR, char.key, '_history'));

    const args = [
      '-M', 'img_gen',
      '-m', modelPath,
      '-p', positive,
      '-n', negative,
      '--cfg-scale', String(settings.cfg),
      '--steps', String(settings.steps),
      '--sampling-method', settings.sampler,
      '--scheduler', settings.schedule,
      '-W', String(BASE_WIDTH),
      '-H', String(BASE_HEIGHT),
      '-s', String(resolvedSeed),
      '-t', String(CPU_THREADS),
      '-o', rawOutputPath,
      ...commonSdArgs(),
    ];

    await runSdCli(args, job);

    await sharp(rawOutputPath)
      .resize(512, 512, { fit: 'cover', position: 'top' })
      .png()
      .toFile(croppedPath);

    const wantRembg = body.rembg !== false;
    const removed = wantRembg ? await removeBackground(croppedPath, finalOutputPath) : false;
    if (!removed) copyFileSync(croppedPath, finalOutputPath);

    updateBase(row.id, { seed: resolvedSeed, imagePath: `/generated/${char.key}/bases/base_${row.id}.png` });

    job.status = 'done';
    job.outputPath = `/generated/${char.key}/bases/base_${row.id}.png`;
    job.progress.percent = 100;
    emitJobUpdate(jobId);
  } catch (err) {
    if (job.status !== 'cancelled') {
      job.status = 'error';
      job.error = err.message;
      emitJobUpdate(jobId);
    }
  }
}
