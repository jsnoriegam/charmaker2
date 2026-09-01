import { EventEmitter } from 'events';

// Cola de jobs + SSE (GPU exclusiva, FIFO)

export const jobs = new Map();
let jobIdCounter = 0;

export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(50);

export function nextJobId() {
  return ++jobIdCounter;
}

export function emitJobUpdate(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  // Solo los jobs en espera tienen posición: los que corren ya salieron de la cola.
  job.queuePosition = job.status === 'pending' ? queuePosition(jobId) : null;
  jobEvents.emit(`job:${jobId}`, job);
}

// Job activo (pending/running) de un ítem concreto: evita encolar dos veces la
// misma base/variante.
export function findActiveJob(kind, refId) {
  for (const job of jobs.values()) {
    if (job.kind === kind && job.refId === refId
      && (job.status === 'pending' || job.status === 'running')) {
      return job;
    }
  }
  return null;
}

export function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return { ok: false, error: 'Job not found' };
  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
    return { ok: false, error: `Job already ${job.status}` };
  }
  job.cancelled = true;
  if (job.currentProc) {
    job.currentProc.kill('SIGKILL');
  } else if (job.status === 'pending') {
    job.status = 'cancelled';
    emitJobUpdate(jobId);
  }
  return { ok: true };
}

const generationQueue = [];
let queueRunning = false;

// jobId es opcional para no romper usos que solo encolan una tarea anónima.
export function enqueueJob(task, jobId = null) {
  generationQueue.push({ task, jobId });
  processQueue();
}

// Ids en orden de cola (sin contar el que está corriendo).
export function getQueue() {
  return generationQueue.map(e => e.jobId).filter(id => id != null);
}

function queuePosition(jobId) {
  const idx = generationQueue.findIndex(e => e.jobId === jobId);
  return idx === -1 ? null : idx + 1;
}

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  while (generationQueue.length > 0) {
    const entry = generationQueue.shift();
    // Al arrancar una tarea, las que siguen en cola cambian de posición.
    for (const pending of generationQueue) {
      if (pending.jobId != null) emitJobUpdate(pending.jobId);
    }
    try {
      await entry.task();
    } catch (err) {
      console.error('Error inesperado procesando la cola de generación:', err);
    }
  }
  queueRunning = false;
}

const JOB_TTL_MS = 10 * 60 * 1000;
const JOB_SWEEP_INTERVAL_MS = 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== 'done' && job.status !== 'error' && job.status !== 'cancelled') continue;
    const age = now - new Date(job.createdAt).getTime();
    if (age > JOB_TTL_MS) jobs.delete(id);
  }
}, JOB_SWEEP_INTERVAL_MS).unref();
