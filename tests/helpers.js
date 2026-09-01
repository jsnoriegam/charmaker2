import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// db.js resuelve su DATA_DIR desde process.cwd() al cargarse: cambiamos al
// directorio temporal ANTES de importarlo para nunca tocar la DB real.
export function useTempDb() {
  process.chdir(mkdtempSync(join(tmpdir(), 'charmaker2-test-')));
}
