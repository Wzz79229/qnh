import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { CatalogStore, CatalogStoreError, normalizeManifest } from '../backend/catalog-store.mjs';
import { createWorker } from '../backend/worker.mjs';
import { CloudStore } from '../dist/cloud.mjs';

const GENERATION = '36b8f84d-df4e-4d49-b662-bcde71a8764f';
const NEXT_GENERATION = '36b8f84d-df4e-4d49-b662-bcde71a87650';
const TOKEN = 'github_pat_catalog_test_secret';
const ROOT = 'https://api.github.com/repos/Wzz79229/bzq/contents/';
const MANIFEST_PATH = 'data/catalog.json';
const SOURCE = { platform: 'meituan-qnh', syncedAt: '2026-10-16T12:00:00.000Z', scope: '当前门店商品库', complete: false };
const PRODUCT = { sku: '000123', spu: '000012', name: '牵牛花鲜牛奶', spec: '250毫升', barcodes: ['0012345678901'], category: '乳制品', imageUrl: 'https://img.meituan.net/empowerstoremanagement/test.jpg@80w_80h_90Q' };
const reply = (status, value, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const pathOf = (index = 0, generation = GENERATION) => `data/catalog/${generation}/${index}.json`;
const page = (extra = {}) => ({ schemaVersion: 1, source: SOURCE, products: [PRODUCT], ...extra });
function file(path, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  return { type: 'file', path, size: bytes.length, encoding: 'base64', sha, content: bytes.toString('base64') };
}
function manifest(pageFile = file(pathOf(), page()), extra = {}) {
  return { schemaVersion: 1, source: SOURCE, generation: GENERATION, pages: [{ index: 0, count: 1, path: pathOf(), sha: pageFile.sha }], total: 1, ...extra };
}
function harness(...replies) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.ok(replies.length, 'unexpected GitHub call');
    const result = replies.shift();
    return typeof result === 'function' ? result(url, options) : result;
  };
  return { store: new CatalogStore({ token: TOKEN }, fetchImpl, webcrypto), fetchImpl, calls };
}
const errorCode = (code, status) => error => error instanceof CatalogStoreError && error.code === code && (status === undefined || error.status === status);

test('reads a sanitized Chinese manifest from the fixed private repository without caching or redirects', async () => {
  const input = { ...manifest(), token: 'must-not-be-returned', source: { ...SOURCE, secret: 'must-not-be-returned' } };
  const h = harness(reply(200, file(MANIFEST_PATH, input)));
  assert.deepEqual(await h.store.read(), manifest());
  const { url, options } = h.calls[0];
  assert.equal(url, `${ROOT}data/catalog.json?ref=main`);
  assert.equal(options.method, 'GET');
  assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(options.cache, 'no-store');
  assert.equal(options.redirect, 'manual');
  assert.equal(Object.hasOwn(options, 'credentials'), false);
  assert.equal(options.headers.Cookie, undefined);
  assert.ok(!url.includes(TOKEN));
  assert.ok(!JSON.stringify(h.store).includes(TOKEN));
});

test('reads only a manifest-named page, verifies its actual Git blob hash and returns its generation', async () => {
  const pageFile = file(pathOf(), page({ products: [{ ...PRODUCT, privateMetadata: 'stripped' }] }));
  const h = harness(reply(200, file(MANIFEST_PATH, manifest(pageFile))), reply(200, pageFile));
  assert.deepEqual(await h.store.page(0), { ...page(), generation: GENERATION, index: 0 });
  assert.deepEqual(h.calls.map(call => call.url), [`${ROOT}data/catalog.json?ref=main`, `${ROOT}${pathOf()}?ref=main`]);
});

test('page requests re-read the current manifest and expose a changed generation for client rejection', async () => {
  const firstFile = file(pathOf(), page());
  const secondFile = file(pathOf(0, NEXT_GENERATION), page({ source: { ...SOURCE, complete: true } }));
  const secondManifest = manifest(secondFile, {
    source: { ...SOURCE, complete: true }, generation: NEXT_GENERATION,
    pages: [{ index: 0, count: 1, path: pathOf(0, NEXT_GENERATION), sha: secondFile.sha }],
  });
  const h = harness(reply(200, file(MANIFEST_PATH, manifest(firstFile))), reply(200, firstFile), reply(200, file(MANIFEST_PATH, secondManifest)), reply(200, secondFile));
  assert.equal((await h.store.page(0)).generation, GENERATION);
  assert.equal((await h.store.page(0)).generation, NEXT_GENERATION);
  assert.equal(h.calls.filter(call => call.url === `${ROOT}data/catalog.json?ref=main`).length, 2);
});

