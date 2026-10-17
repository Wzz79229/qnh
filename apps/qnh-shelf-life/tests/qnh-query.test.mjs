import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { ConflictError, GitHubError } from '../dist/github.mjs';
import { createWorker } from '../backend/worker.mjs';
import { QnhQueryQueue, QnhQueryError, QNH_QUERY_LIMITS, QNH_QUERY_PATH, normalizeQuerySku, normalizeQueryProduct } from '../backend/qnh-query.mjs';

const TIME = Date.parse('2026-10-16T10:00:00.000Z');
const SKU = '0002110000000000000001';
const PRODUCT = { sku: SKU, spu: '0002110000000000000000', name: '合成测试酸奶', spec: '200毫升', category: '测试乳品',
  barcodes: ['0001234567890'], imageUrl: 'https://img.meituan.net/empowerstoremanagement/synthetic.jpg@80w_80h_90Q' };
const ORIGIN = 'https://wzz79229.github.io';
const BASE = 'https://fresh-period.example.workers.dev';
const ENV = { GITHUB_TOKEN: 'github_pat_synthetic_queue_test', TEAM_PASSWORD: 'synthetic-team-password',
  SESSION_SECRET: 'synthetic-session-secret-longer-than-thirty-two', ALLOWED_ORIGIN: ORIGIN,
  QNH_CONNECTOR_KEY: 'synthetic-connector-key-longer-than-thirty-two' };
const code = expected => error => error instanceof QnhQueryError && error.code === expected;

function memory({ writeFailure, initial = null } = {}) {
  let data = structuredClone(initial);
  let revision = 0;
  let time = TIME;
  const calls = { reads: 0, writes: 0 };
  const store = {
    async read() { calls.reads++; return { data: structuredClone(data), sha: data === null ? null : String(revision) }; },
    async write(value, sha) {
      calls.writes++;
      if (writeFailure) await writeFailure({ value, sha, calls });
      assert.equal(sha, data === null ? null : String(revision));
      data = structuredClone(value); revision++;
      return { data: structuredClone(data), sha: String(revision) };
    },
  };
  return { queue: new QnhQueryQueue(store, { now: () => time, cryptoImpl: webcrypto }), calls,
    get data() { return structuredClone(data); }, set data(value) { data = structuredClone(value); }, advance(ms) { time += ms; } };
}

test('SKU stays a trimmed exact string and supports letters without numeric conversion', () => {
  assert.equal(normalizeQuerySku(`  ${SKU}  `), SKU);
  assert.equal(normalizeQuerySku('AbC-01._'), 'AbC-01._');
  assert.equal(normalizeQuerySku('x'.repeat(64)), 'x'.repeat(64));
  for (const input of [123, '', 'a b', 'a/b', '../outside/', '<img>', '中文SKU', 'x'.repeat(65), null]) assert.throws(() => normalizeQuerySku(input), code('INVALID_QNH_QUERY'));
});

test('product result requires the exact SKU and safe bounded fields and Meituan images', () => {
  assert.deepEqual(normalizeQueryProduct(PRODUCT, SKU), PRODUCT);
  const value = normalizeQueryProduct({ ...PRODUCT, barcodes: ['0001', '0001'] }, SKU);
  assert.deepEqual(value.barcodes, ['0001']);
  for (const patch of [{ sku: 'different' }, { sku: 2110000000000000001 }, { name: '<script>alert(1)</script>' },
    { name: 'x'.repeat(201) }, { spec: 'x\nsecret' }, { barcodes: [123] }, { cookie: 'not-allowed' },
    { imageUrl: 'https://img.meituan.net/p.jpg?token=private' }, { imageUrl: 'https://evil.example/p.jpg' },
    { imageUrl: 'https://name:password@img.meituan.net/p.jpg' }, { imageUrl: 'http://img.meituan.net/p.jpg' }]) {
    assert.throws(() => normalizeQueryProduct({ ...PRODUCT, ...patch }, SKU), code('INVALID_QNH_QUERY'));
  }
});

