# CharMaker2

**English** · [Español](README.es.md)

Web application to **generate visual novel characters** with stable-diffusion.cpp
(`sd-cli`). It is not a generation form: it is a **character manager** where each
character is built up, a **base** (facial reference) is generated, and its
**variants** (expression + clothing + accessories + framing) branch off from it.
**Inpaints** of regions (e.g. the face) can be run on a variant to fix or change
the expression. All working data lives in **SQLite** and is edited from the UI.

## Concepts

- **Character**: fixed identity (`identity`, `face`, `hair`, `body`, `lighting`) +
  `negative_identity` reserved **for traits only**. Clothing never touches identity,
  so there are no contradictions like "shirtless in the identity negative and
  shirtless in the prompt".
- **Base**: reference portrait (800×800 → 512 crop + rembg). It stores its own
  clothing, seed, model, sampler, etc. — the base _is_ the preset.
- **Variant**: expression + clothing + accessories + framing + facial-consistency
  method (PhotoMaker/IP-Adapter using the face from a base). It also stores its own
  generation settings; `Regenerate` retouches and generates again, `Clone` duplicates
  it so you can experiment without touching the original.
- **Inpaint**: region correction on a variant with `-M adetailer` (its own denoise
  and prompt). Identity is anchored with `none`, `prompt`, PhotoMaker or IP-Adapter.
  Every inpaint is a new row with its own image.
- **Framings / Accessories / Global prompts**: their own CRUD screens in the sidebar.
- **Live preview**: every modal shows the final positive/negative prompt that will be
  sent to sd-cli, with a **conflicts** warning (terms that appear on both sides).

## Requirements

- Node.js 22+ (uses native `node:sqlite`). Installable with npm or bun. `sharp`
  ships libvips as a prebuilt binary, so nothing needs to be compiled.
- Compiled **sd-cli** (stable-diffusion.cpp) and SDXL checkpoints.
- Frontend: **Alpine.js** (bundled in `public/vendor/`, no build step).
- (Optional) Python 3 for the rembg `.venv`: `bash scripts/setup-rembg.sh`
  (the binary is resolved as: `REMBG_BIN` → `.venv/bin/rembg` → PATH).

## Usage

```bash
cd charmaker2
bun install            # or: npm install
cp .env.example .env   # set your sd-cli/model paths
bun run dev            # http://127.0.0.1:3002
```

The server listens on `127.0.0.1:3002` by default (not exposed to the LAN). To
reach it from another machine use `SERVER_HOST=0.0.0.0`, keeping in mind there is
no authentication.

On startup with an empty DB it auto-seeds from `character_data.js` (the **generic
sample set**): sample characters, 1 base per character (clothing from the `base`
outfit) and 1 variant per outfit (no image — generated on demand). After that the
DB is the only source of truth; `bun run seed` replaces everything with `--force`.

If you have your own characters and don't want to publish them, put them in
`character_data.local.js` (git-ignored): if it exists it takes priority over
`character_data.js` both on startup and in `bun run seed`. See
`loadCharacterData()` in `seed.js`.

From a character's view you can download a **bundle `.zip`** with every generated
image: `{name}_base.png`, `{name}_{variant}.png` and
`{name}_{variant}_{inpaint}.png`. If two files end up with the same name, the most
recent one wins.

## Architecture

