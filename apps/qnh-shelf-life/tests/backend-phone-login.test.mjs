import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createWorker } from '../backend/worker.mjs';
import { QNH_PHONE_COOKIE } from '../backend/qnh-browser-session.mjs';

const ORIGIN = 'https://qnh-shelf-life-api.w792294944.workers.dev';
const PAGES = 'https://wzz79229.github.io';
const TIME = Date.parse('2026-10-17T10:00:00Z');
const PHONE = 'a'.repeat(64);
const SECOND_PHONE = 'b'.repeat(64);
const PHONE_COOKIE = `${QNH_PHONE_COOKIE}=${PHONE}`;
const TENANT_A = '1012619';
const TENANT_B = '97654321';
const SHA = 'c'.repeat(40);
const SKU = '0002110713367388348481';
const PRODUCT = { sku: SKU, name: '合成测试酸奶', spec: '200毫升',
  imageUrl: 'https://img.meituan.net/empowerstoremanagement/synthetic.jpg@80w_80h_90Q' };
const state = () => ({ schemaVersion: 1, records: [], settings: { urgentDays: 7, warningDays: 30 }, updatedAt: '2026-10-17T10:00:00.000Z' });
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});
const file = value => ({ type: 'file', encoding: 'base64', sha: SHA,
  content: Buffer.from(JSON.stringify(value), 'utf8').toString('base64') });

function harness({ initiallyAuthorized = false, tenantId = TENANT_A, statusReply, lookupReply, startReply, cancelReply, networkReply } = {}) {
  let isAuthorized = initiallyAuthorized;
  const calls = { phone: [], browser: 0, budget: 0, github: [] };
  const env = {
    GITHUB_TOKEN: 'github_pat_phone_integration_test_only', MEMBER_AUTH_MODE: 'qnh', ALLOWED_ORIGIN: PAGES,
    QNH_TENANT_MODE: 'per_tenant',
    QNH_BROWSER_ALLOWED_DOMAINS: 'qnh.meituan.com,*.meituan.com,*.meituan.net',
    BROWSER: { acquire() { calls.browser++; throw new Error('a Worker integration test must not acquire a cloud browser'); },
      connectSession() { throw new Error('must not connect a cloud browser'); },
      closeSession() { throw new Error('must not close a cloud browser'); }, devtools: { newTarget() { throw new Error('must not create a cloud target'); } } },
    QNH_BROWSER_BUDGET: { idFromName: name => name, get() { calls.budget++; throw new Error('fake phone objects own no real quota'); } },
    QNH_PHONE_SESSIONS: {
      idFromName: name => name,
      get(phone) {
        return { async fetch(request) {
          const url = new URL(request.url);
          const body = await request.json();
          calls.phone.push({ phone, url: request.url, path: url.pathname, method: request.method, headers: [...request.headers.entries()], body });
          const status = { authorized: isAuthorized, loginMethod: 'qnh_browser', status: isAuthorized ? 'ready' : 'login',
            expiresAt: TIME + 180_000, viewport: { width: 1280, height: 900 }, ...(isAuthorized ? { tenantId } : {}) };
          if (url.pathname === '/status' || url.pathname === '/verify') return statusReply ? statusReply(phone, body) : response(status);
          if (url.pathname === '/start') return startReply ? startReply(phone, body) : response({ ...status, authorized: false, status: 'login' });
          if (url.pathname === '/lookup') return lookupReply ? lookupReply(phone, body) : response({ status: 'found', product: PRODUCT });
          if (url.pathname === '/cancel') return cancelReply ? cancelReply(phone, body) : response({ authorized: false, loginMethod: 'qnh_browser', status: 'expired' });
          throw new Error('unexpected internal phone route');
        } };
      },
    },
  };
  const worker = createWorker({ now: () => TIME, cryptoImpl: webcrypto, fetchImpl: async (url, options) => {
    calls.github.push({ url, options });
    if (!networkReply) throw new Error('unexpected GitHub access');
    return typeof networkReply === 'function' ? networkReply(url, options) : networkReply;
  } });
  const request = (path, { method = 'GET', cookie, body, origin = ORIGIN, site = 'same-origin', dest = 'empty', headers = {}, environment = env } = {}) => {
    const reqHeaders = { ...(origin ? { Origin: origin } : {}), ...(site ? { 'Sec-Fetch-Site': site } : {}),
      ...(dest ? { 'Sec-Fetch-Dest': dest } : {}), ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers };
    return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: reqHeaders,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), environment);
  };
  return { calls, env, worker, request, set authorized(value) { isAuthorized = value; } };
}