test('new queries persist only the queue document and duplicate pending SKU reuses the pending id', async () => {
  const h = memory();
  const result = await h.queue.enqueue(SKU);
  assert.equal(result.status, 'pending');
  assert.match(result.id, /^[a-f0-9-]{36}$/);
  assert.equal(h.data.schemaVersion, 1);
  assert.equal(h.data.jobs[0].expiresAt - h.data.jobs[0].createdAt, QNH_QUERY_LIMITS.ttlMs);
  assert.deepEqual(await h.queue.enqueue(` ${SKU} `), result);
  assert.equal(h.calls.writes, 1);
  assert.deepEqual(Object.keys(h.data.jobs[0]), ['id', 'sku', 'createdAt', 'expiresAt', 'status']);
});

test('claim returns one lease, phone status never exposes it, and found product is single SKU', async () => {
  const h = memory();
  const requested = await h.queue.enqueue(SKU);
  const { job } = await h.queue.claim();
  assert.equal(job.id, requested.id);
  assert.equal(job.sku, SKU);
  assert.match(job.leaseToken, /^[a-f0-9]{64}$/);
  assert.equal(h.data.jobs[0].status, 'working');
  assert.ok(!JSON.stringify(h.data).includes(job.leaseToken));
  assert.ok(!JSON.stringify(await h.queue.get(job.id)).includes('lease'));
  assert.deepEqual(await h.queue.claim(), { job: null });
  const result = await h.queue.submit({ id: job.id, leaseToken: job.leaseToken, result: { status: 'found', product: PRODUCT } });
  assert.equal(result.status, 'found');
  assert.deepEqual(result.product, PRODUCT);
  assert.deepEqual(await h.queue.get(job.id), result);
});

test('result submission is idempotent for the same lease and normalized result without a second write', async () => {
  const h = memory();
  await h.queue.enqueue(SKU);
  const { job } = await h.queue.claim();
  const input = { id: job.id, leaseToken: job.leaseToken, result: { status: 'found', product: PRODUCT } };
  const first = await h.queue.submit(input);
  const count = h.calls.writes;
  h.advance(QNH_QUERY_LIMITS.leaseMs + 1);
  assert.deepEqual(await h.queue.submit(input), first);
  assert.equal(h.calls.writes, count);
  await assert.rejects(h.queue.submit({ ...input, result: { status: 'not_found' } }), code('QNH_QUERY_LEASE_EXPIRED'));
});

test('expired lease can be reclaimed and an old lease cannot overwrite the new result', async () => {
  const h = memory();
  await h.queue.enqueue(SKU);
  const first = (await h.queue.claim()).job;
  h.advance(QNH_QUERY_LIMITS.leaseMs);
  await assert.rejects(h.queue.submit({ id: first.id, leaseToken: first.leaseToken, result: { status: 'found', product: PRODUCT } }), code('QNH_QUERY_LEASE_EXPIRED'));
  const second = (await h.queue.claim()).job;
  assert.equal(second.id, first.id);
  assert.notEqual(second.leaseToken, first.leaseToken);
  await assert.rejects(h.queue.submit({ id: first.id, leaseToken: first.leaseToken, result: { status: 'not_found' } }), code('QNH_QUERY_LEASE_EXPIRED'));
  assert.equal((await h.queue.submit({ id: second.id, leaseToken: second.leaseToken, result: { status: 'not_found' } })).status, 'not_found');
});

