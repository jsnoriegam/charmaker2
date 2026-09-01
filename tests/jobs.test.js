import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers.js';

useTempDb();
const jobs = await import('../server/jobs.js');

test('nextJobId es secuencial', () => {
  const a = jobs.nextJobId();
  const b = jobs.nextJobId();
  assert.equal(b, a + 1);
});

test('la cola corrida FIFO de a una tarea', async () => {
  const order = [];
  let release;
  const gate = new Promise(r => { release = r; });
  jobs.enqueueJob(async () => { order.push('a'); await gate; });
  jobs.enqueueJob(async () => { order.push('b'); });
  jobs.enqueueJob(async () => { order.push('c'); });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(order, ['a'], 'b y c esperan a que termine a');
  release();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('cancelJob sobre job inexistente', () => {
  assert.deepEqual(jobs.cancelJob(999999), { ok: false, error: 'Job not found' });
});

test('cancelJob en pending marca cancelled y emite', () => {
  const id = jobs.nextJobId();
  const job = { id, status: 'pending', cancelled: false, currentProc: null, createdAt: new Date().toISOString() };
  jobs.jobs.set(id, job);
  let sawEvent = null;
  const onUp = (j) => { sawEvent = j; };
  jobs.jobEvents.on(`job:${id}`, onUp);
  const r = jobs.cancelJob(id);
  jobs.jobEvents.off(`job:${id}`, onUp);
  assert.equal(r.ok, true);
  assert.equal(job.cancelled, true);
  assert.equal(job.status, 'cancelled');
  assert.equal(sawEvent, job);
});

test('cancelJob en job terminado falla', () => {
  const id = jobs.nextJobId();
  jobs.jobs.set(id, { id, status: 'done', cancelled: false, createdAt: new Date().toISOString() });
  assert.deepEqual(jobs.cancelJob(id), { ok: false, error: 'Job already done' });
});

test('findActiveJob solo encuentra pending/running por kind+refId', () => {
  const active = { id: jobs.nextJobId(), kind: 'base', refId: 1, status: 'running' };
  const done = { id: jobs.nextJobId(), kind: 'base', refId: 2, status: 'done' };
  jobs.jobs.set(active.id, active);
  jobs.jobs.set(done.id, done);
  assert.equal(jobs.findActiveJob('base', 1), active);
  assert.equal(jobs.findActiveJob('base', 2), null);
  assert.equal(jobs.findActiveJob('variant', 1), null);
});

test('getQueue devuelve los ids en orden y los saca al ejecutarse', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const a = jobs.nextJobId();
  const b = jobs.nextJobId();
  jobs.enqueueJob(async () => { await gate; }, a);
  jobs.enqueueJob(async () => {}, b);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(jobs.getQueue(), [b], 'a ya salió a ejecutar; b sigue en cola');
  release();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(jobs.getQueue(), []);
});