```
charmaker2/
├── server.js                # Express entrypoint + auto-seed + graceful shutdown
├── db.js                    # node:sqlite: schema and data layer
├── seed.js                  # character_data(.local).js → DB (CLI or automatic)
├── character_data.js        # generic seed set, never used at runtime
├── character_data.local.js  # personal characters (git-ignored, optional)
├── server/
│   ├── config.js            # all environment variables (dotenv)
│   ├── jobs.js              # FIFO queue + SSE events + job TTL
│   ├── prompts.js           # positive/negative layer building + conflicts
│   ├── sdcli.js             # sd-cli argv building + runner
│   ├── rembg.js             # rembg resolution and execution
│   ├── util.js              # crud helper, dirs, history, orphan cleanup
│   ├── pipeline/            # base.js · variant.js · inpaint.js
│   └── routes/              # characters · items · gallery · prompt-data · generate · meta
├── public/                  # Alpine SPA (index.html + app.js + style.css + vendor/)
├── scripts/setup-rembg.sh
├── tests/                   # node --test
├── data/charmaker2.db       # created automatically (git-ignored)
└── generated/<char>/{bases,variants,inpaints,_stages,_history}/   # git-ignored
```

### Prompt building (layers)

```
positive = GLOBAL + identity, face, hair, body, lighting, [expression], clothing,
           accessories.pos, framing.pos
negative = GLOBAL_NEG + negative_identity + negative_extra(item) +
           framing.neg + accessories.neg
```

`negative_extra` is per base/variant: it holds the opposite of the chosen clothing
(e.g. a "bikini" variant → `fully clothed, shirt on`).

The inpaint reuses the variant's scene prompt as context (`-p`/`-n`) and sends the
region text as `--ad-prompt`; with the `prompt` anchor it prepends the character's
`identity, face, hair` to the region prompt.

### API

