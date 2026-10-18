import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createMobileCloud } from '../backend/mobile-cloud.mjs';
import { createWorker } from '../backend/worker.mjs';

const ROOT = 'https://qnh-shelf-life-api.w792294944.workers.dev';
const QNH = 'https://qnh.meituan.com/api/v1/isLogined';
const COOKIE = 'synthetic-session=valid';
const product = { sku: '2110000000000000001', spu: '2110000000000000000', name: '合成测试商品', spec: '100g', category: '测试', barcodes: [], imageUrl: 'https://img.meituan.net/test/synthetic.jpg' };
const batch = () => ({ id: '12345678-1234-4234-8234-123456789abc', product, productionDate: '2026-10-01', shelfLife: 12, shelfUnit: 'month', expiryDate: '2027-10-01', quantity: 12 });
function setup(t) {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('../backend/migrations/0001_mobile_batches.sql', import.meta.url), 'utf8')); t.after(() => db.close());
  const objects = new Map(), requests = [], clock = { time: Date.parse('2026-10-18T02:00:00Z') };
  const state = { identity: { logined: true, tenantId: '12345', accountId: '98765' }, imageStatus: 200, imageType: 'image/jpeg' };
  const env = { FRESH_DB: { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; },
    async first() { return db.prepare(sql).get(...args) || null; }, async run() { return { success: true, meta: db.prepare(sql).run(...args) }; },
    async all() { return { success: true, results: db.prepare(sql).all(...args) }; } }; } },
    PRODUCT_IMAGES: { async put(key, bytes, options) { if (!objects.has(key)) objects.set(key, { bytes: new Uint8Array(bytes), httpMetadata: options.httpMetadata }); },
      async get(key) { const object = objects.get(key); return object ? { body: new Response(object.bytes).body, httpMetadata: object.httpMetadata } : null; } } };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url === QNH) return new Response(JSON.stringify({ code: 0, data: options.headers.Cookie === COOKIE ? state.identity : { logined: false, tenantId: null, accountId: null } }), { headers: { 'Content-Type': 'application/json' } });
    if (url === product.imageUrl) return new Response(Uint8Array.from([255,216,255,224,0,2,255,217]), { status: state.imageStatus, headers: { 'Content-Type': state.imageType } });
    throw Error('Unexpected external URL');
  };
  const router = createMobileCloud({ fetchImpl, now: () => clock.time });
  const request = (path, { method = 'GET', body, token, tenant = '12345', headers = {} } = {}) => new Request(ROOT + '/api/mobile/' + path, { method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}`, 'X-QNH-Tenant': tenant } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const call = (path, options) => router.handle(request(path, options), env);
  const login = async (tenant = '12345') => { const response = await call('sessions', { method: 'POST', body: { tenantId: tenant, qnhCookie: COOKIE } }); assert.equal(response.status, 200); return (await response.json()).token; };
  return { db, env, objects, requests, state, clock, fetchImpl, request, call, login };
}
test('public configuration reveals readiness and never allocates a QNH or cloud browser session', async t => {
  const h = setup(t); assert.equal((await (await h.call('config')).json()).configured, true);
  const absent = await createMobileCloud({ fetchImpl: () => { throw Error('Must not fetch'); } }).handle(h.request('config'), {});
  assert.equal((await absent.json()).configured, false); assert.equal(h.requests.length, 0);
});
test('mobile cloud works independently of GitHub configuration while missing bindings fail closed', async t => {
  const h = setup(t); const worker = createWorker({ fetchImpl: h.fetchImpl, now: () => h.clock.time });
  assert.equal((await (await worker.fetch(h.request('config'), h.env)).json()).configured, true);
  assert.equal((await worker.fetch(h.request('batches', { method: 'POST', body: batch() }), {})).status, 503);
});
test('only the official status response can bind a tenant; cookies never enter session storage', async t => {
  const h = setup(t); const token = await h.login(); assert.match(token, /^[a-f0-9]{64}$/);
  const row = h.db.prepare('SELECT * FROM mobile_sessions').get(); assert.equal(row.tenant_id, '12345'); assert.notEqual(row.token_hash, token);
  assert.doesNotMatch(JSON.stringify(row), /synthetic-session|valid|98765/);
  const first = h.requests[0]; assert.equal(first.url, QNH); assert.equal(first.options.method, 'POST'); assert.equal(first.options.redirect, 'manual');
  assert.equal(first.options.body, '{}'); assert.equal(first.options.headers.Cookie, COOKIE);
});
test('a cookie string, fabricated client login flag or a different tenant do not grant access', async t => {
  const h = setup(t);
  assert.equal((await h.call('sessions', { method: 'POST', body: { tenantId: '12345', qnhCookie: 'synthetic-session=wrong' } })).status, 401);
  assert.equal((await h.call('sessions', { method: 'POST', body: { tenantId: '67890', qnhCookie: COOKIE } })).status, 401);
  assert.equal((await h.call('sessions', { method: 'POST', body: { tenantId: '12345', qnhCookie: COOKIE, logined: true } })).status, 400);
  assert.equal(h.db.prepare('SELECT count(*) AS count FROM mobile_sessions').get().count, 0);
});
test('anonymous, expired and tenant-mismatched tokens cannot read or write any batches or images', async t => {
  const h = setup(t); assert.equal((await h.call('batches', { method: 'POST', body: batch() })).status, 401);
  const token = await h.login(); assert.equal((await h.call('batches', { token, tenant: '67890' })).status, 409);
  h.clock.time += 3600001; assert.equal((await h.call('batches', { token })).status, 401);
  assert.equal(h.objects.size, 0); assert.equal(h.db.prepare('SELECT count(*) AS count FROM mobile_batches').get().count, 0);
});
test('saving archives the image and metadata together, retries are idempotent and reads stay scoped', async t => {
  const h = setup(t); const token = await h.login();
  const saved = await h.call('batches', { method: 'POST', body: batch(), token }); assert.equal(saved.status, 201);
  const row = (await saved.json()).batch; assert.equal(row.quantity, 12); assert.equal(row.product.name, product.name); assert.equal(row.syncStatus, 'cloud'); assert.match(row.imagePath, /^\/api\/mobile\/images\/[a-f0-9]{64}\.jpg$/);
  assert.equal(h.objects.size, 1); assert.ok([...h.objects.keys()][0].startsWith('tenants/12345/product-images/'));
  assert.equal((await h.call('batches', { method: 'POST', body: batch(), token })).status, 200);
  assert.equal(h.requests.filter(value => value.url === product.imageUrl).length, 1);
  assert.equal((await h.call('batches', { method: 'POST', body: { ...batch(), quantity: 13 }, token })).status, 409);
  assert.equal((await (await h.call('batches', { token })).json()).batches.length, 1);
  const photo = await h.call(row.imagePath.replace('/api/mobile/', ''), { token }); assert.equal(photo.status, 200); assert.match(photo.headers.get('Cache-Control'), /private/);
  h.state.identity.tenantId = '67890'; const other = await h.login('67890');
  assert.equal((await (await h.call('batches', { token: other, tenant: '67890' })).json()).batches.length, 0);
  assert.equal((await h.call(row.imagePath.replace('/api/mobile/', ''), { token: other, tenant: '67890' })).status, 404);
});
test('a phone-provided tenant, photo payload or arbitrary image URL is rejected before storage', async t => {
  const h = setup(t); const token = await h.login();
  assert.equal((await h.call('batches', { method: 'POST', body: { ...batch(), tenantId: '67890' }, token })).status, 400);
  assert.equal((await h.call('batches', { method: 'POST', body: { ...batch(), photo: 'private-photo' }, token })).status, 400);
  assert.equal((await h.call('batches', { method: 'POST', body: { ...batch(), product: { ...product, imageUrl: 'http://127.0.0.1/private' } }, token })).status, 400);
  assert.equal(h.requests.length, 1); assert.equal(h.objects.size, 0);
});
test('dates and integer counts are validated again by the server', async t => {
  const h = setup(t); const token = await h.login();
  for (const body of [{ ...batch(), expiryDate: '2030-01-01' }, { ...batch(), quantity: 1.5 }, { ...batch(), productionDate: '2026-10-19' }]) {
    assert.equal((await h.call('batches', { method: 'POST', body, token })).status, 400);
  } assert.equal(h.objects.size, 0);
});
test('image redirects, non-images and failed fetches never create a saved batch', async t => {
  const h = setup(t); const token = await h.login(); h.state.imageStatus = 302;
  assert.equal((await h.call('batches', { method: 'POST', body: batch(), token })).status, 502);
  h.state.imageStatus = 200; h.state.imageType = 'text/html';
  assert.equal((await h.call('batches', { method: 'POST', body: batch(), token })).status, 502);
  assert.equal(h.db.prepare('SELECT count(*) AS count FROM mobile_batches').get().count, 0);
  for (const call of h.requests.filter(value => value.url === product.imageUrl)) assert.equal(call.options.headers.Cookie, undefined);
});
test('logout invalidates the opaque session and cross-origin requests are denied', async t => {
  const h = setup(t); const token = await h.login();
  assert.equal((await h.call('batches', { token, headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await h.call('session', { method: 'DELETE', token })).status, 200); assert.equal((await h.call('batches', { token })).status, 401);
});
test('per-minute failed login throttling is separate from a daily trial quota', async t => {
  const h = setup(t);
  for (let i = 0; i < 6; i++) assert.equal((await h.call('sessions', { method: 'POST', body: { tenantId: '12345', qnhCookie: 'synthetic-session=wrong' } })).status, 401);
  assert.equal((await h.call('sessions', { method: 'POST', body: { tenantId: '12345', qnhCookie: COOKIE } })).status, 429);
  h.clock.time += 60001; assert.match(await h.login(), /^[a-f0-9]{64}$/);
});
