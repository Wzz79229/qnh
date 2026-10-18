import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBatchDates, createBatchDraft, scanSkuValue } from '../batch-domain.mjs';

const context = { today: '2026-10-18', now: '2026-10-18T02:00:00.000Z' };
const product = { sku: '2110000000000000001', spu: '2110000000000000000', name: '合成测试商品', spec: '100g', category: '测试', barcodes: [], imageUrl: 'https://img.meituan.net/test/synthetic.jpg' };
const input = () => ({ id: '12345678-1234-4234-8234-123456789abc', tenantId: '12345', product,
  dates: parseBatchDates('生产日期：2026-10-01\n保质期：12个月', context), quantity: '12' });

test('SKU supplies the name; date-only photographs do not require OCR to identify the product', () => {
  const result = parseBatchDates('生产日期：2026-10-01\n保质期：12个月', context);
  assert.equal(result.complete, true); assert.equal(result.expiryDate, '2027-10-01'); assert.deepEqual(result.issues, []);
});
test('separate photographs can be combined and duplicate matching labels are harmless', () => {
  const result = parseBatchDates('生产日期 2026.10.01\n保质期12个月\n保质期12个月', context);
  assert.equal(result.complete, true); assert.equal(result.shelfLife, 12);
});
test('month and year arithmetic uses the calendar including short months and leap days', () => {
  assert.equal(parseBatchDates('生产日期2026-01-31\n保质期1个月', context).expiryDate, '2026-02-28');
  assert.equal(parseBatchDates('生产日期2024-02-29\n保质期1年', context).expiryDate, '2025-02-28');
  assert.equal(parseBatchDates('生产日期2026-10-01\n保质期30天', context).expiryDate, '2026-10-31');
});
test('expiry-only text does not replace required production date and shelf duration', () => {
  assert.equal(parseBatchDates('有效期至2027-10-01', context).complete, false);
});
test('future dates, bad dates, multiple production dates and fractional duration require retake', () => {
  for (const value of ['生产日期2026-10-19\n保质期12个月', '生产日期2026-02-30\n保质期12个月',
    '生产日期2026-10-01\n生产日期2026-10-02\n保质期12个月', '生产日期2026-10-01\n保质期1.5个月']) {
    assert.equal(parseBatchDates(value, context).complete, false, value);
  }
});
test('a lot number, net weight and opening period are not manufactured into dates or piece counts', () => {
  for (const value of ['批号20261001\n净含量500g\n保质期12个月', '生产日期2026-10-01\n保质期开封后3天']) {
    assert.equal(parseBatchDates(value, context).complete, false);
  }
});
test('printed expiry that disagrees with the computed date is reported', () => {
  const result = parseBatchDates('生产日期2026-10-01\n保质期12个月\n有效期至2027-09-01', context);
  assert.equal(result.complete, false); assert.ok(result.issues.some(value => value.includes('不一致')));
});
test('batch snapshots retain product metadata and only explicitly counted integer pieces', () => {
  const value = createBatchDraft(input(), context); assert.equal(value.quantity, 12); assert.equal(value.unit, '件');
  assert.equal(value.product.sku, product.sku); assert.equal(value.expiryDate, '2027-10-01'); assert.equal(value.syncStatus, 'local');
  for (const quantity of ['', '0', '01', '1.5', -1, NaN, 1_000_001, true]) assert.throws(() => createBatchDraft({ ...input(), quantity }, context));
});
test('a forged calculated date or incomplete OCR state cannot be saved', () => {
  assert.throws(() => createBatchDraft({ ...input(), dates: { ...input().dates, expiryDate: '2030-01-01' } }, context));
  assert.throws(() => createBatchDraft({ ...input(), dates: { ...input().dates, complete: false } }, context));
});
test('images, raw OCR and unrelated credentials never enter a stored batch snapshot', () => {
  const value = createBatchDraft({ ...input(), photo: 'private-image', ocrText: 'private-text', cookie: 'private-cookie', product: { ...product, photoBytes: 'private-image', password: 'private-password' } }, context);
  assert.doesNotMatch(JSON.stringify(value), /private-|photoBytes|ocrText|cookie|password/);
});
test('invalid tenant paths are rejected and SKU text stays exact during scanning', () => {
  assert.throws(() => createBatchDraft({ ...input(), tenantId: '../12345' }, context));
  assert.equal(scanSkuValue('SKU：2110000000000000001'), product.sku);
  assert.equal(scanSkuValue('0000123'), '0000123');
  for (const text of ['https://attacker.invalid/?sku=123', 'javascript:alert(1)', '123 456', '', 123]) assert.throws(() => scanSkuValue(text));
});
