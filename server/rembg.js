import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from './config.js';

// rembg: REMBG_BIN -> .venv/bin/rembg -> PATH
const REMBG_CANDIDATES = [
  process.env.REMBG_BIN || null,
  join(PROJECT_ROOT, '.venv', 'bin', 'rembg'),
  'rembg',
].filter(Boolean);

export const REMBG_MODEL = process.env.REMBG_MODEL || 'birefnet-general';

let resolvedRembgBin = null;
let rembgHealthy = false;

function probeRembg(bin) {
  return new Promise((resolve) => {
    const proc = spawn(bin, ['i', '--help'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c; });
    proc.on('error', (err) => {
      rembgHealthy = false;
      console.warn(`No se pudo ejecutar rembg (${bin}): ${err.message}`);
      resolve();
    });
    proc.on('close', (code) => {
      rembgHealthy = code === 0;
      if (!rembgHealthy) {
        console.warn(`rembg encontrado en ${bin} pero no funciona (exit ${code}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
        console.warn('Reparalo con: .venv/bin/pip install "rembg[cpu,cli]" onnxruntime');
      }
      resolve();
    });
  });
}

export async function initRembg() {
  resolvedRembgBin = REMBG_CANDIDATES.find(c => c === 'rembg' || existsSync(c)) || null;
  if (!resolvedRembgBin) {
    console.warn('rembg no disponible (REMBG_BIN, .venv/bin/rembg ni PATH). Ejecutá scripts/setup-rembg.sh para activarlo.');
  }
  if (resolvedRembgBin) await probeRembg(resolvedRembgBin);
}

export function rembgBin() {
  return rembgHealthy ? resolvedRembgBin : null;
}

export async function removeBackground(inputPath, outputPath) {
  const bin = rembgBin();
  if (!bin) return false;
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(bin, ['i', '-m', REMBG_MODEL, inputPath, outputPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 8000) stderr = stderr.slice(-8000); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) return resolve();
        const detail = stderr.trim().split('\n').slice(-5).join(' | ');
        reject(new Error(`rembg exit ${code}${detail ? `: ${detail}` : ''}`));
      });
    });
    return true;
  } catch (err) {
    console.warn(`Fallo rembg (${err.message}) — se conserva la imagen con fondo.`);
    return false;
  }
}
