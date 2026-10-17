import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createWorker } from '../backend/worker.mjs';

const ORIGIN = 'https://wzz79229.github.io';
const BASE = 'https://fresh-period.example.workers.dev';
const INITIAL_TIME = Date.parse('2026-10-15T10:00:00Z');
const env = {
  GITHUB_TOKEN: 'github_pat_backend_test_secret', TEAM_PASSWORD: 'test-team-password-1234',
  SESSION_SECRET: 'test-session-secret-with-at-least-32-characters', ALLOWED_ORIGIN: ORIGIN,
};
const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);
const ID = '36b8f84d-df4e-4d49-b662-bcde71a8764f';
// Small marker fixture tests the upload protocol's JPEG signature checks.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22, 0xff, 0xd9]);
const imageDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
const state = () => ({ schemaVersion: 1, records: [], settings: { urgentDays: 7, warningDays: 30 }, updatedAt: '2026-10-15T10:00:00.000Z' });
const record = (extra = {}) => ({
  id: 'milk-1', name: '牵牛花鲜牛奶', barcode: '', category: '', location: '', batchCode: '',
  productionDate: '', shelfLife: null, shelfUnit: 'day', expiryDate: '2026-10-31', quantity: 1,
  unit: '瓶', note: '', status: 'active', handledAt: '', handledReason: '', updatedAt: '2026-10-15T10:00:00.000Z', ...extra,
});
const file = (value, sha = OLD) => ({ type: 'file', encoding: 'base64', sha, content: Buffer.from(JSON.stringify(value), 'utf8').toString('base64') });
const photoFile = (bytes = jpeg) => ({ type: 'file', encoding: 'base64', sha: NEW, size: bytes.length, content: bytes.toString('base64') });
const reply = (status, value, headers = {}) => new Response(JSON.stringify(value), { status, headers });

function harness(...replies) {
  const calls = [];
  let time = INITIAL_TIME;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.ok(replies.length, 'unexpected network call');
    const value = replies.shift();
    if (typeof value === 'function') return value(url, options);
    return value;
  };
  const worker = createWorker({ fetchImpl, now: () => time, cryptoImpl: webcrypto });
  const request = (path, { method = 'GET', body, cookie, headers = {}, environment = env, origin = ORIGIN } = {}) => {
    const combined = { ...headers };
    if (origin !== null) combined.Origin = origin;
    if (cookie) combined.Cookie = cookie;
    if (body !== undefined) combined['Content-Type'] = 'application/json';
    return worker.fetch(new Request(`${BASE}${path}`, { method, headers: combined, body: body === undefined ? undefined : JSON.stringify(body) }), environment);
  };
  const login = async () => {
    const response = await request('/api/login', { method: 'POST', body: { password: env.TEAM_PASSWORD } });
    assert.equal(response.status, 200);
    return response.headers.get('Set-Cookie').split(';')[0];
  };
  return { worker, request, login, calls, advance: ms => { time += ms; }, remaining: () => replies.length };
}

test('missing or invalid administrator configuration fails closed without a GitHub call', async () => {
  const h = harness();
  for (const environment of [{}, { ...env, GITHUB_TOKEN: '' }, { ...env, TEAM_PASSWORD: 'short' }, { ...env, SESSION_SECRET: 'short' }, { ...env, ALLOWED_ORIGIN: 'https://evil.example' }]) {
    for (const path of ['/api/session', '/api/state', `/api/photos/${ID}`]) {
      const response = await h.request(path, { environment });
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.code, 'SETUP_REQUIRED');
      assert.ok(!JSON.stringify(body).includes(env.GITHUB_TOKEN));
    }
  }
  assert.equal(h.calls.length, 0);
});

test('session status exposes only configured and authorized; unauthenticated data and photos are denied', async () => {
  const h = harness();
  assert.deepEqual(await (await h.request('/api/session')).json(), { configured: true, authorized: false, loginMethod: 'legacy' });
  for (const path of ['/api/state', `/api/photos/${ID}`]) {
    const response = await h.request(path);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'AUTH_REQUIRED');
  }
  assert.equal(h.calls.length, 0);
});

