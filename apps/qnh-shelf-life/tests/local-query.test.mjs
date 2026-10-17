import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { configuration, createBridgeClient, validateJob, sanitizedResult, processOne, runAgent, DEFAULT_API } from '../local-query/agent.mjs';
import { normalizeSku, sanitizeProduct, safeImageUrl, resolveExactSku, parseScopedCells, readVisibleProductRows, createQueryAdapter, createVisibleQnhAdapter, observeTableRefresh, QNH_PRODUCT_URL } from '../local-query/extract.mjs';

const SKU = '2110000000000000001';
const KEY = 'synthetic_connector_key_do_not_use_1234567890';
const JOB = { id: '12345678-1234-4234-8234-123456789abc', sku: SKU, leaseToken: 'synthetic-lease-token-0123456789' };
const PRODUCT = {
  sku: SKU, spu: '2110000000000000000', name: '合成测试酸奶', spec: '100g', category: '测试食品',
  barcodes: ['06900000000001'], imageUrl: 'https://img.meituan.net/empowerstoremanagement/synthetic.jpg@80w_80h_90Q',
};
const FOUND = { status: 'found', product: PRODUCT };
const json = (value, status = 200) => Response.json(value, { status });
const ready = rows => ({ complete: true, rows });

test('SKU stays a string with leading zeros and 19-digit precision', () => {
  assert.equal(normalizeSku(` ${SKU} `), SKU);
  assert.equal(normalizeSku('0000123'), '0000123');
  assert.equal(normalizeSku('A.B_3-4'), 'A.B_3-4');
  for (const value of [2110000000000000001, null, '', 'a b', '../x', 'x'.repeat(65), '条码']) assert.throws(() => normalizeSku(value));
});

test('observed product/spec cells parse exact string IDs without unrelated table cells', () => {
  const output = parseScopedCells({
    productText: '预览\n合成测试酸奶\nSPU：2110000000000000000\n商品类目：测试食品',
    specText: '100g\nSKU：2110000000000000001\n商品条码：\n06900000000001\n外部编码：-',
    imageUrls: [PRODUCT.imageUrl, 'https://s3plus.sankuai.com/channel-logo.png'],
  });
  assert.deepEqual(output, PRODUCT);
});

test('multiple SKU blocks must be scoped before parsing and barcodes are never inferred', () => {
  const productText = '预览\n合成测试酸奶\nSPU：2110000000000000000\n商品类目：测试食品';
  assert.throws(() => parseScopedCells({ productText, specText: '100g\nSKU：2110000000000000001\n商品条码：-\nSKU：2110000000000000002' }), /UNSCOPED/);
  const output = parseScopedCells({ productText, specText: '100g\nSKU：2110000000000000001\n商品条码：\n-\n外部编码：-', imageUrls: [PRODUCT.imageUrl] });
  assert.deepEqual(output.barcodes, []);
});