test('full job TTL expires even a working lease and discards product and lease from status', async () => {
  const h = memory();
  await h.queue.enqueue(SKU);
  const { job } = await h.queue.claim();
  await h.queue.submit({ id: job.id, leaseToken: job.leaseToken, result: { status: 'found', product: PRODUCT } });
  h.advance(QNH_QUERY_LIMITS.ttlMs);
  const current = await h.queue.get(job.id);
  assert.equal(current.status, 'expired');
  assert.equal(current.product, undefined);
  assert.match(current.message, /5 分钟/);
  await assert.rejects(h.queue.submit({ id: job.id, leaseToken: job.leaseToken, result: { status: 'found', product: PRODUCT } }), code('QNH_QUERY_LEASE_EXPIRED'));
  assert.deepEqual(await h.queue.claim(), { job: null });
  assert.equal(h.data.jobs[0].status, 'expired');
  assert.equal(h.data.jobs[0].product, undefined);
  assert.equal(h.data.jobs[0].lease, undefined);
});

test('queue permits at most twenty jobs and expired entries are reclaimed on new enqueue', async () => {
  const h = memory();
  const jobs = [];
  for (let index = 0; index < 20; index++) jobs.push(await h.queue.enqueue(`SKU-${index}`));
  await assert.rejects(h.queue.enqueue('SKU-21'), code('QNH_QUERY_QUEUE_FULL'));
  assert.equal(h.data.jobs.length, 20);
  h.advance(QNH_QUERY_LIMITS.ttlMs);
  await h.queue.enqueue('SKU-21');
  assert.equal(h.data.jobs.length, 1);
  await assert.rejects(h.queue.get(jobs[0].id), code('QNH_QUERY_NOT_FOUND'));
});

test('untrusted result messages are replaced and unsupported status or product lists are refused', async () => {
  for (const status of ['not_found', 'ambiguous', 'login_required', 'error']) {
    const h = memory();
    await h.queue.enqueue(SKU);
    const { job } = await h.queue.claim();
    const result = await h.queue.submit({ id: job.id, leaseToken: job.leaseToken, result: { status, message: '<script>synthetic-password</script>' } });
    assert.equal(result.status, status);
    assert.ok(!JSON.stringify(h.data).includes('synthetic-password'));
    assert.ok(!JSON.stringify(result).includes('<script>'));
  }
  const h = memory();
  await h.queue.enqueue(SKU);
  const { job } = await h.queue.claim();
  for (const result of [{ status: 'pending' }, { status: 'found', products: [PRODUCT] }, { status: 'found', product: { ...PRODUCT, sku: 'other' } },
    { status: 'not_found', product: PRODUCT }, { status: 'error', message: 'x'.repeat(501) }]) {
    await assert.rejects(h.queue.submit({ id: job.id, leaseToken: job.leaseToken, result }), code('INVALID_QNH_QUERY'));
  }
  assert.equal(h.data.jobs[0].status, 'working');
});

test('only the exact missing-image error message survives storage, readback and an idempotent submission', async () => {
  const message = '此 SKU 的商品主图缺失，请在牵牛花核对后重试。';
  const h = memory();
  await h.queue.enqueue(SKU);
  const { job } = await h.queue.claim();
  const input = { id: job.id, leaseToken: job.leaseToken, result: { status: 'error', message } };
  const result = await h.queue.submit(input);
  assert.equal(result.message, message);
  assert.equal(h.data.jobs[0].message, message);
  assert.deepEqual(await h.queue.get(job.id), result);
  const writes = h.calls.writes;
  assert.deepEqual(await h.queue.submit(input), result);
  assert.equal(h.calls.writes, writes);
});

test('near matches, appended HTML and secret text cannot enter the error-message allowlist', async () => {
  const allowed = '此 SKU 的商品主图缺失，请在牵牛花核对后重试。';
  for (const message of [` ${allowed}`, `${allowed} `, `${allowed}<script>synthetic-secret</script>`,
    `${allowed}\nsynthetic-secret`, allowed.replace('SKU', 'sku'), 'synthetic-secret']) {
    const h = memory();
    await h.queue.enqueue(SKU);
    const { job } = await h.queue.claim();
    const result = await h.queue.submit({ id: job.id, leaseToken: job.leaseToken, result: { status: 'error', message } });
    assert.notEqual(result.message, allowed);
    assert.notEqual(result.message, message);
    assert.equal(result.message, '电脑未能完成牵牛花查询，请检查牵牛花页面后重试。');
    assert.equal((await h.queue.get(job.id)).message, result.message);
    assert.ok(!JSON.stringify(h.data).includes('synthetic-secret'));
  }
});

