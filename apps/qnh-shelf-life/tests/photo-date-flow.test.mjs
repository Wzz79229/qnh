import test from 'node:test';
import assert from 'node:assert/strict';
import { dateBatchResult, validateBatchQuantity, openPhotoFlow, applyCatalogProduct } from '../dist/photo-flow.mjs';
import { parsePackagingText } from '../dist/photo-parser.mjs';
import { calculateExpiry } from '../dist/core.mjs';

const TODAY = '2026-10-16';
const PRODUCT = { sku: '2110000000000000001', spu: '2110000000000000000', name: '合成原味酸奶', spec: '200毫升', barcodes: [], imageUrl: 'https://img.meituan.net/empowerstoremanagement/synthetic.jpg' };
const parse = text => parsePackagingText(text, { today: TODAY });
const result = (text, product = PRODUCT) => dateBatchResult(parse(text), product, { today: TODAY });
const DATES = '生产日期：2026-10-10\n保质期：10天';

test('date-only flow needs production and shelf life but does not need a packaging product name', () => {
  const output = result(DATES);
  assert.equal(output.name, PRODUCT.name);
  assert.equal(output.productionDate, '2026-10-10');
  assert.equal(output.expiryDate, '2026-10-20');
  assert.equal(output.complete, true);
  assert.deepEqual(output.issues, []);
});

test('a queried product is required and OCR names cannot replace missing SKU lookup', () => {
  for (const product of [null, {}, { ...PRODUCT, sku: 211 }, { ...PRODUCT, name: '' }]) {
    const output = result(`品名：包装名称\n${DATES}`, product);
    assert.equal(output.complete, false);
    assert.equal(output.name, '');
    assert.ok(output.issues.some(issue => issue.includes('先扫描 SKU')));
  }
  assert.equal(result(`品名：包装名称\n${DATES}`).name, PRODUCT.name);
});

test('explicit expiry alone, missing duration and a missing production label all require a retake', () => {
  for (const text of ['到期日期：2026-10-20', '生产日期：2026-10-10\n到期日期：2026-10-20', '保质期：10天\n到期日期：2026-10-20', '2026-10-10\n保质期：10天']) {
    const output = result(text);
    assert.equal(output.complete, false, text);
    assert.ok(output.issues.some(issue => /生产日期|保质期/.test(issue)), text);
  }
});

test('zero, fractional, unitless, ranged and ambiguous shelf lives never become valid batches', () => {
  for (const duration of ['0天', '1.5个月', '10', '-10天', '10至20天', '约10天', '10天或20天']) {
    const output = result(`生产日期：2026-10-10\n保质期：${duration}`);
    assert.equal(output.complete, false, duration);
  }
  const parsed = parse(DATES);
  for (const patch of [{ shelfUnit: '' }, { shelfUnit: 'hours' }, { shelfLife: '10' }, { shelfLife: 0 }, { shelfLife: 1.5 }, { shelfLife: Infinity }]) {
    assert.equal(dateBatchResult({ ...parsed, ...patch }, PRODUCT, { today: TODAY }).complete, false);
  }
});

test('expiry is recalculated using calendar day, month and year semantics including leap day clamps', () => {
  for (const [production, duration, unit, expected] of [
    ['2026-10-10', 10, 'day', '2026-10-20'],
    ['2024-01-31', 1, 'month', '2024-02-29'],
    ['2024-02-29', 1, 'year', '2025-02-28'],
    ['2025-01-31', 1, 'month', '2025-02-28'],
  ]) {
    const output = dateBatchResult({ productionDate: production, shelfLife: duration, shelfUnit: unit, expiryDate: '', issues: [] }, PRODUCT, { today: TODAY });
    assert.equal(output.complete, true);
    assert.equal(output.expiryDate, expected);
    assert.equal(output.expiryDate, calculateExpiry(production, duration, unit));
  }
});

test('matching explicit expiry is allowed, but conflicting expiry blocks save and explains both dates', () => {
  const matched = result(`${DATES}\n到期日期：2026-10-20`);
  assert.equal(matched.complete, true);
  assert.equal(matched.explicitExpiryDate, '2026-10-20');
  const conflicted = result(`${DATES}\n到期日期：2026-10-21`);
  assert.equal(conflicted.complete, false);
  assert.equal(conflicted.expiryDate, '2026-10-20');
  assert.equal(conflicted.explicitExpiryDate, '2026-10-21');
  assert.ok(conflicted.issues.some(issue => issue.includes('2026-10-20') && issue.includes('2026-10-21') && issue.includes('不能保存')));
});

