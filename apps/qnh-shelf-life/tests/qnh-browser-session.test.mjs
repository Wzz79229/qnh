import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  QNH_BROWSER_LIMITS, QNH_PHONE_COOKIE, QnhBrowserError,
  createQnhPhoneCookie, readQnhPhoneCookie, clearQnhPhoneCookie, requireQnhBrowserOrigin,
  normalizeQnhViewerInput, ManagedQnhPhoneSession, createCloudflareQnhBrowserFactory, readObservedQnhTenantId, readLoggedInQnhShell,
} from '../backend/qnh-browser-session.mjs';

const BASE = 'https://fresh-period.example.workers.dev';
const TIME = Date.parse('2026-10-17T10:00:00.000Z');
const SKU = '0002110000000000000001';
const PRODUCT = { sku: SKU, spu: '0002110000000000000000', name: '合成测试酸奶', spec: '200毫升', category: '测试乳品',
  barcodes: ['0001234567890'], imageUrl: 'https://img.meituan.net/empowerstoremanagement/synthetic.jpg@80w_80h_90Q' };
const JPEG = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const code = expected => error => error instanceof QnhBrowserError && error.code === expected;
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function harness(options = {}) {
  let time = TIME;
  let accessible = false;
  const events = [];
  const calls = { starts: 0, closes: 0, reserves: 0, releases: 0, probes: 0 };
  const browser = {
    async frame() { events.push('frame'); return JPEG; },
    async input(value) { events.push(['input', value]); },
    async verifyAccess() { calls.probes++; events.push('probe'); return accessible; },
    async lookup(sku) { events.push(['lookup', sku]); return { status: 'found', product: PRODUCT }; },
    async close() { calls.closes++; },
    ...options.browser,
  };
  const session = new ManagedQnhPhoneSession({
    now: () => time,
    async reserveBrowser(value) {
      calls.reserves++; events.push(['reserve', value]);
      if (options.quotaError) throw options.quotaError;
      return { async release() { calls.releases++; } };
    },
    async browserFactory() { calls.starts++; if (options.startError) throw options.startError; return browser; },
  });
  return { session, calls, events, browser, advance(ms) { time += ms; }, set accessible(value) { accessible = value; } };
}

test('phone cookie is random opaque server routing material, Secure/HttpOnly/Strict and duplicate-safe', () => {
  const first = createQnhPhoneCookie(webcrypto);
  const second = createQnhPhoneCookie(webcrypto);
  assert.match(first.token, /^[a-f0-9]{64}$/u);
  assert.notEqual(first.token, second.token);
  assert.equal(first.cookie, `${QNH_PHONE_COOKIE}=${first.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600`);
  const request = cookie => new Request(BASE, { headers: { Cookie: cookie } });
  assert.equal(readQnhPhoneCookie(request(`other=one; ${QNH_PHONE_COOKIE}=${first.token}`)), first.token);
  for (const cookie of ['', `${QNH_PHONE_COOKIE}=short`, `${QNH_PHONE_COOKIE}=${first.token}; ${QNH_PHONE_COOKIE}=${second.token}`,
    `${QNH_PHONE_COOKIE}=${first.token.toUpperCase()}`, `${QNH_PHONE_COOKIE}=${'a'.repeat(4097)}`]) assert.equal(readQnhPhoneCookie(request(cookie)), null);
  assert.match(clearQnhPhoneCookie(), /Max-Age=0/u);
});

test('browser-login transport requires exact same-origin Origin and rejects cross-site or missing Origin', () => {
  const request = (origin, site, url = BASE) => new Request(url, { headers: {
    ...(origin ? { Origin: origin } : {}), ...(site ? { 'Sec-Fetch-Site': site } : {}),
  } });
  assert.doesNotThrow(() => requireQnhBrowserOrigin(request(BASE, 'same-origin'), BASE));
  assert.doesNotThrow(() => requireQnhBrowserOrigin(request(BASE), BASE));
  for (const value of [request(), request('https://evil.example', 'cross-site'), request(BASE, 'same-site'),
    request(BASE, 'same-origin', 'https://other.example/')]) assert.throws(() => requireQnhBrowserOrigin(value, BASE), code('QNH_BROWSER_ORIGIN_DENIED'));
  assert.throws(() => requireQnhBrowserOrigin(request(BASE), `${BASE}/path`), code('QNH_BROWSER_NOT_CONFIGURED'));
});

