import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createPhoneRuntime } from '../phone-runtime.mjs';

const SKU = '2110000000000000001';
const IMAGE = 'https://img.meituan.net/test/synthetic-product.jpg';
const cell = sku => ({ productText: '合成测试商品\nSPU：2110000000000000000\n商品类目：测试',
  specText: `100g\nSKU：${sku}\n商品条码：\n06900000000001\n外部编码：-`, imageUrls: [IMAGE] });

function harness(t) {
  const previous = Object.fromEntries(['document', 'location', 'HTMLInputElement', 'getComputedStyle'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of Object.entries(previous)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
  class Input { get value() { return this.current || ''; } set value(value) { this.current = value; } dispatchEvent() {} }
  const table = { getClientRects: () => [1] }, field = new Input(), watchers = [];
  const state = { tenant: '12345', loggedIn: true, cells: [cell(SKU)], empty: false, clicks: 0, refresh: false };
  globalThis.location = { href: 'https://qnh.meituan.com/#/unifiedGoods/tenant/spu-list', hash: '#/unifiedGoods/tenant/spu-list' };
  globalThis.HTMLInputElement = Input;
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  globalThis.document = { querySelectorAll: selector => selector === 'table' ? [table] : state.empty ? [table] : [] };
  Object.defineProperty(globalThis.document, 'cookie', { get() { throw Error('Cookies must never be read'); } });
  const runtime = createPhoneRuntime({ shell: () => state.loggedIn, tenant: () => state.tenant,
    getControls: () => ({ field, tables: [table], button: { click: () => state.clicks++ } }),
    observe: () => { let resolve; const promise = new Promise(done => { resolve = done; }); const watcher = { promise, cancel: () => resolve(false), resolve }; watchers.push(watcher); return watcher; },
    readRows: () => ({ cells: state.cells, unscoped: false }),
  });
  return { runtime, state, field, watchers, settle: () => new Promise(resolve => setImmediate(resolve)) };
}

test('login is local-only and fails closed for missing shell, invalid tenant or a different origin', t => {
  const h = harness(t); assert.equal(h.runtime.inspect().authorized, true);
  h.state.loggedIn = false; assert.equal(h.runtime.inspect().authorized, false);
  h.state.loggedIn = true; h.state.tenant = '0'; assert.equal(h.runtime.inspect().authorized, false);
  h.state.tenant = '12345'; location.href = 'https://qnh.meituan.com.attacker.invalid/'; assert.equal(h.runtime.inspect().authorized, false);
  assert.equal(h.runtime.begin(1, SKU, '12345'), false); assert.equal(h.state.clicks, 0);
});

test('a 19-digit SKU stays exact and results are withheld until a fresh table response', async t => {
  const h = harness(t); assert.equal(h.runtime.begin(1, SKU, h.state.tenant), true);
  assert.equal(h.field.value, SKU); assert.equal(h.state.clicks, 1);
  assert.equal(h.runtime.inspect().status, 'pending'); assert.equal(h.runtime.inspect().product, undefined);
  h.watchers[0].resolve(true); await h.settle();
  const output = h.runtime.inspect(); assert.equal(output.status, 'found'); assert.equal(output.product.sku, SKU);
  assert.equal(output.product.name, '合成测试商品'); assert.equal(output.product.imageUrl, IMAGE);
  assert.deepEqual(Object.keys(output.product).sort(), ['barcodes', 'category', 'imageUrl', 'name', 'sku', 'spec', 'spu']);
});

test('a leading-zero SKU is never coerced to a number', async t => {
  const h = harness(t); h.state.cells = [cell('000123')];
  assert.equal(h.runtime.begin(2, '000123', h.state.tenant), true);
  h.watchers[0].resolve(true); await h.settle(); assert.equal(h.runtime.inspect().product.sku, '000123');
});

test('no refresh means no old product, even when the table still contains the requested SKU', async t => {
  const h = harness(t); h.runtime.begin(3, SKU, h.state.tenant);
  h.watchers[0].resolve(false); await h.settle();
  assert.equal(h.runtime.inspect().status, 'error'); assert.equal(h.runtime.inspect().product, undefined);
});

test('a tenant switch while awaiting the query discards every product field', async t => {
  const h = harness(t); h.runtime.begin(4, SKU, h.state.tenant); h.state.tenant = '67890';
  assert.equal(h.runtime.inspect().tenantId, '67890'); h.watchers[0].resolve(true); await h.settle();
  assert.equal(h.runtime.inspect().status, 'idle'); assert.equal(h.runtime.inspect().product, undefined);
});

test('logout while awaiting a query clears the local result', async t => {
  const h = harness(t); h.runtime.begin(5, SKU, h.state.tenant); h.state.loggedIn = false;
  h.watchers[0].resolve(true); await h.settle();
  assert.equal(h.runtime.inspect().authorized, false); assert.equal(h.runtime.inspect().product, undefined);
});

test('a cancelled request cannot overwrite the result from a newer SKU', async t => {
  const h = harness(t); h.runtime.begin(6, SKU, h.state.tenant);
  h.runtime.begin(7, '000456', h.state.tenant); h.state.cells = [cell('000456')];
  h.watchers[0].resolve(true); h.watchers[1].resolve(true); await h.settle();
  assert.equal(h.runtime.inspect().requestId, '7'); assert.equal(h.runtime.inspect().product.sku, '000456');
});

test('the same barcode or SPU does not authorize a different SKU', async t => {
  const h = harness(t); h.state.cells = [cell('000999')]; h.runtime.begin(8, SKU, h.state.tenant);
  h.watchers[0].resolve(true); await h.settle();
  assert.equal(h.runtime.inspect().status, 'not_found'); assert.equal(h.runtime.inspect().product, undefined);
});

test('an unconfirmed empty table is an error rather than a false not-found', async t => {
  const h = harness(t); h.state.cells = []; h.runtime.begin(9, SKU, h.state.tenant);
  h.watchers[0].resolve(true); await h.settle(); assert.equal(h.runtime.inspect().status, 'error');
});

test('input changes during a refresh cannot return a stale match', async t => {
  const h = harness(t); h.runtime.begin(10, SKU, h.state.tenant); h.field.value = 'other';
  h.watchers[0].resolve(true); await h.settle(); assert.equal(h.runtime.inspect().status, 'error');
});

test('foreign image origins and ambiguous product rows are rejected', async t => {
  const h = harness(t); h.state.cells = [{ ...cell(SKU), imageUrls: ['https://attacker.invalid/image.jpg'] }];
  h.runtime.begin(11, SKU, h.state.tenant); h.watchers[0].resolve(true); await h.settle(); assert.equal(h.runtime.inspect().status, 'error');
  h.state.cells = [cell(SKU), { ...cell(SKU), specText: cell(SKU).specText.replace('100g', '200g') }];
  h.runtime.begin(12, SKU, h.state.tenant); h.watchers[1].resolve(true); await h.settle(); assert.equal(h.runtime.inspect().status, 'ambiguous');
});

test('a mismatched tenant assertion does not trigger any product query', t => {
  const h = harness(t); assert.equal(h.runtime.begin(13, SKU, '67890'), false); assert.equal(h.state.clicks, 0);
  assert.equal(h.runtime.begin(14, '../../bad', h.state.tenant), false); assert.equal(h.state.clicks, 0);
});

test('the real Android JavaScript bundle installs without server helpers and stays inert on other origins', async () => {
  const output = await build({ entryPoints: [fileURLToPath(new URL('../phone-entry.mjs', import.meta.url))], bundle: true,
    platform: 'browser', format: 'iife', target: 'chrome80', keepNames: false, write: false });
  const script = output.outputFiles[0].text;
  const context = { window: {}, location: { origin: 'https://qnh.meituan.com', href: 'https://qnh.meituan.com/', hash: '' }, URL,
    document: { readyState: 'loading' } };
  vm.runInNewContext(script, context);
  assert.equal(context.window.__xianqiPhoneValidation.version, 1);
  assert.equal(context.window.__xianqiPhoneValidation.inspect().authorized, false);
  vm.runInNewContext(script, { window: {}, location: { origin: 'https://attacker.invalid' } });
  assert.doesNotMatch(script, /binding\.acquire|createQnhProductReceipt|__name|document\.cookie|localStorage/);
});