test('only definite 409 CAS conflicts retry and retries stop after three write attempts', async () => {
  const h = memory({ writeFailure: async () => { throw new ConflictError(); } });
  await assert.rejects(h.queue.enqueue(SKU), code('QNH_QUERY_CONFLICT'));
  assert.equal(h.calls.reads, 3);
  assert.equal(h.calls.writes, 3);
  assert.equal(h.data, null);
  const succeeds = memory({ writeFailure: async ({ calls }) => { if (calls.writes < 3) throw new ConflictError(); } });
  assert.equal((await succeeds.queue.enqueue(SKU)).status, 'pending');
  assert.equal(succeeds.calls.writes, 3);
  assert.equal(succeeds.data.jobs.length, 1);
});

test('uncertain writes and branch-rule rejection never repeat a mutation', async () => {
  for (const error of [new GitHubError('unsafe synthetic secret', 'NETWORK_ERROR'), new GitHubError('unsafe', 'TIMEOUT'),
    new GitHubError('unsafe', 'SAVE_UNCONFIRMED'), new GitHubError('unsafe', 'HTTP_ERROR', 500)]) {
    const h = memory({ writeFailure: async () => { throw error; } });
    await assert.rejects(h.queue.enqueue(SKU), code('QNH_QUERY_WRITE_UNCERTAIN'));
    assert.equal(h.calls.writes, 1);
    assert.equal(h.calls.reads, 1);
  }
  const h = memory({ writeFailure: async () => { throw new ConflictError('branch rule', 422); } });
  await assert.rejects(h.queue.enqueue(SKU), error => error instanceof ConflictError && error.status === 422);
  assert.equal(h.calls.writes, 1);
});

test('a lost write response after actual commit stays uncertain and later enqueue reconciles without duplication', async () => {
  let persisted = null;
  let writes = 0;
  const store = {
    async read() { return { data: structuredClone(persisted), sha: persisted === null ? null : 'committed' }; },
    async write(value) { persisted = structuredClone(value); writes++; throw new GitHubError('synthetic lost response', 'NETWORK_ERROR'); },
  };
  const queue = new QnhQueryQueue(store, { now: () => TIME, cryptoImpl: webcrypto });
  await assert.rejects(queue.enqueue(SKU), code('QNH_QUERY_WRITE_UNCERTAIN'));
  assert.equal(writes, 1);
  assert.equal(persisted.jobs.length, 1);
  assert.deepEqual(await queue.enqueue(SKU), { id: persisted.jobs[0].id, status: 'pending' });
  assert.equal(writes, 1);
});

test('CAS retry re-reads and preserves another writer job instead of replaying a stale queue', async () => {
  let persisted = { schemaVersion: 1, jobs: [] };
  let version = 1;
  let writes = 0;
  const otherId = '21100000-0000-4000-8000-000000000001';
  const store = {
    async read() { return { data: structuredClone(persisted), sha: String(version) }; },
    async write(value, expected) {
      writes++;
      if (writes === 1) {
        persisted.jobs.push({ id: otherId, sku: 'OTHER-SKU', createdAt: TIME, expiresAt: TIME + QNH_QUERY_LIMITS.ttlMs, status: 'pending' });
        version++;
        throw new ConflictError();
      }
      assert.equal(expected, String(version));
      persisted = structuredClone(value); version++;
      return { data: persisted, sha: String(version) };
    },
  };
  const queue = new QnhQueryQueue(store, { now: () => TIME, cryptoImpl: webcrypto });
  const requested = await queue.enqueue(SKU);
  assert.equal(writes, 2);
  assert.deepEqual(persisted.jobs.map(value => value.id), [otherId, requested.id]);
  assert.equal(persisted.jobs[0].sku, 'OTHER-SKU');
});