| Endpoint                                                                          | Method              | Description                                                                                                     |
| --------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/api/characters[/:key]`                                                          | GET/POST/PUT/DELETE | character CRUD (delete also removes its image folder)                                                           |
| `/api/characters/:key/bundle`                                                     | GET                 | `.zip` with every generated image (`{name}_base.png`, `{name}_{variant}.png`, `{name}_{variant}_{inpaint}.png`) |
| `/api/bases?character=` · `/api/variants?character=` · `/api/inpaints?character=` | GET                 | lists for a character                                                                                           |
| `/api/bases/:id/clone` · `/api/variants/:id/clone`                                | POST                | duplicate row + image with a new id                                                                             |
| `/api/bases/:id` · `/api/variants/:id`                                            | PUT/DELETE          | edit data / delete row + file + stages                                                                          |
| `/api/inpaints/:id`                                                               | PUT/DELETE          | edit config / delete inpaint + file + stages                                                                    |
| `/api/suggestions?character=`                                                     | GET                 | previously used values (modal datalists)                                                                        |
| `/api/preview`                                                                    | POST                | positive/negative + conflicts for a _draft_ (modal calls it debounced)                                          |
| `/api/framings[/:key]` · `/api/accessories[/:key]`                                | GET/POST/PUT/DELETE | collection CRUD                                                                                                 |
| `/api/globals`                                                                    | PUT                 | global prompt segments                                                                                          |
| `/api/prompt-data`                                                                | GET/PUT             | full JSON export / import (import cleans orphan images)                                                         |
| `/api/gallery`                                                                    | GET                 | metadata for every image (no prompts)                                                                           |
| `/api/gallery/:kind/:id`                                                          | GET                 | resolved prompt for one image (`base`\|`variant`\|`inpaint`)                                                    |
| `/api/generate-base`                                                              | POST                | `{character, baseId?, clothing, ...}` → job                                                                     |
| `/api/generate-variant`                                                           | POST                | `{character, baseId, variantId?, expression, clothing, accessories, framingKey, method, strength, ...}`         |
| `/api/inpaint-variant`                                                            | POST                | `{variantId, label, region, prompt, negative, denoise, identityMode, ...}` → job                                |
| `/api/jobs`                                                                       | GET                 | active/queued jobs (to rehydrate tracking after a refresh)                                                      |
| `/api/generate/:id/stream` · `/cancel` · `/:id`                                   | GET/POST            | SSE (includes `queuePosition`), cancel, status                                                                  |
| `/api/config` · `/api/models`                                                     | GET                 | environment + available checkpoints                                                                             |

### Generation

- **Exclusive FIFO GPU queue** (one job at a time); progress over SSE by parsing
  sd-cli stdout; finished jobs TTL is 10 min.
- `GET /api/jobs` lets the UI reattach tracking after a refresh. The same
  base/variant cannot be queued twice (409 if a job is already running).
- Variant: 1st `img_gen` pass (scene/clothing/background) + 2nd `-M adetailer` pass
  with PhotoMaker/IP-Adapter **on the face only** (requires `SD_AD_FACE_MODEL`).
  `method: none` skips the second pass. `SD_AD_FACE_STEPS` tunes the 2nd-pass steps.
- Inpaint: `-M adetailer` over the detected region, with its own `denoise`
  (0.05–0.95) and prompt; the source is the variant's background-free stage (or the
  final image).
- The identity reference is the chosen base image; if it has a transparent
  background (rembg) it is flattened onto white before use.
- When regenerating over an existing base/variant, the previous image is moved to
  `generated/<char>/_history/` (`SD_HISTORY_KEEP` kept, default 5).
- Hand ADetailer: out of scope for now.

## Development

```bash
npm test            # node --test tests/*.test.js
node --test tests/prompts.test.js   # a single file
npm run lint        # ESLint (flat config)
npm run format      # Prettier (opt-in)
npm run watch       # dev with node --watch
```

Tests use a temporary DB (by changing the `cwd` before importing `db.js`), so they
never touch `data/` or `generated/`. CI (`.github/workflows/ci.yml`) runs lint +
test with Bun and Node 22. The server shuts down gracefully on `SIGINT`/`SIGTERM`
(kills running `sd-cli` processes and closes SQLite).

## Environment variables

The usual SDXL/stable-diffusion.cpp settings (`SD_BINARY`, `SD_MODEL_DIR`,
`SD_DEFAULT_MODEL`, VAE, cache, `SD_AD_FACE_MODEL`, `SD_PHOTOMAKER_PATH`,
`SD_IP_ADAPTER_PATH`, `SD_CLIP_VISION_PATH`…). Additional ones: `REMBG_BIN`,
`REMBG_MODEL` (default `birefnet-general`), `SD_AD_FACE_STEPS` (2nd-pass steps;
defaults to the row's steps), `SD_HISTORY_KEEP` and `SERVER_HOST`/`SERVER_PORT`
(default `127.0.0.1:3002`; use `SERVER_HOST=0.0.0.0` to expose on the LAN). See
`.env.example`.

## Security

There is no authentication: anyone with access to the port can trigger GPU jobs,
import/delete data and read the images. That is why the default is localhost-only;
exposing it on the LAN is your responsibility.

## Relevant links

- [stable-diffusion.cpp (`sd-cli`)](https://github.com/leejet/stable-diffusion.cpp) —
  the inference engine CharMaker2 drives.
- [stable-diffusion.cpp releases](https://github.com/leejet/stable-diffusion.cpp/releases) —
  prebuilt binaries and build instructions.
- [PhotoMaker](https://github.com/TencentARC/PhotoMaker) and
  [IP-Adapter](https://github.com/tencent-ailab/IP-Adapter) — optional
  facial-consistency models (2nd pass).
- [rembg](https://github.com/danielgatis/rembg) — optional background removal.
- [Alpine.js](https://alpinejs.dev/) — frontend framework (vendored, no build step).
- [Express](https://expressjs.com/) and
  [`node:sqlite`](https://nodejs.org/api/sqlite.html) — backend stack.

## Support

If CharMaker2 is useful to you, you can support its development:

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-jsnoriegam-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/jsnoriegam)

Thanks!

## License

CharMaker2 is licensed under the
[Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License
(CC BY-NC-SA 4.0)](https://creativecommons.org/licenses/by-nc-sa/4.0/). See
[LICENSE](LICENSE) for the full legal code.

You may share and adapt the material for non-commercial purposes with
attribution, and derivatives must be distributed under the same license.