test('viewer accepts bounded pointer/text/scroll/drag and rounds coordinates inward', () => {
  assert.deepEqual(normalizeQnhViewerInput({ type: 'click', x: 1279.9, y: 899.9 }), { type: 'click', x: 1279, y: 899 });
  assert.deepEqual(normalizeQnhViewerInput({ type: 'text', text: '员工123' }), { type: 'text', text: '员工123' });
  assert.deepEqual(normalizeQnhViewerInput({ type: 'key', key: 'Enter' }), { type: 'key', key: 'Enter' });
  assert.deepEqual(normalizeQnhViewerInput({ type: 'scroll', x: 40, y: 60, deltaY: -100 }), { type: 'scroll', x: 40, y: 60, deltaY: -100 });
  assert.deepEqual(normalizeQnhViewerInput({ type: 'drag', points: [{ x: 1, y: 2 }, { x: 200, y: 2 }] }),
    { type: 'drag', points: [{ x: 1, y: 2 }, { x: 200, y: 2 }] });
});

test('viewer rejects CDP, eval, URLs, selectors, modifier shortcuts, control text, unexpected fields and unbounded values', () => {
  const inputs = [null, [], { type: 'Runtime.evaluate', expression: 'document.body.innerHTML="forged"' },
    { type: 'navigate', url: 'javascript:alert(1)' }, { type: 'click', selector: 'input' },
    { type: 'click', x: -1, y: 1 }, { type: 'click', x: 1280, y: 1 }, { type: 'click', x: 1, y: NaN },
    { type: 'click', x: 1, y: 2, targetId: 'secret' }, { type: 'key', key: 'F12' }, { type: 'key', key: 'Control' },
    { type: 'key', key: 'Enter', modifiers: 2 }, { type: 'text', text: '' }, { type: 'text', text: 'x'.repeat(129) },
    { type: 'text', text: 'password\nnext' }, { type: 'text', text: '\u202e' },
    { type: 'scroll', x: 1, y: 2, deltaY: 901 }, { type: 'drag', points: [] },
    { type: 'drag', points: Array.from({ length: 33 }, () => ({ x: 1, y: 2 })) }];
  for (const input of inputs) assert.throws(() => normalizeQnhViewerInput(input), code('INVALID_QNH_BROWSER_INPUT'));
});

test('session requires an atomic external quota gate and startup reserves once without exposing browser capabilities', async () => {
  assert.throws(() => new ManagedQnhPhoneSession({ browserFactory() {} }), code('QNH_BROWSER_NOT_CONFIGURED'));
  const h = harness();
  const status = await h.session.start();
  assert.deepEqual(status, { authorized: false, loginMethod: 'qnh_browser', status: 'login', expiresAt: TIME + QNH_BROWSER_LIMITS.loginMs,
    viewport: { width: 1280, height: 900 } });
  assert.deepEqual(await h.session.start(), status);
  assert.equal(h.calls.starts, 1); assert.equal(h.calls.reserves, 1);
  assert.deepEqual(h.events[0], ['reserve', { maximumMs: QNH_BROWSER_LIMITS.sessionMs }]);
  assert.doesNotMatch(JSON.stringify(status), /sessionId|targetId|devtools|webSocket|token/u);
});

test('quota denial allocates no browser, and raw provider failures are never reflected', async () => {
  const denied = harness({ quotaError: new QnhBrowserError(429, 'QNH_BROWSER_QUOTA', '今日连接额度已用完。') });
  await assert.rejects(denied.session.start(), code('QNH_BROWSER_QUOTA'));
  assert.equal(denied.calls.starts, 0);
  const failed = harness({ startError: new Error('private CDP token / password / stack from provider') });
  await assert.rejects(failed.session.start(), error => code('QNH_BROWSER_UNAVAILABLE')(error) && !error.message.includes('private'));
  assert.equal(failed.calls.releases, 1);
  await assert.rejects(failed.session.start(), code('QNH_BROWSER_SESSION_EXPIRED'));
});