test('login creates a private signed session and does not return any configured secret', async () => {
  const h = harness();
  const response = await h.request('/api/login', { method: 'POST', body: { password: env.TEAM_PASSWORD } });
  const cookie = response.headers.get('Set-Cookie');
  for (const expected of ['__Host-fresh-period-session=', 'HttpOnly', 'Secure', 'SameSite=None', 'Partitioned', 'Path=/', 'Max-Age=2592000']) assert.ok(cookie.includes(expected));
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const text = await response.text();
  for (const secret of [env.GITHUB_TOKEN, env.TEAM_PASSWORD, env.SESSION_SECRET]) assert.ok(!text.includes(secret) && !cookie.includes(secret));
  assert.deepEqual(JSON.parse(text), { configured: true, authorized: true });
  assert.equal(h.calls.length, 0);
});

test('valid sessions read the fixed private data and sanitize unknown fields', async () => {
  const data = { ...state(), token: 'untrusted-extra' };
  const h = harness(reply(200, file(data)));
  const cookie = await h.login();
  assert.deepEqual(await (await h.request('/api/session', { cookie })).json(), { configured: true, authorized: true, loginMethod: 'legacy' });
  const response = await h.request('/api/state', { cookie });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: state(), sha: OLD });
  const { url, options } = h.calls[0];
  assert.equal(url, 'https://api.github.com/repos/Wzz79229/bzq/contents/data/shelf-life.json?ref=main');
  assert.equal(options.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
  assert.equal(options.headers['User-Agent'], 'qnh-shelf-life-team-backend');
  assert.equal(options.redirect, 'manual');
  assert.equal(Object.hasOwn(options, 'credentials'), false);
  assert.equal(Object.hasOwn(options, 'referrerPolicy'), false);
  assert.equal(options.headers.Cookie, undefined);
  assert.equal(options.cache, 'no-store');
  assert.ok(!url.includes(env.GITHUB_TOKEN));
});

test('Worker state and direct photo requests work with a runtime that rejects browser-only fetch options', async () => {
  const runtime = value => async (_url, options) => {
    if (options.redirect === 'error' || Object.hasOwn(options, 'credentials') || Object.hasOwn(options, 'referrerPolicy')) {
      throw new TypeError('unsupported Worker fetch option');
    }
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Cookie, undefined);
    return reply(200, value);
  };
  const h = harness(runtime(file(state())), runtime(photoFile()));
  const cookie = await h.login();
  assert.equal((await h.request('/api/state', { cookie })).status, 200);
  assert.equal((await h.request(`/api/photos/${ID}`, { cookie })).status, 200);
  assert.equal(h.calls.length, 2);
});

test('Worker manual requests reject redirects for state and direct photos without following them', async () => {
  for (const status of [301, 302, 307, 308]) {
    for (const path of ['/api/state', `/api/photos/${ID}`]) {
      const h = harness(new Response('', { status, headers: { Location: 'https://untrusted.example/redirect' } }));
      const cookie = await h.login();
      const response = await h.request(path, { cookie });
      assert.equal(response.status, 502);
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].options.redirect, 'manual');
      const text = await response.text();
      assert.ok(!text.includes(env.GITHUB_TOKEN) && !text.includes('untrusted.example'));
    }
  }
});

test('tampered, duplicated, expired and secret-rotated cookies cannot authorize', async () => {
  const h = harness();
  const cookie = await h.login();
  const last = cookie.at(-1);
  const tampered = cookie.slice(0, -1) + (last === 'A' ? 'B' : 'A');
  for (const value of [tampered, `${cookie}; ${cookie}`, '__Host-fresh-period-session=arbitrary']) {
    assert.equal((await h.request('/api/state', { cookie: value })).status, 401);
  }
  assert.equal((await h.request('/api/state', { cookie, environment: { ...env, SESSION_SECRET: `${env.SESSION_SECRET}-rotated` } })).status, 401);
  h.advance(30 * 24 * 60 * 60_000 + 1_000);
  assert.equal((await h.request('/api/state', { cookie })).status, 401);
  assert.equal(h.calls.length, 0);
});

