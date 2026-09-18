import { readFileSync, statSync } from 'node:fs';
import { crc32 } from 'node:zlib';

// Escritor ZIP mínimo, método "store" (sin compresión). Los PNG ya vienen
// comprimidos (medido: deflate ahorraba ~1%), así que evitar una dependencia
// sale gratis. Streaming: escribe entrada por entrada respetando backpressure.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const VERSION = 20; // 2.0
const FLAG_UTF8 = 0x0800;

function dosDateTime(input) {
  const d = input instanceof Date ? input : new Date(input);
  const year = Math.max(d.getFullYear(), 1980);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// entries: [{ name, path, mtime? }]. Escribe el zip completo en `out` y lo cierra.
export async function streamZip(out, entries) {
  if (entries.length > 0xffff) {
    throw new Error('Demasiadas entradas para un ZIP sin ZIP64.');
  }

  const write = (buf) => new Promise((resolve, reject) => {
    out.write(buf, (err) => (err ? reject(err) : resolve()));
  });

  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const data = readFileSync(entry.path);
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data) >>> 0;
    const { time, date } = dosDateTime(entry.mtime ?? statSync(entry.path).mtime);

    if (offset + 30 + nameBuf.length + data.length > 0xffffffff) {
      throw new Error('El ZIP supera 4 GB; se necesita ZIP64.');
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(0, 8); // método: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra

    await write(local);
    await write(nameBuf);
    await write(data);

    central.push({ nameBuf, crc, size: data.length, offset, time, date });
    offset += local.length + nameBuf.length + data.length;
  }

  const centralOffset = offset;
  for (const c of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(SIG_CENTRAL, 0);
    header.writeUInt16LE(VERSION, 4); // version made by
    header.writeUInt16LE(VERSION, 6); // version needed
    header.writeUInt16LE(FLAG_UTF8, 8);
    header.writeUInt16LE(0, 10); // método
    header.writeUInt16LE(c.time, 12);
    header.writeUInt16LE(c.date, 14);
    header.writeUInt32LE(c.crc, 16);
    header.writeUInt32LE(c.size, 20);
    header.writeUInt32LE(c.size, 24);
    header.writeUInt16LE(c.nameBuf.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comentario
    header.writeUInt16LE(0, 34); // disco
    header.writeUInt16LE(0, 36); // atributos internos
    header.writeUInt32LE(0, 38); // atributos externos
    header.writeUInt32LE(c.offset, 42);

    await write(header);
    await write(c.nameBuf);
    offset += header.length + c.nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - centralOffset, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  await write(eocd);

  out.end();
}