test('configured phone login is advertised without allocating a DO, browser, budget or GitHub read', async () => {
  const h = harness();
  const result = await h.request('/api/session', { origin: null });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { configured: true, authorized: false, loginMethod: 'qnh_browser', loginAvailable: true,
    message: '请在鲜期内登录牵牛花。' });
  assert.deepEqual(h.calls, { phone: [], browser: 0, budget: 0, github: [] });
  assert.match(result.headers.get('Cache-Control'), /no-store/u);
});

test('no phone cookie denies both batch reads and writes before contacting GitHub', async () => {
  const h = harness();
  for (const options of [{}, { method: 'PUT', body: { data: state(), expectedSha: null } }]) {
    const result = await h.request('/api/state', options);
    assert.equal(result.status, 401);
    assert.equal((await result.json()).code, 'AUTH_REQUIRED');
  }
  assert.deepEqual(h.calls, { phone: [], browser: 0, budget: 0, github: [] });
});

test('fresh phone authorization enables only its tenant batch-file read and never forwards phone cookies to GitHub', async () => {
  const h = harness({ initiallyAuthorized: true, networkReply: response(file(state())) });
  const result = await h.request('/api/state', { cookie: PHONE_COOKIE, origin: null });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { data: state(), sha: SHA });
  assert.equal(h.calls.phone.length, 1);
  assert.equal(h.calls.phone[0].phone, PHONE);
  assert.equal(h.calls.phone[0].path, '/status');
  assert.equal(h.calls.github.length, 1);
  const { url, options } = h.calls.github[0];
  assert.equal(url, `https://api.github.com/repos/Wzz79229/bzq/contents/data/tenants/${TENANT_A}/shelf-life.json?ref=main`);
  assert.equal(options.headers.Authorization, `Bearer ${h.env.GITHUB_TOKEN}`);
  assert.equal(options.headers.Cookie, undefined);
  assert.equal(options.redirect, 'manual');
  assert.equal(Object.hasOwn(options, 'credentials'), false);
  assert.equal(h.calls.browser, 0);
  assert.equal(h.calls.budget, 0);
});

test('logged-out or expired phone proof cannot read batches even with a well-formed opaque cookie', async () => {
  for (const statusReply of [
    () => response({ authorized: false, loginMethod: 'qnh_browser', status: 'login' }),
    () => response({ code: 'QNH_BROWSER_SESSION_EXPIRED', error: 'PRIVATE-SESSION-DETAIL' }, 401),
    () => response({ code: 'QNH_BROWSER_LOGIN_REQUIRED', error: 'PRIVATE-SESSION-DETAIL' }, 401),
    () => response({ authorized: 'true', loginMethod: 'qnh_browser', status: 'ready' }),
  ]) {
    const h = harness({ statusReply });
    const result = await h.request('/api/state', { cookie: PHONE_COOKIE });
    assert.equal(result.status, 401);
    assert.equal((await result.json()).code, 'AUTH_REQUIRED');
    assert.equal(h.calls.phone.length, 1);
    assert.equal(h.calls.github.length, 0);
  }
});

test('authorized proof without a valid server tenant never grants access to any batch file', async () => {
  for (const tenantId of [undefined, '', '0', 1012619, '../97654321', '1012619/another', '9'.repeat(21)]) {
    const h = harness({ statusReply: () => response({ authorized: true, loginMethod: 'qnh_browser', status: 'ready',
      ...(tenantId === undefined ? {} : { tenantId }) }) });
    const result = await h.request('/api/state', { cookie: PHONE_COOKIE });
    assert.equal(result.status, 401);
    assert.equal((await result.json()).code, 'AUTH_REQUIRED');
    assert.equal(h.calls.github.length, 0);
    const session = await h.request('/api/session', { cookie: PHONE_COOKIE });
    const body = await session.json();
    assert.equal(body.authorized, false);
    assert.equal(Object.hasOwn(body, 'tenantId'), false);
  }
});