test('malformed stored queue fails closed rather than replacing its contents', async () => {
  for (const initial of [{ schemaVersion: 2, jobs: [] }, { schemaVersion: 1, jobs: [{}] }, { schemaVersion: 1, jobs: [], secret: 'synthetic' }]) {
    const h = memory({ initial });
    await assert.rejects(h.queue.enqueue(SKU), code('INVALID_QNH_QUEUE'));
    assert.equal(h.calls.writes, 0);
    assert.deepEqual(h.data, initial);
  }
});

function apiHarness() {
  let data = { schemaVersion: 1, jobs: [] };
  let revision = 1;
  let time = TIME;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.ok(url === `https://api.github.com/repos/Wzz79229/bzq/contents/${QNH_QUERY_PATH}?ref=main`
      || url === `https://api.github.com/repos/Wzz79229/bzq/contents/${QNH_QUERY_PATH}`);
    assert.equal(options.headers.Authorization, `Bearer ${ENV.GITHUB_TOKEN}`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    const sha = String(revision).padStart(40, '0');
    if (options.method === 'GET') {
      const bytes = Buffer.from(JSON.stringify(data));
      return Response.json({ type: 'file', encoding: 'base64', path: QNH_QUERY_PATH, size: bytes.length, sha, content: bytes.toString('base64') });
    }
    assert.equal(options.method, 'PUT');
    const body = JSON.parse(options.body);
    assert.equal(body.branch, 'main');
    if (body.sha !== sha) return Response.json({ message: 'synthetic conflict' }, { status: 409 });
    data = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
    revision++;
    return Response.json({ content: { sha: String(revision).padStart(40, '0') } });
  };
  const worker = createWorker({ fetchImpl, now: () => time, cryptoImpl: webcrypto });
  const request = (path, { method = 'GET', body, cookie, bridge = false, environment = ENV, headers = {}, origin = bridge ? null : ORIGIN } = {}) => {
    const combined = { ...headers };
    if (origin !== null) combined.Origin = origin;
    if (cookie) combined.Cookie = cookie;
    if (bridge) combined.Authorization ??= `Bearer ${ENV.QNH_CONNECTOR_KEY}`;
    if (body !== undefined) combined['Content-Type'] = 'application/json';
    return worker.fetch(new Request(BASE + path, { method, headers: combined, body: body === undefined ? undefined : JSON.stringify(body) }), environment);
  };
  const login = async () => {
    const response = await request('/api/login', { method: 'POST', body: { password: ENV.TEAM_PASSWORD } });
    assert.equal(response.status, 200);
    return response.headers.get('Set-Cookie').split(';')[0];
  };
  return { request, login, calls, get data() { return structuredClone(data); }, advance(ms) { time += ms; } };
}

test('team create/status and independent bridge claim/result perform a complete single-SKU round trip', async () => {
  const h = apiHarness();
  const cookie = await h.login();
  const response = await h.request('/api/qnh/queries', { method: 'POST', cookie, body: { sku: ` ${SKU} ` } });
  assert.equal(response.status, 202);
  const requested = await response.json();
  assert.deepEqual(Object.keys(requested), ['id', 'status']);
  const claimed = await h.request('/api/qnh/bridge/claim', { method: 'POST', bridge: true });
  assert.equal(claimed.status, 200);
  const { job } = await claimed.json();
  const status = await h.request(`/api/qnh/queries/${requested.id}`, { cookie });
  assert.equal((await status.json()).status, 'working');
  const submitted = await h.request('/api/qnh/bridge/result', { method: 'POST', bridge: true,
    body: { id: job.id, leaseToken: job.leaseToken, result: { status: 'found', product: PRODUCT } } });
  assert.equal(submitted.status, 200);
  const current = await (await h.request(`/api/qnh/queries/${requested.id}`, { cookie })).json();
  assert.equal(current.status, 'found');
  assert.deepEqual(current.product, PRODUCT);
  assert.ok(!JSON.stringify(current).includes(job.leaseToken));
  assert.ok(h.calls.every(value => value.url.includes('data/qnh-queries.json')));
});

