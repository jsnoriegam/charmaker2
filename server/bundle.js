// Nombres de archivo para el bundle .zip de un personaje:
//   base     → {name}_base.png (solo la base más reciente con imagen)
//   variante → {name}_{variant_name}.png
//   inpaint  → {name}_{variant_name}_{inpaint_name}.png
//
// Si dos items generan el mismo nombre, gana el más reciente (por created_at y,
// a igualdad, por id). (Fase siguiente: validar duplicados al crear/editar.)

const INVALID = /[\\/:*?"<>|\s]+/g;

export function sanitizeName(value) {
  const cleaned = String(value ?? '').replace(INVALID, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'sin_nombre';
}

function isNewer(a, b) {
  const ca = String(a.created_at ?? '');
  const cb = String(b.created_at ?? '');
  if (ca !== cb) return ca > cb;
  return Number(a.id ?? 0) > Number(b.id ?? 0);
}

// items ya filtrados a los que tienen imagen en disco.
// variantLabels: Map(variantId → label) para nombrar los inpaints.
export function buildBundleEntries(characterKey, {
  bases = [], variants = [], inpaints = [], variantLabels = new Map(),
} = {}) {
  const name = sanitizeName(characterKey);
  const byName = new Map();
  const put = (fileName, item) => {
    const prev = byName.get(fileName);
    if (!prev || isNewer(item, prev.item)) byName.set(fileName, { name: fileName, item });
  };

  for (const b of bases) put(`${name}_base.png`, b);
  for (const v of variants) {
    put(`${name}_${sanitizeName(v.label || `variante_${v.id}`)}.png`, v);
  }
  for (const ip of inpaints) {
    const variantName = sanitizeName(variantLabels.get(ip.variant_id) || `variante_${ip.variant_id}`);
    const inpaintName = sanitizeName(ip.label || `inpaint_${ip.id}`);
    put(`${name}_${variantName}_${inpaintName}.png`, ip);
  }

  return [...byName.values()];
}