test('conflicting production dates, invalid explicit expiry and extra unlabelled dates remain blocking', () => {
  for (const text of [
    `${DATES}\n生产日期：2026-10-11`,
    `${DATES}\n到期日期：2026-02-30`,
    `${DATES}\n到期日期：2026-10-20\n到期日期：2026-10-21`,
    `${DATES}\n2026-10-11`,
  ]) assert.equal(result(text).complete, false, text);
});

test('future production, impossible calendar input and expiry overflow fail conservatively', () => {
  assert.equal(result('生产日期：2026-10-17\n保质期：10天').complete, false);
  assert.equal(result('生产日期：2026-02-30\n保质期：10天').complete, false);
  assert.equal(dateBatchResult({ productionDate: '9999-12-31', shelfLife: 1, shelfUnit: 'day', issues: [] }, PRODUCT, { today: '9999-12-31' }).complete, false);
});

test('packaging net content and an incidental OCR quantity never supply employee quantity', () => {
  const parsed = parse(`${DATES}\n净含量：200克`);
  const output = dateBatchResult({ ...parsed, quantity: 200 }, PRODUCT, { today: TODAY });
  assert.equal(output.complete, true);
  assert.equal(Object.hasOwn(output, 'quantity'), false);
  assert.throws(() => validateBatchQuantity(undefined));
});

test('employee quantity is strictly required and accepts only integer counts from 1 to 1000000', () => {
  for (const [value, expected] of [[1, 1], [1_000_000, 1_000_000], ['1', 1], ['00012', 12], [' 12 ', 12]]) {
    assert.equal(validateBatchQuantity(value), expected);
  }
  for (const value of [undefined, null, '', ' ', 0, -1, 1.5, 1_000_001, NaN, Infinity, {}, [], true, '1.0', '1e3', '+1', '-1', '0x10', '1,000', '200克', '１２']) {
    assert.throws(() => validateBatchQuantity(value), /清点件数/, String(value));
  }
});

test('date-only flow ignores incidental OCR barcode, name and quantity after SKU lookup', () => {
  const parsed = { ...parse(DATES), name: '不使用的包装名称', barcode: 'synthetic-other-barcode', quantity: 200 };
  parsed.issues.push('包装条码与所选商品不一致。', '识别到多个有效条码，未自动选择条码。');
  const output = dateBatchResult(parsed, { ...PRODUCT, barcodes: ['synthetic-selected-barcode'] }, { today: TODAY });
  assert.equal(output.complete, true);
  assert.equal(output.name, PRODUCT.name);
  assert.equal(output.barcode, '');
  assert.equal(Object.hasOwn(output, 'quantity'), false);
  assert.deepEqual(output.issues, []);
});

test('date conversion is pure and the catalog compatibility export remains available', () => {
  const parsed = parse(DATES);
  const saved = structuredClone(parsed);
  const output = dateBatchResult(parsed, PRODUCT, { today: TODAY });
  assert.deepEqual(parsed, saved);
  assert.equal(output.name, PRODUCT.name);
  assert.equal(applyCatalogProduct(parsed, PRODUCT).name, PRODUCT.name);
  assert.equal(dateBatchResult(null, PRODUCT), null);
});

// Minimal dialog surface lets us test event/state boundaries without invoking OCR
// workers, a real browser, file uploads, network requests or user credentials.
class DialogFixture {
  constructor() { this.open = false; this.elements = new Map(); this.listeners = new Map(); this.html = ''; }
  set innerHTML(html) {
    this.html = html; this.elements = new Map();
    for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
      this.elements.set(`#${match[1]}`, { disabled: /\sdisabled(?:[ >]|$)/.test(match[0]), value: /\bvalue="([^"]*)"/.exec(match[0])?.[1] || '', textContent: '' });
    }
  }
  get innerHTML() { return this.html; }
  querySelector(selector) { return this.elements.get(selector) || null; }
  querySelectorAll(selector) {
    const attribute = selector === '[data-remove-photo]' ? 'remove-photo' : selector === '[data-product-candidate]' ? 'product-candidate' : null;
    if (!attribute) return [];
    const key = attribute === 'remove-photo' ? 'removePhoto' : 'productCandidate';
    return [...this.html.matchAll(new RegExp(`<button[^>]*data-${attribute}="(\\d+)"[^>]*>`, 'g'))].map(match => ({ dataset: { [key]: match[1] } }));
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  removeEventListener(name) { this.listeners.delete(name); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get('close')?.(); }
}
function dialogHarness(t) {
  const dialog = new DialogFixture();
  const originalDocument = globalThis.document;
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  const revoked = [];
  let photos = 0;
  globalThis.document = { querySelector: selector => selector === '#record-dialog' ? dialog : null };
  URL.createObjectURL = () => `blob:synthetic-${++photos}`;
  URL.revokeObjectURL = url => revoked.push(url);
  t.after(() => { if (dialog.open) dialog.close(); globalThis.document = originalDocument; URL.createObjectURL = create; URL.revokeObjectURL = revoke; });
  const q = selector => dialog.querySelector(selector);
  const addPhoto = () => q('#packaging-photo-input').onchange({ target: { files: [new Blob(['synthetic'], { type: 'image/jpeg' })] } });
  const enterCount = value => q('#batch-quantity').oninput({ target: { value } });
  return { dialog, q, addPhoto, enterCount, revoked };
}