test('bridge auth never accepts team cookies, and weak/missing/shared key is an explicit setup error', async () => {
  const h = apiHarness();
  const cookie = await h.login();
  for (const key of [undefined, 'short', ENV.SESSION_SECRET, ENV.GITHUB_TOKEN, 'x'.repeat(32) + '\n']) {
    const response = await h.request('/api/qnh/queries', { method: 'POST', cookie, body: { sku: SKU }, environment: { ...ENV, QNH_CONNECTOR_KEY: key } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'QNH_CONNECTOR_NOT_CONFIGURED');
  }
  const rejected = await h.request('/api/qnh/bridge/claim', { method: 'POST', cookie, origin: null });
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.json()).code, 'QNH_CONNECTOR_AUTH_REQUIRED');
  for (const header of ['Bearer wrong-key', `Basic ${ENV.QNH_CONNECTOR_KEY}`, `Bearer ${ENV.QNH_CONNECTOR_KEY}, Bearer other`]) {
    assert.equal((await h.request('/api/qnh/bridge/claim', { method: 'POST', bridge: true, headers: { Authorization: header } })).status, 401);
  }
  assert.equal(h.calls.length, 0);
});

test('team query endpoints preserve existing auth and CSRF checks while bridge rejects browser calls', async () => {
  const h = apiHarness();
  const cookie = await h.login();
  assert.equal((await h.request('/api/qnh/queries', { method: 'POST', body: { sku: SKU } })).status, 401);
  assert.equal((await h.request('/api/qnh/queries', { method: 'POST', cookie, body: { sku: SKU }, origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.request('/api/qnh/queries', { method: 'POST', cookie, body: { sku: SKU }, origin: null })).status, 403);
  assert.equal((await h.request('/api/qnh/bridge/claim', { method: 'POST', bridge: true, origin: ORIGIN })).status, 403);
  assert.equal((await h.request('/api/qnh/bridge/claim', { method: 'POST', bridge: true, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 403);
  assert.equal((await h.request('/api/qnh/bridge/claim', { method: 'OPTIONS', bridge: true })).status, 405);
  assert.equal(h.calls.length, 0);
});

test('queue API refuses arbitrary fields, URL queries, malformed IDs and bridge claim body without storage calls', async () => {
  const h = apiHarness();
  const cookie = await h.login();
  for (const body of [{ sku: 123 }, { sku: SKU, owner: 'other' }, { sku: SKU, path: 'data/shelf-life.json' }]) {
    assert.equal((await h.request('/api/qnh/queries', { method: 'POST', cookie, body })).status, 400);
  }
  assert.equal((await h.request('/api/qnh/queries?repo=other', { method: 'POST', cookie, body: { sku: SKU } })).status, 404);
  assert.equal((await h.request('/api/qnh/queries/anything', { cookie })).status, 400);
  assert.equal((await h.request('/api/qnh/bridge/claim', { method: 'POST', bridge: true, body: {} })).status, 400);
  assert.equal(h.calls.length, 0);
});

test('offline connector expires explicitly and never reads catalog or photos', async () => {
  const h = apiHarness();
  const cookie = await h.login();
  const { id } = await (await h.request('/api/qnh/queries', { method: 'POST', cookie, body: { sku: SKU } })).json();
  h.advance(QNH_QUERY_LIMITS.ttlMs);
  const result = await (await h.request(`/api/qnh/queries/${id}`, { cookie })).json();
  assert.equal(result.status, 'expired');
  assert.match(result.message, /电脑连接程序/);
  assert.equal(result.product, undefined);
  assert.ok(h.calls.every(value => value.url.includes('data/qnh-queries.json')));
});