test('only an exact trusted true access result grants entry; phone cannot submit an authorization flag', async () => {
  const h = harness(); await h.session.start();
  for (const result of [false, undefined, { authorized: true }, 'true', 1]) {
    h.accessible = result;
    assert.equal((await h.session.verify()).authorized, false);
  }
  assert.throws(() => h.session.input({ type: 'authorized', authorized: true }), code('INVALID_QNH_BROWSER_INPUT'));
  await assert.rejects(h.session.lookup(SKU), code('QNH_BROWSER_LOGIN_REQUIRED'));
  h.accessible = true;
  assert.equal((await h.session.verify()).authorized, true);
  await assert.rejects(h.session.input({ type: 'text', text: 'not accepted after login' }), code('QNH_BROWSER_INPUT_FROZEN'));
  await assert.rejects(h.session.frame(), code('QNH_BROWSER_INPUT_FROZEN'));
});

test('verification freezes immediately, drains previously accepted input, then probes and blocks all later input', async () => {
  const inputGate = deferred(); const events = [];
  const h = harness({ browser: {
    async input() { events.push('input-start'); await inputGate.promise; events.push('input-end'); },
    async verifyAccess() { events.push('probe'); return true; },
  } });
  await h.session.start();
  const accepted = h.session.input({ type: 'text', text: 'synthetic user' });
  const verifying = h.session.verify();
  assert.equal(h.session.verify(), verifying);
  await assert.rejects(h.session.input({ type: 'key', key: 'Enter' }), code('QNH_BROWSER_INPUT_FROZEN'));
  inputGate.resolve(); await accepted;
  assert.equal((await verifying).authorized, true);
  assert.deepEqual(events, ['input-start', 'input-end', 'probe']);
});

test('failed login proof unfreezes input but provider probe failure closes and releases safely', async () => {
  const h = harness(); await h.session.start();
  assert.equal((await h.session.verify()).authorized, false);
  assert.deepEqual(await h.session.input({ type: 'click', x: 1, y: 1 }), { accepted: true });
  h.browser.verifyAccess = async () => { throw new Error('password and CDP URL must not escape'); };
  await assert.rejects(h.session.verify(), error => code('QNH_BROWSER_UNAVAILABLE')(error) && !error.message.includes('password'));
  assert.equal(h.calls.closes, 1); assert.equal(h.calls.releases, 1);
});

test('login has an absolute three-minute deadline, and repeated requests cannot renew it', async () => {
  const h = harness(); await h.session.start();
  h.advance(QNH_BROWSER_LIMITS.loginMs - 1);
  assert.equal((await h.session.verify()).authorized, false);
  h.advance(1);
  await assert.rejects(h.session.verify(), code('QNH_BROWSER_SESSION_EXPIRED'));
  assert.equal(h.calls.closes, 1); assert.equal(h.calls.releases, 1);
  await assert.rejects(h.session.start(), code('QNH_BROWSER_SESSION_EXPIRED'));
});

test('authorization and SKU requests retain the original maximum session deadline', async () => {
  const h = harness(); await h.session.start();
  h.advance(100_000); h.accessible = true;
  const status = await h.session.verify();
  assert.equal(status.expiresAt, TIME + QNH_BROWSER_LIMITS.sessionMs);
  assert.deepEqual(await h.session.lookup(` ${SKU} `), { status: 'found', product: PRODUCT });
  assert.equal(h.calls.probes, 3);
  assert.deepEqual(h.events.filter(value => Array.isArray(value) && value[0] === 'lookup'), [['lookup', SKU]]);
  h.advance(QNH_BROWSER_LIMITS.sessionMs - 100_000);
  await assert.rejects(h.session.lookup(SKU), code('QNH_BROWSER_SESSION_EXPIRED'));
  assert.equal(h.calls.closes, 1);
});

