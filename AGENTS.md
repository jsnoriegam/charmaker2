# AGENTS.md

CharMaker2: SPA + servidor Express que genera personajes de visual novels vía `sd-cli` (stable-diffusion.cpp). Datos de prompts en SQLite; imágenes en `generated/`.

## Comandos

- `node server.js` (o `npm run dev`; `npm run watch` para `--watch`) — arranca en `:3002` (o `SERVER_PORT`), bind a `127.0.0.1` por defecto (`SERVER_HOST` para exponer en LAN). No hay build step ni bundler.
- `npm test` — corre `node --test tests/*.test.js`. Uno solo: `node --test tests/prompts.test.js`.
- `npm run lint` (ESLint flat) y `npm run format` (Prettier, opt-in). CI en `.github/workflows/ci.yml` corre lint + test con Bun/Node 22.
- `npm run seed` — `node seed.js --force`: **reemplaza toda la DB** desde `character_data.js`.
- Usar Node 22+ (`node:sqlite` nativo).

## Gotchas

- `db.js` resuelve `data/charmaker2.db` desde `process.cwd()` **al importarse**. Los tests cambian de cwd con `useTempDb()` (tests/helpers.js) ANTES de importar módulos; replicar ese patrón en cualquier test nuevo o se corrompe la DB real.
- `character_data.js` (genérico, versionado) es solo dato para el seed; nunca usarlo en runtime. Si existe `character_data.local.js` (ignorado por git, datos personales) tiene prioridad — ver `loadCharacterData()` en `seed.js`. Tras el primer arranque la DB es la única fuente de verdad (el arranque auto-siembra solo si `characters` está vacía).
- `data/`, `generated/`, `.venv/`, `.env` están en `.gitignore` — no commitearlos.
- Import JSON y `npm run seed` llaman a `cleanupOrphanImages`: **borran** `generated/<key>/` y refs `_photomaker_ref`/`_ipadapter_ref` de personajes que ya no están en la DB.
- Los tests de `sdcli.test.js` / `jobs.test.js` no ejecutan `sd-cli` real; no se necesita GPU ni `.env` para `npm test`.
- La cola de generación es FIFO exclusiva (una job a la vez); el progreso va por SSE parseando stdout de `sd-cli`.
- Variante con consistencia facial = 2 pases (`img_gen` + adetailer/PhotoMaker); requiere `SD_AD_FACE_MODEL` configurada. `method: none` omite el segundo pase.
- rembg es un venv de Python opcional: `bash scripts/setup-rembg.sh`. Resolución del binario: `REMBG_BIN` → `.venv/bin/rembg` → PATH.

## Estructura

- `server.js` — entrypoint Express; monta routers de `server/routes/`.
- `server/` — `config.js` (todas las vars de entorno se leen ahí vía dotenv), `prompts.js` (armado de capas positivo/negativo), `sdcli.js` (construcción de argv para sd-cli), `jobs.js` (cola), `pipeline/{base,variant,inpaint}.js`, `rembg.js`.
- `public/app.js` + `index.html` — SPA Alpine.js (vendor en `public/vendor/`); el modal llama a `/api/preview` debounced para mostrar positivo/negativo y conflictos.
- El negocio del prompt vive en `server/prompts.js`; duplicar lógica de capas en otro lado rompe la preview.

## Estilo

- Comentarios, nombres de dominio y docs en **español**; mantener consistencia con el código existente.
- ESM puro (`"type": "module"`), sin TypeScript.
