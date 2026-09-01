import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { updateInpaint } from '../../db.js';
import { OUTPUT_DIR, PROJECT_ROOT, CPU_THREADS } from '../config.js';
import { moveToHistory, itemDirs } from '../util.js';
import { emitJobUpdate } from '../jobs.js';
import { runSdCli, commonSdArgs } from '../sdcli.js';
import { removeBackground } from '../rembg.js';

// ctx: { job, char, row, settings, seed, adModel, adPrompt, adNegative, denoise,
//        identityMode, identityStrength, identityBase, scenePrompt, sourcePath, modelPath, body }
export async function runInpaintGeneration(ctx) {
  const {
    job, char, row, settings, seed, adModel, adPrompt, adNegative, denoise,
    identityMode, identityStrength, identityBase, scenePrompt, sourcePath, modelPath, body,
  } = ctx;
  const jobId = job.id;
  if (job.cancelled) { job.status = 'cancelled'; emitJobUpdate(jobId); return; }
  try {
    job.status = 'running';
    emitJobUpdate(jobId);

    const { charDir, stagesDir, inpaintsDir } = itemDirs(char.key);
    let inputPath = sourcePath;

    // Si la fuente tiene alpha (final con rembg), aplanar sobre blanco primero.
    const meta = await sharp(sourcePath).metadata();
    if (meta.hasAlpha) {
      inputPath = join(stagesDir, `inpaint_${row.id}_source.png`);
      await sharp(sourcePath).flatten({ background: '#ffffff' }).png().toFile(inputPath);
    }

    const stageOutputPath = join(stagesDir, `inpaint_${row.id}_raw.png`);
    const finalOutputPath = join(inpaintsDir, `inpaint_${row.id}.png`);
    if (existsSync(finalOutputPath)) moveToHistory(finalOutputPath, join(charDir, '_history'));

    const args = [
      '-M', 'adetailer',
      '-m', modelPath,
      '-i', inputPath,
      '-p', scenePrompt.positive,
      '-n', scenePrompt.negative,
      '--ad-model', adModel,
      '--ad-prompt', adPrompt,
      '--extra-ad-args', `denoising_strength=${denoise},inpaint_padding=48,mask_blur=4`,
      '--cfg-scale', String(settings.cfg),
      '--steps', String(settings.steps),
      '--sampling-method', settings.sampler,
      '--scheduler', settings.schedule,
      '-s', String(seed),
      '-t', String(CPU_THREADS),
      '-o', stageOutputPath,
      ...commonSdArgs(),
    ];
    if (adNegative) args.push('--ad-negative-prompt', adNegative);

    // Anclaje de identidad vía PhotoMaker/IP-Adapter: misma técnica que el
    // pase de identidad de variantes, apuntando a la imagen de la base.
    if (identityMode === 'photomaker' || identityMode === 'ipadapter') {
      const refPath = join(PROJECT_ROOT, identityBase.image_path);

      if (identityMode === 'photomaker') {
        const photoMakerModel = process.env.SD_PHOTOMAKER_PATH;
        const pmIdImagesDir = join(OUTPUT_DIR, '_photomaker_ref', `${char.key}_base${identityBase.id}`);
        if (!existsSync(pmIdImagesDir)) mkdirSync(pmIdImagesDir, { recursive: true });
        await sharp(refPath).flatten({ background: '#ffffff' }).png().toFile(join(pmIdImagesDir, 'ref.png'));
        args.push('--photo-maker', photoMakerModel, '--pm-id-images-dir', pmIdImagesDir);
        args.push('--pm-style-strength', String(identityStrength));
      }

      if (identityMode === 'ipadapter') {
        const ipAdapterModel = process.env.SD_IP_ADAPTER_PATH;
        const clipVisionModel = process.env.SD_CLIP_VISION_PATH;
        const cropDir = join(OUTPUT_DIR, '_ipadapter_ref');
        if (!existsSync(cropDir)) mkdirSync(cropDir, { recursive: true });
        const ipAdapterRefPath = join(cropDir, `${char.key}_base${identityBase.id}.png`);
        const refMeta = await sharp(refPath).metadata();
        const cropHeight = Math.round(refMeta.height * 0.72);
        await sharp(refPath)
          .flatten({ background: '#ffffff' })
          .extract({ left: 0, top: 0, width: refMeta.width, height: cropHeight })
          .resize(512, 512, { fit: 'cover', position: 'top' })
          .png()
          .toFile(ipAdapterRefPath);
        args.push('--clip_vision', clipVisionModel, '--ip-adapter', ipAdapterModel, '--ip-adapter-image', ipAdapterRefPath);
        args.push('--ip-adapter-strength', String(identityStrength));
      }
    }

    job.progress.stage = 'Inpintando rostro';
    emitJobUpdate(jobId);
    await runSdCli(args, job);
    if (job.cancelled) { job.status = 'cancelled'; emitJobUpdate(jobId); return; }

    const wantRembg = body.rembg !== false;
    let removed = false;
    if (wantRembg) removed = await removeBackground(stageOutputPath, finalOutputPath);
    if (!removed) copyFileSync(stageOutputPath, finalOutputPath);

    updateInpaint(row.id, { seed, imagePath: `/generated/${char.key}/inpaints/inpaint_${row.id}.png` });

    job.status = 'done';
    job.outputPath = `/generated/${char.key}/inpaints/inpaint_${row.id}.png`;
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