test('a logout/tenant change before or after lookup closes the same phone session and withholds product data', async () => {
  const before = harness(); await before.session.start(); before.accessible = true; await before.session.verify();
  before.accessible = false;
  await assert.rejects(before.session.lookup(SKU), code('QNH_BROWSER_SESSION_EXPIRED'));
  assert.equal(before.events.filter(value => Array.isArray(value) && value[0] === 'lookup').length, 0);
  const after = harness(); await after.session.start(); after.accessible = true; await after.session.verify();
  after.browser.lookup = async () => { after.accessible = false; return { status: 'found', product: PRODUCT }; };
  await assert.rejects(after.session.lookup(SKU), code('QNH_BROWSER_SESSION_EXPIRED'));
  assert.equal(after.calls.closes, 1);
});

test('stale authorized cookie cannot retain entry after access revocation', async () => {
  const h = harness(); await h.session.start(); h.accessible = true; await h.session.verify();
  h.accessible = false;
  await assert.rejects(h.session.status(), code('QNH_BROWSER_SESSION_EXPIRED'));
  assert.equal(h.calls.closes, 1); assert.equal(h.calls.releases, 1);
});

test('frame bytes are private in-memory bounded JPEG and rate-limited; bad provider frame closes safely', async () => {
  const h = harness(); await h.session.start();
  assert.deepEqual(await h.session.frame(), JPEG);
  await assert.rejects(h.session.frame(), code('QNH_BROWSER_FRAME_RATE'));
  h.advance(QNH_BROWSER_LIMITS.frameIntervalMs);
  assert.deepEqual(await h.session.frame(), JPEG);
  h.advance(QNH_BROWSER_LIMITS.frameIntervalMs);
  h.browser.frame = async () => new TextEncoder().encode('<html>provider secret</html>');
  await assert.rejects(h.session.frame(), code('QNH_BROWSER_UNAVAILABLE'));
  assert.equal(h.calls.closes, 1);
});

test('input rate and total accepted input are bounded without closing a healthy login', async () => {
  const h = harness(); await h.session.start();
  await h.session.input({ type: 'key', key: 'Tab' });
  await assert.rejects(h.session.input({ type: 'key', key: 'Tab' }), code('QNH_BROWSER_INPUT_RATE'));
  h.advance(QNH_BROWSER_LIMITS.inputIntervalMs);
  await h.session.input({ type: 'key', key: 'Tab' });
  for (let attempt = 3; attempt < QNH_BROWSER_LIMITS.inputs; attempt++) {
    h.advance(QNH_BROWSER_LIMITS.inputIntervalMs);
    await h.session.input({ type: 'key', key: 'Tab' });
  }
  h.advance(QNH_BROWSER_LIMITS.inputIntervalMs);
  await assert.rejects(h.session.input({ type: 'key', key: 'Tab' }), code('QNH_BROWSER_INPUT_RATE'));
  assert.equal(h.calls.closes, 0);
});

test('non-product provider messages are fixed; exact SKU product is sanitized again server-side', async () => {
  const h = harness(); await h.session.start(); h.accessible = true; await h.session.verify();
  h.browser.lookup = async () => ({ status: 'error', message: 'secret provider cookie or URL' });
  const error = await h.session.lookup(SKU);
  assert.equal(error.status, 'error'); assert.ok(!error.message.includes('secret'));
  h.browser.lookup = async () => ({ status: 'found', product: { ...PRODUCT, sku: 'different' } });
  assert.equal((await h.session.lookup(SKU)).status, 'not_found');
  assert.throws(() => h.session.lookup(2110000000000000001), /INVALID_SKU/u);
  await h.session.close(); await h.session.close();
  assert.equal(h.calls.closes, 1); assert.equal(h.calls.releases, 1);
});

