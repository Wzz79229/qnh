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

test('phone direct results preserve exact 19-digit and leading-zero SKUs without polling or catalog reads', async () => {
  for(const sku of [SKU,'0000123456789012345']){
    const requested=[];
    const h=fixture([],{async createSkuQuery(value){requested.push(value);return {mode:'direct',sku:value,status:'found',product:{...PRODUCT,sku:value,privateMetadata:'not displayed'}};}});
    const product=await lookupSku(h.store,` ${sku} `,{now:h.now,wait:h.wait});
    assert.deepEqual(requested,[sku]);
    assert.equal(typeof requested[0],'string');
    assert.deepEqual(product,{...PRODUCT,sku});
    assert.equal(h.calls.length,0,'direct responses must not call the polling API');
    assert.equal(h.now(),0);
    assert.equal(h.oldCatalogCalls,0);
  }
});

test('every phone lookup submits afresh even for the same SKU', async () => {
  let submissions=0;
  const h=fixture([],{async createSkuQuery(sku){submissions++;return {mode:'direct',sku,status:'found',product:PRODUCT};}});
  await lookupSku(h.store,SKU,{now:h.now,wait:h.wait});
  await lookupSku(h.store,SKU,{now:h.now,wait:h.wait});
  assert.equal(submissions,2);
  assert.equal(h.calls.length,0);
  assert.equal(h.oldCatalogCalls,0);
});

test('phone direct responses reject another exact SKU, numeric SKU or mismatched normalized product', async () => {
  for(const response of [
    {sku:'2110000000000000002',product:PRODUCT},
    {sku:2110000000000000001,product:PRODUCT},
    {sku:` ${SKU} `,product:PRODUCT},
    {sku:SKU,product:{...PRODUCT,sku:'2110000000000000002'}},
    {sku:SKU,product:{...PRODUCT,sku:2110000000000000001}},
  ]){
    const h=fixture([],{async createSkuQuery(){return {mode:'direct',status:'found',...response};}});
    await assert.rejects(lookupSku(h.store,SKU,{now:h.now,wait:h.wait}),/SKU/);
    assert.equal(h.calls.length,0);
    assert.equal(h.oldCatalogCalls,0);
  }
});

test('phone direct products use the existing safe image URL validation', async () => {
  for(const imageUrl of [
    'https://untrusted.example/product.jpg',
    'https://img.meituan.net/product.jpg?token=synthetic',
    'https://user:password@img.meituan.net/product.jpg',
    'javascript:alert(1)',
  ]){
    const h=fixture([],{async createSkuQuery(sku){return {mode:'direct',sku,status:'found',product:{...PRODUCT,imageUrl}};}});
    await assert.rejects(lookupSku(h.store,SKU,{now:h.now,wait:h.wait}),error=>error.code==='UNSAFE_IMAGE_URL');
    assert.equal(h.calls.length,0);
    assert.equal(h.oldCatalogCalls,0);
  }
});

test('phone direct terminal failures hide arbitrary provider messages and never poll', async () => {
  for(const status of ['not_found','ambiguous','error']){
    const h=fixture([],{async createSkuQuery(sku){return {mode:'direct',sku,status,product:PRODUCT,message:'unsafe provider detail'};}});
    await assert.rejects(lookupSku(h.store,SKU,{now:h.now,wait:h.wait}),error=>error.code===status&&!error.message.includes('unsafe')&&!/电脑|查询程序/.test(error.message));
    assert.equal(h.calls.length,0);
    assert.equal(h.oldCatalogCalls,0);
  }
  const missingImage='此 SKU 的商品主图缺失，请在牵牛花核对后重试。';
  const h=fixture([],{async createSkuQuery(sku){return {mode:'direct',sku,status:'error',message:missingImage};}});
  await assert.rejects(lookupSku(h.store,SKU,{now:h.now,wait:h.wait}),error=>error.code==='error'&&error.message===missingImage);
});

test('only an explicit direct mode and supported terminal status bypass legacy job validation', async () => {
  for(const mode of [undefined,'DIRECT','other']){
    const h=fixture([],{async createSkuQuery(sku){return {mode,sku,status:'found',product:PRODUCT};}});
    await assert.rejects(lookupSku(h.store,SKU,{now:h.now,wait:h.wait}),/无效任务/);
    assert.equal(h.calls.length,0);
  }
  for(const status of ['pending','working','login_required','unknown',undefined]){
    const h=fixture([],{async createSkuQuery(sku){return {mode:'direct',sku,status,product:PRODUCT};}});
    await assert.rejects(lookupSku(h.store,SKU,{now:h.now,wait:h.wait}),error=>error.code==='INVALID_QUERY_STATUS');
    assert.equal(h.calls.length,0);
  }
});

test('cancelled or overdue phone submission cannot return a late product or poll', async () => {
  for(const reason of ['abort','timeout']){
    const submitted=deferred();
    const controller=new AbortController();
    let submittedSku;
    const h=fixture([],{createSkuQuery(sku){submittedSku=sku;return submitted.promise;}});
    const running=lookupSku(h.store,SKU,{signal:controller.signal,now:h.now,wait:h.wait,timeoutMs:5000});
    assert.equal(submittedSku,SKU);
    if(reason==='abort')controller.abort();else h.advance(5001);
    submitted.resolve({mode:'direct',sku:SKU,status:'found',product:PRODUCT});
    await assert.rejects(running,error=>reason==='abort'?error.name==='AbortError':error.code==='QNH_QUERY_TIMEOUT'&&!/电脑|查询程序/.test(error.message));
    assert.equal(h.calls.length,0);
    assert.equal(h.oldCatalogCalls,0);
  }
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