test('two actual login tenants read and save separate GitHub files without ever reading the former shared file', async () => {
  const snapshots = new Map([[TENANT_A, { data: state(), sha: SHA }], [TENANT_B, {
    data: { ...state(), settings: { urgentDays: 9, warningDays: 45 } }, sha: SHA,
  }]]);
  const h = harness({
    statusReply: phone => response({ authorized: true, loginMethod: 'qnh_browser', status: 'ready', tenantId: phone === PHONE ? TENANT_A : TENANT_B }),
    networkReply(url, options) {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://api.github.com');
      const match = /^\/repos\/Wzz79229\/bzq\/contents\/data\/tenants\/([1-9][0-9]*)\/shelf-life\.json$/u.exec(parsed.pathname);
      assert.ok(match, 'phone access must never fall back to the old shared file or another repository');
      const saved = snapshots.get(match[1]);
      assert.ok(saved);
      if (options.method !== 'PUT') return response({ ...file(saved.data), sha: saved.sha });
      const body = JSON.parse(options.body);
      assert.equal(body.sha, saved.sha);
      assert.equal(body.branch, 'main');
      saved.data = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      saved.sha = (match[1] === TENANT_A ? 'd' : 'e').repeat(40);
      return response({ content: { sha: saved.sha } });
    },
  });
  const secondCookie = `${QNH_PHONE_COOKIE}=${SECOND_PHONE}`;
  const firstRead = await (await h.request('/api/state', { cookie: PHONE_COOKIE })).json();
  const secondRead = await (await h.request('/api/state', { cookie: secondCookie })).json();
  assert.equal(firstRead.data.settings.urgentDays, 7);
  assert.equal(secondRead.data.settings.urgentDays, 9);
  const a = { ...firstRead.data, settings: { urgentDays: 3, warningDays: 30 } };
  const b = { ...secondRead.data, settings: { urgentDays: 5, warningDays: 45 } };
  assert.equal((await h.request('/api/state', { method: 'PUT', cookie: PHONE_COOKIE, body: { data: a, expectedSha: firstRead.sha } })).status, 200);
  assert.equal((await h.request('/api/state', { method: 'PUT', cookie: secondCookie, body: { data: b, expectedSha: secondRead.sha } })).status, 200);
  assert.deepEqual(snapshots.get(TENANT_A).data, a);
  assert.deepEqual(snapshots.get(TENANT_B).data, b);
  const writes = h.calls.github.filter(value => value.options.method === 'PUT');
  assert.equal(writes.length, 2);
  assert.equal(new URL(writes[0].url).pathname, `/repos/Wzz79229/bzq/contents/data/tenants/${TENANT_A}/shelf-life.json`);
  assert.equal(new URL(writes[1].url).pathname, `/repos/Wzz79229/bzq/contents/data/tenants/${TENANT_B}/shelf-life.json`);
  assert.equal(h.calls.github.some(value => new URL(value.url).pathname === '/repos/Wzz79229/bzq/contents/data/shelf-life.json'), false);
});

test('request parameters and headers cannot select another tenant or restore the old shared storage path', async () => {
  const h = harness({ initiallyAuthorized: true, networkReply: response(file(state())) });
  const query = await h.request(`/api/state?tenantId=${TENANT_B}`, { cookie: PHONE_COOKIE });
  assert.equal(query.status, 404);
  const forged = await h.request('/api/state', { method: 'PUT', cookie: PHONE_COOKIE,
    body: { data: state(), expectedSha: SHA, tenantId: TENANT_B } });
  assert.equal(forged.status, 400);
  assert.equal((await forged.json()).code, 'INVALID_FIELDS');
  assert.equal(h.calls.github.length, 0);
  const read = await h.request('/api/state', { cookie: PHONE_COOKIE, headers: {
    'X-Qnh-Tenant-Id': TENANT_B, 'X-GitHub-Path': 'data/shelf-life.json',
  } });
  assert.equal(read.status, 200);
  assert.equal(h.calls.github.length, 1);
  assert.equal(new URL(h.calls.github[0].url).pathname, `/repos/Wzz79229/bzq/contents/data/tenants/${TENANT_A}/shelf-life.json`);
});

test('shared catalog and photo endpoints stay unavailable to phone sessions without touching GitHub', async () => {
  const h = harness({ initiallyAuthorized: true });
  for (const [path, options] of [['/api/catalog', {}], ['/api/catalog/pages/0', {}],
    ['/api/photos/36b8f84d-df4e-4d49-b662-bcde71a8764f', {}], ['/api/photos', { method: 'POST', body: {} }]]) {
    const result = await h.request(path, { cookie: PHONE_COOKIE, ...options });
    assert.equal(result.status, 404);
    assert.equal((await result.json()).code, 'NOT_FOUND');
  }
  assert.equal(h.calls.github.length, 0);
});