test('dialog retains required quantity across photo/OCR rerenders and saves no photos or previews', async t => {
  const h = dialogHarness(t);
  const preview = ['data:image/jpeg;base64,synthetic-only'];
  let saved;
  openPhotoFlow({ selectedProduct: PRODUCT, onSave: async payload => { saved = payload; return false; }, recognize: async () => ({ text: `${DATES}\n净含量：200克`, previews: preview }) });
  assert.equal(h.q('#batch-quantity').value, '');
  assert.equal(h.q('#photo-save').disabled, true);
  assert.equal(h.q('#photo-unlink'), null);
  assert.ok(h.dialog.innerHTML.includes(PRODUCT.sku));
  assert.ok(h.dialog.innerHTML.includes(PRODUCT.spec));
  assert.ok(h.dialog.innerHTML.includes(PRODUCT.imageUrl));
  assert.ok(h.dialog.innerHTML.includes('不会上传或保存'));
  h.enterCount('12');
  h.addPhoto();
  assert.equal(h.q('#batch-quantity').value, '12');
  await h.q('#photo-recognize').onclick();
  assert.equal(h.q('#batch-quantity').value, '12');
  assert.deepEqual(preview, []);
  assert.equal(h.q('#photo-save').disabled, false);
  await h.q('#photo-save').onclick();
  assert.equal(saved.quantity, 12);
  assert.deepEqual(saved.previews, []);
  assert.equal(saved.parsed.expiryDate, '2026-10-20');
  assert.equal(saved.selectedProduct.sku, PRODUCT.sku);
  assert.deepEqual(h.revoked, ['blob:synthetic-1']);
  assert.equal(h.q('#photo-recognize').disabled, true);
  assert.ok(!h.dialog.innerHTML.includes('blob:synthetic-1'));
});

test('dialog blocks invalid counts even if a caller invokes the disabled save handler directly', async t => {
  const h = dialogHarness(t);
  let saves = 0;
  openPhotoFlow({ selectedProduct: PRODUCT, onSave: async () => { saves++; }, recognize: async () => ({ text: DATES, previews: [] }) });
  h.addPhoto(); await h.q('#photo-recognize').onclick();
  for (const value of ['', '0', '1.5', '1000001', '1e3']) {
    h.enterCount(value);
    assert.equal(h.q('#photo-save').disabled, true);
    await h.q('#photo-save').onclick();
    assert.equal(saves, 0);
  }
});

test('retake keeps an existing count, caps photos at three and clears stale results and URLs on close', async t => {
  const h = dialogHarness(t);
  const recognizedCounts = [];
  openPhotoFlow({ selectedProduct: PRODUCT, existingRecord: { quantity: 27 }, onSave: async () => {}, recognize: async files => { recognizedCounts.push(files.length); return { text: DATES, previews: [] }; } });
  assert.equal(h.q('#batch-quantity').value, '27');
  h.addPhoto(); await h.q('#photo-recognize').onclick();
  assert.equal(h.q('#photo-save').disabled, false);
  h.addPhoto();
  assert.equal(h.q('#photo-save').disabled, true);
  assert.equal(h.q('#batch-quantity').value, '27');
  h.addPhoto(); h.addPhoto();
  assert.equal(h.q('#packaging-photo-input').disabled, true);
  await h.q('#photo-recognize').onclick();
  assert.deepEqual(recognizedCounts, [1, 3]);
  h.dialog.close();
  assert.deepEqual(h.revoked, ['blob:synthetic-1', 'blob:synthetic-2', 'blob:synthetic-3']);
  assert.equal(h.dialog.innerHTML, '');
});

test('date-only dialog without a queried product cannot photograph or recognize packaging as fallback', async t => {
  const h = dialogHarness(t);
  let recognizes = 0;
  openPhotoFlow({ onSave: async () => {}, recognize: async () => { recognizes++; return { text: DATES, previews: [] }; } });
  assert.equal(h.q('#packaging-photo-input').disabled, true);
  h.addPhoto(); await h.q('#photo-recognize').onclick();
  assert.equal(recognizes, 0);
  assert.equal(h.q('#photo-save').disabled, true);
  assert.equal(h.q('#photo-unlink'), null);
});