test('missing manifest has an actionable catalog-not-ready error', async () => {
  const h = harness(reply(404, { message: 'provider-private-detail' }));
  await assert.rejects(h.store.read(), errorCode('CATALOG_NOT_READY', 404));
  assert.equal(h.calls.length, 1);
});

test('a missing immutable page or different SHA asks for a full catalog reload', async () => {
  const pageFile = file(pathOf(), page());
  for (const response of [reply(404, {}), reply(200, { ...pageFile, sha: 'a'.repeat(40) })]) {
    const h = harness(reply(200, file(MANIFEST_PATH, manifest(pageFile))), response);
    await assert.rejects(h.store.page(0), errorCode('CATALOG_CHANGED', 409));
  }
});

test('page count and source must agree with the same manifest snapshot', async () => {
  for (const input of [page({ products: [] }), page({ source: { ...SOURCE, complete: true } }), page({ source: { ...SOURCE, scope: '另一门店' } })]) {
    const pageFile = file(pathOf(), input);
    const h = harness(reply(200, file(MANIFEST_PATH, manifest(pageFile))), reply(200, pageFile));
    await assert.rejects(h.store.page(0), errorCode('CATALOG_CHANGED', 409));
  }
});

test('invalid page indices cannot select a path or cause a GitHub request', async () => {
  const h = harness();
  for (const index of [-1, 100, 0.5, '0', '../shelf-life', null, NaN]) {
    await assert.rejects(h.store.page(index), errorCode('INVALID_CATALOG_PAGE', 400));
  }
  assert.equal(h.calls.length, 0);
});

test('an absent manifest index never reads an arbitrary GitHub path', async () => {
  const h = harness(reply(200, file(MANIFEST_PATH, manifest())));
  await assert.rejects(h.store.page(1), errorCode('CATALOG_PAGE_NOT_FOUND', 404));
  assert.equal(h.calls.length, 1);
});

test('manifest paths, generation, totals, completeness and contiguous indices are strictly bounded', () => {
  const valid = manifest();
  const invalidValues = [
    { ...valid, schemaVersion: 2 }, { ...valid, generation: '../private' }, { ...valid, generation: GENERATION.toUpperCase() },
    { ...valid, total: 2 }, { ...valid, total: 50_001 }, { ...valid, total: -1 },
    { ...valid, source: { ...SOURCE, complete: undefined } }, { ...valid, source: { ...SOURCE, platform: 'other' } },
    { ...valid, pages: [{ ...valid.pages[0], index: 1 }] },
    { ...valid, pages: [{ ...valid.pages[0], path: 'data/shelf-life.json' }] },
    { ...valid, pages: [{ ...valid.pages[0], path: 'https://evil.example/private' }] },
    { ...valid, pages: [{ ...valid.pages[0], path: `data/catalog/${NEXT_GENERATION}/0.json` }] },
    { ...valid, pages: [{ ...valid.pages[0], count: 0 }] }, { ...valid, pages: [{ ...valid.pages[0], count: 501 }] },
    { ...valid, pages: [{ ...valid.pages[0], sha: 'A'.repeat(40) }] },
    { ...valid, pages: Array.from({ length: 101 }, (_, index) => ({ ...valid.pages[0], index, path: pathOf(index) })), total: 101 },
  ];
  for (const input of invalidValues) assert.throws(() => normalizeManifest(input), errorCode('INVALID_CATALOG', 502));
  assert.deepEqual(normalizeManifest({ ...valid, pages: [], total: 0 }), { ...valid, pages: [], total: 0 });
  const pages = Array.from({ length: 100 }, (_, index) => ({ ...valid.pages[0], index, path: pathOf(index), count: 500 }));
  assert.equal(normalizeManifest({ ...valid, pages, total: 50_000 }).total, 50_000);
});

test('rejects oversized manifest files and oversized actual transport before exposing any metadata', async () => {
  const oversized = file(MANIFEST_PATH, { ...manifest(), padding: 'x'.repeat(128 * 1024) });
  for (const response of [reply(200, oversized), reply(200, file(MANIFEST_PATH, manifest()), { 'Content-Length': '10000000' }), new Response('x'.repeat(250_000))]) {
    await assert.rejects(harness(response).store.read(), errorCode('INVALID_CATALOG', 502));
  }
});

