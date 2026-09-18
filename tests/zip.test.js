import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { streamZip } from '../server/zip.js';

function collector() {
  const chunks = [];
  const w = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  });
  w.buffer = () => Buffer.concat(chunks);
  return w;
}

function readStoreZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'falta firma EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x04034b50, 'falta firma de header local');
    const crc = buf.readUInt32LE(p + 14);
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const dataStart = p + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + size);
    entries.push({ name, data, crc });
    p = dataStart + size;
  }
  return entries;
}

test('streamZip genera un zip store válido con nombres UTF-8', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm2-zip-'));
  try {
    const a = join(dir, 'a.bin');
    const b = join(dir, 'b.bin');
    writeFileSync(a, Buffer.from('hola mundo'));
    writeFileSync(b, Buffer.from('segundo archivo'));

    const out = collector();
    await streamZip(out, [
      { name: 'ana_variante.png', path: a },
      { name: 'ana_café.png', path: b },
    ]);
    await once(out, 'finish');

    const entries = readStoreZip(out.buffer());
    assert.deepEqual(entries.map(e => e.name), ['ana_variante.png', 'ana_café.png']);
    assert.equal(entries[0].data.toString(), 'hola mundo');
    assert.equal(entries[1].data.toString(), 'segundo archivo');
    assert.equal(entries[0].crc, crc32(entries[0].data) >>> 0);
    assert.equal(entries[1].crc, crc32(entries[1].data) >>> 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