function bindingHarness({ result, exception = false, commandResult } = {}) {
  const commands = []; const acquired = []; const closed = []; const connections = [];
  const socket = new EventTarget();
  socket.accept = () => {};
  socket.close = () => {};
  socket.send = value => {
    const command = JSON.parse(value); commands.push(command);
    const body = exception ? { error: { message: 'provider private URL jwt=secret' } }
      : commandResult ? { result: commandResult(command) }
        : { result: command.method === 'Runtime.evaluate' ? { result: { value: result ?? { origin: 'https://qnh.meituan.com', shell: true, tenantId: '1012619' } } }
        : command.method === 'Page.captureScreenshot' ? { data: Buffer.from(JPEG).toString('base64') } : {} };
    queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: command.id, ...body }) })));
  };
  return {
    commands, acquired, closed, connections,
    binding: {
      async acquire(options) { acquired.push(options); return { sessionId: 'private-browser-id' }; },
      devtools: { async newTarget(id, url) { assert.equal(id, 'private-browser-id'); assert.equal(url, 'about:blank'); return { id: 'private-target-id' }; } },
      async connectSession(id, options) { connections.push({ id, options }); return { webSocket: { async fetch(url, options) {
        assert.equal(url, 'https://browser-binding.invalid'); assert.equal(options.headers.Upgrade, 'websocket'); return { webSocket: socket };
      } } }; },
      async closeSession(id) { closed.push(id); },
    },
  };
}
const FACTORY_OPTIONS = { expectedTenantId: '1012619', allowedDomains: ['qnh.meituan.com', '*.meituan.net'],
  async confirmProductAccess() { return true; } };

test('native factory refuses a missing fixed tenant or unknown relay domains before allocation', () => {
  const h = bindingHarness();
  for (const options of [{ ...FACTORY_OPTIONS, expectedTenantId: undefined }, { ...FACTORY_OPTIONS, expectedTenantId: 1012619 },
    { ...FACTORY_OPTIONS, allowedDomains: ['qnh.meituan.com', '*.com'] },
    { ...FACTORY_OPTIONS, allowedDomains: ['evil.example'] }]) {
    assert.throws(() => createCloudflareQnhBrowserFactory(h.binding, options), code('QNH_BROWSER_NOT_CONFIGURED'));
  }
  assert.equal(h.acquired.length, 0);
});

test('native adapter keeps CDP/target capabilities private, recording disabled, fixed login route and strict controls', async () => {
  const h = bindingHarness();
  const adapter = await createCloudflareQnhBrowserFactory(h.binding, FACTORY_OPTIONS)();
  assert.deepEqual(h.acquired, [{ keepAlive: 60_000, recording: false, guardrails: { allowedDomains: ['qnh.meituan.com', '*.meituan.net'] } }]);
  assert.deepEqual(h.connections, [{ id: 'private-browser-id', options: { targetId: 'private-target-id' } }]);
  assert.deepEqual(Object.keys(adapter), ['tenantId', 'frame', 'input', 'verifyAccess', 'lookup', 'close']);
  assert.equal(h.commands.find(value => value.method === 'Page.navigate').params.url, 'https://qnh.meituan.com/');
  assert.deepEqual(await adapter.frame(), JPEG);
  await adapter.input({ type: 'key', key: 'Enter' });
  assert.deepEqual(h.commands.filter(value => value.method === 'Input.dispatchKeyEvent').map(value => value.params.modifiers), [0, 0]);
  assert.equal(await adapter.verifyAccess(), true);
  await assert.rejects(adapter.input({ type: 'Runtime.evaluate', expression: 'forged' }), code('INVALID_QNH_BROWSER_INPUT'));
  assert.ok(!h.commands.some(value => value.method === 'Cloudflare.getLiveView'));
  await adapter.close(); await adapter.close();
  assert.deepEqual(h.closed, ['private-browser-id']);
});

test('tenant mismatch, absent login shell, foreign origin or invalid tenant cannot authorize native session', async () => {
  for (const result of [{ origin: 'https://qnh.meituan.com', shell: true, tenantId: '9999999' },
    { origin: 'https://qnh.meituan.com', shell: false, tenantId: '1012619' },
    { origin: 'https://evil.example', shell: true, tenantId: '1012619' },
    { origin: 'https://qnh.meituan.com', shell: true, tenantId: 1012619 }]) {
    const h = bindingHarness({ result });
    const adapter = await createCloudflareQnhBrowserFactory(h.binding, FACTORY_OPTIONS)();
    assert.equal(await adapter.verifyAccess(), false); await adapter.close();
  }
});

