import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { updateVariant } from '../../db.js';
import { OUTPUT_DIR, PROJECT_ROOT, WIDTH, HEIGHT, CPU_THREADS } from '../config.js';
import { moveToHistory, itemDirs } from '../util.js';
import { buildPromptLayers } from '../prompts.js';
import { emitJobUpdate } from '../jobs.js';
import { runSdCli, commonSdArgs, buildFacePassArgs } from '../sdcli.js';
import { removeBackground } from '../rembg.js';

// ctx: { job, char, row, base, settings, resolvedSeed, draft, body, modelPath,
//        method, usePhotoMaker, useIpAdapter, pmStyleStrength, resolvedWidth, resolvedHeight }
export async function runVariantGeneration(ctx) {
  const {
    job, char, row, base, settings, resolvedSeed, draft, body, modelPath,
    method, usePhotoMaker, useIpAdapter, pmStyleStrength,
  } = ctx;
  const resolvedWidth = ctx.resolvedWidth ?? WIDTH;
  const resolvedHeight = ctx.resolvedHeight ?? HEIGHT;
  const jobId = job.id;
  if (job.cancelled) { job.status = 'cancelled'; emitJobUpdate(jobId); return; }
  try {
    job.status = 'running';
    emitJobUpdate(jobId);

    const { charDir, variantsDir, stagesDir } = itemDirs(char.key);
    const { positive, negative } = buildPromptLayers(draft);

    const sceneOutputPath = join(stagesDir, `variant_${row.id}_scene.png`);
    const rawOutputPath = join(stagesDir, `variant_${row.id}_raw.png`);
    const finalOutputPath = join(variantsDir, `variant_${row.id}.png`);
    if (existsSync(finalOutputPath)) moveToHistory(finalOutputPath, join(charDir, '_history'));

    // Pase principal SIN identidad: el prompt controla escena/ropa/fondo.
    const sceneArgs = [
      '-M', 'img_gen',
      '-m', modelPath,
      '-p', positive,
      '-n', negative,
      '--cfg-scale', String(settings.cfg),
      '--steps', String(settings.steps),
      '--sampling-method', settings.sampler,
      '--scheduler', settings.schedule,
      '-W', String(resolvedWidth),
      '-H', String(resolvedHeight),
      '-s', String(resolvedSeed),
      '-t', String(CPU_THREADS),
      '-o', sceneOutputPath,
      ...commonSdArgs(),
    ];

    job.progress.totalSteps = settings.steps;
    job.progress.currentStep = 0;
    job.progress.percent = 0;
    job.progress.stage = 'Generación principal';
    emitJobUpdate(jobId);
    await runSdCli(sceneArgs, job);
    if (job.cancelled) { job.status = 'cancelled'; emitJobUpdate(jobId); return; }

    let currentPath = sceneOutputPath;
    let identityOutputPath = currentPath;

    if (usePhotoMaker || useIpAdapter) {
      const refPath = base.image_path ? join(PROJECT_ROOT, base.image_path) : null;
      if (!refPath || !existsSync(refPath)) {
        throw new Error('La base seleccionada todavía no tiene imagen generada. Generá la base primero.');
      }

      const { positive: facePositive, negative: faceNegative } = buildPromptLayers({ ...draft, method });

      let photoMakerModel, pmIdImagesDir;
      let ipAdapterModel, clipVisionModel, ipAdapterRefPath;

      if (usePhotoMaker) {
        photoMakerModel = process.env.SD_PHOTOMAKER_PATH;
        pmIdImagesDir = join(OUTPUT_DIR, '_photomaker_ref', `${char.key}_base${base.id}`);
        if (!existsSync(pmIdImagesDir)) mkdirSync(pmIdImagesDir, { recursive: true });
        // La base puede tener fondo transparente (rembg) — aplanar sobre blanco.
        await sharp(refPath).flatten({ background: '#ffffff' }).png()
          .toFile(join(pmIdImagesDir, 'ref.png'));
      }

      if (useIpAdapter) {
        ipAdapterModel = process.env.SD_IP_ADAPTER_PATH;
        clipVisionModel = process.env.SD_CLIP_VISION_PATH;
        const cropDir = join(OUTPUT_DIR, '_ipadapter_ref');
        if (!existsSync(cropDir)) mkdirSync(cropDir, { recursive: true });
        ipAdapterRefPath = join(cropDir, `${char.key}_base${base.id}.png`);
        const meta = await sharp(refPath).metadata();
        const cropHeight = Math.round(meta.height * 0.72);
        await sharp(refPath)
          .flatten({ background: '#ffffff' })
          .extract({ left: 0, top: 0, width: meta.width, height: cropHeight })
          .resize(512, 512, { fit: 'cover', position: 'top' })
          .png()
          .toFile(ipAdapterRefPath);
      }

      const faceArgs = buildFacePassArgs({
        modelPath,
        inputImagePath: currentPath,
        outputPath: rawOutputPath,
        positive: facePositive,
        negative: faceNegative,
        settings,
        usePhotoMaker, photoMakerModel, pmIdImagesDir, pmStyleStrength,
        useIpAdapter, ipAdapterModel, clipVisionModel, ipAdapterRefPath, ipAdapterStrength: pmStyleStrength,
      });

      job.progress.stage = 'Ajustando rostro (identidad)';
      job.progress.currentStep = 0;
      job.progress.percent = 0;
      emitJobUpdate(jobId);
      await runSdCli(faceArgs, job);
      identityOutputPath = rawOutputPath;
    }
    if (job.cancelled) { job.status = 'cancelled'; emitJobUpdate(jobId); return; }

    const wantRembg = body.rembg !== false;
    let removed = false;
    if (wantRembg) {
      removed = await removeBackground(identityOutputPath, finalOutputPath);
    }
    if (!removed) copyFileSync(identityOutputPath, finalOutputPath);

    updateVariant(row.id, { seed: resolvedSeed, imagePath: `/generated/${char.key}/variants/variant_${row.id}.png` });

    job.status = 'done';
    job.outputPath = `/generated/${char.key}/variants/variant_${row.id}.png`;
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
