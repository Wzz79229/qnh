import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { normalizeCatalog } from '../dist/catalog.mjs';
import { CatalogStore, normalizeManifest } from '../backend/catalog-store.mjs';
import { CatalogPublisher, CatalogPublishError, CATALOG_PUBLISH_LIMITS, prepareCatalogSnapshot } from '../backend/catalog-publish.mjs';

const TOKEN = 'github_pat_catalog_publish_synthetic_only';
const ROOT = 'https://api.github.com/repos/Wzz79229/bzq';
const GENERATION = '553cfc6e-4301-44bb-aed3-202b936bb2b2';
const HEAD = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const SOURCE = { platform: 'meituan-qnh', syncedAt: '2026-10-16T07:00:00.000Z', scope: '合成测试商品', complete: false };
const PRODUCT = {
  sku: '2110000000000000001', spu: '2110000000000000000', name: '合成酸奶', spec: '200毫升',
  barcodes: ['0001234567890'], category: '测试乳品', imageUrl: 'https://img.meituan.net/empowerstoremanagement/synthetic.jpg@80w_80h_90Q',
};
const catalog = (products = [PRODUCT]) => ({ schemaVersion: 1, source: SOURCE, products });
const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const hash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const errorCode = code => error => error instanceof CatalogPublishError && error.code === code;

function harness({ mode = 'success', privateRepo = true, existingGeneration = false, timeoutMs = 20_000 } = {}) {
  const tree = new Map([
    ['data/shelf-life.json', Buffer.from('{"products":[{"id":"synthetic-state"}]}')],
    ['photos/21100000-0000-4000-8000-000000000001.jpg', Buffer.from('synthetic-photo')],
    ['data/catalog.json', Buffer.from('{"existing":"catalog"}')],
    ['data/catalog/old-generation/0.json', Buffer.from('old-page')],
  ]);
  const original = new Map([...tree].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const calls = [];
  let head = HEAD;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    if (url === ROOT) return reply(200, { full_name: 'Wzz79229/bzq', private: privateRepo });
    if (url === `${ROOT}/git/ref/heads/main`) return reply(200, { ref: 'refs/heads/main', object: { type: 'commit', sha: head } });
    if (url === `${ROOT}/contents/data/catalog/${GENERATION}?ref=${HEAD}`) return reply(existingGeneration ? 200 : 404, []);
    assert.equal(url, 'https://api.github.com/graphql');
    assert.equal(options.method, 'POST');
    const request = JSON.parse(options.body);
    assert.match(request.query, /createCommitOnBranch/);
    assert.deepEqual(request.variables.input.branch, { repositoryNameWithOwner: 'Wzz79229/bzq', branchName: 'main' });
    assert.equal(request.variables.input.expectedHeadOid, HEAD);
    assert.equal(request.variables.input.clientMutationId, GENERATION);
    assert.deepEqual(Object.keys(request.variables.input.fileChanges), ['additions']);
    const additions = request.variables.input.fileChanges.additions;
    for (const addition of additions) {
      assert.match(addition.path, new RegExp(`^(?:data/catalog\\.json|data/catalog/${GENERATION}/\\d+\\.json)$`));
      assert.ok(!addition.path.startsWith('photos/'));
    }
    if (mode === 'conflict') {
      // Another writer changes the state while this publish is being prepared.
      tree.set('data/shelf-life.json', Buffer.from('{"products":[{"id":"other-writer"}]}'));
      head = OTHER;
      return reply(200, { data: { createCommitOnBranch: null }, errors: [{ type: 'STALE_DATA', path: ['createCommitOnBranch'], message: `${TOKEN} private provider message` }] });
    }
    if (mode === 'forbidden') return reply(403, { message: `${TOKEN} provider secret` });
    if (mode === 'validation') return reply(200, { data: { createCommitOnBranch: null }, errors: [{ type: 'UNPROCESSABLE', path: ['createCommitOnBranch'], message: `${TOKEN} provider validation detail` }] });
    if (mode === 'network') throw new Error(`${TOKEN} unsafe network detail`);
    if (mode === 'timeout') return new Promise(() => {});
    if (mode === 'server') return reply(500, { message: `${TOKEN} provider server detail` });
    if (mode === 'broken-json') return new Response('{not-json', { status: 200 });
    if (mode === 'oversized') return new Response('x'.repeat(140_000), { status: 200 });
    if (mode === 'partial-error') return reply(200, { data: { createCommitOnBranch: { clientMutationId: GENERATION } }, errors: [{ type: 'INTERNAL', path: ['createCommitOnBranch', 'commit'] }] });
    if (mode === 'unknown-error') return reply(200, { data: { createCommitOnBranch: null }, errors: [{ type: 'INTERNAL', path: ['createCommitOnBranch'] }] });
    if (mode === 'redirect') return new Response('', { status: 302, headers: { location: 'https://evil.example/' } });
    if (mode === 'rate-limit') return reply(429, { message: `${TOKEN} provider rate limit` });
    if (mode === 'unexpected-result') return reply(200, { data: { createCommitOnBranch: { commit: { oid: COMMIT } } } });
    for (const addition of additions) tree.set(addition.path, Buffer.from(addition.contents, 'base64'));
    head = COMMIT;
    if (mode === 'committed-response-lost') throw new Error(`${TOKEN} response lost after commit`);
    return reply(200, { data: { createCommitOnBranch: {
      clientMutationId: GENERATION, commit: { oid: COMMIT, parents: { nodes: [{ oid: HEAD }] } }, ref: { name: 'main', target: { oid: COMMIT } },
    } } });
  };
  return {
    tree, original, calls, fetchImpl, get head() { return head; },
    publisher: new CatalogPublisher({ token: TOKEN, timeoutMs }, fetchImpl, webcrypto),
  };
}

