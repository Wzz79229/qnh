import test from 'node:test';
import assert from 'node:assert/strict';
import { createQnhProductReceipt, freshProductMatches, freshEmptyMatches, requestSelectsSku } from '../backend/qnh-product-proof.mjs';

const product = { sku: '2110713367388348481', name: 'SYNTHETIC-PRODUCT' };
const payload = { code: 0, data: { list: [{ spuName: product.name, skus: [{ skuId: product.sku }] }] } };
test('fresh proof preserves long SKU strings and rejects errors or unrelated product data', () => {
  assert.equal(freshProductMatches(payload, product), true);
  for (const data of [{ ...payload, code: 401 }, { ...payload, success: false },
    { data: [{ skuId: Number(product.sku), spuName: product.name }] },
    { code: 0, data: [{ sku: product.sku, name: 'OTHER' }, { sku: 'OTHER', name: product.name }] },
    { data: [{ skuId: product.sku, spuName: 'OTHER-PRODUCT' }] }, { data: [{ skuId: `0${product.sku}`, spuName: product.name }] }]) {
    assert.equal(freshProductMatches(data, product), false);
  }
});
function harness() {
  const listeners = new Map(), calls = [];
  const cdp = { on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); },
    async send(method, params) { calls.push({ method, params }); return { body: JSON.stringify(payload), base64Encoded: false }; } };
  return { receipt: createQnhProductReceipt(cdp), calls,
    event(name, params) { for (const fn of listeners.get(`Network.${name}`) || []) fn(params); },
    count: () => [...listeners.values()].reduce((count, set) => count + set.size, 0) };
}
function respond(h, { request = true, url = 'https://qnh.meituan.com/api/unifiedGoods/querySku', ...override } = {}) {
  if (request) h.event('requestWillBeSent', { requestId: 'synthetic', type: 'XHR', request: { url, method: 'POST' } });
  h.event('responseReceived', { requestId: 'synthetic', type: 'XHR', response: { url, status: 200, mimeType: 'application/json', ...override } });
  h.event('loadingFinished', { requestId: 'synthetic', encodedDataLength: 200 });
}
test('only a newly observed completed product request can supply fresh evidence', async () => {
  const h = harness();respond(h);assert.equal(await h.receipt.matches(product), true);
  assert.deepEqual(h.calls, [{ method: 'Network.getResponseBody', params: { requestId: 'synthetic' } }]);
  assert.equal(h.count(), 0);
});
test('cached, failed, redirected, unrelated and previously started responses cannot authorize', async () => {
  for (const option of [{ request: false }, { fromDiskCache: true }, { fromServiceWorker: true },
    { fromPrefetchCache: true }, { status: 401 }, { status: 302 }, { mimeType: 'text/html' },
    { url: 'https://evil.example/api/goods' }, { url: 'https://qnh.meituan.com/analytics/goods' }]) {
    const h = harness();respond(h, option);assert.equal(await h.receipt.matches(product), false);
    assert.equal(h.calls.length, 0);
  }
  const h = harness();h.event('requestWillBeSent', { requestId: 'synthetic', type: 'XHR', request: { method: 'POST', url: 'https://qnh.meituan.com/api/goods' } });
  h.event('requestWillBeSent', { requestId: 'synthetic', type: 'XHR', redirectResponse: {}, request: { method: 'POST', url: 'https://qnh.meituan.com/api/goods' } });
  respond(h, { request: false });assert.equal(await h.receipt.matches(product), false);
});
test('closing the receipt drops event handlers and prevents later response-body reads', async () => {
  const h = harness();h.receipt.close();respond(h);assert.equal(h.count(), 0);assert.equal(h.calls.length, 0);
});
test('empty results require successful typed data and an exact string SKU selection', () => {
  assert.equal(requestSelectsSku({ url: 'https://qnh.meituan.com/api/goods', postData: JSON.stringify({ filter: { sku: product.sku } }) }, product.sku), true);
  assert.equal(requestSelectsSku({ url: `https://qnh.meituan.com/api/goods?sku=${product.sku}` }, product.sku), true);
  assert.equal(requestSelectsSku({ url: 'https://qnh.meituan.com/api/goods', postData: JSON.stringify({ sku: Number(product.sku) }) }, product.sku), false);
  assert.equal(requestSelectsSku({ url: 'https://qnh.meituan.com/api/goods', postData: JSON.stringify({ skuList: [product.sku, 'OTHER'] }) }, product.sku), false);
  assert.equal(freshEmptyMatches({ code: 0, data: { total: 0, list: [] } }), true);
  for (const payload of [{ code: 401, data: [] }, { data: [] }, { code: 0, data: { total: 2, list: [] } }, { success: false, code: 0, data: [] }]) assert.equal(freshEmptyMatches(payload), false);
});
