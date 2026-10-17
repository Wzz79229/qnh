import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createQnhPhoneRouter, QnhPhoneSession, QnhBrowserBudget, QNH_PHONE_DEMO_LIMITS } from '../backend/qnh-phone-router.mjs';
import { QNH_PHONE_COOKIE } from '../backend/qnh-browser-session.mjs';

const ORIGIN = 'https://phone.example.workers.dev';
const TIME = Date.parse('2026-10-17T10:00:00Z');
const SKU = '0002110713367388348481';
const PRODUCT = { sku: SKU, spu: '0002110000000000000000', name: '合成测试酸奶', spec: '200毫升', category: '测试乳品',
  barcodes: ['0001234567890'], imageUrl: 'https://img.meituan.net/empowerstoremanagement/synthetic.jpg@80w_80h_90Q' };
const JPEG = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const lease = char => char.repeat(64);

class Storage {
  constructor() { this.data = new Map(); this.alarm = null; }
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async delete(key) { this.data.delete(key); }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
}

function phoneRequest(action, { method = action === 'frame' ? 'GET' : 'POST', body = {}, cookie,
  origin = ORIGIN, site = 'same-origin', dest = 'empty', ip = '192.0.2.10', headers = {}, search = '' } = {}) {
  return new Request(`${ORIGIN}/api/qnh/login/${action}${search}`, { method, headers: {
    ...(origin ? { Origin: origin } : {}), ...(site ? { 'Sec-Fetch-Site': site } : {}),
    ...(dest ? { 'Sec-Fetch-Dest': dest } : {}), ...(cookie ? { Cookie: cookie } : {}),
    ...(ip ? { 'CF-Connecting-IP': ip } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers,
  }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
}

const cookieOf = response => response.headers.get('Set-Cookie')?.split(';')[0];
async function bodyOf(response) { return response.json(); }
const budgetRequest = (path, body) => new Request(`http://qnh-browser-budget.internal${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

function setup(options = {}) {
  let time = options.time ?? TIME;
  const now = () => time;
  const budgetStorage = new Storage();
  const budget = new QnhBrowserBudget({ storage: budgetStorage }, {}, { now });
  const calls = { phoneGet: 0, budgetGet: 0, acquisitions: 0, frames: 0, inputs: [], probes: 0, lookups: [], closes: 0, internal: [], diagnostics: [] };
  const diagnostic = (phase, code) => calls.diagnostics.push([phase, code]);
  const phones = new Map();
  const browsers = [];
  const env = {
    BROWSER: { acquire() {}, connectSession() {}, closeSession() {}, devtools: { newTarget() {} } },
    QNH_EXPECTED_TENANT_ID: '1012619', QNH_AUTH_PROBE_SKU: '2110713367388348481',
    QNH_BROWSER_ALLOWED_DOMAINS: 'qnh.meituan.com,*.meituan.com,*.meituan.net',
    QNH_BROWSER_BUDGET: { idFromName: name => name, get() { calls.budgetGet++; return { fetch: request => budget.fetch(request) }; } },
  };
  if (options.perTenant) {
    env.QNH_TENANT_MODE = 'per_tenant';
    delete env.QNH_EXPECTED_TENANT_ID;
    delete env.QNH_AUTH_PROBE_SKU;
  }
  const factory = async () => {
    calls.acquisitions++;
    if (options.startFailure) throw new Error('PRIVATE-PROVIDER-URL-wss://secret.example/token');
    const browser = {
      accessible: false,
      tenant: options.tenantIds?.[browsers.length] ?? '1012619',
      tenantId() { return this.tenant; },
      async frame() { calls.frames++; return JPEG; },
      async input(value) { calls.inputs.push(value); },
      async verifyAccess() { calls.probes++; return this.accessible; },
      async lookup(sku) { calls.lookups.push(sku); return { status: 'found', product: PRODUCT }; },
      async close() { calls.closes++; },
    };
    browsers.push(browser);
    return browser;
  };
  const makePhone = storage => new QnhPhoneSession({ storage }, env, { now, cryptoImpl: webcrypto, browserFactory: factory, diagnostic });
  env.QNH_PHONE_SESSIONS = {
    idFromName: name => name,
    get(name) {
      calls.phoneGet++;
      if (!phones.has(name)) {
        const storage = new Storage();
        phones.set(name, { storage, instance: makePhone(storage) });
      }
      return { fetch(request) {
        calls.internal.push({ url: request.url, headers: [...request.headers.entries()] });
        return phones.get(name).instance.fetch(request);
      } };
    },
  };
  const router = createQnhPhoneRouter(env, { origin: ORIGIN, now, cryptoImpl: webcrypto, diagnostic });
  return { env, router, calls, browsers, phones, budget, budgetStorage, now, advance(ms) { time += ms; },
    evict(cookie) {
      const entry = phones.get(cookie.split('=')[1]);
      entry.instance = makePhone(entry.storage);
    },
  };
}

test('public status preflight never allocates phone objects, quota, or browsers and legacy cookies cannot authorize', async () => {
  const h = setup();
  for (const cookie of [undefined, 'team-session=old', `${QNH_PHONE_COOKIE}=bad`]) {
    assert.deepEqual(await h.router.status(phoneRequest('status', { method: 'GET', cookie })),
      { authorized: false, loginMethod: 'qnh_browser', status: 'login_required' });
  }
  assert.deepEqual({ phone: h.calls.phoneGet, budget: h.calls.budgetGet, browser: h.calls.acquisitions }, { phone: 0, budget: 0, browser: 0 });
});

test('a start issues a random HttpOnly phone cookie and returns only a bounded viewer contract', async () => {
  const h = setup();
  const response = await h.router.handle(phoneRequest('start'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Set-Cookie'), /^__Host-qnh-phone=[a-f0-9]{64}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=600$/u);
  const body = await bodyOf(response);
  assert.deepEqual(Object.keys(body).sort(), ['authorized', 'expiresAt', 'loginMethod', 'status', 'viewport']);
  assert.equal(body.authorized, false);
  assert.equal(body.status, 'login');
  assert.equal(body.expiresAt, TIME + 180_000);
  assert.equal(h.calls.acquisitions, 1);
  assert.equal(h.calls.probes, 0);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(JSON.stringify(body).includes('sessionId'), false);
  const saved = await h.budgetStorage.get('budget');
  assert.equal(saved.usedMs, 240_000);
  assert.equal(Object.keys(saved.attempts)[0].length, 64);
  assert.equal(JSON.stringify(saved).includes('192.0.2.10'), false);
});

test('all forwarding uses fixed internal paths with no caller cookie, Origin, Authorization, or raw IP', async () => {
  const h = setup();
  const result = await h.router.handle(phoneRequest('start', { headers: { Authorization: 'Bearer untrusted', 'X-Proxy-Url': 'https://evil.example' } }));
  assert.equal(result.status, 200);
  assert.deepEqual(h.calls.internal[0], { url: 'http://qnh-phone.internal/start', headers: [['content-type', 'application/json']] });
});

test('mutations require the exact same origin and fetch metadata before allocating any session', async () => {
  const h = setup();
  for (const request of [phoneRequest('start', { origin: null }), phoneRequest('start', { origin: 'https://evil.example' }),
    phoneRequest('start', { site: null }), phoneRequest('start', { site: 'same-site' }), phoneRequest('start', { dest: 'document' })]) {
    const response = await h.router.handle(request);
    assert.equal(response.status, 403);
    assert.equal((await bodyOf(response)).code, 'QNH_BROWSER_ORIGIN_DENIED');
  }
  assert.equal(h.calls.phoneGet, 0);
  assert.equal(h.calls.acquisitions, 0);
});

test('GET frame accepts the browser-typical absent Origin but rejects document/cross-site/missing metadata requests', async () => {
  const h = setup();
  const cookie = cookieOf(await h.router.handle(phoneRequest('start')));
  const frame = await h.router.handle(phoneRequest('frame', { cookie, origin: null }));
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(frame.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(new Uint8Array(await frame.arrayBuffer()), JPEG);
  for (const extra of [{ site: 'cross-site' }, { site: null }, { dest: 'image' }, { dest: null }, { origin: 'https://evil.example' }]) {
    assert.equal((await h.router.handle(phoneRequest('frame', { cookie, ...extra }))).status, 403);
  }
  assert.equal(h.calls.frames, 1);
});

test('expiry diagnostics distinguish missing cookie, lost in-memory controller, and deadline using fixed enums only', async () => {
  const missing = setup();
  await missing.router.handle(phoneRequest('start'));
  const withoutCookie = await missing.router.handle(phoneRequest('frame'));
  assert.equal(withoutCookie.status, 401);
  assert.deepEqual(missing.calls.diagnostics, [['NO_PHONE_COOKIE', 'QNH_BROWSER_SESSION_EXPIRED']]);

  const evicted = setup();
  const oldCookie = cookieOf(await evicted.router.handle(phoneRequest('start')));
  evicted.evict(oldCookie);
  assert.equal((await evicted.router.handle(phoneRequest('frame', { cookie: oldCookie }))).status, 401);
  assert.deepEqual(evicted.calls.diagnostics, [
    ['RECONSTRUCTED_ACTIVE_MARKER', 'QNH_BROWSER_SESSION_EXPIRED'], ['NO_CONTROLLER', 'QNH_BROWSER_SESSION_EXPIRED'],
  ]);

  const deadline = setup();
  const expiredCookie = cookieOf(await deadline.router.handle(phoneRequest('start')));
  deadline.advance(180_000);
  assert.equal((await deadline.router.handle(phoneRequest('frame', { cookie: expiredCookie }))).status, 401);
  assert.deepEqual(deadline.calls.diagnostics, [['ABSOLUTE_DEADLINE', 'QNH_BROWSER_SESSION_EXPIRED']]);
  for (const h of [missing, evicted, deadline]) {
    const printed = JSON.stringify(h.calls.diagnostics);
    assert.equal(printed.includes('192.0.2.'), false);
    assert.equal(printed.includes('__Host-qnh-phone'), false);
    assert.equal(printed.includes('http'), false);
    assert.equal(printed.includes(SKU), false);
  }
});

test('a controller which closed independently is diagnosed without logging its browser capability', async () => {
  const h = setup();
  const cookie = cookieOf(await h.router.handle(phoneRequest('start')));
  await h.phones.get(cookie.split('=')[1]).instance.controller.close();
  const result = await h.router.handle(phoneRequest('frame', { cookie }));
  assert.equal(result.status, 401);
  assert.deepEqual(h.calls.diagnostics, [['CONTROLLER_ALREADY_CLOSED', 'QNH_BROWSER_SESSION_EXPIRED']]);
});

test('wrong methods, query strings, non-JSON, excess bytes and unexpected start fields are rejected without allocation', async () => {
  const h = setup();
  const requests = [phoneRequest('start', { method: 'GET' }), phoneRequest('start', { search: '?url=https://evil.example' }),
    phoneRequest('start', { headers: { 'Content-Type': 'text/plain' } }), phoneRequest('start', { headers: { 'Content-Encoding': 'gzip' } }),
    phoneRequest('start', { body: 'x'.repeat(4097) }), phoneRequest('start', { body: { tenantId: '1012619' } }),
    phoneRequest('start', { body: { sessionId: 'provider-id' } }), phoneRequest('start', { body: '[]' }),
    phoneRequest('start', { body: '{bad-json' })];
  for (const request of requests) assert.ok([400, 405].includes((await h.router.handle(request)).status));
  assert.equal(h.calls.phoneGet, 0);
  assert.equal(h.calls.acquisitions, 0);
  assert.equal(await h.router.handle(new Request(`${ORIGIN}/api/not-the-login-route`)), null);
});

test('missing browser, DO namespaces, tenant identity, domain policy or fresh proof configuration fails closed', async () => {
  for (const missing of ['BROWSER', 'QNH_PHONE_SESSIONS', 'QNH_BROWSER_BUDGET', 'QNH_EXPECTED_TENANT_ID', 'QNH_AUTH_PROBE_SKU', 'QNH_BROWSER_ALLOWED_DOMAINS']) {
    const h = setup();
    delete h.env[missing];
    const router = createQnhPhoneRouter(h.env, { origin: ORIGIN, cryptoImpl: webcrypto });
    assert.equal(router.configured, false, missing);
    const response = await router.handle(phoneRequest('start'));
    assert.equal(response.status, 503);
    assert.equal((await bodyOf(response)).code, 'QNH_BROWSER_NOT_CONFIGURED');
    assert.equal(h.calls.phoneGet, 0);
    assert.equal(h.calls.acquisitions, 0);
  }
});

test('repeat start uses the same phone session without another quota reservation or acquisition', async () => {
  const h = setup();
  const cookie = cookieOf(await h.router.handle(phoneRequest('start')));
  const response = await h.router.handle(phoneRequest('start', { cookie }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.has('Set-Cookie'), false);
  assert.equal(h.calls.acquisitions, 1);
  assert.equal((await h.budgetStorage.get('budget')).usedMs, 240_000);
});

test('viewer rejects arbitrary CDP, URLs, script, selectors and shortcuts before forwarding controls', async () => {
  const h = setup();
  const cookie = cookieOf(await h.router.handle(phoneRequest('start')));
  const inputs = [{ type: 'Runtime.evaluate', expression: 'forged()' }, { type: 'navigate', url: 'https://evil.example' },
    { type: 'key', key: 'F12' }, { type: 'key', key: 'Enter', modifiers: 2 }, { type: 'click', x: 1, y: 1, targetId: 'browser' },
    { type: 'click', selector: 'input' }, { type: 'text', text: 'a'.repeat(129) }];
  const before = h.calls.phoneGet;
  for (const input of inputs) assert.equal((await h.router.handle(phoneRequest('input', { cookie, body: input }))).status, 400);
  assert.equal(h.calls.phoneGet, before);
  assert.deepEqual(h.calls.inputs, []);
  const accepted = await h.router.handle(phoneRequest('input', { cookie, body: { type: 'click', x: 60.5, y: 80.5 } }));
  assert.equal(accepted.status, 200);
  assert.deepEqual(h.calls.inputs, [{ type: 'click', x: 60, y: 80 }]);
});

test('only fresh server access proof unlocks the phone, and protected status rechecks proof instead of trusting a cookie', async () => {
  const h = setup();
  const cookie = cookieOf(await h.router.handle(phoneRequest('start')));
  let response = await h.router.handle(phoneRequest('verify', { cookie }));
  assert.equal((await bodyOf(response)).authorized, false);
  h.browsers[0].accessible = true;
  response = await h.router.handle(phoneRequest('verify', { cookie }));
  const ready = await bodyOf(response);
  assert.equal(ready.authorized, true);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.tenantId, '1012619');
  assert.equal(ready.expiresAt, TIME + 225_000);
  const probes = h.calls.probes;
  assert.equal((await h.router.status(phoneRequest('status', { method: 'GET', cookie, origin: null }))).authorized, true);
  assert.equal(h.calls.probes, probes + 1);
  h.browsers[0].accessible = false;
  assert.equal((await h.router.status(phoneRequest('status', { method: 'GET', cookie }))).authorized, false);
  assert.equal(h.calls.closes, 1);
});

test('a phone cannot authorize another phone and login browser state is never shared', async () => {
  const h = setup();
  const first = cookieOf(await h.router.handle(phoneRequest('start')));
  h.browsers[0].accessible = true;
  assert.equal((await bodyOf(await h.router.handle(phoneRequest('verify', { cookie: first })))).authorized, true);
  h.advance(21_000);
  const second = cookieOf(await h.router.handle(phoneRequest('start', { ip: '192.0.2.11' })));
  assert.notEqual(first, second);
  assert.equal(h.calls.acquisitions, 2);
  assert.equal((await h.router.status(phoneRequest('status', { method: 'GET', cookie: second }))).authorized, false);
  assert.equal((await h.router.status(phoneRequest('status', { method: 'GET', cookie: first }))).authorized, true);
});

test('per-tenant login is configured without a fixed tenant or probe SKU and exposes identity only after fresh authorization', async () => {
  const h = setup({ perTenant: true, tenantIds: ['97654321'] });
  assert.equal(h.env.QNH_EXPECTED_TENANT_ID, undefined);
  assert.equal(h.env.QNH_AUTH_PROBE_SKU, undefined);
  assert.equal(h.router.configured, true);
  const start = await h.router.handle(phoneRequest('start'));
  const cookie = cookieOf(start);
  assert.equal(start.status, 200);
  assert.equal(Object.hasOwn(await bodyOf(start), 'tenantId'), false);
  const pending = await bodyOf(await h.router.handle(phoneRequest('verify', { cookie })));
  assert.equal(pending.authorized, false);
  assert.equal(Object.hasOwn(pending, 'tenantId'), false);
  h.browsers[0].accessible = true;
  const ready = await bodyOf(await h.router.handle(phoneRequest('verify', { cookie })));
  assert.equal(ready.authorized, true);
  assert.equal(ready.tenantId, '97654321');
  const marker = await h.phones.get(cookie.split('=')[1]).storage.get('session');
  assert.equal(Object.hasOwn(marker, 'tenantId'), false);
  assert.equal(Object.hasOwn(marker, 'authorized'), false);
});

test('different actual tenants are bound separately to their own phone sessions', async () => {
  const h = setup({ perTenant: true, tenantIds: ['1012619', '97654321'] });
  const first = cookieOf(await h.router.handle(phoneRequest('start')));
  h.browsers[0].accessible = true;
  await h.router.handle(phoneRequest('verify', { cookie: first }));
  h.advance(21_000);
  const second = cookieOf(await h.router.handle(phoneRequest('start', { ip: '192.0.2.11' })));
  h.browsers[1].accessible = true;
  await h.router.handle(phoneRequest('verify', { cookie: second }));
  const a = await h.router.status(phoneRequest('status', { method: 'GET', cookie: first }));
  const b = await h.router.status(phoneRequest('status', { method: 'GET', cookie: second }));
  assert.equal(a.authorized, true);
  assert.equal(b.authorized, true);
  assert.equal(a.tenantId, '1012619');
  assert.equal(b.tenantId, '97654321');
  assert.notEqual(a.tenantId, b.tenantId);
});

test('client-selected tenants are rejected in per-tenant start, verify and lookup contracts', async () => {
  const h = setup({ perTenant: true });
  assert.equal((await h.router.handle(phoneRequest('start', { body: { tenantId: '97654321' } }))).status, 400);
  assert.equal(h.calls.acquisitions, 0);
  const cookie = cookieOf(await h.router.handle(phoneRequest('start')));
  assert.equal((await h.router.handle(phoneRequest('verify', { cookie, body: { tenantId: '97654321' } }))).status, 400);
  const entry = h.phones.get(cookie.split('=')[1]);
  const forged = await entry.instance.fetch(new Request('http://qnh-phone.internal/lookup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku: SKU, tenantId: '97654321' }),
  }));
  assert.equal(forged.status, 400);
  assert.equal(h.calls.lookups.length, 0);
});

test('an authorized phone cannot change its bound tenant through a later proof status', async () => {
  const h = setup({ perTenant: true });
  const cookie = cookieOf(await h.router.handle(phoneRequest('start')));
  h.browsers[0].accessible = true;
  assert.equal((await bodyOf(await h.router.handle(phoneRequest('verify', { cookie })))).tenantId, '1012619');
  h.browsers[0].tenant = '97654321';
  const status = await h.router.status(phoneRequest('status', { method: 'GET', cookie }));
  assert.equal(status.authorized, false);
  assert.equal(Object.hasOwn(status, 'tenantId'), false);
  assert.equal(h.calls.closes, 1);
  await assert.rejects(h.router.lookup(phoneRequest('lookup', { method: 'GET', cookie }), SKU), error => error.code === 'QNH_BROWSER_SESSION_EXPIRED');
  assert.equal(h.calls.lookups.length, 0);
});

test('an invalid or missing tenant identity never yields an authorized phone status', async () => {
  for (const invalidTenant of ['', '0', '../97654321', 97654321, '97654321/another', '9'.repeat(21)]) {
    const h = setup({ perTenant: true });
    const cookie = cookieOf(await h.router.handle(phoneRequest('start')));
    h.browsers[0].accessible = true;
    h.browsers[0].tenant = invalidTenant;
    const response = await h.router.handle(phoneRequest('verify', { cookie }));
    assert.ok(response.status >= 400);
    assert.notEqual((await bodyOf(response)).authorized, true);
    assert.equal(h.calls.closes, 1);
    assert.equal((await h.router.status(phoneRequest('status', { method: 'GET', cookie }))).authorized, false);
  }
});

test('a tenant change also prevents direct lookup even if no status endpoint was called first', async () => {
  const h = setup({ perTenant: true });
  const cookie = cookieOf(await h.router.handle(phoneRequest('start')));
  h.browsers[0].accessible = true;
  await h.router.handle(phoneRequest('verify', { cookie }));
  h.browsers[0].tenant = '97654321';
  await assert.rejects(h.router.lookup(phoneRequest('lookup', { method: 'GET', cookie }), SKU), error => error.code === 'QNH_BROWSER_SESSION_EXPIRED');
  assert.equal(h.calls.lookups.length, 0);
  assert.equal(h.calls.closes, 1);
});

test('live SKU lookup preserves leading zeros, requires phone authorization and checks proof again', async () => {
  const h = setup();
  const cookie = cookieOf(await h.router.handle(phoneRequest('start')));
  await assert.rejects(h.router.lookup(phoneRequest('lookup', { method: 'GET', cookie }), SKU), error => error.code === 'QNH_BROWSER_LOGIN_REQUIRED');
  h.browsers[0].accessible = true;
  await h.router.handle(phoneRequest('verify', { cookie }));
  const probes = h.calls.probes;
  const result = await h.router.lookup(phoneRequest('lookup', { method: 'GET', cookie }), SKU);
  assert.equal(result.status, 'found');
  assert.equal(result.product.sku, SKU);
  assert.deepEqual(h.calls.lookups, [SKU]);
  assert.equal(h.calls.probes, probes + 2);
  h.browsers[0].accessible = false;
  await assert.rejects(h.router.lookup(phoneRequest('lookup', { method: 'GET', cookie }), SKU), error => error.code === 'QNH_BROWSER_SESSION_EXPIRED');
  assert.deepEqual(h.calls.lookups, [SKU]);
});

test('after authorization all viewer input and frame capture are frozen', async () => {
  const h = setup();
  const cookie = cookieOf(await h.router.handle(phoneRequest('start')));
  h.browsers[0].accessible = true;
  await h.router.handle(phoneRequest('verify', { cookie }));
  const input = await h.router.handle(phoneRequest('input', { cookie, body: { type: 'key', key: 'Enter' } }));
  assert.equal(input.status, 409);
  assert.equal((await bodyOf(input)).code, 'QNH_BROWSER_INPUT_FROZEN');
  assert.equal((await h.router.handle(phoneRequest('frame', { cookie }))).status, 409);
  assert.deepEqual(h.calls.inputs, []);
  assert.equal(h.calls.frames, 0);
});

test('cancel closes the browser, removes only its own lease and clears the opaque cookie without refunding time', async () => {
  const h = setup();
  const cookie = cookieOf(await h.router.handle(phoneRequest('start')));
  const response = await h.router.handle(phoneRequest('cancel', { cookie }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/u);
  assert.equal(h.calls.closes, 1);
  const saved = await h.budgetStorage.get('budget');
  assert.equal(saved.active.length, 0);
  assert.equal(saved.usedMs, 240_000);
  assert.equal((await h.router.status(phoneRequest('status', { method: 'GET', cookie }))).authorized, false);
  assert.equal(h.calls.acquisitions, 1);
});

test('an explicitly restarted expired/cancelled phone always receives a new cookie and a new object, including after eviction', async () => {
  const h = setup();
  const first = cookieOf(await h.router.handle(phoneRequest('start')));
  await h.router.handle(phoneRequest('cancel', { cookie: first }));
  h.evict(first);
  h.advance(21_000);
  const restarted = await h.router.handle(phoneRequest('start', { cookie: first }));
  assert.equal(restarted.status, 200);
  assert.notEqual(cookieOf(restarted), first);
  assert.equal(h.calls.acquisitions, 2);
  assert.equal(h.phones.size, 2);
  const old = h.phones.get(first.split('=')[1]);
  assert.equal(await old.storage.get('retired'), true);
  assert.equal(await old.storage.get('session'), undefined);
});

test('failed browser acquisitions consume a full reservation and errors never reflect provider capabilities', async () => {
  const h = setup({ startFailure: true });
  const response = await h.router.handle(phoneRequest('start'));
  assert.equal(response.status, 502);
  assert.equal(response.headers.has('Set-Cookie'), false);
  const text = await response.text();
  assert.equal(text.includes('PRIVATE-PROVIDER'), false);
  assert.equal(text.includes('wss://'), false);
  assert.equal((await h.budgetStorage.get('budget')).usedMs, 240_000);
  h.advance(21_000);
  assert.equal((await h.router.handle(phoneRequest('start'))).status, 502);
  h.advance(21_000);
  const denied = await h.router.handle(phoneRequest('start'));
  assert.equal(denied.status, 429);
  assert.equal((await bodyOf(denied)).code, 'QNH_BROWSER_DEMO_LIMIT');
  assert.equal(h.calls.acquisitions, 2);
});

test('global rate and time allowance serialize simultaneous starts and deny further starts after cancellation', async () => {
  const h = setup();
  const results = await Promise.all([h.router.handle(phoneRequest('start')), h.router.handle(phoneRequest('start', { ip: '192.0.2.11' }))]);
  assert.deepEqual(results.map(value => value.status).sort(), [200, 429]);
  const rate = results.find(value => value.status === 429);
  assert.equal(rate.headers.get('Retry-After'), '21');
  assert.equal((await bodyOf(rate)).code, 'QNH_BROWSER_START_RATE');
  const first = results.find(value => value.status === 200);
  await h.router.handle(phoneRequest('cancel', { cookie: cookieOf(first) }));
  h.advance(21_000);
  const second = await h.router.handle(phoneRequest('start', { ip: '192.0.2.11' }));
  assert.equal(second.status, 200);
  await h.router.handle(phoneRequest('cancel', { cookie: cookieOf(second) }));
  h.advance(21_000);
  const denied = await h.router.handle(phoneRequest('start', { ip: '192.0.2.12' }));
  assert.equal(denied.status, 429);
  assert.equal((await h.budgetStorage.get('budget')).usedMs, QNH_PHONE_DEMO_LIMITS.dailyMs);
  assert.equal(h.calls.acquisitions, 2);
});

test('absolute login alarm closes the session and never silently restores or acquires another browser', async () => {
  const h = setup();
  const cookie = cookieOf(await h.router.handle(phoneRequest('start')));
  const entry = h.phones.get(cookie.split('=')[1]);
  assert.equal(entry.storage.alarm, TIME + 180_000);
  h.advance(180_000);
  await entry.instance.alarm();
  assert.equal(h.calls.closes, 1);
  assert.equal(entry.storage.alarm, null);
  assert.equal(await entry.storage.get('session'), undefined);
  assert.equal((await h.router.status(phoneRequest('status', { method: 'GET', cookie }))).authorized, false);
  assert.equal(h.calls.acquisitions, 1);
});

test('an evicted phone object never restores authorization or credentials and retains its unproven remote lease', async () => {
  const h = setup();
  const cookie = cookieOf(await h.router.handle(phoneRequest('start')));
  h.browsers[0].accessible = true;
  await h.router.handle(phoneRequest('verify', { cookie }));
  const entry = h.phones.get(cookie.split('=')[1]);
  const saved = await entry.storage.get('session');
  assert.deepEqual(Object.keys(saved).sort(), ['absoluteExpiresAt', 'expiresAt', 'leaseId']);
  assert.equal(JSON.stringify(saved).includes('authorized'), false);
  h.evict(cookie);
  assert.equal((await h.router.status(phoneRequest('status', { method: 'GET', cookie }))).authorized, false);
  assert.equal(h.calls.acquisitions, 1);
  assert.equal((await h.budgetStorage.get('budget')).active.length, 1);
});

test('the active authorized deadline is conservatively shorter than the reserved time and enforces cleanup on access', async () => {
  const h = setup();
  const cookie = cookieOf(await h.router.handle(phoneRequest('start')));
  h.browsers[0].accessible = true;
  await h.router.handle(phoneRequest('verify', { cookie }));
  const entry = h.phones.get(cookie.split('=')[1]);
  assert.equal(entry.storage.alarm, TIME + QNH_PHONE_DEMO_LIMITS.reservationMs - QNH_PHONE_DEMO_LIMITS.cleanupMs);
  h.advance(225_000);
  assert.equal((await h.router.status(phoneRequest('status', { method: 'GET', cookie }))).authorized, false);
  assert.equal(h.calls.closes, 1);
  assert.equal(h.calls.acquisitions, 1);
});

test('budget contracts reject arbitrary origins/paths, malformed leases and client-selected duration', async () => {
  const h = setup();
  const good = { leaseId: lease('a'), ipHash: lease('b'), maximumMs: 240_000 };
  for (const body of [{ ...good, maximumMs: 600_000 }, { ...good, leaseId: 'bad' }, { ...good, ipHash: '192.0.2.1' },
    { ...good, url: 'https://evil.example' }, { ...good, maximumMs: '240000' }]) {
    assert.equal((await h.budget.fetch(budgetRequest('/reserve', body))).status, 400);
  }
  assert.equal((await h.budget.fetch(new Request('https://public.example/reserve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(good),
  }))).status, 400);
  assert.equal(await h.budgetStorage.get('budget'), undefined);
});

test('daily budget resets only on the UTC boundary; partial reservations cannot run across midnight', async () => {
  const midnight = Date.parse('2026-10-18T00:00:00Z');
  const h = setup({ time: midnight - 40_000 });
  const first = await h.budget.fetch(budgetRequest('/reserve', { leaseId: lease('a'), ipHash: lease('b'), maximumMs: 240_000 }));
  assert.equal(first.status, 200);
  assert.equal((await bodyOf(first)).expiresAt, midnight - 15_000);
  assert.equal((await h.budgetStorage.get('budget')).usedMs, 40_000);
  h.advance(40_000);
  const next = await h.budget.fetch(budgetRequest('/reserve', { leaseId: lease('c'), ipHash: lease('b'), maximumMs: 240_000 }));
  assert.equal(next.status, 200);
  const saved = await h.budgetStorage.get('budget');
  assert.equal(saved.usedMs, 240_000);
  assert.equal(saved.active.length, 1);
  assert.deepEqual(saved.attempts, { [lease('b')]: 1 });
});

test('insufficient midnight cleanup allowance refuses acquisition, and budget alarm removes expired leases', async () => {
  const midnight = Date.parse('2026-10-18T00:00:00Z');
  const near = setup({ time: midnight - 15_000 });
  assert.equal((await near.budget.fetch(budgetRequest('/reserve', {
    leaseId: lease('a'), ipHash: lease('b'), maximumMs: 240_000,
  }))).status, 429);
  const h = setup();
  await h.budget.fetch(budgetRequest('/reserve', { leaseId: lease('a'), ipHash: lease('b'), maximumMs: 240_000 }));
  h.advance(240_000);
  await h.budget.alarm();
  const saved = await h.budgetStorage.get('budget');
  assert.equal(saved.active.length, 0);
  assert.equal(saved.usedMs, 240_000);
  assert.equal(h.budgetStorage.alarm, null);
});

test('phone DO rejects publicly addressed and unexpected internal contracts without reading or allocating a browser', async () => {
  const h = setup();
  const instance = new QnhPhoneSession({ storage: new Storage() }, h.env, { now: h.now, cryptoImpl: webcrypto, browserFactory() { throw new Error('must not allocate'); } });
  const publicResponse = await instance.fetch(phoneRequest('start'));
  assert.equal(publicResponse.status, 400);
  const extra = await instance.fetch(new Request('http://qnh-phone.internal/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ipHash: 'unknown', sessionId: 'forged' }),
  }));
  assert.equal(extra.status, 400);
  assert.equal(h.calls.budgetGet, 0);
});