function element(innerText, tagName = 'DIV', children = []) {
  const node = {
    innerText, tagName, children, parentElement: null,
    getClientRects: () => [{}],
    contains(candidate) { while (candidate) { if (candidate === this) return true; candidate = candidate.parentElement; } return false; },
    querySelectorAll(selector) {
      if (selector === 'tbody tr') return this.rows || [];
      const descendants = [];
      const walk = parent => { for (const child of parent.children) { descendants.push(child); walk(child); } };
      walk(this);
      return selector === 'img' ? descendants.filter(child => child.tagName === 'IMG') : descendants;
    },
    closest(selector) { let current = this; while (current) { if (selector === 'table' && current.tagName === 'TABLE') return current; current = current.parentElement; } return null; },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

test('visible DOM extraction keeps nested SKU specifications associated and ignores other cells', t => {
  const previous = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  t.after(() => { if (previous) globalThis.getComputedStyle = previous; else delete globalThis.getComputedStyle; });
  const image = element('', 'IMG'); image.currentSrc = PRODUCT.imageUrl;
  const logo = element('', 'IMG'); logo.currentSrc = 'https://s3plus.sankuai.com/channel-logo.png';
  const productCell = element('预览\n合成测试酸奶\nSPU：2110000000000000000\n商品类目：测试食品', 'TD', [image, logo]);
  const block = (sku, spec, barcode) => element(`${spec}\nSKU：${sku}\n商品条码：\n${barcode}\n外部编码：-`, 'DIV', [
    element(spec), element(`SKU：${sku}`), element(`商品条码：\n${barcode}`), element('外部编码：-'),
  ]);
  const first = block(SKU, '100g', '06900000000001');
  const second = block('2110000000000000002', '200g', '06900000000002');
  const specCell = element(`${first.innerText}\n${second.innerText}`, 'TD', [first, second]);
  const unrelated = element('', 'TD');
  Object.defineProperty(unrelated, 'innerText', { get() { throw new Error('Price/operator cells must not be read'); } });
  const row = element('', 'TR', [element('', 'TD'), productCell, specCell, unrelated]);
  const table = element('', 'TABLE', [row]); table.rows = [row];
  const snapshot = readVisibleProductRows([table]);
  assert.equal(snapshot.unscoped, false);
  assert.equal(snapshot.cells.length, 2);
  const result = resolveExactSku(ready(snapshot.cells.map(parseScopedCells)), '2110000000000000002');
  assert.equal(result.status, 'found');
  assert.equal(result.product.spec, '200g');
  assert.deepEqual(result.product.barcodes, ['06900000000002']);
  assert.equal(result.product.imageUrl, PRODUCT.imageUrl);
});

test('search requires exact SKU, without barcode or SPU fallback', () => {
  const unrelated = { ...PRODUCT, sku: '0001', spu: SKU, barcodes: [SKU] };
  assert.deepEqual(resolveExactSku(ready([unrelated]), SKU).status, 'not_found');
  assert.equal(resolveExactSku(ready([{ ...PRODUCT, sku: `${SKU}2` }, PRODUCT]), SKU).status, 'found');
});

test('identical duplicate DOM rows collapse but different exact matches are ambiguous', () => {
  assert.equal(resolveExactSku(ready([PRODUCT, { ...PRODUCT }]), SKU).status, 'found');
  assert.equal(resolveExactSku(ready([PRODUCT, { ...PRODUCT, spu: '2110000000000000002' }]), SKU).status, 'ambiguous');
  assert.equal(resolveExactSku(ready([PRODUCT, { ...PRODUCT, spec: '200g' }]), SKU).status, 'ambiguous');
});

test('unsettled search, invalid numeric identifiers and expired login never yield found', () => {
  assert.equal(resolveExactSku({ complete: false, rows: [PRODUCT] }, SKU).status, 'error');
  assert.equal(resolveExactSku(ready([{ ...PRODUCT, sku: Number(SKU) }]), SKU).status, 'error');
  assert.equal(resolveExactSku({ ...ready([PRODUCT]), loginRequired: true }, SKU).status, 'login_required');
});

test('missing image is an explicit error and never invents an image URL', () => {
  const result = resolveExactSku(ready([{ ...PRODUCT, imageUrl: '' }]), SKU);
  assert.equal(result.status, 'error');
  assert.match(result.message, /主图缺失/);
  assert.equal(Object.hasOwn(result, 'product'), false);
});

test('product sanitization keeps only allowed fields and never synthesizes barcodes', () => {
  const output = sanitizeProduct({ ...PRODUCT, barcodes: [], password: KEY, customer: 'unrelated', cookie: 'private' }, SKU);
  assert.deepEqual(output, { ...PRODUCT, barcodes: [] });
  assert.doesNotMatch(JSON.stringify(output), /password|customer|cookie/);
  assert.throws(() => sanitizeProduct(PRODUCT, 'another-sku'));
});

test('image URL accepts observed Meituan URLs only without credentials, query or fragment', () => {
  assert.equal(safeImageUrl(PRODUCT.imageUrl), PRODUCT.imageUrl);
  for (const url of ['http://img.meituan.net/x.jpg', 'https://attacker.test/x.jpg', 'https://img.meituan.net/x.jpg?token=secret', 'https://img.meituan.net/x.jpg#x', 'https://u:p@img.meituan.net/x.jpg', 'https://img.meituan.net:8443/x.jpg']) {
    assert.throws(() => safeImageUrl(url));
  }
});

test('query adapter checks login and completion on every request instead of using cached products', async () => {
  const events = [];
  const adapter = createQueryAdapter({
    checkLogin: async () => { events.push('login'); return true; },
    searchSku: async sku => events.push(`search:${sku}`),
    readSearchResults: async () => { events.push('read'); return ready([PRODUCT]); },
  });
  assert.equal((await adapter.lookup(SKU)).status, 'found');
  assert.equal((await adapter.lookup(SKU)).status, 'found');
  assert.deepEqual(events, ['login', `search:${SKU}`, 'read', 'login', `search:${SKU}`, 'read']);
});

test('query adapter does not search or read when login is missing or budget expired', async () => {
  let searches = 0;
  const adapter = createQueryAdapter({ checkLogin: async () => false, searchSku: async () => searches++, readSearchResults: async () => ready([PRODUCT]) });
  assert.equal((await adapter.lookup(SKU)).status, 'login_required');
  assert.equal(searches, 0);
  const expired = createQueryAdapter({ checkLogin: async () => true, searchSku: async () => searches++, readSearchResults: async () => ready([PRODUCT]) });
  assert.equal((await expired.lookup(SKU, { deadline: Date.now() - 1 })).status, 'error');
  assert.equal(searches, 0);
});

function fakeProductPage({ empty = false, cells, refreshed = true, route = 'https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-list', fieldCount = 1, afterClick } = {}) {
  const events = [];
  let value = '';
  const field = { count: async () => fieldCount, isVisible: async () => true,
    fill: async input => { value = input; events.push('fill'); }, inputValue: async () => value };
  const query = { count: async () => 1, isVisible: async () => true,
    click: async () => { events.push('query'); if (afterClick) afterClick({ setInput: input => { value = input; } }); } };
  const table = { evaluateAll: async reader => reader === readVisibleProductRows
    ? { cells: cells ?? [{ productText: '预览\n合成测试酸奶\nSPU：2110000000000000000\n商品类目：测试食品', specText: '100g\nSKU：2110000000000000001\n商品条码：\n06900000000001\n外部编码：-', imageUrls: [PRODUCT.imageUrl] }], unscoped: false }
    : ['商品信息', '规格信息'] };
  const emptyLocator = { count: async () => empty ? 1 : 0, first() { return this; }, isVisible: async () => empty, filter() { return this; } };
  const page = {
    url: () => route,
    locator(selector) {
      if (selector === '.unifiedGoods-ant-form-item-row') return { filter({ hasText }) {
        assert.equal(hasText.source, '^SKU$'); return { locator(input) { assert.equal(input, 'input[type="text"]'); return field; } };
      } };
      assert.equal(selector, '.unifiedGoods-ant-table-empty'); return emptyLocator;
    },
    getByRole(role, options) { if (role === 'table') return table; assert.deepEqual(options, { name: '查询', exact: true }); return query; },
  };
  const watchRefresh = async () => { events.push('observe'); return {
    wait: async () => { events.push('refresh'); return refreshed; }, close: async () => events.push('disconnect'),
  }; };
  return { page, events, watchRefresh };
}

test('real-page adapter uses the verified SKU field and waits for refresh before extracting', async () => {
  const f = fakeProductPage();
  const result = await createVisibleQnhAdapter(f.page, { watchRefresh: f.watchRefresh }).lookup(SKU);
  assert.deepEqual(result, FOUND);
  assert.deepEqual(f.events, ['fill', 'observe', 'query', 'refresh', 'disconnect']);
});

test('verified empty-table text produces not_found; an unknown blank remains error', async () => {
  const f = fakeProductPage({ empty: true, cells: [] });
  assert.equal((await createVisibleQnhAdapter(f.page, { watchRefresh: f.watchRefresh }).lookup(SKU)).status, 'not_found');
  const unknown = fakeProductPage({ cells: [] });
  assert.equal((await createVisibleQnhAdapter(unknown.page, { watchRefresh: unknown.watchRefresh }).lookup(SKU)).status, 'error');
});

test('query with unchanged/unverified refresh does not return stale existing row', async () => {
  const f = fakeProductPage({ refreshed: false });
  assert.equal((await createVisibleQnhAdapter(f.page, { watchRefresh: f.watchRefresh }).lookup(SKU)).status, 'error');
  assert.equal(f.events.at(-1), 'disconnect');
});

test('redirected login or nonunique SKU field prevents querying', async () => {
  for (const options of [{ route: 'https://passport.meituan.com/' }, { fieldCount: 2 }]) {
    const f = fakeProductPage(options);
    const adapter = createVisibleQnhAdapter(f.page, { watchRefresh: f.watchRefresh });
    assert.equal(await adapter.checkLogin(), false);
    assert.equal((await adapter.lookup(SKU)).status, 'login_required');
    assert.deepEqual(f.events, []);
  }
});

test('root-path product page with hash query is accepted and is the preferred entry', async () => {
  assert.equal(QNH_PRODUCT_URL, 'https://qnh.meituan.com/#/unifiedGoods/tenant/spu-list');
  const f = fakeProductPage({ route: `https://qnh.meituan.com/#/unifiedGoods/tenant/spu-list?_t=synthetic&sku=${SKU}` });
  const adapter = createVisibleQnhAdapter(f.page, { watchRefresh: f.watchRefresh });
  assert.equal(await adapter.checkLogin(), true);
  assert.equal((await adapter.lookup(SKU)).status, 'found');
});

test('previously verified home.html product route is still accepted', async () => {
  const f = fakeProductPage({ route: 'https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-list?_t=synthetic' });
  assert.equal(await createVisibleQnhAdapter(f.page, { watchRefresh: f.watchRefresh }).checkLogin(), true);
});

test('unknown path, host or product hash remains rejected', async () => {
  for (const route of [
    'https://qnh.meituan.com/other.html#/unifiedGoods/tenant/spu-list',
    'https://attacker.test/#/unifiedGoods/tenant/spu-list',
    'https://qnh.meituan.com/#/unifiedGoods/tenant/other',
    'https://qnh.meituan.com/#/unifiedGoods/tenant/spu-list-extra',
  ]) {
    const f = fakeProductPage({ route });
    assert.equal(await createVisibleQnhAdapter(f.page, { watchRefresh: f.watchRefresh }).checkLogin(), false);
  }
});

test('input altered after query never returns another lookup as the requested SKU', async () => {
  const f = fakeProductPage({ afterClick: ({ setInput }) => setInput('other-sku') });
  assert.equal((await createVisibleQnhAdapter(f.page, { watchRefresh: f.watchRefresh }).lookup(SKU)).status, 'error');
});

function fakeRefreshPage() {
  let callback;
  let busy = false;
  let mounted = true;
  let loadingClass = 'unifiedGoods-ant-spin-spinning';
  let disconnected = 0;
  const observed = [];
  const timers = new Map();
  let timerId = 0;
  const spinner = { nodeType: 1, getClientRects: () => [{}], getAttribute: () => busy ? `unifiedGoods-ant-spin ${loadingClass}` : 'unifiedGoods-ant-spin',
    matches: () => false, querySelector: () => null, querySelectorAll: () => [] };
  const wrapper = { nodeType: 1, getAttribute: () => '', matches: () => false, querySelector: () => null, querySelectorAll: () => [spinner] };
  const root = { nodeType: 1, querySelectorAll: () => mounted ? [spinner] : [],
    contains: candidate => candidate === spinner || candidate === wrapper,
    closest: () => null, getAttribute: () => '' };
  spinner.parentElement = root;
  wrapper.parentElement = root;
  const table = { getClientRects: () => [{}], closest: () => root };
  const scope = vm.createContext({
    document: { body: { unrelated: true }, querySelectorAll: () => [table] },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    MutationObserver: class {
      constructor(fn) { callback = fn; }
      observe(target, options) { observed.push([target, options]); }
      disconnect() { disconnected++; }
    },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const page = { async evaluateHandle(factory, args) {
    scope.args = args;
    const state = vm.runInContext(`(${factory.toString()})(args)`, scope);
    return { evaluate: async fn => fn(state), dispose: async () => {} };
  } };
  return { page, root, observed, timers,
    get disconnected() { return disconnected; },
    loading(value) { const oldValue = spinner.getAttribute('class'); busy = value; callback([{ type: 'attributes', target: spinner, oldValue }]); },
    mountSpinner(nested = false, marker = 'unifiedGoods-ant-spin-spinning') { mounted = true; busy = true; loadingClass = marker; callback([{ type: 'childList', target: root, addedNodes: [nested ? wrapper : spinner], removedNodes: [] }]); },
    unmountSpinner(nested = false) { mounted = false; callback([{ type: 'childList', target: root, addedNodes: [], removedNodes: [nested ? wrapper : spinner] }]); },
    unrelatedMutation() { callback([{ type: 'childList', target: { nodeType: 1, closest: () => null }, addedNodes: [], removedNodes: [] }]); },
    fire(ms) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } },
  };
}

test('refresh observer watches only the table loading root and waits until loading ends', async () => {
  const f = fakeRefreshPage();
  const watcher = await observeTableRefresh(f.page, 15000);
  assert.equal(f.observed.length, 1);
  assert.equal(f.observed[0][0], f.root);
  f.loading(true);
  assert.equal([...f.timers.values()].some(timer => timer.ms === 600), false);
  f.loading(false);
  assert.equal([...f.timers.values()].some(timer => timer.ms === 600), true);
  const waiting = watcher.wait();
  f.fire(600);
  assert.equal(await waiting, true);
  await watcher.close();
  assert.equal(f.disconnected, 1);
});

test('unrelated UI mutation cannot count as query completion; timeout stays unverified', async () => {
  const f = fakeRefreshPage();
  const watcher = await observeTableRefresh(f.page, 15000);
  f.unrelatedMutation();
  assert.equal([...f.timers.values()].some(timer => timer.ms === 600), false);
  const waiting = watcher.wait();
  f.fire(15000);
  assert.equal(await waiting, false);
  await watcher.close();
});

test('spinner mount/unmount verifies a repeated SKU even when rows are identical', async () => {
  for (const nested of [false, true]) {
    const f = fakeRefreshPage();
    const watcher = await observeTableRefresh(f.page, 15000);
    f.mountSpinner(nested);
    assert.equal([...f.timers.values()].some(timer => timer.ms === 600), false);
    f.unmountSpinner(nested);
    assert.equal([...f.timers.values()].some(timer => timer.ms === 600), true);
    const waiting = watcher.wait();
    f.fire(600);
    assert.equal(await waiting, true);
    await watcher.close();
  }
});

test('nested loading dots/icons must disappear before query completion is accepted', async () => {
  for (const marker of ['unifiedGoods-ant-spin-dot', 'unifiedGoods-anticon-loading']) {
    const f = fakeRefreshPage();
    const watcher = await observeTableRefresh(f.page, 15000);
    f.mountSpinner(true, marker);
    assert.equal([...f.timers.values()].some(timer => timer.ms === 600), false);
    f.unmountSpinner(true);
    const waiting = watcher.wait();
    f.fire(600);
    assert.equal(await waiting, true);
    await watcher.close();
  }
});

test('cancel cleans observer and timers before a table refresh completes', async () => {
  const f = fakeRefreshPage();
  const watcher = await observeTableRefresh(f.page, 15000);
  const waiting = watcher.wait();
  await watcher.close();
  assert.equal(await waiting, false);
  assert.equal(f.disconnected, 1);
  assert.equal(f.timers.size, 0);
});

test('detached query target or destroyed page context still closes the refresh handle', async () => {
  const detached = fakeProductPage({ afterClick() { throw new Error('target detached'); } });
  await assert.rejects(createVisibleQnhAdapter(detached.page, { watchRefresh: detached.watchRefresh }).lookup(SKU), /target detached/);
  assert.equal(detached.events.at(-1), 'disconnect');
  const closed = fakeProductPage();
  const watchRefresh = async () => {
    const watcher = await closed.watchRefresh();
    return { ...watcher, wait: async () => { throw new Error('page context destroyed'); } };
  };
  await assert.rejects(createVisibleQnhAdapter(closed.page, { watchRefresh }).lookup(SKU), /page context destroyed/);
  assert.equal(closed.events.at(-1), 'disconnect');
});

test('configuration uses HTTPS fixed default and a separate persistent profile', () => {
  const config = configuration({ QNH_CONNECTOR_KEY: KEY, LOCALAPPDATA: 'C:\\SyntheticProfile' });
  assert.equal(config.apiBase, DEFAULT_API);
  assert.equal(config.channel, 'msedge');
  assert.match(config.profile, /QnhShelfLife.*QueryBrowser-msedge$/);
  assert.doesNotMatch(config.profile, /Microsoft.*Edge.*User Data/);
  const other = configuration({ QNH_CONNECTOR_KEY: KEY, QNH_API_BASE_URL: 'https://explicit.example.test/', QNH_BROWSER: 'chrome' });
  assert.equal(other.apiBase, 'https://explicit.example.test');
  assert.equal(other.channel, 'chrome');
});

test('configuration rejects missing keys, plaintext or credential-bearing endpoints', () => {
  for (const env of [
    {}, { QNH_CONNECTOR_KEY: 'short' }, { QNH_CONNECTOR_KEY: `${KEY} ` }, { QNH_CONNECTOR_KEY: `${KEY}!` }, { QNH_CONNECTOR_KEY: '中文'.repeat(32) },
    { QNH_CONNECTOR_KEY: KEY, QNH_API_BASE_URL: 'http://example.test' },
    { QNH_CONNECTOR_KEY: KEY, QNH_API_BASE_URL: 'https://user:secret@example.test' },
    { QNH_CONNECTOR_KEY: KEY, QNH_API_BASE_URL: 'https://example.test/?token=secret' },
    { QNH_CONNECTOR_KEY: KEY, QNH_API_BASE_URL: 'https://example.test/path' },
    { QNH_CONNECTOR_KEY: KEY, QNH_BROWSER: 'firefox' },
  ]) assert.throws(() => configuration(env));
});

test('bridge claim sends no body, no browser Origin, no redirect and only the server key', async () => {
  const calls = [];
  const client = createBridgeClient(configuration({ QNH_CONNECTOR_KEY: KEY }), async (url, init) => {
    calls.push([url, init]); return json({ job: JOB });
  });
  assert.deepEqual(await client.claim(), JOB);
  assert.equal(calls[0][0], `${DEFAULT_API}/api/qnh/bridge/claim`);
  const init = calls[0][1];
  assert.equal(init.method, 'POST');
  assert.equal(Object.hasOwn(init, 'body'), false);
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(init.headers.Origin, undefined);
});

test('claim treats no job as idle and rejects malformed or numeric jobs', async () => {
  const config = configuration({ QNH_CONNECTOR_KEY: KEY });
  assert.equal(await createBridgeClient(config, async () => json({ job: null })).claim(), null);
  for (const job of [undefined, {}, { ...JOB, sku: Number(SKU) }, { ...JOB, id: '../../path' }, { ...JOB, leaseToken: 'short' }]) {
    assert.throws(() => validateJob(job));
  }
});

test('bridge submit whitelists product fields and validates matching acknowledgement', async () => {
  let submitted;
  const client = createBridgeClient(configuration({ QNH_CONNECTOR_KEY: KEY }), async (url, init) => {
    submitted = JSON.parse(init.body);
    return json({ id: JOB.id, sku: SKU, status: 'found' });
  });
  await client.submit(JOB, { ...FOUND, product: { ...PRODUCT, cookie: KEY, password: KEY } });
  assert.deepEqual(submitted, { id: JOB.id, leaseToken: JOB.leaseToken, result: FOUND });
  assert.doesNotMatch(JSON.stringify(submitted), /password|cookie/);
  const wrong = createBridgeClient(configuration({ QNH_CONNECTOR_KEY: KEY }), async () => json({ id: JOB.id, sku: 'wrong', status: 'found' }));
  await assert.rejects(wrong.submit(JOB, FOUND), /RESULT_UNCONFIRMED/);
});

test('raw web errors, credentials and unknown result fields are not transmitted', () => {
  assert.deepEqual(sanitizedResult({ status: 'error', message: `password=${KEY}`, html: '<html>private</html>' }, SKU), {
    status: 'error', message: '牵牛花商品查询未完成，请管理员检查本机查询程序。',
  });
  assert.equal(sanitizedResult({ status: 'found', product: { ...PRODUCT, sku: 'wrong' } }, SKU).status, 'error');
  const missing = resolveExactSku(ready([{ ...PRODUCT, imageUrl: '' }]), SKU);
  assert.match(sanitizedResult(missing, SKU).message, /主图缺失/);
});

test('oversized/invalid responses and provider errors are reduced to fixed local codes', async () => {
  const config = configuration({ QNH_CONNECTOR_KEY: KEY });
  for (const [response, code] of [
    [new Response('password-secret', { status: 403 }), 'BRIDGE_AUTH_REQUIRED'],
    [new Response('upstream-private', { status: 409 }), 'LEASE_EXPIRED'],
    [new Response('x'.repeat(17000)), 'INVALID_BRIDGE_RESPONSE'],
    [new Response('not json'), 'INVALID_BRIDGE_RESPONSE'],
  ]) await assert.rejects(createBridgeClient(config, async () => response).claim(), new RegExp(code));
});

test('not logged in returns login_required to the phone without searching or reading products', async () => {
  const notices = [];
  let claimed = 0;
  let submitted;
  let searched = 0;
  const result = await processOne({
    client: { claim: async () => { claimed++; return JOB; }, submit: async (job, value) => { assert.equal(job, JOB); submitted = value; } },
    adapter: { checkLogin: async () => false, lookup: async () => { searched++; throw new Error('must not read products'); } },
    notify: value => notices.push(value),
  });
  assert.equal(result, 'login_required');
  assert.equal(claimed, 1);
  assert.equal(searched, 0);
  assert.deepEqual(submitted, { status: 'login_required' });
  assert.deepEqual(notices, ['login_required']);
});

test('logged-out idle connector still reports login_required locally without submitting an empty job', async () => {
  let submitted = 0;
  const result = await processOne({
    client: { claim: async () => null, submit: async () => submitted++ },
    adapter: { checkLogin: async () => false },
  });
  assert.equal(result, 'login_required');
  assert.equal(submitted, 0);
});

test('logout after claiming a job also reaches the phone without running search or row reads', async () => {
  let loginChecks = 0;
  let searches = 0;
  let reads = 0;
  let submitted;
  const adapter = createQueryAdapter({
    checkLogin: async () => ++loginChecks === 1,
    searchSku: async () => searches++,
    readSearchResults: async () => { reads++; return ready([PRODUCT]); },
  });
  await processOne({
    client: { claim: async () => JOB, submit: async (_job, value) => { submitted = value; } }, adapter,
  });
  assert.equal(submitted.status, 'login_required');
  assert.equal(searches, 0);
  assert.equal(reads, 0);
});

test('one job is queried fresh and submitted before success is announced', async () => {
  const events = [];
  const client = {
    claim: async () => { events.push('claim'); return JOB; },
    submit: async (job, result) => { assert.equal(job, JOB); assert.deepEqual(result, FOUND); events.push('submit'); },
  };
  const adapter = { checkLogin: async () => true, lookup: async (sku, options) => {
    assert.equal(sku, SKU); assert.ok(options.deadline <= Date.now() + 35000); events.push('lookup'); return FOUND;
  } };
  assert.equal(await processOne({ client, adapter, notify: result => events.push(result) }), 'processed');
  assert.deepEqual(events, ['claim', 'lookup', 'submit', 'found']);
});

test('submission uncertainty never announces success or retries a write automatically', async () => {
  const notices = [];
  let submissions = 0;
  await assert.rejects(processOne({
    adapter: { checkLogin: async () => true, lookup: async () => FOUND },
    client: { claim: async () => JOB, submit: async () => { submissions++; throw new Error('network'); } },
    notify: value => notices.push(value),
  }));
  assert.equal(submissions, 1);
  assert.deepEqual(notices, []);
});

test('unexpected browser exceptions become generic error results without credentials', async () => {
  let result;
  await processOne({
    adapter: { checkLogin: async () => true, lookup: async () => { throw new Error(KEY); } },
    client: { claim: async () => JOB, submit: async (_job, value) => { result = value; } },
  });
  assert.deepEqual(result, { status: 'error' });
});

test('agent processes jobs serially, pauses on failures and stops after abort', async () => {
  const controller = new AbortController();
  let claims = 0;
  let active = 0;
  let maximum = 0;
  const pauses = [];
  await runAgent({
    config: { pollMs: 2000 }, signal: controller.signal,
    adapter: { checkLogin: async () => true, lookup: async () => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return FOUND; } },
    client: { claim: async () => { claims++; if (claims === 1) throw new Error('network'); return JOB; }, submit: async () => {} },
    pause: async ms => { pauses.push(ms); if (claims === 3) controller.abort(); },
  });
  assert.equal(maximum, 1);
  assert.equal(claims, 3);
  assert.deepEqual(pauses, [6000, 2000, 2000]);
});