test('each page is limited to 500 products and 900000 decoded bytes', async () => {
  const validPage = page({ products: Array.from({ length: 500 }, (_, index) => ({ ...PRODUCT, sku: `sku-${index}` })) });
  const validFile = file(pathOf(), validPage);
  const validManifest = manifest(validFile, { pages: [{ index: 0, count: 500, path: pathOf(), sha: validFile.sha }], total: 500 });
  const h = harness(reply(200, file(MANIFEST_PATH, validManifest)), reply(200, validFile));
  assert.equal((await h.store.page(0)).products.length, 500);
  for (const input of [page({ products: [...validPage.products, { ...PRODUCT, sku: 'sku-501' }] }), page({ padding: 'x'.repeat(900_000) })]) {
    const pageFile = file(pathOf(), input);
    const invalid = harness(reply(200, file(MANIFEST_PATH, manifest(pageFile))), reply(200, pageFile));
    await assert.rejects(invalid.store.page(0), errorCode('INVALID_CATALOG', 502));
  }
});

test('a page at the exact byte limit preserves Chinese text without stack-sized base64 conversions', async () => {
  const input = page({ padding: '' });
  input.padding = 'x'.repeat(900_000 - Buffer.byteLength(JSON.stringify(input)));
  const pageFile = file(pathOf(), input);
  assert.equal(pageFile.size, 900_000);
  const h = harness(reply(200, file(MANIFEST_PATH, manifest(pageFile))), reply(200, pageFile));
  assert.deepEqual(await h.store.page(0), { ...page(), generation: GENERATION, index: 0 });
});

test('invalid base64, encoding, UTF-8, file metadata and mismatched actual Git blob hashes are rejected', async () => {
  const valid = file(MANIFEST_PATH, manifest());
  const utf8 = file(MANIFEST_PATH, Buffer.from([0xff, 0xfe]));
  for (const input of [
    { ...valid, type: 'dir' }, { ...valid, encoding: 'none' }, { ...valid, size: valid.size + 1 },
    { ...valid, size: -1 }, { ...valid, path: 'data/shelf-life.json' }, { ...valid, sha: 'a'.repeat(40) },
    { ...valid, content: '$invalid$' }, { ...valid, content: '' }, utf8,
  ]) await assert.rejects(harness(reply(200, input)).store.read(), errorCode('INVALID_CATALOG', 502));
});

test('unsafe images, duplicate SKUs and oversized normalized products cannot escape validation', async () => {
  for (const products of [[{ ...PRODUCT, imageUrl: 'https://evil.example/a.jpg' }], [PRODUCT, PRODUCT], [{ ...PRODUCT, name: 'x'.repeat(201) }]]) {
    const pageFile = file(pathOf(), page({ products }));
    const h = harness(reply(200, file(MANIFEST_PATH, manifest(pageFile))), reply(200, pageFile));
    await assert.rejects(h.store.page(0), errorCode('INVALID_CATALOG', 502));
  }
});

test('provider permissions and rate limits are actionable without reflecting provider bodies or tokens', async () => {
  for (const [status, headers, code, expectedStatus] of [[401, {}, 'CATALOG_ACCESS_DENIED', 502], [403, {}, 'CATALOG_ACCESS_DENIED', 502], [403, { 'x-ratelimit-remaining': '0' }, 'RATE_LIMITED', 429], [429, {}, 'RATE_LIMITED', 429], [500, {}, 'CATALOG_UNAVAILABLE', 502]]) {
    const h = harness(reply(status, { message: `${TOKEN}-provider-secret` }, headers));
    await assert.rejects(h.store.read(), error => errorCode(code, expectedStatus)(error) && !error.message.includes(TOKEN));
  }
});

test('redirects are never followed and unexpected URLs or network exception text are not exposed', async () => {
  const redirected = reply(200, file(MANIFEST_PATH, manifest()));
  Object.defineProperty(redirected, 'url', { value: 'https://evil.example/redirect' });
  for (const response of [reply(302, {}, { Location: 'https://evil.example' }), redirected]) {
    const h = harness(response);
    await assert.rejects(h.store.read(), errorCode('INVALID_CATALOG', 502));
    assert.equal(h.calls.length, 1);
  }
  await assert.rejects(harness(() => { throw new Error(TOKEN); }).store.read(), error => error.code === 'CATALOG_NETWORK' && !error.message.includes(TOKEN));
});

test('a fetch that ignores abort is still bounded by the request timeout', async () => {
  const store = new CatalogStore({ token: TOKEN, timeoutMs: 5 }, () => new Promise(() => {}), webcrypto);
  await assert.rejects(store.read(), errorCode('TIMEOUT', 504));
});