test('login uses only the official shell and tenant, without any SKU probe, product query or approval hook', async () => {
  const h = bindingHarness();
  const adapter = await createCloudflareQnhBrowserFactory(h.binding, { expectedTenantId: undefined, perTenant: true,
    allowedDomains: ['qnh.meituan.com'], probeSku: '000123', async confirmProductAccess() { throw new Error('login must not run a product approval hook'); } })();
  assert.equal(await adapter.verifyAccess(), true);
  assert.equal(adapter.tenantId(), '1012619');
  const evaluated = h.commands.filter(value => value.method === 'Runtime.evaluate');
  assert.equal(evaluated.length, 2);
  assert.ok(evaluated.every(value => value.params.expression.includes('readLoggedInQnhShell')));
  assert.ok(evaluated.every(value => !value.params.expression.includes('readVisibleProductRows') && !value.params.expression.includes('searchVisibleSku')));
  assert.ok(!h.commands.some(value => ['Page.getFrameTree', 'Network.getResponseBody'].includes(value.method)));
  assert.deepEqual(h.commands.filter(value => value.method === 'Page.navigate').map(value => value.params.url), ['https://qnh.meituan.com/']);
  await adapter.close();
});

test('only an employee SKU lookup navigates to the product page and starts a fresh exact-SKU search', async () => {
  let currentUrl;
  const h = bindingHarness({ commandResult(command) {
    if (command.method === 'Page.navigate') currentUrl = command.params.url;
    if (command.method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'synthetic-official-main-frame' } } };
    if (command.method !== 'Runtime.evaluate') return {};
    const expression = command.params.expression;
    if (expression.includes('readLoggedInQnhShell')) return { result: { value: { origin: 'https://qnh.meituan.com', shell: true, tenantId: '1012619' } } };
    if (expression.includes('readProductAccess')) return { result: { value: { origin: 'https://qnh.meituan.com',
      access: currentUrl === 'https://qnh.meituan.com/#/unifiedGoods/tenant/spu-list', tenantId: '1012619' } } };
    if (expression.includes('searchVisibleSku')) return { result: { value: false } }; // No synthetic receipt: an incomplete query must fail closed.
    throw new Error('unexpected remote evaluation');
  } });
  const adapter = await createCloudflareQnhBrowserFactory(h.binding, { perTenant: true, allowedDomains: ['qnh.meituan.com'] })();
  assert.equal(await adapter.verifyAccess(), true);
  assert.equal(currentUrl, 'https://qnh.meituan.com/');
  assert.equal(h.commands.some(command => command.method === 'Page.getFrameTree'), false);
  const answer = await adapter.lookup(SKU);
  assert.equal(answer.status, 'error');
  assert.deepEqual(h.commands.filter(command => command.method === 'Page.navigate').map(command => command.params.url), [
    'https://qnh.meituan.com/', 'https://qnh.meituan.com/#/unifiedGoods/tenant/spu-list',
  ]);
  assert.equal(h.commands.some(command => command.method === 'Page.getFrameTree'), true);
  assert.equal(h.commands.some(command => command.method === 'Runtime.evaluate'
    && command.params.expression.includes('searchVisibleSku') && command.params.expression.includes(SKU)), true);
  await adapter.close();
});

test('native provider error closes allocated session and never reflects CDP error text', async () => {
  const h = bindingHarness({ exception: true });
  await assert.rejects(createCloudflareQnhBrowserFactory(h.binding, FACTORY_OPTIONS)(),
    error => code('QNH_BROWSER_UNAVAILABLE')(error) && !error.message.includes('jwt'));
  assert.deepEqual(h.closed, ['private-browser-id']);
});

test('per-tenant native login binds the actual verified tenant and refuses later tenant switching', async () => {
  const result = { origin: 'https://qnh.meituan.com', shell: true, tenantId: '7654321' };
  const h = bindingHarness({ result });
  const adapter = await createCloudflareQnhBrowserFactory(h.binding, { ...FACTORY_OPTIONS, expectedTenantId: undefined, perTenant: true })();
  assert.equal(adapter.tenantId(), null);
  assert.equal(await adapter.verifyAccess(), true);
  assert.equal(adapter.tenantId(), '7654321');
  result.tenantId = '1234567';
  assert.equal(await adapter.verifyAccess(), false);
  assert.equal(adapter.tenantId(), '7654321');
  await adapter.close();
});