test('snapshot preserves string identifiers, exact UTF-8 bytes and Git blob SHA1 in bounded pages', async () => {
  const products = Array.from({ length: 1001 }, (_, index) => ({ ...PRODUCT, sku: `000${index}` }));
  const snapshot = await prepareCatalogSnapshot(catalog(products), { generation: GENERATION }, webcrypto);
  assert.deepEqual(normalizeManifest(snapshot.manifest), snapshot.manifest);
  assert.deepEqual(snapshot.manifest.pages.map(page => page.count), [500, 500, 1]);
  assert.equal(snapshot.manifest.total, 1001);
  assert.equal(snapshot.files.length, 4);
  const normalized = [];
  for (const page of snapshot.manifest.pages) {
    const item = snapshot.files.find(item => item.path === page.path);
    const bytes = Buffer.from(item.content, 'base64');
    assert.equal(bytes.length, item.bytes);
    assert.equal(hash(bytes), item.sha);
    assert.equal(item.sha, page.sha);
    assert.ok(item.bytes <= CATALOG_PUBLISH_LIMITS.pageBytes);
    assert.ok(bytes.toString('utf8').endsWith('\n'));
    const parsed = JSON.parse(bytes);
    assert.deepEqual(parsed.source, SOURCE);
    assert.deepEqual(normalizeCatalog(parsed), parsed);
    normalized.push(...parsed.products);
  }
  assert.deepEqual(normalized, products);
  const manifestFile = snapshot.files.at(-1);
  assert.equal(manifestFile.path, 'data/catalog.json');
  assert.equal(hash(Buffer.from(manifestFile.content, 'base64')), manifestFile.sha);
  assert.deepEqual(JSON.parse(Buffer.from(manifestFile.content, 'base64')), snapshot.manifest);
});

test('byte-heavy valid products paginate before 900000 bytes even when below 500 SKU', async () => {
  const large = { ...PRODUCT, name: '字'.repeat(200), spec: '字'.repeat(120), category: '字'.repeat(200), barcodes: Array.from({ length: 32 }, (_, i) => `${i}`.padStart(128, '0')) };
  const products = Array.from({ length: 500 }, (_, index) => ({ ...large, sku: `large-${index}` }));
  const snapshot = await prepareCatalogSnapshot(catalog(products), { generation: GENERATION }, webcrypto);
  assert.ok(snapshot.manifest.pages.length > 1);
  assert.ok(snapshot.manifest.pages.every(page => page.count < 500));
  assert.ok(snapshot.files.slice(0, -1).every(item => item.bytes <= 900_000));
  assert.equal(snapshot.manifest.pages.reduce((sum, page) => sum + page.count, 0), 500);
});

