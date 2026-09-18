'use strict';

/* exported app */

// ---------------------------------------------------------------------------
// helpers fuera del componente (Alpine solo expone app())
// ---------------------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const LEGACY_SAMPLERS = { dpmpp_2m_sde: 'dpm++2m_sde', dpmpp_2m: 'dpm++2m' };

function rowSettings(row, config) {
  const sampler = row?.sampler ? (LEGACY_SAMPLERS[row.sampler] || row.sampler) : config.defaults.sampler;
  return {
    steps: row?.steps ?? config.defaults.steps,
    cfg: row?.cfg ?? config.defaults.cfg,
    sampler,
    schedule: row?.schedule ?? config.defaults.schedule,
    model: row?.model ?? config.defaultModel,
  };
}

// ---------------------------------------------------------------------------
// Componente raíz
// ---------------------------------------------------------------------------

function app() {
  return {
    view: 'characters',
    config: null,
    models: [],
    samplers: [],
    schedules: [],
    characters: [],
    charSearch: '',
    framings: [],
    accessories: [],
    globals: { positive: '', negative: '' },

    detail: null, // {key, char, bases, variants, suggestions}
    gallery: [],
    galleryLoading: false,
    galleryFilter: { character: '', kind: '', search: '' },
    gallerySort: 'recent',
    galleryModal: null, // {item, showOriginal}
    activeJobs: [], // jobs corriendo aunque el modal correspondiente esté cerrado
    finishedJobs: [], // historial reciente en la bandeja de trabajos

    charModal: null,
    baseModal: null,
    variantModal: null,
    inpaintModal: null,
    confirmModal: null,

    toastMsg: '',
    toastKind: '',
    lightbox: null,
    lightboxDims: '',
    _previewTimer: null,

    // ---------------- init ----------------

    async boot() {
      try {
        this.setupRoutes();
        await this.refreshGlobal();
        await this.resumeJobs();
        await this.applyHash();
      } catch (err) {
        this.toast(err.message, 'err');
      }
    },

    // Reengancha el seguimiento de jobs que ya estaban corriendo en el server
    // (p. ej. tras un refresh de la página).
    async resumeJobs() {
      try {
        const { jobs } = await api('/api/jobs');
        for (const job of jobs) {
          if (this.activeJobs.some(j => j.jobId === job.id)) continue;
          const entry = {
            jobId: job.id,
            kind: job.kind,
            character: job.character,
            refId: job.refId,
            variantId: job.kind === 'inpaint' ? job.refId : undefined,
            label: this.jobLabel(job),
            status: job.status,
            percent: job.progress?.percent ?? 0,
            currentStep: job.progress?.currentStep ?? 0,
            totalSteps: job.progress?.totalSteps,
            stage: job.progress?.stage || '',
            error: job.error || '',
            queuePosition: job.queuePosition ?? null,
          };
          this.activeJobs.push(entry);
          this.watchJob(job.id, entry);
        }
      } catch (err) {
        // Si falla, el seguimiento en vivo arranca igual al lanzar nuevos jobs.
      }
    },

    jobLabel(job) {
      const who = job.character || '';
      if (job.kind === 'base') return `Base ${job.refId} — ${who}`;
      if (job.kind === 'variant') return `Variante ${job.refId} — ${who}`;
      return `Inpaint ${job.refId} — ${who}`;
    },

    // ---------------- ruteo por hash (persiste la vista en un refresh) ----------------

    setupRoutes() {
      window.addEventListener('hashchange', () => this.applyHash());
    },

    routeFor(view, key = null) {
      if (view === 'character' && key) return `#/personaje/${encodeURIComponent(key)}`;
      if (view === 'framings') return '#/framings';
      if (view === 'accessories') return '#/accesorios';
      if (view === 'globals') return '#/globales';
      if (view === 'gallery') return '#/galeria';
      return '#/characters';
    },

    syncHash() {
      const target = this.routeFor(this.view, this.detail?.key);
      if (location.hash !== target) history.pushState(null, '', target);
    },

    go(view) {
      this.view = view;
      if (view !== 'character') this.detail = null;
      if (view !== 'characters') this.charSearch = '';
      if (view === 'gallery') this.ensureGallery();
      this.syncHash();
    },

    async applyHash() {
      const parts = (location.hash.replace(/^#\/?/, '') || 'characters').split('/');
      const seg = parts[0];
      if (seg === 'personaje' && parts[1]) {
        const key = decodeURIComponent(parts[1]);
        if (this.detail?.key !== key) await this.openCharacter(key);
        return;
      }
      const views = { framings: 'framings', accesorios: 'accessories', globales: 'globals', galeria: 'gallery' };
      const next = views[seg] ?? 'characters';
      if (this.view !== next || this.detail) {
        this.view = next;
        this.detail = null;
      }
      if (next === 'gallery') this.ensureGallery();
    },

    // ---------------- galería ----------------

    async ensureGallery(force = false) {
      if (!force && (this.gallery.length || this.galleryLoading)) return;
      this.galleryLoading = true;
      try {
        this.gallery = await api('/api/gallery');
      } catch (err) {
        this.toast(err.message, 'err');
      } finally {
        this.galleryLoading = false;
      }
    },

    galleryCharacters() {
      return [...new Set(this.gallery.map(g => g.character))].sort();
    },

    galleryFiltered() {
      const { character, kind, search } = this.galleryFilter;
      const q = (search || '').trim().toLowerCase();
      const list = this.gallery.filter(g => {
        if (character && g.character !== character) return false;
        if (kind && g.kind !== kind) return false;
        if (!q) return true;
        return [g.character, g.title, g.meta?.label, g.meta?.expression, g.meta?.clothing]
          .some(v => String(v || '').toLowerCase().includes(q));
      });
      const byDateAsc = (a, b) => String(a.created_at).localeCompare(String(b.created_at));
      if (this.gallerySort === 'old') return [...list].sort(byDateAsc);
      if (this.gallerySort === 'character') {
        return [...list].sort((a, b) => a.character.localeCompare(b.character) || byDateAsc(a, b));
      }
      return list; // 'recent': ya viene ordenada por el server
    },

    // El listado no trae prompts (se arman on-demand); al abrir se piden una vez
    // y se cachean sobre el propio item.
    async openGalleryItem(item) {
      this.galleryModal = { item, showOriginal: false, loading: !item.prompts };
      if (item.prompts) return;
      try {
        const detail = await api(`/api/gallery/${item.kind}/${item.id}`);
        Object.assign(item, detail || {});
      } catch (err) {
        this.toast(err.message, 'err');
      } finally {
        if (this.galleryModal?.item === item) this.galleryModal.loading = false;
      }
    },

    closeGalleryModal() {
      this.galleryModal = null;
    },

    // Nombre de descarga: siempre prefijo con el personaje; para inpaints además
    // el identificador de la variante origen: <personaje>_[origen_]identificador.ext
    galleryDownloadName(item) {
      const ext = item.image_path.match(/\.\w+$/)?.[0] ?? '.png';
      const clean = s => String(s).replace(/[\\/:*?"<>|\s]+/g, '_');
      const id = item.kind === 'inpaint'
        ? (item.meta.label || `inpaint_${item.id}`)
        : item.kind === 'variant'
          ? (item.meta.label || `variante_${item.id}`)
          : `base_${item.id}`;
      const origin = item.kind === 'inpaint'
        ? clean(item.meta.source_label || `variante_${item.meta.variant_id ?? '?'}`)
        : '';
      return [clean(item.character), origin, clean(id)].filter(Boolean).join('_') + ext;
    },

    // ←/→ en el modal de galería: pasar a la imagen original y volver.
    galleryCompareNav(dir) {
      const m = this.galleryModal;
      if (!m || !m.item.origin) return;
      if (dir > 0 && !m.showOriginal) m.showOriginal = true;
      else if (dir < 0 && m.showOriginal) m.showOriginal = false;
    },

    // Cualquier cambio que agregue/elimine imágenes deja la caché de galería
    // vieja: se vacía y, si la vista está abierta, se recarga.
    invalidateGallery() {
      this.gallery = [];
      if (this.view === 'gallery') this.ensureGallery();
    },

    galleryMetaRows(item) {
      const m = item.meta || {};
      const rows = [['creada', item.created_at]];
      if (item.character) rows.push(['personaje', item.character]);
      if (m.seed != null) rows.push(['seed', m.seed]);
      if (m.steps != null) rows.push(['steps', m.steps]);
      if (m.cfg != null) rows.push(['cfg', m.cfg]);
      if (m.sampler) rows.push(['sampler', m.sampler]);
      if (m.schedule) rows.push(['scheduler', m.schedule]);
      if (m.model) rows.push(['modelo', m.model]);
      if (item.kind === 'base') {
        rows.push(['ropas', m.clothing || '—'], ['encuadre', m.framing_key]);
      }
      if (item.kind === 'variant') {
        rows.push(['expresión', m.expression || '—'], ['ropas', m.clothing || '—']);
        if (m.accessories?.length) rows.push(['accesorios', m.accessories.join(', ')]);
        if (m.method && m.method !== 'none') {
          rows.push(['identidad', m.method]);
          if (m.strength != null) rows.push(['strength', m.strength]);
        }
        if (m.width && m.height) rows.push(['tamaño', `${m.width}x${m.height}`]);
        if (m.base_id) rows.push(['base', `#${m.base_id}`]);
      }
      if (item.kind === 'inpaint') {
        rows.push(['región', m.region], ['denoise', m.denoise]);
        if (m.identity_mode && m.identity_mode !== 'none') {
          rows.push(['anclaje', m.identity_mode]);
          if (m.identity_strength != null) rows.push(['strength', m.identity_strength]);
        }
        if (m.variant_id) rows.push(['variante', `#${m.variant_id}`]);
      }
      rows.push(['quitar fondo', m.rembg ? 'sí' : 'no']);
      return rows;
    },

    async refreshGlobal() {
      const [config, models, promptData, characters] = await Promise.all([
        api('/api/config'),
        api('/api/models'),
        api('/api/prompt-data'),
        api('/api/characters'),
      ]);
      this.config = config;
      this.samplers = config.samplers || [];
      this.schedules = config.schedules || [];
      this.models = models;
      this.characters = characters;
      this.framings = Object.entries(promptData.framings).map(([key, v]) =>
        ({ _key: key, _origKey: key, positive: v.positive, negative: v.negative, _isNew: false }));
      this.accessories = Object.entries(promptData.accessories).map(([key, v]) =>
        ({ _key: key, _origKey: key, positive: v.positive, negative: v.negative, _isNew: false }));
      this.globals = promptData.globals;
    },

    async loadCharacters() {
      this.characters = await api('/api/characters');
    },

    filteredCharacters() {
      const q = this.charSearch.trim().toLowerCase();
      if (!q) return this.characters;
      return this.characters.filter(c =>
        c.key.toLowerCase().includes(q) ||
        (c.identity || '').toLowerCase().includes(q)
      );
    },

    toast(msg, kind = 'ok') {
      this.toastMsg = msg;
      this.toastKind = kind;
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => { this.toastMsg = ''; }, 3000);
    },

    // Muestra la última base generada como avatar del listado.
    avatarStyle(c) {
      return c?.thumb ? `background-image:url('${c.thumb}')` : '';
    },

    anyModalOpen() {
      return !!(this.lightbox || this.confirmModal || this.galleryModal
        || this.inpaintModal || this.variantModal || this.baseModal || this.charModal);
    },

    // Escape cierra el modal de más arriba en el stack.
    closeTopModal() {
      if (this.lightbox) { this.lightbox = null; return; }
      if (this.confirmModal) { this.confirmModal = null; return; }
      if (this.galleryModal) { this.closeGalleryModal(); return; }
      if (this.inpaintModal) { this.closeInpaintModal(); return; }
      if (this.variantModal) { this.closeVariantModal(); return; }
      if (this.baseModal) { this.closeBaseModal(); return; }
      if (this.charModal) { this.charModal = null; return; }
    },

    // Foco al primer control cuando se abre el contenido de un modal.
    focusModal(el) {
      this.$nextTick(() => {
        const target = el.querySelector('input, textarea, select, button');
        if (target) target.focus();
      });
    },

    // ---------------- personaje ----------------

    async openCharacter(key) {
      try {
        const [char, bases, variants, suggestions, inpaints] = await Promise.all([
          api(`/api/characters/${encodeURIComponent(key)}`),
          api(`/api/bases?character=${encodeURIComponent(key)}`),
          api(`/api/variants?character=${encodeURIComponent(key)}`),
          api(`/api/suggestions?character=${encodeURIComponent(key)}`),
          api(`/api/inpaints?character=${encodeURIComponent(key)}`),
        ]);
        this.detail = { key, char, bases, variants, suggestions, inpaints };
        this.view = 'character';
        this.syncHash();
      } catch (err) { this.toast(err.message, 'err'); }
    },

    async refreshDetail() {
      if (!this.detail) return;
      await this.openCharacter(this.detail.key);
    },

    // URL del .zip con todas las imágenes generadas del personaje abierto.
    bundleUrl() {
      return this.detail ? `/api/characters/${encodeURIComponent(this.detail.key)}/bundle` : '#';
    },

    openCharModal() {
      this.charModal = { key: '', identity: '', face: '', hair: '', body: '', lighting: 'soft natural light', negative_identity: '' };
    },

    async createCharacter() {
      const form = this.charModal;
      try {
        await api('/api/characters', { method: 'POST', body: form });
        this.charModal = null;
        this.toast('Personaje creado', 'ok');
        await this.loadCharacters();
        await this.openCharacter(form.key);
      } catch (err) { this.toast(err.message, 'err'); }
    },

    async saveIdentity() {
      const { key, char } = this.detail;
      try {
        await api(`/api/characters/${encodeURIComponent(key)}`, { method: 'PUT', body: char });
        this.toast('Identidad guardada', 'ok');
        this.detail.key = char.key;
        await this.refreshDetail();
        await this.loadCharacters();
      } catch (err) { this.toast(err.message, 'err'); }
    },

    async deleteCharacter() {
      try {
        await api(`/api/characters/${encodeURIComponent(this.detail.key)}`, { method: 'DELETE' });
        this.detail = null;
        this.view = 'characters';
        this.syncHash();
        await this.loadCharacters();
        this.toast('Personaje eliminado', 'ok');
      } catch (err) { this.toast(err.message, 'err'); }
    },

    confirmDelete(title, message, action) {
      this.confirmModal = { title, message, action };
    },
    async runConfirm() {
      const action = this.confirmModal?.action;
      this.confirmModal = null;
      if (action) await action();
    },

    // ---------------- preview en vivo ----------------

    currentModal() {
      return this.baseModal || this.variantModal;
    },

    schedulePreview() {
      clearTimeout(this._previewTimer);
      this._previewTimer = setTimeout(() => this.updatePreview(), 350);
    },

    async updatePreview() {
      const modal = this.currentModal();
      if (!modal || !this.detail) return;
      try {
        const preview = await api('/api/preview', { method: 'POST', body: this.modalPreviewBody(modal) });
        modal.preview = { positive: preview.positive, negative: preview.negative };
        modal.conflicts = preview.conflicts || [];
      } catch (err) {
        modal.preview = { positive: '', negative: `— ${err.message}` };
        modal.conflicts = [];
      }
    },

    modalPreviewBody(modal) {
      const d = modal.draft;
      if (modal === this.baseModal) {
        return { type: 'base', character: this.detail.key, clothing: d.clothing, negativeExtra: d.negativeExtra, framingKey: d.framingKey };
      }
      return {
        type: 'variant', character: this.detail.key, clothing: d.clothing, negativeExtra: d.negativeExtra,
        expression: d.expression, accessories: d.accessories, framingKey: d.framingKey, method: d.method,
      };
    },

    // ---------------- base ----------------

    openBaseModal(base) {
      if (!this.config) return;
      const existingJob = base?.id
        ? this.activeJobs.find(j => j.kind === 'base' && j.refId === base.id)
        : null;
      this.baseModal = {
        draft: {
          baseId: base?.id ?? null,
          clothing: base?.clothing ?? '',
          negativeExtra: base?.negative_extra ?? '',
          framingKey: base?.framing_key ?? 'portrait',
          seedAuto: !base?.seed,
          seed: base?.seed ?? '',
          rembg: base ? !!base.rembg : this.config.rembg.available,
          ...rowSettings(base, this.config),
        },
        preview: { positive: '', negative: '' },
        conflicts: [],
        busy: !!existingJob,
        jobId: existingJob?.jobId ?? null,
        progress: existingJob ? { ...existingJob } : { outputPath: base?.image_path ?? null },
      };
      this.updatePreview();
    },

    closeBaseModal() {
      this.baseModal = null;
      this.refreshDetail();
    },

    async generateBase() {
      const m = this.baseModal;
      const d = m.draft;
      m.busy = true;
      m.progress = { status: 'pending', percent: 0, stage: 'En cola...' };
      try {
        const { jobId, baseId } = await api('/api/generate-base', {
          method: 'POST',
          body: {
            character: this.detail.key,
            baseId: d.baseId || undefined,
            clothing: d.clothing, negativeExtra: d.negativeExtra, framingKey: d.framingKey,
            rembg: d.rembg,
            seed: d.seedAuto ? null : parseInt(d.seed, 10),
            steps: d.steps, cfg: d.cfg, sampler: d.sampler, schedule: d.schedule, model: d.model,
          },
        });
        m.jobId = jobId;
        d.baseId = d.baseId || baseId;
        const jobEntry = {
          jobId, kind: 'base', character: this.detail.key, refId: baseId,
          label: `Base ${baseId} — ${this.detail.key}`,
          status: 'pending', percent: 0, stage: 'En cola...', error: '',
        };
        this.activeJobs.push(jobEntry);
        this.watchJob(jobId, jobEntry);
      } catch (err) {
        m.busy = false;
        this.toast(err.message, 'err');
      }
    },

    async saveBaseChanges() {
      const m = this.baseModal;
      const d = m.draft;
      if (!d.baseId) return;
      try {
        await api(`/api/bases/${d.baseId}`, {
          method: 'PUT',
          body: {
            clothing: d.clothing, negativeExtra: d.negativeExtra, framingKey: d.framingKey,
            seed: d.seedAuto ? null : parseInt(d.seed, 10),
            steps: d.steps, cfg: d.cfg, sampler: d.sampler, schedule: d.schedule, model: d.model,
            rembg: d.rembg,
          },
        });
        this.toast('Base guardada', 'ok');
        await this.refreshDetail();
      } catch (err) { this.toast(err.message, 'err'); }
    },

    async cloneBase(id) {
      try {
        await api(`/api/bases/${id}/clone`, { method: 'POST' });
        await this.refreshDetail();
        this.invalidateGallery();
        this.toast('Base clonada', 'ok');
      } catch (err) { this.toast(err.message, 'err'); }
    },

    async deleteBase(id) {
      try {
        await api(`/api/bases/${id}`, { method: 'DELETE' });
        await this.refreshDetail();
        this.invalidateGallery();
      } catch (err) { this.toast(err.message, 'err'); }
    },

    // ---------------- variante ----------------

    openVariantModal(variant) {
      if (!this.config) return;
      const withImage = this.detail.bases.filter(b => b.image_path);
      const baseId = variant?.base_id ?? (withImage[0]?.id ?? this.detail.bases[0]?.id ?? null);
      const method = variant?.method ?? (this.config.identityMethods.photomaker ? 'photomaker' : (this.config.identityMethods.ipadapter ? 'ipadapter' : 'none'));
      const existingJob = variant?.id
        ? this.activeJobs.find(j => j.kind === 'variant' && j.refId === variant.id)
        : null;
      this.variantModal = {
        draft: {
          variantId: variant?.id ?? null,
          baseId,
          label: variant?.label ?? '',
          expression: variant?.expression ?? '',
          clothing: variant?.clothing ?? '',
          accessories: variant ? [...variant.accessories] : [],
          negativeExtra: variant?.negative_extra ?? '',
          framingKey: variant?.framing_key ?? 'three_quarters',
          method,
          strength: variant?.strength ?? (method !== 'none' ? this.defaultStrength(method) : ''),
          size: variant?.width ? `${variant.width}x${variant.height}` : '832x1216',
          seedAuto: !variant?.seed,
          seed: variant?.seed ?? '',
          rembg: variant ? !!variant.rembg : this.config.rembg.available,
          ...rowSettings(variant, this.config),
        },
        preview: { positive: '', negative: '' },
        conflicts: [],
        busy: !!existingJob,
        jobId: existingJob?.jobId ?? null,
        progress: existingJob ? { ...existingJob } : { outputPath: variant?.image_path ?? null },
      };
      this.updatePreview();
    },

    closeVariantModal() {
      this.variantModal = null;
      this.refreshDetail();
    },

    strengthError(d) {
      if (d.method === 'none') return null;
      const label = d.method === 'ipadapter' ? 'IP-Adapter' : 'PhotoMaker';
      if (d.strength === '' || d.strength === null || d.strength === undefined) {
        return `${label}: strength es obligatorio.`;
      }
      const s = parseFloat(d.strength);
      if (Number.isNaN(s)) return 'Strength inválido.';
      if (d.method === 'ipadapter' && !(s > 0 && s <= 1)) return 'IP-Adapter: strength debe ser mayor que 0 y hasta 1.';
      if (d.method === 'photomaker' && !(s > 0 && s <= 100)) return 'PhotoMaker: strength debe ser mayor que 0 y hasta 100.';
      return null;
    },

    defaultStrength(method) {
      return method === 'ipadapter' ? 0.5 : 30;
    },

    onMethodChange() {
      const d = this.variantModal.draft;
      if (d.method !== 'none' && (d.strength === '' || d.strength === null || d.strength === undefined)) {
        d.strength = this.defaultStrength(d.method);
      }
      this.schedulePreview();
    },

    async generateVariant() {
      const m = this.variantModal;
      const d = m.draft;
      const strengthErr = this.strengthError(d);
      if (strengthErr) { this.toast(strengthErr, 'err'); return; }
      m.busy = true;
      m.progress = { status: 'pending', percent: 0, stage: 'En cola...' };
      const [width, height] = d.size.split('x').map(Number);
      try {
        const { jobId, variantId } = await api('/api/generate-variant', {
          method: 'POST',
          body: {
            character: this.detail.key,
            variantId: d.variantId || undefined,
            baseId: d.baseId,
            label: d.label, expression: d.expression, clothing: d.clothing,
            accessories: d.accessories, negativeExtra: d.negativeExtra,
            framingKey: d.framingKey, method: d.method,
            strength: d.strength === '' ? undefined : parseFloat(d.strength),
            width, height, rembg: d.rembg,
            seed: d.seedAuto ? null : parseInt(d.seed, 10),
            steps: d.steps, cfg: d.cfg, sampler: d.sampler, schedule: d.schedule, model: d.model,
          },
        });
        m.jobId = jobId;
        d.variantId = d.variantId || variantId;
        const jobEntry = {
          jobId, kind: 'variant', character: this.detail.key, refId: variantId,
          label: `${d.label || 'Variante ' + variantId} — ${this.detail.key}`,
          status: 'pending', percent: 0, stage: 'En cola...', error: '',
        };
        this.activeJobs.push(jobEntry);
        this.watchJob(jobId, jobEntry);
      } catch (err) {
        m.busy = false;
        this.toast(err.message, 'err');
      }
    },

    async saveVariantChanges() {
      const m = this.variantModal;
      const d = m.draft;
      if (!d.variantId) return;
      const strengthErr = this.strengthError(d);
      if (strengthErr) { this.toast(strengthErr, 'err'); return; }
      const [width, height] = d.size.split('x').map(Number);
      try {
        await api(`/api/variants/${d.variantId}`, {
          method: 'PUT',
          body: {
            baseId: d.baseId, label: d.label, expression: d.expression, clothing: d.clothing,
            accessories: d.accessories, negativeExtra: d.negativeExtra, framingKey: d.framingKey,
            method: d.method, strength: d.strength === '' ? null : parseFloat(d.strength),
            seed: d.seedAuto ? null : parseInt(d.seed, 10),
            steps: d.steps, cfg: d.cfg, sampler: d.sampler, schedule: d.schedule, model: d.model,
            width, height, rembg: d.rembg,
          },
        });
        this.toast('Variante guardada', 'ok');
        await this.refreshDetail();
      } catch (err) { this.toast(err.message, 'err'); }
    },

    async cloneVariant(id) {
      try {
        await api(`/api/variants/${id}/clone`, { method: 'POST' });
        await this.refreshDetail();
        this.invalidateGallery();
        this.toast('Variante clonada', 'ok');
      } catch (err) { this.toast(err.message, 'err'); }
    },

    async deleteVariant(id) {
      try {
        await api(`/api/variants/${id}`, { method: 'DELETE' });
        await this.refreshDetail();
        this.invalidateGallery();
      } catch (err) { this.toast(err.message, 'err'); }
    },

    // ---------------- inpainting ----------------

    inpaintsFor(variantId) {
      return (this.detail?.inpaints || []).filter(i => i.variant_id === variantId);
    },

    // Refleja exactamente la concatenación que hace el server en modo 'prompt'
    // (server/routes/generate.js): identidad anticipada al prompt de la región.
    // null en otros modos, que no concatenan.
    inpaintFinalPrompt() {
      const d = this.inpaintModal?.draft;
      if (!d || d.identityMode !== 'prompt') return null;
      const c = this.detail?.char;
      if (!c) return null;
      const idParts = [c.identity, c.face, c.hair].filter(Boolean).join(', ');
      const positive = [idParts, String(d.prompt ?? '').trim()].filter(Boolean).join(', ');
      const negative = [c.negative_identity, String(d.negative ?? '').trim()].filter(Boolean).join(', ');
      return { positive, negative };
    },

    openInpaintModal(variant, existingInpaint = null) {
      if (!this.config || !variant) return;
      const existingJob = this.activeJobs.find(j => j.kind === 'inpaint' && j.variantId === variant.id);
      // Modo de identidad por defecto: si el personaje tiene photomaker/ipadapter
      // disponibles preferimos eso; si no, al menos 'prompt' (no cuesta nada y
      // ya ayuda a que la cara no se vaya de tema).
      const defaultIdentityMode = existingInpaint?.identity_mode
        ?? (this.config.identityMethods.photomaker ? 'photomaker'
          : (this.config.identityMethods.ipadapter ? 'ipadapter' : 'prompt'));
      this.inpaintModal = {
        source: variant,
        editingId: existingInpaint?.id ?? null,
        draft: {
          variantId: variant.id,
          label: existingInpaint?.label ?? '',
          region: existingInpaint?.region ?? this.config.inpaint?.regions?.find(r => r.available)?.key ?? 'face',
          prompt: existingInpaint?.prompt ?? '',
          negative: existingInpaint?.negative ?? '',
          denoise: existingInpaint?.denoise ?? this.config.inpaint?.defaultDenoise ?? 0.45,
          identityMode: defaultIdentityMode,
          identityStrength: existingInpaint?.identity_strength ?? this.defaultIdentityStrength(defaultIdentityMode),
          seedAuto: !existingInpaint?.seed,
          seed: existingInpaint?.seed ?? '',
          rembg: existingInpaint ? !!existingInpaint.rembg : this.config.rembg.available,
        },
        busy: !!existingJob,
        jobId: existingJob?.jobId ?? null,
        progress: existingJob ? { ...existingJob } : { outputPath: existingInpaint?.image_path ?? variant.image_path ?? null, percent: 0 },
      };
    },

    closeInpaintModal() {
      this.inpaintModal = null;
      this.refreshDetail();
    },

    defaultIdentityStrength(identityMode) {
      if (identityMode === 'ipadapter') return 0.5;
      if (identityMode === 'photomaker') return 30;
      return '';
    },

    onInpaintIdentityModeChange() {
      const d = this.inpaintModal.draft;
      if ((d.identityMode === 'photomaker' || d.identityMode === 'ipadapter')
        && (d.identityStrength === '' || d.identityStrength === null || d.identityStrength === undefined)) {
        d.identityStrength = this.defaultIdentityStrength(d.identityMode);
      }
    },

    inpaintIdentityStrengthError(d) {
      if (d.identityMode !== 'photomaker' && d.identityMode !== 'ipadapter') return null;
      const label = d.identityMode === 'ipadapter' ? 'IP-Adapter' : 'PhotoMaker';
      if (d.identityStrength === '' || d.identityStrength === null || d.identityStrength === undefined) {
        return `${label}: strength es obligatorio.`;
      }
      const s = parseFloat(d.identityStrength);
      if (Number.isNaN(s)) return 'Strength inválido.';
      if (d.identityMode === 'ipadapter' && !(s > 0 && s <= 1)) return 'IP-Adapter: strength debe ser mayor que 0 y hasta 1.';
      if (d.identityMode === 'photomaker' && !(s > 0 && s <= 100)) return 'PhotoMaker: strength debe ser mayor que 0 y hasta 100.';
      return null;
    },

    // Validación compartida entre "Generar" y "Guardar cambios".
    validateInpaintDraft(d) {
      d.label = String(d.label ?? '').trim().toLowerCase();
      if (!d.label) return 'Poné un identificador para la imagen.';
      if (!/^[a-z0-9_-]+$/.test(d.label)) return 'Identificador inválido: solo letras, números, _ y -.';
      if (!String(d.prompt ?? '').trim()) return 'El prompt de inpainting es obligatorio.';
      return this.inpaintIdentityStrengthError(d);
    },

    inpaintBody(d) {
      return {
        variantId: d.variantId, label: d.label, region: d.region,
        prompt: d.prompt, negative: d.negative, denoise: parseFloat(d.denoise),
        identityMode: d.identityMode,
        identityStrength: (d.identityMode === 'photomaker' || d.identityMode === 'ipadapter')
          ? parseFloat(d.identityStrength) : undefined,
        seed: d.seedAuto ? null : parseInt(d.seed, 10), rembg: d.rembg,
      };
    },

    // Actualiza la config del inpaint existente sin generar una imagen nueva.
    async saveInpaintChanges() {
      const m = this.inpaintModal;
      if (!m?.editingId) return;
      const d = m.draft;
      const err = this.validateInpaintDraft(d);
      if (err) { this.toast(err, 'err'); return; }
      try {
        await api(`/api/inpaints/${m.editingId}`, { method: 'PUT', body: this.inpaintBody(d) });
        this.toast('Inpaint guardado', 'ok');
        await this.refreshDetail();
      } catch (e) { this.toast(e.message, 'err'); }
    },

    async runInpaint() {
      const m = this.inpaintModal;
      const d = m.draft;
      const validationErr = this.validateInpaintDraft(d);
      if (validationErr) { this.toast(validationErr, 'err'); return; }
      m.busy = true;
      m.progress = { status: 'pending', percent: 0, stage: 'En cola...' };
      try {
        const { jobId, inpaintId } = await api('/api/inpaint-variant', {
          method: 'POST',
          body: this.inpaintBody(d),
        });
        m.jobId = jobId;
        const jobEntry = {
          jobId, kind: 'inpaint', character: this.detail.key, refId: inpaintId, variantId: d.variantId,
          label: `Inpaint ${m.source.label || 'variante'}_${d.label} — ${this.detail.key}`,
          status: 'pending', percent: 0, stage: 'En cola...', error: '',
        };
        this.activeJobs.push(jobEntry);
        this.watchJob(jobId, jobEntry);
      } catch (err) {
        m.busy = false;
        this.toast(err.message, 'err');
      }
    },

    async deleteInpaint(id) {
      try {
        await api(`/api/inpaints/${id}`, { method: 'DELETE' });
        await this.refreshDetail();
        this.invalidateGallery();
        this.toast('Inpaint eliminado', 'ok');
      } catch (err) { this.toast(err.message, 'err'); }
    },

    // ---------------- jobs SSE ----------------

    modalForJob(jobId) {
      if (this.baseModal?.jobId === jobId) return this.baseModal;
      if (this.variantModal?.jobId === jobId) return this.variantModal;
      if (this.inpaintModal?.jobId === jobId) return this.inpaintModal;
      return null;
    },

    removeActiveJob(jobId) {
      this.activeJobs = this.activeJobs.filter(j => j.jobId !== jobId);
    },

    // Guarda el job terminado para que quede visible un rato en la bandeja.
    finishJob(jobEntry) {
      this.finishedJobs = [jobEntry, ...this.finishedJobs].slice(0, 10);
    },

    watchJob(jobId, jobEntry) {
      const es = new EventSource(`/api/generate/${jobId}/stream`);
      es.onmessage = async (e) => {
        const msg = JSON.parse(e.data);
        const p = msg.progress || {};
        Object.assign(jobEntry, {
          status: msg.status,
          stage: p.stage,
          percent: p.percent ?? jobEntry.percent ?? 0,
          currentStep: p.currentStep ?? 0,
          totalSteps: p.totalSteps ?? jobEntry.totalSteps,
          error: msg.error || '',
          queuePosition: msg.queuePosition ?? jobEntry.queuePosition ?? null,
        });

        // Si el modal de este item sigue abierto, reflejar el progreso ahí también.
        const modal = this.modalForJob(jobId);
        if (modal) {
          modal.progress = { ...modal.progress, ...jobEntry };
          if (msg.seed !== undefined && msg.seed !== null) modal.draft.seed = msg.seed;
        }

        if (msg.status === 'done') {
          jobEntry.outputPath = msg.outputPath;
          jobEntry.stamp = Date.now();
          es.close();
          if (modal) {
            modal.progress.outputPath = msg.outputPath;
            modal.progress.stamp = jobEntry.stamp;
            modal.busy = false;
          }
          this.removeActiveJob(jobId);
          this.finishJob({ ...jobEntry, status: 'done', percent: 100 });
          await this.refreshDetail();
          this.invalidateGallery();
          this.toast(`Generación terminada — ${jobEntry.label}`, 'ok');
        } else if (msg.status === 'error' || msg.status === 'cancelled') {
          es.close();
          if (modal) modal.busy = false;
          this.removeActiveJob(jobId);
          this.finishJob({ ...jobEntry });
          this.toast(
            msg.status === 'error' ? `Error en la generación — ${jobEntry.label}` : `Cancelada — ${jobEntry.label}`,
            msg.status === 'error' ? 'err' : ''
          );
        }
      };
      es.onerror = () => { /* si el stream cae, el job sigue en el server; se pierde el tracking en vivo */ };
    },

    async cancelJob(modal) {
      if (!modal?.jobId) return;
      try { await api(`/api/generate/${modal.jobId}/cancel`, { method: 'POST' }); }
      catch (err) { this.toast(err.message, 'err'); }
    },

    async cancelActiveJob(job) {
      try { await api(`/api/generate/${job.jobId}/cancel`, { method: 'POST' }); }
      catch (err) { this.toast(err.message, 'err'); }
    },

    // ---------------- framings / accesorios / globales ----------------

    addCollectionItem(view) {
      const list = view === 'framings' ? this.framings : this.accessories;
      list.push({ _key: '', _origKey: '', positive: '', negative: '', _isNew: true });
    },

    confirmDeleteCollection(row) {
      this.confirmDelete('Entrada', `Eliminar '${row._key}'.`, async () => {
        await this.deleteCollectionItem(this.view, row._key);
      });
    },

    async saveCollectionItem(view, row) {
      const path = view === 'framings' ? '/api/framings' : '/api/accessories';
      try {
        if (row._isNew) {
          await api(path, { method: 'POST', body: { key: row._key, positive: row.positive, negative: row.negative } });
          row._isNew = false;
          row._origKey = row._key;
          this.toast('Creado', 'ok');
        } else {
          await api(`${path}/${encodeURIComponent(row._origKey)}`, { method: 'PUT', body: { key: row._key, positive: row.positive, negative: row.negative } });
          row._origKey = row._key;
          this.toast('Guardado', 'ok');
        }
        await this.refreshGlobal();
      } catch (err) { this.toast(err.message, 'err'); }
    },

    async deleteCollectionItem(view, key) {
      const path = view === 'framings' ? '/api/framings' : '/api/accessories';
      try {
        await api(`${path}/${encodeURIComponent(key)}`, { method: 'DELETE' });
        await this.refreshGlobal();
        this.toast('Eliminado', 'ok');
      } catch (err) { this.toast(err.message, 'err'); }
    },

    async saveGlobals() {
      try {
        await api('/api/globals', { method: 'PUT', body: this.globals });
        this.toast('Globales guardados', 'ok');
      } catch (err) { this.toast(err.message, 'err'); }
    },

    // ---------------- export / import ----------------

    async exportJSON() {
      try {
        const data = await api('/api/prompt-data');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'charmaker2-datos.json';
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (err) { this.toast(err.message, 'err'); }
    },

    openLightbox(path) {
      if (!path) return;
      this.lightboxDims = '';
      this.lightbox = `${path}?orig=${Date.now()}`;
    },

    async importJSON(event) {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;
      try {
        const json = JSON.parse(await file.text());
        if (!json.characters) throw new Error('El JSON no tiene "characters"');
        this.confirmDelete('Importar JSON',
          `Reemplaza TODOS los personajes (y sus bases/variantes), framings, accesorios y globales con los ${Object.keys(json.characters).length} personajes del archivo.`,
          async () => {
            try {
              await api('/api/prompt-data', { method: 'PUT', body: json });
              await this.refreshGlobal();
              this.detail = null;
              this.view = 'characters';
              this.toast('Datos importados', 'ok');
            } catch (err) { this.toast(err.message, 'err'); }
          });
      } catch (err) { this.toast(`Import inválido: ${err.message}`, 'err'); }
    },
  };
}