test('observed tenant reader requires a unique visible non-editable exact header span', () => {
  const oldDocument = globalThis.document; const oldStyle = globalThis.getComputedStyle;
  const element = (text, hidden = false, editable = false) => ({
    innerText: text, nodeType: 1, parentElement: null,
    getClientRects: () => hidden ? [] : [{}], closest: () => editable ? {} : null,
  });
  let nodes = [];
  globalThis.document = { querySelectorAll(selector) { assert.equal(selector, 'span[class^="SearchLeftTenantId--"]'); return nodes; } };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  try {
    nodes = [element('（租户ID:1012619）')]; assert.equal(readObservedQnhTenantId(), '1012619');
    nodes = [element('（租户ID:1012619）'), element('（租户ID:9999999）')]; assert.equal(readObservedQnhTenantId(), null);
    for (const value of [element('1012619'), element('other （租户ID:1012619）'), element('（租户ID:1012619）', true),
      element('（租户ID:1012619）', false, true)]) { nodes = [value]; assert.equal(readObservedQnhTenantId(), null); }
  } finally {
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldStyle === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = oldStyle;
  }
});

test('login shell requires the real visible official layout and top-bar tenant ancestry, never an arbitrary HTTP page', () => {
  const prior = { document: globalThis.document, location: globalThis.location, style: globalThis.getComputedStyle };
  const element = (parentElement = null, innerText = '') => ({ parentElement, innerText, nodeType: 1, hidden: false, editable: false,
    getClientRects() { return this.hidden ? [] : [{}]; },
    closest() { return this.editable ? {} : null; },
    contains(other) { for (let current = other; current; current = current.parentElement) if (current === this) return true; return false; },
  });
  const layout = element(), top = element(layout), main = element(layout), tenant = element(top, '（租户ID:1012619）'), password = element(main);
  const nodes = { '.saas-platform-layout-wrapper': [layout], '.top-nav-base': [top], '.saas-platform-layout-main': [main],
    'span[class^="SearchLeftTenantId--"]': [tenant], 'input[type="password"]': [] };
  globalThis.document = { readyState: 'complete', querySelectorAll: selector => nodes[selector] || [] };
  globalThis.location = { href: 'https://qnh.meituan.com/#/home' };
  globalThis.getComputedStyle = node => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1' });
  try {
    assert.equal(readLoggedInQnhShell(), true);
    assert.equal(readObservedQnhTenantId(), '1012619');
    for (const href of ['https://evil.example/', 'http://qnh.meituan.com/', 'https://qnh.meituan.com/error.html', 'https://qnh.meituan.com/#/login']) {
      globalThis.location.href = href;
      assert.equal(readLoggedInQnhShell(), false);
    }
    globalThis.location.href = 'https://qnh.meituan.com/home.html#/home';
    assert.equal(readLoggedInQnhShell(), true);
    document.readyState = 'loading'; assert.equal(readLoggedInQnhShell(), false); document.readyState = 'complete';
    for (const selector of ['.saas-platform-layout-wrapper', '.top-nav-base', '.saas-platform-layout-main', 'span[class^="SearchLeftTenantId--"]']) {
      const original = nodes[selector];
      nodes[selector] = []; assert.equal(readLoggedInQnhShell(), false);
      nodes[selector] = [...original, ...original]; assert.equal(readLoggedInQnhShell(), false);
      nodes[selector] = original;
    }
    tenant.parentElement = main; assert.equal(readLoggedInQnhShell(), false); tenant.parentElement = top;
    tenant.editable = true; assert.equal(readLoggedInQnhShell(), false); tenant.editable = false;
    tenant.innerText = 'arbitrary 1012619'; assert.equal(readLoggedInQnhShell(), false); tenant.innerText = '（租户ID:1012619）';
    layout.hidden = true; assert.equal(readLoggedInQnhShell(), false); layout.hidden = false;
    nodes['input[type="password"]'] = [password]; assert.equal(readLoggedInQnhShell(), false);
    password.hidden = true; assert.equal(readLoggedInQnhShell(), true);
  } finally {
    if (prior.document === undefined) delete globalThis.document; else globalThis.document = prior.document;
    if (prior.location === undefined) delete globalThis.location; else globalThis.location = prior.location;
    if (prior.style === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = prior.style;
  }
});