test('noncanonical HMAC encoding and insecure HTTP API requests are denied', async () => {
  const h = harness();
  const cookie = await h.login();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const index = alphabet.indexOf(cookie.at(-1));
  const equivalentBytes = cookie.slice(0, -1) + alphabet[index + 1];
  assert.equal((await h.request('/api/state', { cookie: equivalentBytes })).status, 401);
  const insecure = await h.worker.fetch(new Request('http://fresh-period.example.workers.dev/api/state', { headers: { Origin: ORIGIN, Cookie: cookie } }), env);
  assert.equal(insecure.status, 400);
  assert.equal((await insecure.json()).code, 'HTTPS_REQUIRED');
  assert.equal(h.calls.length, 0);
});

test('untrusted origins and cross-site cookie requests never get business access', async () => {
  const h = harness();
  const cookie = await h.login();
  for (const origin of ['https://evil.example', 'https://wzz79229.github.io.evil.example', 'null', 'https://wzz79229.github.io/']) {
    const response = await h.request('/api/state', { cookie, origin });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal((await h.request('/api/state', { cookie, origin: null, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await h.request('/api/logout', { method: 'POST', cookie, origin: null })).status, 403);
  assert.equal(h.calls.length, 0);
});

test('secure same-origin login and same-origin reads support co-hosted PWA', async () => {
  const h = harness(reply(200, file(state())));
  const response = await h.request('/api/login', { method: 'POST', body: { password: env.TEAM_PASSWORD }, origin: BASE });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await h.request('/api/state', { cookie, origin: null, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
});

test('CORS preflight permits only exact origin, intended methods and Content-Type', async () => {
  const h = harness();
  const response = await h.request('/api/state', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true');
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, PUT');
  for (const headers of [{ 'Access-Control-Request-Method': 'DELETE' }, { 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization' }]) {
    assert.equal((await h.request('/api/state', { method: 'OPTIONS', headers })).status, 403);
  }
  assert.equal(h.calls.length, 0);
});

test('unknown routes, arbitrary URLs, query targets and unsupported methods do not proxy', async () => {
  const h = harness();
  const cookie = await h.login();
  for (const path of ['/api/proxy?url=https://evil.example', '/api/state?repo=other', '/api/photos/a/b', '/api/repos/evil']) {
    assert.equal((await h.request(path, { cookie })).status, 404);
  }
  assert.equal((await h.request('/api/state', { method: 'DELETE', cookie })).status, 405);
  assert.equal((await h.request('/api/state', { method: 'PUT', cookie, body: { data: state(), expectedSha: OLD, owner: 'evil' } })).status, 400);
  assert.equal(h.calls.length, 0);
});

test('bad logins are throttled per isolate and IP without reflecting the password', async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) {
    const response = await h.request('/api/login', { method: 'POST', body: { password: 'wrong-password-marker' }, headers: { 'CF-Connecting-IP': '192.0.2.1' } });
    assert.equal(response.status, 401);
    assert.ok(!(await response.text()).includes('wrong-password-marker'));
  }
  const limited = await h.request('/api/login', { method: 'POST', body: { password: env.TEAM_PASSWORD }, headers: { 'CF-Connecting-IP': '192.0.2.1' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '900');
  h.advance(15 * 60_000);
  assert.equal((await h.request('/api/login', { method: 'POST', body: { password: env.TEAM_PASSWORD }, headers: { 'CF-Connecting-IP': '192.0.2.1' } })).status, 200);
});

test('logout expires the HTTP-only cookie', async () => {
  const h = harness();
  const cookie = await h.login();
  const response = await h.request('/api/logout', { method: 'POST', cookie });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('Set-Cookie').includes('Max-Age=0'));
  assert.deepEqual(await response.json(), { configured: true, authorized: false });
});

test('state rejects a stale SHA before any PUT and does not silently merge', async () => {
  const h = harness(reply(200, file(state(), NEW)));
  const cookie = await h.login();
  const response = await h.request('/api/state', { method: 'PUT', cookie, body: { data: state(), expectedSha: OLD } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'CONFLICT');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.method, 'GET');
});

test('state writes only the fixed file with expected SHA; later server conflict is surfaced', async () => {
  for (const status of [200, 409, 422]) {
    const h = harness(reply(200, file(state())), reply(200, file(state())), reply(status, status === 200 ? { content: { sha: NEW } } : { message: env.GITHUB_TOKEN }));
    const cookie = await h.login();
    const response = await h.request('/api/state', { method: 'PUT', cookie, body: { data: state(), expectedSha: OLD } });
    assert.equal(response.status, status === 200 ? 200 : 409);
    const text = await response.text();
    assert.ok(!text.includes(env.GITHUB_TOKEN));
    if (status === 200) assert.deepEqual(JSON.parse(text), { data: state(), sha: NEW });
    else assert.equal(JSON.parse(text).code, 'CONFLICT');
    const call = h.calls[2];
    assert.equal(call.url, 'https://api.github.com/repos/Wzz79229/bzq/contents/data/shelf-life.json');
    const body = JSON.parse(call.options.body);
    assert.equal(body.branch, 'main');
    assert.equal(body.sha, OLD);
    assert.ok(!body.content.includes(env.GITHUB_TOKEN));
    assert.equal(h.remaining(), 0);
  }
});

test('invalid snapshots and photo references fail before touching GitHub', async () => {
  const h = harness();
  const cookie = await h.login();
  for (const data of [
    { ...state(), schemaVersion: 2 }, { ...state(), records: [record({ quantity: -1 })] },
    { ...state(), records: [record({ photoRefs: [{ id: ID, path: '../private.json' }] })] },
    { ...state(), records: [record({ photoRefs: [{ id: ID, path: `photos/${ID}.jpg` }, { id: ID, path: `photos/${ID}.jpg` }] })] },
    { ...state(), records: [record({ photoRefs: Array(4).fill({ id: ID, path: `photos/${ID}.jpg` }) })] },
  ]) {
    assert.equal((await h.request('/api/state', { method: 'PUT', cookie, body: { data, expectedSha: OLD } })).status, 400);
  }
  assert.equal((await h.request('/api/state', { method: 'PUT', cookie, body: { data: state() } })).status, 400);
  assert.equal(h.calls.length, 0);
});

test('photo upload is bounded and creates a separate immutable file in private bzq', async () => {
  const h = harness(reply(404, {}), reply(201, { content: { sha: NEW } }));
  const cookie = await h.login();
  const response = await h.request('/api/photos', { method: 'POST', cookie, body: { id: ID, imageDataUrl } });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: ID, path: `photos/${ID}.jpg` });
  assert.equal(h.calls[1].url, `https://api.github.com/repos/Wzz79229/bzq/contents/photos/${ID}.jpg`);
  assert.equal(h.calls[1].options.headers['User-Agent'], 'qnh-shelf-life-team-backend');
  const body = JSON.parse(h.calls[1].options.body);
  assert.equal(body.branch, 'main');
  assert.ok(!('sha' in body), 'an existing photo must never be overwritten');
  assert.deepEqual(Buffer.from(body.content, 'base64'), jpeg);
});

test('a JPEG at the exact byte limit can be uploaded without UTF-8 or stack errors', async () => {
  const bytes = Buffer.alloc(400_000, 0);
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff;
  bytes[bytes.length - 2] = 0xff; bytes[bytes.length - 1] = 0xd9;
  const h = harness(reply(404, {}), reply(201, { content: { sha: NEW } }));
  const cookie = await h.login();
  const response = await h.request('/api/photos', { method: 'POST', cookie, body: { id: ID, imageDataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` } });
  assert.equal(response.status, 201);
  assert.deepEqual(Buffer.from(JSON.parse(h.calls[1].options.body).content, 'base64'), bytes);
});

test('repeated identical photo uploads are idempotent, different images cannot overwrite', async () => {
  const h = harness(reply(200, photoFile()), reply(200, photoFile()));
  const cookie = await h.login();
  assert.equal((await h.request('/api/photos', { method: 'POST', cookie, body: { id: ID, imageDataUrl } })).status, 200);
  const changed = Buffer.from(jpeg); changed[4] = 0x33;
  const response = await h.request('/api/photos', { method: 'POST', cookie, body: { id: ID, imageDataUrl: `data:image/jpeg;base64,${changed.toString('base64')}` } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'PHOTO_CONFLICT');
  assert.ok(h.calls.every(call => call.options.method === 'GET'));
});

test('a racing identical photo creation is a safe success without retrying the PUT', async () => {
  const h = harness(reply(404, {}), reply(422, {}), reply(200, photoFile()));
  const cookie = await h.login();
  assert.equal((await h.request('/api/photos', { method: 'POST', cookie, body: { id: ID, imageDataUrl } })).status, 200);
  assert.equal(h.calls.filter(call => call.options.method === 'PUT').length, 1);
});

test('invalid IDs, non-JPEG signatures, oversized photos and arbitrary fields are rejected', async () => {
  const h = harness();
  const cookie = await h.login();
  const tooBig = Buffer.alloc(400_001, 0); tooBig[0] = 0xff; tooBig[1] = 0xd8; tooBig[2] = 0xff; tooBig[tooBig.length - 2] = 0xff; tooBig[tooBig.length - 1] = 0xd9;
  for (const body of [
    { id: '../data', imageDataUrl }, { id: ID.toUpperCase(), imageDataUrl },
    { id: ID, imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    { id: ID, imageDataUrl: 'data:image/jpeg;base64,aGVsbG8=' },
    { id: ID, imageDataUrl: `data:image/jpeg;base64,${tooBig.toString('base64')}` },
    { id: ID, imageDataUrl, path: 'evil.json' },
  ]) {
    assert.equal((await h.request('/api/photos', { method: 'POST', cookie, body })).status, 400);
  }
  const response = await h.request('/api/photos', { method: 'POST', cookie, body: { id: ID, imageDataUrl: 'x'.repeat(550_000) } });
  assert.equal(response.status, 413);
  assert.equal(h.calls.length, 0);
});

test('authenticated photo reads are private JPEG bytes, never raw GitHub URLs', async () => {
  const h = harness(reply(200, photoFile()));
  const cookie = await h.login();
  const response = await h.request(`/api/photos/${ID}`, { cookie });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
  assert.equal(h.calls.length, 1);
});

test('new photo refs must exist before state commit and are preserved by validation', async () => {
  const data = { ...state(), records: [record({ photoRefs: [{ id: ID, path: `photos/${ID}.jpg` }] })] };
  const h = harness(reply(200, file(state())), reply(200, photoFile()), reply(200, file(state())), reply(200, { content: { sha: NEW } }));
  const cookie = await h.login();
  const response = await h.request('/api/state', { method: 'PUT', cookie, body: { data, expectedSha: OLD } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.data.records[0].photoRefs, data.records[0].photoRefs);
  assert.ok(h.calls[1].url.includes(`/photos/${ID}.jpg?ref=main`));
  assert.equal(h.calls[3].options.method, 'PUT');
  const missing = harness(reply(200, file(state())), reply(404, {}));
  const missingCookie = await missing.login();
  const rejected = await missing.request('/api/state', { method: 'PUT', cookie: missingCookie, body: { data, expectedSha: OLD } });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, 'PHOTO_NOT_UPLOADED');
  assert.ok(missing.calls.every(call => call.options.method === 'GET'));
});

test('provider auth failures and thrown errors never reveal a secret or provider body', async () => {
  for (const result of [reply(401, { message: env.GITHUB_TOKEN }), reply(403, { message: env.TEAM_PASSWORD }), () => { throw new Error(`${env.SESSION_SECRET} https://evil.example`); }]) {
    const h = harness(result);
    const cookie = await h.login();
    const response = await h.request('/api/state', { cookie });
    assert.equal(response.status, 502);
    const text = await response.text();
    for (const secret of [env.GITHUB_TOKEN, env.TEAM_PASSWORD, env.SESSION_SECRET, 'evil.example']) assert.ok(!text.includes(secret));
  }
});

test('optional static assets do not expose API data when backend is unconfigured', async () => {
  const h = harness();
  const assets = { ASSETS: { fetch: async () => new Response('<html>App shell only</html>') } };
  const response = await h.worker.fetch(new Request(`${BASE}/`), assets);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<html>App shell only</html>');
  const api = await h.request('/api/state', { environment: assets });
  assert.equal(api.status, 503);
  assert.equal(h.calls.length, 0);
});