test('phone batch saves reject photo references before any GitHub read or upload', async () => {
  const h = harness({ initiallyAuthorized: true });
  const id = '36b8f84d-df4e-4d49-b662-bcde71a8764f';
  const data = { ...state(), records: [{ id: 'synthetic-batch', name: '合成测试酸奶', barcode: '', category: '', location: '', batchCode: '',
    productionDate: '2026-10-17', shelfLife: 14, shelfUnit: 'day', expiryDate: '2026-10-31', quantity: 5,
    unit: '件', note: '', status: 'active', handledAt: '', handledReason: '', updatedAt: '2026-10-17T10:00:00.000Z',
    photoRefs: [{ id, path: `photos/${id}.jpg` }] }] };
  const result = await h.request('/api/state', { method: 'PUT', cookie: PHONE_COOKIE, body: { data, expectedSha: SHA } });
  assert.equal(result.status, 400);
  assert.equal((await result.json()).code, 'INVALID_PHOTOS');
  assert.equal(h.calls.github.length, 0);
});

test('a later fresh-proof failure revokes batch access instead of caching the previous successful login', async () => {
  const h = harness({ initiallyAuthorized: true, networkReply: response(file(state())) });
  const first = await h.request('/api/state', { cookie: PHONE_COOKIE });
  assert.equal(first.status, 200);
  h.authorized = false;
  const second = await h.request('/api/state', { cookie: PHONE_COOKIE });
  assert.equal(second.status, 401);
  assert.equal(h.calls.phone.filter(value => value.path === '/status').length, 2);
  assert.equal(h.calls.github.length, 1);
});

test('SKU query returns directly from this phone session with leading zeros and no GitHub queue', async () => {
  const h = harness({ initiallyAuthorized: true });
  const result = await h.request('/api/qnh/queries', { method: 'POST', cookie: PHONE_COOKIE, body: { sku: SKU } });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { status: 'found', product: PRODUCT, mode: 'direct', sku: SKU });
  assert.deepEqual(h.calls.phone.map(value => ({ phone: value.phone, path: value.path })), [
    { phone: PHONE, path: '/status' }, { phone: PHONE, path: '/lookup' },
  ]);
  assert.deepEqual(h.calls.phone[1].body, { sku: SKU });
  assert.equal(h.calls.github.length, 0);
  assert.equal(h.calls.browser, 0);
  assert.equal(h.calls.budget, 0);
});

test('different phones retain independent product results and cannot borrow another phone authorization', async () => {
  const h = harness({ statusReply: phone => response({ authorized: phone === PHONE, loginMethod: 'qnh_browser', status: phone === PHONE ? 'ready' : 'login',
    ...(phone === PHONE ? { tenantId: TENANT_A } : {}) }),
    lookupReply: phone => {
      assert.equal(phone, PHONE);
      return response({ status: 'found', product: PRODUCT });
    } });
  const denied = await h.request('/api/qnh/queries', { method: 'POST', cookie: `${QNH_PHONE_COOKIE}=${SECOND_PHONE}`, body: { sku: SKU } });
  assert.equal(denied.status, 401);
  const allowed = await h.request('/api/qnh/queries', { method: 'POST', cookie: PHONE_COOKIE, body: { sku: SKU } });
  assert.equal(allowed.status, 200);
  assert.equal(h.calls.phone.filter(value => value.path === '/lookup').length, 1);
  assert.equal(h.calls.github.length, 0);
});

test('old desktop queue polling is not exposed by the phone direct-query route', async () => {
  const h = harness({ initiallyAuthorized: true });
  const result = await h.request('/api/qnh/queries/old-desktop-query-id', { cookie: PHONE_COOKIE });
  assert.equal(result.status, 404);
  assert.equal((await result.json()).code, 'NOT_FOUND');
  assert.equal(h.calls.github.length, 0);
  assert.equal(h.calls.phone.some(value => value.path === '/lookup'), false);
});

