import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupSku, normalizeSku } from '../dist/sku-query.mjs';
import { GitHubError } from '../dist/github.mjs';

const ID = '21100000-0000-4000-8000-000000000001';
const SKU = '2110000000000000001';
const PRODUCT = { sku: SKU, spu: '2110000000000000000', name: '合成酸奶', spec: '200毫升', category: '测试乳品',
  barcodes: ['0001234567890'], imageUrl: 'https://img.meituan.net/empowerstoremanagement/synthetic.jpg' };
const row = (status, extra = {}) => ({ id: ID, sku: SKU, status, ...extra });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(statuses, overrides = {}) {
  const calls = [];
  let time = 0;
  let oldCatalogCalls = 0;
  const store = {
    async createSkuQuery(sku) { calls.push(['create', sku]); return { id: ID, status: 'pending' }; },
    async skuQuery(id) { calls.push(['status', id]); assert.ok(statuses.length, 'unexpected extra polling'); return statuses.shift(); },
    async catalog() { oldCatalogCalls++; throw new Error('old catalog must never be used'); },
    async catalogPage() { oldCatalogCalls++; throw new Error('old catalog must never be used'); },
    ...overrides,
  };
  return { store, calls, now: () => time, wait: async ms => { time += ms; }, advance: ms => { time += ms; }, get oldCatalogCalls() { return oldCatalogCalls; } };
}

test('lookup submits a 19-digit exact SKU string, follows pending/working/found and never loads catalog', async () => {
  const h = fixture([row('pending'), row('working'), row('found', { product: PRODUCT })]);
  const progress = [];
  const product = await lookupSku(h.store, ` ${SKU} `, { now: h.now, wait: h.wait, onProgress: value => progress.push(value) });
  assert.deepEqual(product, PRODUCT);
  assert.deepEqual(h.calls, [['create', SKU], ['status', ID], ['status', ID], ['status', ID]]);
  assert.equal(typeof h.calls[0][1], 'string');
  assert.equal(h.now(), 6000);
  assert.equal(progress.length, 2);
  assert.equal(h.oldCatalogCalls, 0);
});

test('SKU normalization preserves leading zeroes and rejects non-SKU inputs before any network access', async () => {
  assert.equal(normalizeSku(' 0000123 '), '0000123');
  assert.equal(normalizeSku('AbC-01._'), 'AbC-01._');
  assert.equal(normalizeSku('x'.repeat(64)), 'x'.repeat(64));
  const h = fixture([]);
  for (const sku of [2110000000000000001, '', '牛奶', 'https://qnh.meituan.com/', 'SKU A', 'x'.repeat(65), null]) {
    await assert.rejects(lookupSku(h.store, sku), /SKU/);
  }
  assert.equal(h.calls.length, 0);
});

test('a result from another job or SKU is refused even when it reports found', async () => {
  for (const response of [
    row('found', { id: '21100000-0000-4000-8000-000000000002', product: PRODUCT }),
    row('found', { sku: '2110000000000000002', product: PRODUCT }),
    row('found', { sku: 2110000000000000001, product: PRODUCT }),
    row('found', { product: { ...PRODUCT, sku: '2110000000000000002' } }),
  ]) {
    const h = fixture([response]);
    await assert.rejects(lookupSku(h.store, SKU, { now: h.now, wait: h.wait }), /SKU|本次/);
    assert.equal(h.oldCatalogCalls, 0);
  }
});

test('each lookup creates a fresh query even when the same product was just found', async () => {
  const h = fixture([row('found', { product: PRODUCT }), row('found', { product: PRODUCT })]);
  await lookupSku(h.store, SKU, { now: h.now, wait: h.wait });
  await lookupSku(h.store, SKU, { now: h.now, wait: h.wait });
  assert.equal(h.calls.filter(([name]) => name === 'create').length, 2);
  assert.equal(h.oldCatalogCalls, 0);
});

test('login required, expiry, not found, ambiguity and error never fall back to a cached catalog', async () => {
  for (const status of ['login_required', 'expired', 'not_found', 'ambiguous', 'error']) {
    const h = fixture([row(status, { product: PRODUCT, message: 'unsafe provider detail' })]);
    await assert.rejects(lookupSku(h.store, SKU, { now: h.now, wait: h.wait }), error => error.code === status && !error.message.includes('unsafe'));
    assert.equal(h.calls.filter(([name]) => name === 'status').length, 1);
    assert.equal(h.oldCatalogCalls, 0);
  }
});

test('offline submission or polling errors propagate and never trigger a catalog read', async () => {
  for (const point of ['createSkuQuery', 'skuQuery']) {
    const error = new GitHubError('合成离线提示', 'NETWORK_ERROR');
    const h = fixture([], { async [point]() { throw error; } });
    await assert.rejects(lookupSku(h.store, SKU, { now: h.now, wait: h.wait }), value => value === error);
    assert.equal(h.oldCatalogCalls, 0);
  }
});

test('an unanswered query times out and never substitutes old product data', async () => {
  const h = fixture([row('pending'), row('working')]);
  await assert.rejects(lookupSku(h.store, SKU, { now: h.now, wait: h.wait, timeoutMs: 5000 }), error => error.code === 'QNH_QUERY_TIMEOUT');
  assert.equal(h.now(), 6000);
  assert.equal(h.oldCatalogCalls, 0);
});

test('found received after the lookup deadline is rejected', async () => {
  const h = fixture([], { async skuQuery() { h.advance(5001); return row('found', { product: PRODUCT }); } });
  await assert.rejects(lookupSku(h.store, SKU, { now: h.now, wait: h.wait, timeoutMs: 5000 }), error => error.code === 'QNH_QUERY_TIMEOUT');
  assert.equal(h.oldCatalogCalls, 0);
});

test('cancelling before submission performs no request', async () => {
  const controller = new AbortController(); controller.abort();
  const h = fixture([]);
  await assert.rejects(lookupSku(h.store, SKU, { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(h.calls.length, 0);
});

test('cancelling while submission is pending prevents subsequent status polling', async () => {
  const submission = deferred();
  const controller = new AbortController();
  const h = fixture([], { createSkuQuery: () => submission.promise });
  const running = lookupSku(h.store, SKU, { signal: controller.signal, now: h.now, wait: h.wait });
  controller.abort(); submission.resolve({ id: ID, status: 'pending' });
  await assert.rejects(running, error => error.name === 'AbortError');
  assert.equal(h.calls.length, 0);
  assert.equal(h.oldCatalogCalls, 0);
});

test('cancelling while polling is pending prevents a late found response from returning a product', async () => {
  const polling = deferred();
  const entered = deferred();
  const controller = new AbortController();
  const h = fixture([], { skuQuery: () => { entered.resolve(); return polling.promise; } });
  const running = lookupSku(h.store, SKU, { signal: controller.signal, now: h.now, wait: h.wait });
  await entered.promise;
  controller.abort(); polling.resolve(row('found', { product: PRODUCT }));
  await assert.rejects(running, error => error.name === 'AbortError');
  assert.equal(h.oldCatalogCalls, 0);
});
