# CharMaker2

Aplicación web para **generar personajes de visual novels** con stable-diffusion.cpp
(`sd-cli`). A diferencia de charmaker 1, no es un formulario de generación: es un
gestor de personajes donde cada personaje se arma, se le genera una **base**
(referencia facial) y de ahí salen sus **variantes** (expresión + ropa + accesorios
+ encuadre). Todo el material de trabajo vive en **SQLite** y se edita desde la UI.

## Conceptos

- **Personaje**: identidad fija (identity, face, hair, body, lighting) +
  `negative_identity` reservado **solo para rasgos**. La ropa nunca toca la
  identidad: así no aparecen contradicciones del estilo "shirtless en el negativo
  de identity y shirtless en el prompt".
- **Base**: retrato de referencia (800x800 → crop 512 + rembg). Guarda su propia
  ropa, seed, modelo, sampler, etc. — la base *es* el preset.
- **Variante**: expresión + ropa + accesorios + framing + método de consistencia
  facial (PhotoMaker/IP-Adapter tomando la cara de una base). También guarda su
  propia configuración de generación; `Regenerar` retoca y vuelve a generar,
  `Clonar` duplica para experimentar sin tocar el original.
- **Framings / Accesorios / Prompts globales**: CRUDs propios en el menú.
- **Preview en vivo**: cada modal muestra el positivo/negativo final que se va a
  mandar a sd-cli, con un aviso de **conflictos** (términos que aparecen en ambos
  lados).

## Requisitos

- Node.js 22+ (usa `node:sqlite` nativo) y **bun** (u npm). `sharp` trae libvips
  como binario prebuilt, no requiere compilar nada
- **sd-cli** compilado (stable-diffusion.cpp) y checkpoints SDXL
- Frontend: **Alpine.js** (incluido en `public/vendor/`, sin build step)
- (Opcional) Python 3 para el `.venv` de rembg: `bash scripts/setup-rembg.sh`
  (el binario se resuelve: `REMBG_BIN` → `.venv/bin/rembg` → PATH)

## Uso

```bash
cd charmaker2
bun install
cp .env.example .env   # ajustar rutas de sd-cli/modelos
bun run dev            # http://localhost:3002
```

Al arrancar con la DB vacía, siembra automáticamente desde `character_data.js`
(el set **genérico de ejemplo**): personajes de muestra, 1 base por personaje
(ropa del outfit `base`) y 1 variante por outfit (sin imagen — se generan on
demand). Después de eso la DB es la única fuente de verdad; `bun run seed`
re-emplaza todo con `--force`.

Si tenés tus propios personajes y no querés publicarlos, ponelos en
`character_data.local.js` (ignorado por git): si existe, tiene prioridad sobre
`character_data.js` tanto en el arranque como en `bun run seed`. Ver
`loadCharacterData()` en `seed.js`.

## Arquitectura

```
charmaker2/
├── server.js           # Express: API + cola FIFO + runner sd-cli
├── db.js               # node:sqlite: characters/bases/variants/framings/accessories/globals
├── seed.js             # conversor character_data.js → modelo nuevo (CLI o automático)
├── character_data.js   # set genérico del seed, nunca en runtime
├── character_data.local.js  # personajes personales (ignorado por git, opcional)
├── public/             # SPA Alpine (index.html + app.js + vendor/alpine.min.js)
├── scripts/setup-rembg.sh
├── data/charmaker2.db  # se crea solo
└── generated/<char>/{bases,variants,_stages,_history}/
```

### Armado del prompt (capas)

```
positivo = GLOBAL + identity, face, hair, body, lighting, [expression], clothing,
           accessories.pos, framing.pos
negativo = GLOBAL_NEG + negative_identity + negative_extra(item) +
           framing.neg + accessories.neg
```

`negative_extra` es por base/variante: ahí va el contrario de la ropa elegida
(ej: variante "bikini" → `fully clothed, shirt on`).

### API

| Endpoint | Método | Descripción |
|---|---|---|
| `/api/characters[/:key]` | GET/POST/PUT/DELETE | CRUD personajes (borrar elimina también su carpeta de imágenes) |
| `/api/bases?character=` · `/api/variants?character=` | GET | listas del personaje |
| `/api/bases/:id/clone` · `/api/variants/:id/clone` | POST | duplica fila + imagen con id nuevo |
| `/api/bases/:id` · `/api/variants/:id` | PUT/DELETE | editar datos / borrar fila + archivo |
| `/api/suggestions?character=` | GET | valores ya usados (datalists del modal) |
| `/api/preview` | POST | positivo/negativo + conflictos para un *borrador* (el modal lo llama debounced) |
| `/api/framings[/:key]` · `/api/accessories[/:key]` | GET/POST/PUT/DELETE | CRUD colecciones |
| `/api/globals` | PUT | segmentos globales |
| `/api/prompt-data` | GET/PUT | export / import JSON completo |
| `/api/generate-base` | POST | `{character, baseId?, clothing, ...}` → job; al terminar la fila `bases` queda con seed e imagen |
| `/api/generate-variant` | POST | `{character, baseId, variantId?, expression, clothing, accessories, framingKey, method, strength, ...}` |
| `/api/generate/:id/stream` · `/cancel` · `/:id` | GET/POST | SSE, detener, estado |
| `/api/config` · `/api/models` | GET | entorno + checkpoints disponibles |

### Generación

- Cola FIFO exclusiva de GPU; progreso por SSE parseando stdout de sd-cli; TTL de
  jobs 10 min.
- Variante: 1er pase `img_gen` (escena/ropa/fondo) + 2do pase `-M adetailer` con
  PhotoMaker/IP-Adapter **solo sobre la cara** (requiere `SD_AD_FACE_MODEL`).
  `method: none` omite el segundo pase.
- La referencia de identidad es la imagen de la base elegida; si tiene fondo
  transparente (rembg) se aplanan sobre blanco antes de usarla.
- Al regenerar sobre una base/variante existente, la imagen anterior se mueve a
  `generated/<char>/_history/`.
- ADetailer de manos: fuera del scope por ahora.

## Variables de entorno

Igual que charmaker 1 (`SD_BINARY`, `SD_MODEL_DIR`, `SD_DEFAULT_MODEL`, VAE,
caché, `SD_AD_FACE_MODEL`, `SD_PHOTOMAKER_PATH`, `SD_IP_ADAPTER_PATH`,
`SD_CLIP_VISION_PATH`…). Nuevas: `REMBG_BIN`, `REMBG_MODEL` (default
`birefnet-general`), `SD_AD_FACE_STEPS` (steps del 2º pase; si se omite usa los
de la fila) y `SERVER_HOST`/`SERVER_PORT` (default `127.0.0.1:3002`; usar
`SERVER_HOST=0.0.0.0` para exponer en LAN). Ver `.env.example`.