test('unknown private metadata is stripped and source completeness remains explicit', async () => {
  const snapshot = await prepareCatalogSnapshot({ ...catalog(), secret: TOKEN, source: { ...SOURCE, account: TOKEN }, products: [{ ...PRODUCT, password: TOKEN }] }, { generation: GENERATION }, webcrypto);
  assert.equal(snapshot.manifest.source.complete, false);
  for (const item of snapshot.files) assert.ok(!Buffer.from(item.content, 'base64').toString().includes(TOKEN));
});

test('empty snapshot is representable and a generated UUID is fixed across its files', async () => {
  const cryptoImpl = { subtle: webcrypto.subtle, randomUUID: () => GENERATION };
  const snapshot = await prepareCatalogSnapshot(catalog([]), {}, cryptoImpl);
  assert.deepEqual(snapshot.manifest.pages, []);
  assert.equal(snapshot.manifest.total, 0);
  assert.equal(snapshot.manifest.generation, GENERATION);
  assert.equal(snapshot.files.length, 1);
});

test('invalid input, unsafe image URLs, duplicate SKUs and path-like generations fail before network', async () => {
  for (const [input, options] of [
    [{ ...catalog(), schemaVersion: 2 }, {}],
    [catalog([{ ...PRODUCT, sku: 2110000000000000001 }]), {}],
    [catalog([{ ...PRODUCT, imageUrl: 'https://evil.example/private' }]), {}],
    [catalog([PRODUCT, PRODUCT]), {}],
    [{ ...catalog(), source: { ...SOURCE, complete: undefined } }, {}],
    [catalog(), { generation: '../shelf-life' }],
    [catalog(), { generation: GENERATION.toUpperCase() }],
    [catalog(), { expectedHead: '../main' }],
  ]) {
    const h = harness();
    await assert.rejects(h.publisher.publish(input, options), errorCode('INVALID_CATALOG_SNAPSHOT'));
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.tree, h.original);
  }
});

test('successful strict CAS writes all pages and manifest in one commit without touching state or photos', async () => {
  const h = harness();
  const output = await h.publisher.publish(catalog(), { expectedHead: HEAD, generation: GENERATION });
  assert.deepEqual(output, { status: 'published', commitSha: COMMIT, generation: GENERATION, expectedHead: HEAD, total: 1, pageCount: 1, source: SOURCE });
  assert.equal(h.calls.length, 4);
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(h.head, COMMIT);
  for (const [path, bytes] of h.original) if (path !== 'data/catalog.json') assert.deepEqual(h.tree.get(path), bytes);
  const manifest = JSON.parse(h.tree.get('data/catalog.json'));
  assert.equal(manifest.generation, GENERATION);
  for (const page of manifest.pages) assert.equal(hash(h.tree.get(page.path)), page.sha);
  assert.ok(!JSON.stringify(h.publisher).includes(TOKEN));
  assert.ok(!JSON.stringify(output).includes(TOKEN));
});

test('publisher output can be read by the current CatalogStore protocol without adaptation', async () => {
  const h = harness();
  await h.publisher.publish(catalog(), { generation: GENERATION });
  const store = new CatalogStore({ token: TOKEN }, async url => {
    const parsed = new URL(url);
    const path = parsed.pathname.split('/contents/')[1];
    const bytes = h.tree.get(path);
    assert.ok(bytes);
    return reply(200, { path, type: 'file', encoding: 'base64', size: bytes.length, sha: hash(bytes), content: bytes.toString('base64') });
  }, webcrypto);
  assert.equal((await store.read()).generation, GENERATION);
  assert.deepEqual(await store.page(0), { ...catalog(), generation: GENERATION, index: 0 });
});

test('an expected-head mismatch and an existing immutable generation do not issue any mutation', async () => {
  for (const [options, config, code] of [
    [{ generation: GENERATION, expectedHead: OTHER }, {}, 'CATALOG_PUBLISH_CONFLICT'],
    [{ generation: GENERATION }, { existingGeneration: true }, 'CATALOG_GENERATION_EXISTS'],
  ]) {
    const h = harness(config);
    await assert.rejects(h.publisher.publish(catalog(), options), errorCode(code));
    assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
    assert.deepEqual(h.tree, h.original);
  }
});

