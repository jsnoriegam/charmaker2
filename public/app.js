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
  if (!res.ok) throw new Error(errorMessage(data, res.status));
  return data;
}

// El server manda claves estables (ej. 'errors.baseNotFound') + params; si no
// es una clave conocida (errores técnicos de sd-cli/fs) se muestra tal cual.
function errorMessage(data, status) {
  const key = data && data.error;
  if (typeof key === 'string' && globalThis.i18n && globalThis.i18n.has(key)) {
    return globalThis.i18n.t(key, data.params);
  }
  return key || `HTTP ${status}`;
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
    lang: globalThis.i18n ? globalThis.i18n.detect() : 'es',
    languages: globalThis.i18n ? globalThis.i18n.LANGS : [],
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
    // Cache-busting de imágenes generadas: la ruta no cambia al regenerar
    // (base_5.png sigue siendo base_5.png), así que el navegador reusaría la
    // copia vieja. Este contador sube en cada cambio y fuerza recalcular el src.
    assetVersion: 0,

    // ---------------- init ----------------

    // Traducción: lee this.lang para que Alpine re-renderice al cambiar idioma.
    t(key, params) {
      return globalThis.i18n.translate(this.lang, key, params);
    },

    setLang(lang) {
      this.lang = globalThis.i18n.apply(lang);
    },

    async boot() {
      try {
        this.lang = globalThis.i18n.apply(this.lang);
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
        await this.syncActiveJobs();
      } catch (err) {
        // Si falla, el seguimiento en vivo arranca igual al lanzar nuevos jobs.
      }
    },

    // Trae los jobs activos del server y agrega a la bandeja los que este
    // navegador todavía no sigue (p. ej. lanzados desde otro navegador).
    async syncActiveJobs() {
      const { jobs } = await api('/api/jobs');
      for (const job of jobs) {
        if (this.activeJobs.some(j => j.jobId === job.id)) continue;
        const entry = {
          jobId: job.id,
          kind: job.kind,
          character: job.character,
          refId: job.refId,
          variantId: job.kind === 'inpaint' ? job.variantId : undefined,
          label: this.jobLabel(job),
          status: job.status,
          percent: job.progress?.percent ?? 0,
          currentStep: job.progress?.currentStep ?? 0,
          totalSteps: job.progress?.totalSteps,
          stage: job.progress?.stage || '',
          stageParams: job.progress?.stageParams,
          error: job.error || '',
          queuePosition: job.queuePosition ?? null,
        };
        this.activeJobs.push(entry);
        this.watchJob(job.id, entry);
      }
      return jobs;
    },

    // Antes de encolar un job: sincroniza la bandeja desde el server y, si ya
    // hay algo en ejecución/encolado, pide confirmación (el server encola igual,
    // en FIFO). Si el chequeo falla, no bloquea el lanzamiento.
    async guardQueue(run) {
      let busy = [];
      try {
        await this.syncActiveJobs();
        busy = this.activeJobs.filter(j => j.status === 'pending' || j.status === 'running');
      } catch { /* si no se pudo consultar, seguimos sin bloquear */ }
      if (!busy.length) { await run(); return; }
      const current = busy[0];
      this.confirmModal = {
        title: this.t('confirm.busyTitle'),
        message: this.t('confirm.busyMsg', { label: current.label }),
        confirmLabel: this.t('confirm.enqueueAnyway'),
        confirmClass: 'btn-primary',
        action: () => run(),
      };
    },

    jobLabel(job) {
      const who = job.character || '';
      if (job.kind === 'base') return this.t('jobs.baseLabel', { id: job.refId, char: who });
      if (job.kind === 'variant') return this.t('jobs.variantLabel', { id: job.refId, char: who });
      return this.t('jobs.inpaintLabel', { id: job.refId, char: who });
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
        return [g.character, this.galleryItemTitle(g), g.meta?.label, g.meta?.expression, g.meta?.clothing]
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
    // (nombres de archivo neutros al idioma).
    galleryDownloadName(item) {
      const ext = item.image_path.match(/\.\w+$/)?.[0] ?? '.png';
      const clean = s => String(s).replace(/[\\/:*?"<>|\s]+/g, '_');
      const id = item.kind === 'inpaint'
        ? (item.meta.label || `inpaint_${item.id}`)
        : item.kind === 'variant'
          ? (item.meta.label || `variant_${item.id}`)
          : `base_${item.id}`;
      const origin = item.kind === 'inpaint'
        ? clean(item.meta.source_label || `variant_${item.meta.variant_id ?? '?'}`)
        : '';
      return [clean(item.character), origin, clean(id)].filter(Boolean).join('_') + ext;
    },

    // Título mostrado en la galería (se arma en el front para poder traducirlo).
    galleryItemTitle(item) {
      const m = item.meta || {};
      if (item.kind === 'base') return `${this.t('gallery.baseTitle', { id: item.id })} · ${m.clothing || this.t('gallery.noClothing')}`;
      if (item.kind === 'variant') return `${m.label || this.t('gallery.variantTitle', { id: item.id })}${m.expression ? ` · ${m.expression}` : ''}`;
      return this.t('gallery.inpaintTitle', { label: m.label });
    },

    galleryOriginTitle(item) {
      const origin = item.origin;
      if (!origin) return '';
      if (origin.kind === 'base') return this.t('gallery.baseTitle', { id: origin.id });
      return item.meta?.source_label || this.t('gallery.variantTitle', { id: origin.id });
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
      this.bumpAssets();
      if (this.view === 'gallery') this.ensureGallery();
    },

    galleryMetaRows(item) {
      const m = item.meta || {};
      const rows = [[this.t('prop.created'), item.created_at]];
      if (item.character) rows.push([this.t('prop.character'), item.character]);
      if (m.seed != null) rows.push([this.t('prop.seed'), m.seed]);
      if (m.steps != null) rows.push([this.t('prop.steps'), m.steps]);
      if (m.cfg != null) rows.push([this.t('prop.cfg'), m.cfg]);
      if (m.sampler) rows.push([this.t('prop.sampler'), m.sampler]);
      if (m.schedule) rows.push([this.t('prop.schedule'), m.schedule]);
      if (m.model) rows.push([this.t('prop.model'), m.model]);
      if (item.kind === 'base') {
        rows.push([this.t('prop.clothing'), m.clothing || '—'], [this.t('prop.framing'), m.framing_key]);
      }
      if (item.kind === 'variant') {
        rows.push([this.t('prop.expression'), m.expression || '—'], [this.t('prop.clothing'), m.clothing || '—']);
        if (m.accessories?.length) rows.push([this.t('prop.accessories'), m.accessories.join(', ')]);
        if (m.identity_method && m.identity_method !== 'none') {
          rows.push([this.t('prop.identity'), m.identity_method]);
          if (m.strength != null) rows.push([this.t('prop.strength'), m.strength]);
        }
        if (m.width && m.height) rows.push([this.t('prop.size'), `${m.width}x${m.height}`]);
        if (m.base_id) rows.push([this.t('prop.base'), `#${m.base_id}`]);
      }
      if (item.kind === 'inpaint') {
        rows.push([this.t('prop.region'), this.t('region.' + m.region)], [this.t('prop.denoise'), m.denoise]);
        if (m.identity_method && m.identity_method !== 'none') {
          rows.push([this.t('prop.anchor'), m.identity_method]);
          if (m.strength != null) rows.push([this.t('prop.strength'), m.strength]);
        }
        if (m.variant_id) rows.push([this.t('prop.variant'), `#${m.variant_id}`]);
      }
      rows.push([this.t('prop.rembg'), m.rembg ? this.t('prop.yes') : this.t('prop.no')]);
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

    bumpAssets() {
      this.assetVersion++;
    },

    // Marca un modal como "con cambios sin guardar" (lo dispara @input/@change).
    markDirty(modal) {
      if (modal) modal.dirty = true;
    },

    // URL de una imagen generada con el cache-buster de la versión actual.
    imgSrc(path) {
      if (!path) return path;
      const base = String(path).split('?')[0];
      return `${base}?v=${this.assetVersion}`;
    },

    // Muestra la última base generada como avatar del listado.
    avatarStyle(c) {
      return c?.thumb ? `background-image:url('${this.imgSrc(c.thumb)}')` : '';
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
      // Las imágenes del personaje pueden haber cambiado (regeneración): bumpear
      // ANTES del primer await para que el re-render sea uno solo y se recarguen.
      this.bumpAssets();
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
        this.toast(this.t('toast.characterCreated'), 'ok');
        await this.loadCharacters();
        await this.openCharacter(form.key);
      } catch (err) { this.toast(err.message, 'err'); }
    },

    async saveIdentity() {
      const { key, char } = this.detail;
      try {
        await api(`/api/characters/${encodeURIComponent(key)}`, { method: 'PUT', body: char });
        this.toast(this.t('toast.identitySaved'), 'ok');
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
        this.toast(this.t('toast.characterDeleted'), 'ok');
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

    runDiscard() {
      const discard = this.confirmModal?.discard;
      this.confirmModal = null;
      if (discard) discard();
    },

    // Diálogo "¿guardar antes de cerrar?" para un modal con cambios sin guardar.
    confirmUnsaved(kind) {
      this.confirmModal = {
        title: this.t('confirm.unsavedTitle'),
        message: this.t('confirm.unsavedMsg'),
        confirmLabel: this.t('confirm.save'),
        confirmClass: 'btn-primary',
        discardLabel: this.t('confirm.discard'),
        hasDiscard: true,
        action: async () => {
          const ok = kind === 'base' ? await this.saveBaseChanges()
            : kind === 'variant' ? await this.saveVariantChanges()
              : await this.saveInpaintChanges();
          if (ok) this.closeModalNow(kind);
        },
        discard: () => this.closeModalNow(kind),
      };
    },

    closeModalNow(kind) {
      if (kind === 'base') this.baseModal = null;
      else if (kind === 'variant') this.variantModal = null;
      else this.inpaintModal = null;
      this.refreshDetail();
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
        expression: d.expression, accessories: d.accessories, framingKey: d.framingKey, identityMethod: d.identityMethod,
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
        dirty: false,
        busy: !!existingJob,
        jobId: existingJob?.jobId ?? null,
        progress: existingJob ? { ...existingJob } : { outputPath: base?.image_path ?? null },
      };
      this.updatePreview();
    },

    closeBaseModal() {
      if (this.baseModal?.dirty && this.baseModal?.draft.baseId) {
        this.confirmUnsaved('base');
        return;
      }
      this.closeModalNow('base');
    },

    generateBase() {
      if (this.baseModal?.busy) return;
      return this.guardQueue(() => this.runGenerateBase());
    },

    async runGenerateBase() {
      const m = this.baseModal;
      const d = m.draft;
      m.busy = true;
      m.progress = { status: 'pending', percent: 0, stage: 'stages.queued' };
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
        m.dirty = false; // la ruta ya persistió estos settings al aceptar el job
        d.baseId = d.baseId || baseId;
        const jobEntry = {
          jobId, kind: 'base', character: this.detail.key, refId: baseId,
          label: this.t('jobs.baseLabel', { id: baseId, char: this.detail.key }),
          status: 'pending', percent: 0, stage: 'stages.queued', error: '',
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
      if (!d.baseId) return false;
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
        m.dirty = false;
        this.toast(this.t('toast.baseSaved'), 'ok');
        await this.refreshDetail();
        return true;
      } catch (err) { this.toast(err.message, 'err'); return false; }
    },

    async cloneBase(id) {
      try {
        await api(`/api/bases/${id}/clone`, { method: 'POST' });
        await this.refreshDetail();
        this.invalidateGallery();
        this.toast(this.t('toast.baseCloned'), 'ok');
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
      const identityMethod = variant?.identity_method ?? (this.config.identityMethods.photomaker ? 'photomaker' : (this.config.identityMethods.ipadapter ? 'ipadapter' : 'none'));
      const existingJob = variant?.id
        ? this.activeJobs.find(j => j.kind === 'variant' && j.refId === variant.id)
        : null;
      // Si el strength guardado no es válido para el método (p. ej. quedó de un
      // rango distinto), se normaliza al valor por defecto del método.
      const strengthBounds = this.variantStrengthBounds(identityMethod);
      let strength = variant?.strength ?? (strengthBounds ? this.defaultStrength(identityMethod) : '');
      if (strengthBounds && !this.strengthValid(strength, strengthBounds)) strength = this.defaultStrength(identityMethod);
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
          identityMethod,
          strength,
          size: variant?.width ? `${variant.width}x${variant.height}` : '832x1216',
          seedAuto: !variant?.seed,
          seed: variant?.seed ?? '',
          rembg: variant ? !!variant.rembg : this.config.rembg.available,
          ...rowSettings(variant, this.config),
        },
        preview: { positive: '', negative: '' },
        conflicts: [],
        dirty: false,
        busy: !!existingJob,
        jobId: existingJob?.jobId ?? null,
        progress: existingJob ? { ...existingJob } : { outputPath: variant?.image_path ?? null },
      };
      this.updatePreview();
    },

    closeVariantModal() {
      if (this.variantModal?.dirty && this.variantModal?.draft.variantId) {
        this.confirmUnsaved('variant');
        return;
      }
      this.closeModalNow('variant');
    },

    strengthError(d) {
      if (d.identityMethod === 'none') return null;
      const label = d.identityMethod === 'ipadapter' ? 'IP-Adapter' : 'PhotoMaker';
      if (d.strength === '' || d.strength === null || d.strength === undefined) {
        return this.t('validation.strengthRequired', { label });
      }
      const s = parseFloat(d.strength);
      if (Number.isNaN(s)) return this.t('validation.strengthInvalid');
      if (d.identityMethod === 'ipadapter' && !(s > 0 && s <= 1)) return this.t('validation.ipadapterRange');
      if (d.identityMethod === 'photomaker' && !(s > 0 && s <= 100)) return this.t('validation.photomakerRange');
      return null;
    },

    defaultStrength(identityMethod) {
      return identityMethod === 'ipadapter' ? 0.5 : 30;
    },

    // Rangos válidos de strength por método (deben coincidir con los inputs del
    // modal): IP-Adapter usa decimales (0.05–1), PhotoMaker enteros.
    variantStrengthBounds(identityMethod) {
      if (identityMethod === 'ipadapter') return { min: 0.05, max: 1 };
      if (identityMethod === 'photomaker') return { min: 1, max: 100 };
      return null;
    },

    inpaintStrengthBounds(identityMethod) {
      if (identityMethod === 'ipadapter') return { min: 0.05, max: 1 };
      if (identityMethod === 'photomaker') return { min: 5, max: 100 };
      return null;
    },

    strengthValid(value, bounds) {
      if (!bounds || value === '' || value === null || value === undefined) return false;
      const s = parseFloat(value);
      return !Number.isNaN(s) && s >= bounds.min && s <= bounds.max;
    },

    onMethodChange() {
      const d = this.variantModal.draft;
      const bounds = this.variantStrengthBounds(d.identityMethod);
      if (bounds && !this.strengthValid(d.strength, bounds)) {
        d.strength = this.defaultStrength(d.identityMethod);
      }
      this.schedulePreview();
    },

    generateVariant() {
      const m = this.variantModal;
      if (!m || m.busy) return;
      const strengthErr = this.strengthError(m.draft);
      if (strengthErr) { this.toast(strengthErr, 'err'); return; }
      return this.guardQueue(() => this.runGenerateVariant());
    },

    async runGenerateVariant() {
      const m = this.variantModal;
      const d = m.draft;
      m.busy = true;
      m.progress = { status: 'pending', percent: 0, stage: 'stages.queued' };
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
            framingKey: d.framingKey, identityMethod: d.identityMethod,
            strength: d.strength === '' ? undefined : parseFloat(d.strength),
            width, height, rembg: d.rembg,
            seed: d.seedAuto ? null : parseInt(d.seed, 10),
            steps: d.steps, cfg: d.cfg, sampler: d.sampler, schedule: d.schedule, model: d.model,
          },
        });
        m.jobId = jobId;
        m.dirty = false; // la ruta ya persistió estos settings al aceptar el job
        d.variantId = d.variantId || variantId;
        const jobEntry = {
          jobId, kind: 'variant', character: this.detail.key, refId: variantId,
          label: this.t('jobs.variantCustom', { label: d.label || this.t('jobs.defaultVariant', { id: variantId }), char: this.detail.key }),
          status: 'pending', percent: 0, stage: 'stages.queued', error: '',
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
      if (!d.variantId) return false;
      const strengthErr = this.strengthError(d);
      if (strengthErr) { this.toast(strengthErr, 'err'); return false; }
      const [width, height] = d.size.split('x').map(Number);
      try {
        await api(`/api/variants/${d.variantId}`, {
          method: 'PUT',
          body: {
            baseId: d.baseId, label: d.label, expression: d.expression, clothing: d.clothing,
            accessories: d.accessories, negativeExtra: d.negativeExtra, framingKey: d.framingKey,
            identityMethod: d.identityMethod, strength: d.strength === '' ? null : parseFloat(d.strength),
            seed: d.seedAuto ? null : parseInt(d.seed, 10),
            steps: d.steps, cfg: d.cfg, sampler: d.sampler, schedule: d.schedule, model: d.model,
            width, height, rembg: d.rembg,
          },
        });
        m.dirty = false;
        this.toast(this.t('toast.variantSaved'), 'ok');
        await this.refreshDetail();
        return true;
      } catch (err) { this.toast(err.message, 'err'); return false; }
    },

    async cloneVariant(id) {
      try {
        await api(`/api/variants/${id}/clone`, { method: 'POST' });
        await this.refreshDetail();
        this.invalidateGallery();
        this.toast(this.t('toast.variantCloned'), 'ok');
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

    // Refleja exactamente la concatenación que hace el server en el método 'prompt'
    // (server/routes/generate.js): identidad anticipada al prompt de la región.
    // null en otros métodos, que no concatenan.
    inpaintFinalPrompt() {
      const d = this.inpaintModal?.draft;
      if (!d || d.identityMethod !== 'prompt') return null;
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
      // Método de identidad por defecto: si el personaje tiene photomaker/ipadapter
      // disponibles preferimos eso; si no, al menos 'prompt' (no cuesta nada y
      // ya ayuda a que la cara no se vaya de tema).
      const defaultIdentityMethod = existingInpaint?.identity_method
        ?? (this.config.identityMethods.photomaker ? 'photomaker'
          : (this.config.identityMethods.ipadapter ? 'ipadapter' : 'prompt'));
      // Normaliza un strength guardado que no encaje con el rango del método.
      const strengthBounds = this.inpaintStrengthBounds(defaultIdentityMethod);
      let strength = existingInpaint?.strength ?? this.defaultIdentityStrength(defaultIdentityMethod);
      if (strengthBounds && !this.strengthValid(strength, strengthBounds)) {
        strength = this.defaultIdentityStrength(defaultIdentityMethod);
      }
      // Ajustes del pase principal: por defecto hereda de la variante, pero cada
      // inpaint puede sobrescribirlos (las columnas ya existen en la DB).
      const inherited = rowSettings(variant, this.config);
      const settings = {
        steps: existingInpaint?.steps ?? inherited.steps,
        cfg: existingInpaint?.cfg ?? inherited.cfg,
        sampler: existingInpaint?.sampler ? (LEGACY_SAMPLERS[existingInpaint.sampler] || existingInpaint.sampler) : inherited.sampler,
        schedule: existingInpaint?.schedule ?? inherited.schedule,
        model: existingInpaint?.model ?? inherited.model,
      };
      this.inpaintModal = {
        source: variant,
        editingId: existingInpaint?.id ?? null,
        dirty: false,
        draft: {
          variantId: variant.id,
          label: existingInpaint?.label ?? '',
          region: existingInpaint?.region ?? this.config.inpaint?.regions?.find(r => r.available)?.key ?? 'face',
          prompt: existingInpaint?.prompt ?? '',
          negative: existingInpaint?.negative ?? '',
          denoise: existingInpaint?.denoise ?? this.config.inpaint?.defaultDenoise ?? 0.45,
          identityMethod: defaultIdentityMethod,
          strength,
          seedAuto: !existingInpaint?.seed,
          seed: existingInpaint?.seed ?? '',
          rembg: existingInpaint ? !!existingInpaint.rembg : this.config.rembg.available,
          ...settings,
        },
        busy: !!existingJob,
        jobId: existingJob?.jobId ?? null,
        progress: existingJob ? { ...existingJob } : { outputPath: existingInpaint?.image_path ?? variant.image_path ?? null, percent: 0 },
      };
    },

    closeInpaintModal() {
      if (this.inpaintModal?.dirty && this.inpaintModal?.editingId) {
        this.confirmUnsaved('inpaint');
        return;
      }
      this.closeModalNow('inpaint');
    },

    defaultIdentityStrength(identityMethod) {
      if (identityMethod === 'ipadapter') return 0.5;
      if (identityMethod === 'photomaker') return 30;
      return '';
    },

    onInpaintMethodChange() {
      const d = this.inpaintModal.draft;
      const bounds = this.inpaintStrengthBounds(d.identityMethod);
      if (bounds && !this.strengthValid(d.strength, bounds)) {
        d.strength = this.defaultIdentityStrength(d.identityMethod);
      }
    },

    inpaintStrengthError(d) {
      if (d.identityMethod !== 'photomaker' && d.identityMethod !== 'ipadapter') return null;
      const label = d.identityMethod === 'ipadapter' ? 'IP-Adapter' : 'PhotoMaker';
      if (d.strength === '' || d.strength === null || d.strength === undefined) {
        return this.t('validation.strengthRequired', { label });
      }
      const s = parseFloat(d.strength);
      if (Number.isNaN(s)) return this.t('validation.strengthInvalid');
      if (d.identityMethod === 'ipadapter' && !(s > 0 && s <= 1)) return this.t('validation.ipadapterRange');
      if (d.identityMethod === 'photomaker' && !(s > 0 && s <= 100)) return this.t('validation.photomakerRange');
      return null;
    },

    // Validación compartida entre "Generar" y "Guardar cambios".
    validateInpaintDraft(d) {
      d.label = String(d.label ?? '').trim().toLowerCase();
      if (!d.label) return this.t('validation.labelRequired');
      if (!/^[a-z0-9_-]+$/.test(d.label)) return this.t('validation.labelInvalid');
      if (!String(d.prompt ?? '').trim()) return this.t('validation.promptRequired');
      return this.inpaintStrengthError(d);
    },

    inpaintBody(d) {
      return {
        variantId: d.variantId, label: d.label, region: d.region,
        prompt: d.prompt, negative: d.negative, denoise: parseFloat(d.denoise),
        identityMethod: d.identityMethod,
        strength: (d.identityMethod === 'photomaker' || d.identityMethod === 'ipadapter')
          ? parseFloat(d.strength) : undefined,
        steps: d.steps, cfg: d.cfg, sampler: d.sampler, schedule: d.schedule, model: d.model,
        seed: d.seedAuto ? null : parseInt(d.seed, 10), rembg: d.rembg,
      };
    },

    // Actualiza la config del inpaint existente sin generar una imagen nueva.
    async saveInpaintChanges() {
      const m = this.inpaintModal;
      if (!m?.editingId) return false;
      const d = m.draft;
      const err = this.validateInpaintDraft(d);
      if (err) { this.toast(err, 'err'); return false; }
      try {
        await api(`/api/inpaints/${m.editingId}`, { method: 'PUT', body: this.inpaintBody(d) });
        m.dirty = false;
        this.toast(this.t('toast.inpaintSaved'), 'ok');
        await this.refreshDetail();
        return true;
      } catch (e) { this.toast(e.message, 'err'); return false; }
    },

    runInpaint() {
      const m = this.inpaintModal;
      if (!m || m.busy) return;
      const validationErr = this.validateInpaintDraft(m.draft);
      if (validationErr) { this.toast(validationErr, 'err'); return; }
      return this.guardQueue(() => this.runInpaintJob());
    },

    async runInpaintJob() {
      const m = this.inpaintModal;
      const d = m.draft;
      m.busy = true;
      m.progress = { status: 'pending', percent: 0, stage: 'stages.queued' };
      try {
        const { jobId, inpaintId } = await api('/api/inpaint-variant', {
          method: 'POST',
          body: this.inpaintBody(d),
        });
        m.jobId = jobId;
        m.dirty = false; // la ruta ya persistió estos settings al aceptar el job
        const jobEntry = {
          jobId, kind: 'inpaint', character: this.detail.key, refId: inpaintId, variantId: d.variantId,
          label: this.t('jobs.inpaintCustom', { source: m.source.label || this.t('item.variant'), label: d.label, char: this.detail.key }),
          status: 'pending', percent: 0, stage: 'stages.queued', error: '',
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
        this.toast(this.t('toast.inpaintDeleted'), 'ok');
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

    // Aplica un estado de job (venga de SSE o del polling de respaldo) y
    // devuelve true cuando llegó a un estado terminal.
    applyJobState(jobId, jobEntry, msg) {
      // Mutar a través del proxy reactivo de activeJobs: el jobEntry crudo que
      // se pasó al crear el job comparte el objeto pero no es el proxy que Alpine
      // observa, así que mutarlo no re-renderiza la tarjeta de la cola.
      const entry = this.activeJobs.find(j => j.jobId === jobId) || jobEntry;
      const p = msg.progress || {};
      Object.assign(entry, {
        status: msg.status,
        stage: p.stage,
        stageParams: p.stageParams,
        percent: p.percent ?? entry.percent ?? 0,
        currentStep: p.currentStep ?? 0,
        totalSteps: p.totalSteps ?? entry.totalSteps,
        error: msg.error || '',
        queuePosition: msg.queuePosition ?? entry.queuePosition ?? null,
      });

      // Si el modal de este item sigue abierto, reflejar el progreso ahí también.
      const modal = this.modalForJob(jobId);
      if (modal) {
        modal.progress = { ...modal.progress, ...entry };
        if (msg.seed !== undefined && msg.seed !== null) modal.draft.seed = msg.seed;
      }

      if (msg.status === 'done') {
        entry.outputPath = msg.outputPath;
        entry.stamp = Date.now();
        if (modal) {
          modal.progress.outputPath = msg.outputPath;
          modal.progress.stamp = entry.stamp;
          modal.busy = false;
        }
        this.removeActiveJob(jobId);
        this.finishJob({ ...entry, status: 'done', percent: 100 });
        this.refreshDetail();
        this.invalidateGallery();
        this.loadCharacters();
        this.toast(this.t('toast.generationDone', { label: entry.label }), 'ok');
        return true;
      }
      if (msg.status === 'error' || msg.status === 'cancelled') {
        if (modal) modal.busy = false;
        this.removeActiveJob(jobId);
        this.finishJob({ ...entry });
        this.toast(
          this.t(msg.status === 'error' ? 'toast.generationError' : 'toast.generationCancelled', { label: entry.label }),
          msg.status === 'error' ? 'err' : ''
        );
        return true;
      }
      return false;
    },

    watchJob(jobId, jobEntry) {
      let es = null;
      let pollTimer = null;
      let stopped = false;

      const stop = () => {
        stopped = true;
        if (es) { es.close(); es = null; }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      };

      // Respaldo: si el stream se corta (server reiniciado, red, etc.), el job
      // sigue corriendo en el server; consultamos su estado puntual para no
      // dejar el modal colgado ni perder el resultado.
      const poll = async () => {
        if (stopped) return;
        let job;
        try {
          job = await api(`/api/generate/${jobId}`);
        } catch {
          // 404: el job ya no existe en el server (purgado) — dejamos de trackear.
          this.removeActiveJob(jobId);
          stop();
          return;
        }
        if (stopped) return;
        if (this.applyJobState(jobId, jobEntry, {
          status: job.status, progress: job.progress, outputPath: job.outputPath,
          error: job.error, seed: job.seed, queuePosition: job.queuePosition,
        })) stop();
      };

      es = new EventSource(`/api/generate/${jobId}/stream`);
      es.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (this.applyJobState(jobId, jobEntry, msg)) stop();
      };
      es.onerror = () => {
        // EventSource reintenta solo; por si no logra reconectar, sondeamos.
        if (es) { es.close(); es = null; }
        if (!stopped && !pollTimer) pollTimer = setInterval(poll, 2000);
      };
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
      this.confirmDelete(this.t('confirm.deleteEntryTitle'), this.t('confirm.deleteEntry', { key: row._key }), async () => {
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
          this.toast(this.t('toast.created'), 'ok');
        } else {
          await api(`${path}/${encodeURIComponent(row._origKey)}`, { method: 'PUT', body: { key: row._key, positive: row.positive, negative: row.negative } });
          row._origKey = row._key;
          this.toast(this.t('toast.saved'), 'ok');
        }
        await this.refreshGlobal();
      } catch (err) { this.toast(err.message, 'err'); }
    },

    async deleteCollectionItem(view, key) {
      const path = view === 'framings' ? '/api/framings' : '/api/accessories';
      try {
        await api(`${path}/${encodeURIComponent(key)}`, { method: 'DELETE' });
        await this.refreshGlobal();
        this.toast(this.t('toast.deleted'), 'ok');
      } catch (err) { this.toast(err.message, 'err'); }
    },

    async saveGlobals() {
      try {
        await api('/api/globals', { method: 'PUT', body: this.globals });
        this.toast(this.t('toast.globalsSaved'), 'ok');
      } catch (err) { this.toast(err.message, 'err'); }
    },

    // ---------------- export / import ----------------

    async exportJSON() {
      try {
        const data = await api('/api/prompt-data');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'charmaker2-data.json';
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (err) { this.toast(err.message, 'err'); }
    },

    openLightbox(path) {
      if (!path) return;
      this.lightboxDims = '';
      const base = String(path).split('?')[0];
      this.lightbox = `${base}?orig=${Date.now()}`;
    },

    async importJSON(event) {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;
      try {
        const json = JSON.parse(await file.text());
        if (!json.characters) throw new Error(this.t('validation.jsonNoCharacters'));
        this.confirmDelete(this.t('confirm.importTitle'),
          this.t('confirm.importMsg', { count: Object.keys(json.characters).length }),
          async () => {
            try {
              await api('/api/prompt-data', { method: 'PUT', body: json });
              await this.refreshGlobal();
              this.detail = null;
              this.view = 'characters';
              this.toast(this.t('toast.imported'), 'ok');
            } catch (err) { this.toast(err.message, 'err'); }
          });
      } catch (err) { this.toast(this.t('toast.importFailed', { msg: err.message }), 'err'); }
    },
  };
}