test('logout cancels the phone and clears its cookie even when checking fresh proof would fail', async () => {
  const h = harness({ statusReply: () => { throw new Error('fresh proof must not be needed to log out'); } });
  const result = await h.request('/api/logout', { method: 'POST', cookie: PHONE_COOKIE });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { configured: true, authorized: false, loginMethod: 'qnh_browser' });
  assert.match(result.headers.get('Set-Cookie'), /^__Host-qnh-phone=;.*Max-Age=0/u);
  assert.deepEqual(h.calls.phone.map(value => value.path), ['/cancel']);
  assert.equal(h.calls.github.length, 0);
});

test('the inline login start route works before authorization and issues the opaque cookie without a team password', async () => {
  const h = harness();
  const result = await h.request('/api/qnh/login/start', { method: 'POST', body: {} });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('Set-Cookie'), /^__Host-qnh-phone=[a-f0-9]{64};.*HttpOnly.*SameSite=Strict/u);
  assert.equal((await result.json()).authorized, false);
  assert.deepEqual(h.calls.phone.map(value => value.path), ['/start']);
  assert.equal(h.calls.phone[0].url, 'http://qnh-phone.internal/start');
  assert.deepEqual(h.calls.phone[0].headers, [['content-type', 'application/json']]);
  assert.deepEqual(h.calls.phone[0].body, { ipHash: 'unknown' });
  assert.equal(h.calls.github.length, 0);
});

test('a genuine legacy team cookie still cannot replace phone login in qnh mode', async () => {
  const h = harness();
  const legacy = { ...h.env, MEMBER_AUTH_MODE: 'legacy', TEAM_PASSWORD: 'test-team-password-for-migration',
    SESSION_SECRET: 'test-migration-session-secret-more-than-32-characters' };
  const login = await h.request('/api/login', { method: 'POST', environment: legacy, body: { password: legacy.TEAM_PASSWORD } });
  assert.equal(login.status, 200);
  const oldCookie = login.headers.get('Set-Cookie').split(';')[0];
  const result = await h.request('/api/state', { cookie: oldCookie });
  assert.equal(result.status, 401);
  assert.equal((await result.json()).code, 'AUTH_REQUIRED');
  assert.equal(h.calls.phone.length, 0);
  assert.equal(h.calls.github.length, 0);
  const fallback = await h.request('/api/login', { method: 'POST', body: { password: legacy.TEAM_PASSWORD } });
  assert.equal(fallback.status, 503);
  assert.equal((await fallback.json()).code, 'QNH_LOGIN_NOT_CONNECTED');
});

test('cross-site and Pages-origin inline-login attempts are rejected before phone object allocation', async () => {
  const h = harness();
  for (const values of [{ origin: 'https://evil.example', site: 'cross-site' }, { origin: PAGES, site: 'cross-site' },
    { origin: ORIGIN, site: 'same-site' }, { origin: null }, { dest: 'document' }]) {
    const result = await h.request('/api/qnh/login/start', { method: 'POST', body: {}, ...values });
    assert.equal(result.status, 403);
  }
  assert.equal(h.calls.phone.length, 0);
  assert.equal(h.calls.github.length, 0);
});

test('phone errors retain safe status/code while discarding private DO/provider error text', async () => {
  for (const [code, status] of [['QNH_BROWSER_NOT_CONFIGURED', 503], ['QNH_BROWSER_UNAVAILABLE', 502], ['QNH_BROWSER_DEMO_LIMIT', 429]]) {
    const h = harness({ statusReply: () => response({ code, error: 'PRIVATE-wss://provider.example/?jwt=SECRET' }, status) });
    const result = await h.request('/api/state', { cookie: PHONE_COOKIE });
    assert.equal(result.status, status);
    const body = await result.json();
    assert.equal(body.code, code);
    assert.equal(typeof body.message, 'string');
    assert.equal(JSON.stringify(body).includes('SECRET'), false);
    assert.equal(JSON.stringify(body).includes('wss://'), false);
    assert.equal(h.calls.github.length, 0);
  }
});

test('unknown internal phone failures produce a generic response without leaking exception details', async () => {
  const h = harness({ statusReply: () => { throw new Error('PRIVATE-PROVIDER-SESSION-SECRET'); } });
  const result = await h.request('/api/state', { cookie: PHONE_COOKIE });
  assert.equal(result.status, 500);
  const text = await result.text();
  assert.equal(JSON.parse(text).code, 'INTERNAL_ERROR');
  assert.equal(text.includes('PRIVATE-PROVIDER'), false);
  assert.equal(h.calls.github.length, 0);
});
