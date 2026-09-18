import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBundleEntries, sanitizeName } from '../server/bundle.js';

test('sanitizeName reemplaza separadores y espacios', () => {
  assert.equal(sanitizeName('ana maría'), 'ana_maría');
  assert.equal(sanitizeName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitizeName('  hola  '), 'hola');
  assert.equal(sanitizeName(''), 'sin_nombre');
});

test('buildBundleEntries arma base, variante e inpaint', () => {
  const entries = buildBundleEntries('ana', {
    bases: [{ id: 1, created_at: '2024-01-01', image_path: '/g/ana/base_1.png' }],
    variants: [{ id: 7, label: 'casual', created_at: '2024-01-02', image_path: '/g/ana/v.png' }],
    inpaints: [{ id: 9, label: 'sonrisa', variant_id: 7, created_at: '2024-01-03', image_path: '/g/ana/i.png' }],
    variantLabels: new Map([[7, 'casual']]),
  });
  assert.deepEqual(entries.map(e => e.name).sort(), [
    'ana_base.png',
    'ana_casual.png',
    'ana_casual_sonrisa.png',
  ]);
});

test('buildBundleEntries usa fallbacks y el label de la variante origen', () => {
  const entries = buildBundleEntries('ana', {
    variants: [{ id: 3, label: '', created_at: '2024-01-01', image_path: '/g/v.png' }],
    inpaints: [{ id: 4, label: '', variant_id: 3, created_at: '2024-01-01', image_path: '/g/i.png' }],
    variantLabels: new Map([[3, '']]),
  });
  assert.deepEqual(entries.map(e => e.name).sort(), [
    'ana_variante_3.png',
    'ana_variante_3_inpaint_4.png',
  ]);
});

test('ante nombres repetidos gana el más reciente', () => {
  const entries = buildBundleEntries('ana', {
    variants: [
      { id: 1, label: 'dup', created_at: '2024-01-01T00:00:00', image_path: '/g/viejo.png' },
      { id: 2, label: 'dup', created_at: '2024-06-01T00:00:00', image_path: '/g/nuevo.png' },
    ],
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'ana_dup.png');
  assert.equal(entries[0].item.id, 2);
});

test('ante mismo created_at desempata por id', () => {
  const entries = buildBundleEntries('ana', {
    bases: [
      { id: 5, created_at: '2024-01-01', image_path: '/g/b5.png' },
      { id: 8, created_at: '2024-01-01', image_path: '/g/b8.png' },
    ],
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].item.id, 8);
});
