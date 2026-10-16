import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecord, sanitizeState } from '../dist/core.mjs';

test('catalog linkage survives shared-state normalization without changing batch dates', () => {
  const input = { name: '测试酸奶', quantity: 1, productionDate: '2026-10-10', shelfLife: 10,
    shelfUnit: 'day', productSku: '2110000000000000001', productSpu: '2110000000000000000', spec: '100ml/瓶' };
  const record = validateRecord(input).record;
  assert.equal(record.expiryDate, '2026-10-20');
  const state = sanitizeState({ schemaVersion: 1, records: [record], settings: { urgentDays: 7, warningDays: 30 }, updatedAt: new Date().toISOString() });
  assert.equal(state.records[0].productSku, input.productSku);
  assert.equal(state.records[0].productSpu, input.productSpu);
  assert.equal(state.records[0].spec, input.spec);
  assert.equal(state.records[0].productionDate, input.productionDate);
  assert.equal(state.records[0].expiryDate, '2026-10-20');
});

test('partial or numeric catalog identity cannot bind a batch to the wrong product', () => {
  const base = { name: '测试商品', expiryDate: '2026-10-20', quantity: 1 };
  for (const identity of [
    { productSku: '100' }, { productSpu: '200' },
    { productSku: 2110000000000000001, productSpu: '200' },
    { productSku: '100 200', productSpu: '200' },
    { productSku: '', productSpu: '200' },
    { productSku: '100', productSpu: '200', spec: 'a'.repeat(121) },
  ]) assert.equal(validateRecord({ ...base, ...identity }).valid, false);
  const record = validateRecord(base).record;
  assert.ok(!Object.hasOwn(record, 'productSku'));
  assert.ok(!Object.hasOwn(record, 'productSpu'));
});