test('CAS conflict preserves the prior catalog, photos and another writer’s new state without retry', async () => {
  const h = harness({ mode: 'conflict' });
  await assert.rejects(h.publisher.publish(catalog(), { generation: GENERATION }), error => errorCode('CATALOG_PUBLISH_CONFLICT')(error) && !error.message.includes(TOKEN));
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(h.head, OTHER);
  assert.deepEqual(h.tree.get('data/catalog.json'), h.original.get('data/catalog.json'));
  assert.deepEqual(h.tree.get('photos/21100000-0000-4000-8000-000000000001.jpg'), h.original.get('photos/21100000-0000-4000-8000-000000000001.jpg'));
  assert.equal(JSON.parse(h.tree.get('data/shelf-life.json')).products[0].id, 'other-writer');
  assert.equal(h.tree.size, h.original.size);
});

test('definite HTTP and root GraphQL rejection preserve the complete prior tree without leaking details', async () => {
  for (const [mode, code] of [['forbidden', 'CATALOG_ACCESS_DENIED'], ['validation', 'CATALOG_PUBLISH_FAILED'], ['rate-limit', 'RATE_LIMITED']]) {
    const h = harness({ mode });
    await assert.rejects(h.publisher.publish(catalog(), { generation: GENERATION }), error => errorCode(code)(error) && !error.message.includes(TOKEN) && !error.message.includes('provider'));
    assert.deepEqual(h.tree, h.original);
    assert.equal(h.head, HEAD);
    assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  }
});

test('timeouts, transport failures and ambiguous responses return uncertain and never auto-retry', async () => {
  for (const mode of ['network', 'timeout', 'server', 'broken-json', 'oversized', 'partial-error', 'unknown-error', 'redirect', 'unexpected-result']) {
    const h = harness({ mode, timeoutMs: mode === 'timeout' ? 5 : 20_000 });
    const output = await h.publisher.publish(catalog(), { generation: GENERATION });
    assert.deepEqual(output, { status: 'uncertain', code: 'CATALOG_PUBLISH_UNCERTAIN', generation: GENERATION, expectedHead: HEAD, total: 1, pageCount: 1, source: SOURCE });
    assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1, mode);
    assert.deepEqual(h.tree, h.original);
    assert.equal(h.head, HEAD);
    assert.ok(!JSON.stringify(output).includes(TOKEN));
  }
});

test('a public repository is rejected before head lookup or any write', async () => {
  const h = harness({ privateRepo: false });
  await assert.rejects(h.publisher.publish(catalog(), { generation: GENERATION }), errorCode('SETUP_REQUIRED'));
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.tree, h.original);
});

test('a lost response after an actual commit stays uncertain and never writes a second commit', async () => {
  const h = harness({ mode: 'committed-response-lost' });
  const output = await h.publisher.publish(catalog(), { generation: GENERATION });
  assert.equal(output.status, 'uncertain');
  assert.equal(h.head, COMMIT);
  assert.equal(JSON.parse(h.tree.get('data/catalog.json')).generation, GENERATION);
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.deepEqual(h.tree.get('data/shelf-life.json'), h.original.get('data/shelf-life.json'));
  assert.deepEqual(h.tree.get('photos/21100000-0000-4000-8000-000000000001.jpg'), h.original.get('photos/21100000-0000-4000-8000-000000000001.jpg'));
});

test('read-stage failure is safe to retry and is not reported as an uncertain mutation', async () => {
  let count = 0;
  const publisher = new CatalogPublisher({ token: TOKEN }, async () => { count++; throw new Error(`${TOKEN} failure`); }, webcrypto);
  await assert.rejects(publisher.publish(catalog(), { generation: GENERATION }), error => errorCode('CATALOG_PUBLISH_FAILED')(error) && !error.message.includes(TOKEN));
  assert.equal(count, 1);
});

test('configuration validation hides the token and rejects whitespace, invalid crypto and timeouts', () => {
  for (const options of [{}, { token: '' }, { token: `${TOKEN}\nunsafe` }, { token: TOKEN, timeoutMs: 0 }, { token: TOKEN, timeoutMs: 60_001 }]) {
    assert.throws(() => new CatalogPublisher(options, () => {}, webcrypto), errorCode('SETUP_REQUIRED'));
  }
  assert.throws(() => new CatalogPublisher({ token: TOKEN }, null, webcrypto), errorCode('SETUP_REQUIRED'));
  assert.throws(() => new CatalogPublisher({ token: TOKEN }, () => {}, {}), errorCode('SETUP_REQUIRED'));
});