const ORIGIN = 'https://wzz79229.github.io';
const BASE = 'https://fresh-period.example.workers.dev';
const ENV = { GITHUB_TOKEN: TOKEN, TEAM_PASSWORD: 'catalog-team-password-1234', SESSION_SECRET: 'catalog-session-secret-with-at-least-32-characters', ALLOWED_ORIGIN: ORIGIN };
function workerHarness(...replies) {
  const h = harness(...replies);
  const worker = createWorker({ fetchImpl: h.fetchImpl, cryptoImpl: webcrypto });
  const request = (path, { method = 'GET', cookie, body, environment = ENV, origin = ORIGIN } = {}) => worker.fetch(new Request(`${BASE}${path}`, {
    method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), environment);
  const login = async () => (await request('/api/login', { method: 'POST', body: { password: ENV.TEAM_PASSWORD } })).headers.get('Set-Cookie').split(';')[0];
  return { ...h, request, login };
}

test('catalog routes fail closed on missing configuration, absent session and untrusted origins', async () => {
  const h = workerHarness();
  for (const path of ['/api/catalog', '/api/catalog/pages/0']) {
    assert.equal((await h.request(path, { environment: {} })).status, 503);
    assert.equal((await h.request(path)).status, 401);
    assert.equal((await h.request(path, { origin: 'https://evil.example' })).status, 403);
  }
  assert.equal(h.calls.length, 0);
});

test('authenticated Worker catalog responses are private, sanitized and read-only', async () => {
  const pageFile = file(pathOf(), page());
  const manifestValue = manifest(pageFile);
  const h = workerHarness(reply(200, file(MANIFEST_PATH, manifestValue)), reply(200, file(MANIFEST_PATH, manifestValue)), reply(200, pageFile));
  const cookie = await h.login();
  const response = await h.request('/api/catalog', { cookie });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), manifestValue);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.deepEqual(await (await h.request('/api/catalog/pages/0', { cookie })).json(), { ...page(), generation: GENERATION, index: 0 });
  for (const path of ['/api/catalog', '/api/catalog/pages/0']) assert.equal((await h.request(path, { cookie, method: 'PUT', body: {} })).status, 405);
  assert.ok(h.calls.every(call => call.options.method === 'GET'));
});

test('catalog routes reject all query strings and noncanonical page paths without contacting GitHub', async () => {
  const h = workerHarness();
  const cookie = await h.login();
  for (const path of ['/api/catalog?repo=other', '/api/catalog/pages/0?generation=other', '/api/catalog/pages/00', '/api/catalog/pages/-1', '/api/catalog/pages/100', '/api/catalog/pages/%2e%2e%2fsecrets']) {
    assert.equal((await h.request(path, { cookie })).status, 404);
  }
  assert.equal(h.calls.length, 0);
});

test('Worker maps catalog-not-ready and changed-version errors without exposing provider details', async () => {
  const pageFile = file(pathOf(), page());
  const h = workerHarness(reply(404, { message: TOKEN }), reply(200, file(MANIFEST_PATH, manifest(pageFile))), reply(200, { ...pageFile, sha: 'a'.repeat(40) }));
  const cookie = await h.login();
  const missing = await h.request('/api/catalog', { cookie });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'CATALOG_NOT_READY');
  const conflict = await h.request('/api/catalog/pages/0', { cookie });
  assert.equal(conflict.status, 409);
  const text = await conflict.text();
  assert.equal(JSON.parse(text).code, 'CATALOG_CHANGED');
  assert.ok(!text.includes(TOKEN));
});

test('CloudStore exposes fixed catalog routes with session cookies and preserves catalog version errors', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/pages/1')) return reply(409, { code: 'CATALOG_CHANGED', message: '商品库版本已变化，请重新加载。' });
    return reply(200, { generation: GENERATION });
  };
  const store = new CloudStore(BASE, fetchImpl);
  assert.deepEqual(await store.catalog(), { generation: GENERATION });
  assert.deepEqual(await store.catalogPage(0), { generation: GENERATION });
  await assert.rejects(store.catalogPage(1), error => error.code === 'CATALOG_CHANGED');
  for (const index of ['0', '../state', -1, 100]) assert.throws(() => store.catalogPage(index), error => error.code === 'INVALID_CATALOG_PAGE');
  assert.deepEqual(calls.map(call => call.url), [`${BASE}/api/catalog`, `${BASE}/api/catalog/pages/0`, `${BASE}/api/catalog/pages/1`]);
  assert.ok(calls.every(call => call.options.credentials === 'include' && call.options.cache === 'no-store' && call.options.redirect === 'error'));
});
