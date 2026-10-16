import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker from '../connector/worker.mjs';
import { QnhConnectorSession, QNH_PRODUCTS_URL, SESSION_MS, CATALOG_PROBE, classifyProbe, allowedDomains, validLiveView } from '../connector/session.mjs';
import { ADMIN_SCRIPT } from '../connector/ui.mjs';

const OWNER_A = 'a'.repeat(64);
const OWNER_B = 'b'.repeat(64);
const SESSION_ID = '12345678-1234-4234-8234-123456789abc';
const LIVE_VIEW = 'https://live.browser.run/ui/view?mode=tab&wss=live.browser.run%2Fapi%2Fdevtools%2Fbrowser%2F123%2Fpage%2FABC%3Fjwt%3Dsynthetic-capability';
const READY = { correctRoute: true, mainHeading: true, productHeader: true, spuRows: 1, loginForm: false };

function fixture(overrides = {}) {
  const values = new Map();
  const storage = {
    alarmAt: null,
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) {
      if (typeof key === 'object') for (const [name, item] of Object.entries(key)) values.set(name, structuredClone(item));
      else values.set(key, structuredClone(value));
    },
    async delete(key) { return values.delete(key); },
    async setAlarm(time) { this.alarmAt = time; },
    async deleteAlarm() { this.alarmAt = null; },
  };
  const calls = [];
  let exists = false;
  const browser = {
    async acquire(options) { calls.push(['acquire', options]); exists = true; return { sessionId: SESSION_ID }; },
    async getSession(id) { calls.push(['getSession', id]); return exists ? { sessionId: id } : null; },
    async closeSession(id) { calls.push(['closeSession', id]); exists = false; return 'closed'; },
    async getLiveView(id, options) { calls.push(['getLiveView', id, options]); return { devtoolsFrontendUrl: LIVE_VIEW }; },
    async connectSession(id, options) {
      calls.push(['connectSession', id, options]);
      const socket = new EventTarget();
      socket.accept = () => calls.push(['accept']);
      socket.close = () => calls.push(['socketClose']);
      socket.send = (text) => {
        const command = JSON.parse(text);
        calls.push(['cdp', command]);
        queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ id: command.id, result: { result: { value: overrides.probe ?? READY } } }),
        })));
      };
      return { webSocket: { async fetch(url, init) { calls.push(['socketFetch', url, init]); return { webSocket: socket }; } } };
    },
    devtools: {
      async newTarget(id, url) { calls.push(['newTarget', id, url]); return { id: 'ABC123' }; },
    },
  };
  Object.assign(browser, overrides.browser);
  const env = { BROWSER: browser, ...overrides.env };
  const object = new QnhConnectorSession({ storage }, env);
  env.CONNECTOR_SESSIONS = {
    idFromName(name) { calls.push(['objectName', name]); return name; },
    get() { return object; },
  };
  return { storage, values, calls, env, object };
}

function internal(path, owner = OWNER_A, method = path === '/session/status' ? 'GET' : 'POST') {
  return new Request(`https://connector.internal${path}`, { method, headers: { 'X-Connector-Owner': owner } });
}

function external(path, options = {}) {
  const method = options.method ?? (path.startsWith('/session/status') ? 'GET' : 'POST');
  return new Request(`https://connector.example.workers.dev${path}`, {
    method, ...options,
    headers: {
      'Sec-Fetch-Site': 'same-origin', 'Origin': 'https://connector.example.workers.dev',
      'X-Qnh-Connector': '1', ...(options.headers ?? {}),
    },
  });
}

const access = (email = 'admin@example.test') => ({ access: { aud: 'synthetic-access-audience', async getIdentity() { return { email }; } } });

test('Access is mandatory; supplied identity headers cannot substitute it', async () => {
  const f = fixture();
  const result = await worker.fetch(external('/session/start', { headers: { 'Cf-Access-Jwt-Assertion': 'fake', 'X-Connector-Owner': OWNER_A } }), f.env, {});
  assert.equal(result.status, 403);
  assert.equal((await result.json()).code, 'ACCESS_REQUIRED');
  assert.equal(f.calls.length, 0);
});

test('invalid Access identity and missing native bindings fail closed', async () => {
  const f = fixture();
  assert.equal((await worker.fetch(external('/session/start'), f.env, access('bad identity'))).status, 403);
  assert.equal((await worker.fetch(external('/session/start'), {}, access())).status, 503);
  assert.equal(f.calls.length, 0);
});

test('API rejects cross-origin, absent fetch metadata, request bodies and arbitrary URL input', async () => {
  const f = fixture();
  for (const options of [
    { headers: { Origin: 'https://attacker.test' } },
    { headers: { 'Sec-Fetch-Site': 'cross-site' } },
    { headers: { 'Sec-Fetch-Site': '' } },
    { headers: { 'X-Qnh-Connector': '' } },
  ]) assert.equal((await worker.fetch(external('/session/start', options), f.env, access())).status, 403);
  assert.equal((await worker.fetch(external('/session/start', { body: '{}' }), f.env, access())).status, 400);
  assert.equal((await worker.fetch(external('/session/start?url=https://attacker.test'), f.env, access())).status, 400);
  assert.equal((await worker.fetch(external('/session/start', { method: 'GET' }), f.env, access())).status, 405);
  assert.equal(f.calls.length, 0);
});

test('status requires same-origin protection and does not run from a direct navigation', async () => {
  const f = fixture();
  const request = new Request('https://connector.example.workers.dev/session/status');
  assert.equal((await worker.fetch(request, f.env, access())).status, 403);
  assert.equal(f.calls.length, 0);
});

test('authenticated HTML is no-store; simply opening it never acquires a browser', async () => {
  const f = fixture();
  const result = await worker.fetch(new Request('https://connector.example.workers.dev/'), f.env, access());
  assert.equal(result.status, 200);
  assert.match(result.headers.get('Cache-Control'), /no-store/);
  assert.equal(result.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(await result.text(), /开始 5 分钟/);
  assert.equal(f.calls.length, 0);
  assert.doesNotMatch(ADMIN_SCRIPT, /localStorage|sessionStorage|console\./);
});

test('Worker derives owner from verified Access instead of forwarding request headers', async () => {
  const f = fixture();
  const result = await worker.fetch(external('/session/start', { headers: { 'X-Connector-Owner': OWNER_B } }), f.env, access());
  assert.equal(result.status, 200);
  const active = f.values.get('active');
  assert.match(active.owner, /^[a-f0-9]{64}$/);
  assert.notEqual(active.owner, OWNER_B);
  assert.notEqual(active.owner, 'admin@example.test');
});

test('start creates one fixed guarded non-recording session, with a five-minute alarm', async () => {
  const f = fixture();
  const before = Date.now();
  const result = await f.object.fetch(internal('/session/start'));
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.status, 'login_unverified');
  assert.deepEqual(f.calls.find(call => call[0] === 'acquire')[1], {
    keepAlive: 60000, recording: false,
    guardrails: { allowedDomains: ['qnh.meituan.com', 'img.meituan.net'] },
  });
  assert.deepEqual(f.calls.find(call => call[0] === 'newTarget'), ['newTarget', SESSION_ID, QNH_PRODUCTS_URL]);
  assert.ok(f.storage.alarmAt >= before + SESSION_MS);
  assert.ok(f.storage.alarmAt <= Date.now() + SESSION_MS);
  assert.doesNotMatch(JSON.stringify(body), /sessionId|targetId|jwt|synthetic-capability/);
});

test('concurrent starts serialize and do not acquire twice', async () => {
  const f = fixture();
  const results = await Promise.all([f.object.fetch(internal('/session/start')), f.object.fetch(internal('/session/start'))]);
  assert.ok(results.every(result => result.status === 200));
  assert.equal(f.calls.filter(call => call[0] === 'acquire').length, 1);
});

test('another administrator cannot inspect, stop, renew or reuse the active session', async () => {
  const f = fixture();
  await f.object.fetch(internal('/session/start'));
  const before = f.calls.length;
  for (const path of ['/session/status', '/session/stop', '/session/live-view', '/session/start']) {
    const result = await f.object.fetch(internal(path, OWNER_B));
    assert.equal(result.status, 403);
    assert.equal((await result.json()).code, 'SESSION_OWNED_BY_OTHER_ADMIN');
  }
  assert.equal(f.calls.length, before);
});

test('Live View capability is returned only on an owner request, with one-minute expiry', async () => {
  const f = fixture();
  await f.object.fetch(internal('/session/start'));
  const result = await f.object.fetch(internal('/session/live-view'));
  assert.equal((await result.json()).liveViewUrl, LIVE_VIEW);
  assert.equal(result.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(result.headers.get('Cache-Control'), /no-store/);
  assert.deepEqual(f.calls.find(call => call[0] === 'getLiveView'), [
    'getLiveView', SESSION_ID, { targetId: 'ABC123', mode: 'tab', expiresInMs: 60000 },
  ]);
  assert.doesNotMatch(JSON.stringify([...f.values]), /jwt|synthetic-capability/);
});

test('only a real combination of visible product evidence yields catalog_ready', async () => {
  assert.equal(classifyProbe(READY), 'catalog_ready');
  for (const key of ['correctRoute', 'mainHeading', 'productHeader']) {
    assert.equal(classifyProbe({ ...READY, [key]: false }), 'login_unverified');
  }
  for (const spuRows of [0, -1, '1', NaN, 5000]) assert.equal(classifyProbe({ ...READY, spuRows }), 'login_unverified');
  assert.equal(classifyProbe({ ...READY, loginForm: true }), 'needs_login');
  assert.equal(classifyProbe(null), 'login_unverified');
});

test('DOM probe ignores hidden password fields and hidden SPU rows', () => {
  const element = (innerText, shown = true) => ({ innerText, shown, getClientRects: () => shown ? [{}] : [] });
  const run = (shownRow) => vm.runInNewContext(CATALOG_PROBE, {
    location: { origin: 'https://qnh.meituan.com', pathname: '/home.html', hash: '#/unifiedGoods/tenant/spu-list' },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    document: {
      body: { innerText: '商品主档' },
      querySelectorAll(selector) {
        if (selector.startsWith('thead')) return [element('商品名称')];
        if (selector.startsWith('tbody')) return [element('SPU：2110000000000000001', shownRow)];
        return [element('', false)];
      },
    },
  });
  assert.equal(classifyProbe(run(true)), 'catalog_ready');
  assert.equal(classifyProbe(run(false)), 'login_unverified');
});

test('status uses a read-only fixed DOM command and disconnects without closing browser', async () => {
  const f = fixture();
  await f.object.fetch(internal('/session/start'));
  const result = await f.object.fetch(internal('/session/status'));
  assert.equal((await result.json()).status, 'catalog_ready');
  const command = f.calls.find(call => call[0] === 'cdp')[1];
  assert.equal(command.method, 'Runtime.evaluate');
  assert.equal(command.params.expression, CATALOG_PROBE);
  assert.equal(command.params.returnByValue, true);
  assert.doesNotMatch(command.params.expression, /cookie|localStorage|storageState|fetch\(/);
  assert.equal(f.calls.filter(call => call[0] === 'socketClose').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'closeSession').length, 0);
});

test('status does not treat arrival at a URL or absence of login form as success', async () => {
  const f = fixture({ probe: { correctRoute: true, loginForm: false } });
  await f.object.fetch(internal('/session/start'));
  assert.equal((await (await f.object.fetch(internal('/session/status'))).json()).status, 'login_unverified');
});

test('stop confirms browser absence, clears active metadata and retains daily attempt', async () => {
  const f = fixture();
  await f.object.fetch(internal('/session/start'));
  const stopped = await f.object.fetch(internal('/session/stop'));
  assert.equal((await stopped.json()).status, 'stopped');
  assert.equal(f.values.has('active'), false);
  assert.equal(f.storage.alarmAt, null);
  assert.ok(f.values.has('dailyAttempt'));
  assert.equal((await f.object.fetch(internal('/session/start'))).status, 429);
});

test('failed browser acquisition consumes the daily attempt and does not leak errors', async () => {
  const f = fixture({ browser: { async acquire() { throw new Error(LIVE_VIEW); } } });
  const result = await f.object.fetch(internal('/session/start'));
  assert.equal(result.status, 502);
  const text = await result.text();
  assert.doesNotMatch(text, /jwt|synthetic-capability|live\.browser/);
  assert.equal(f.values.has('active'), false);
  assert.equal((await f.object.fetch(internal('/session/start'))).status, 429);
});

test('failed page creation closes the acquired browser', async () => {
  const f = fixture({ browser: { devtools: { async newTarget() { throw new Error('failure'); } } } });
  assert.equal((await f.object.fetch(internal('/session/start'))).status, 502);
  assert.equal(f.calls.filter(call => call[0] === 'closeSession').length, 1);
  assert.equal(f.values.has('active'), false);
});

test('alarm closes an expired active session rather than leaving it idle', async () => {
  const f = fixture();
  await f.object.fetch(internal('/session/start'));
  const active = f.values.get('active');
  active.expiresAt = Date.now() - 1;
  await f.storage.put('active', active);
  await f.object.alarm();
  assert.equal(f.calls.filter(call => call[0] === 'closeSession').length, 1);
  assert.equal(f.values.has('active'), false);
});

test('a failed or unconfirmed close retains cleanup state and schedules retry', async () => {
  const f = fixture({ browser: { async closeSession() { return 'closing'; } } });
  await f.object.fetch(internal('/session/start'));
  const before = Date.now();
  const result = await f.object.fetch(internal('/session/stop'));
  assert.equal(result.status, 502);
  assert.equal((await result.json()).status, 'stopping');
  assert.equal(f.values.get('active').phase, 'closing');
  assert.ok(f.storage.alarmAt >= before + 15000);
});

test('expired status never returns catalog_ready and always closes the session', async () => {
  const f = fixture();
  await f.object.fetch(internal('/session/start'));
  const active = f.values.get('active');
  active.expiresAt = Date.now() - 1;
  await f.storage.put('active', active);
  const body = await (await f.object.fetch(internal('/session/status'))).json();
  assert.equal(body.status, 'stopped');
  assert.equal(f.calls.filter(call => call[0] === 'connectSession').length, 0);
});

test('daily attempt resets only on the next UTC date', async () => {
  const f = fixture();
  await f.storage.put('dailyAttempt', { utcDay: new Date(Date.now() - 86400000).toISOString().slice(0, 10) });
  assert.equal((await f.object.fetch(internal('/session/start'))).status, 200);
});

test('guardrails allow only explicitly configured corporate hostnames', () => {
  assert.deepEqual(allowedDomains('passport.meituan.com,s3plus.sankuai.com'), [
    'qnh.meituan.com', 'img.meituan.net', 'passport.meituan.com', 's3plus.sankuai.com',
  ]);
  for (const input of ['*.meituan.com', 'https://qnh.meituan.com', 'evil.test', 'qnh.meituan.com.evil.test', 'qnh.meituan.com:443', 'qnh.meituan.com/path']) {
    assert.throws(() => allowedDomains(input));
  }
});

test('Live View validation rejects unexpected origins or modes', () => {
  assert.equal(validLiveView(LIVE_VIEW), true);
  for (const url of [LIVE_VIEW.replace('https://live.browser.run', 'https://attacker.test'), LIVE_VIEW.replace('mode=tab', 'mode=devtools'), 'javascript:alert(1)', 'https://live.browser.run/ui/view?mode=tab']) {
    assert.equal(validLiveView(url), false);
  }
});

test('invalid upstream Live View responses are never reflected', async () => {
  const f = fixture({ browser: { async getLiveView() { return { devtoolsFrontendUrl: 'https://attacker.test/?jwt=synthetic-capability' }; } } });
  await f.object.fetch(internal('/session/start'));
  const result = await f.object.fetch(internal('/session/live-view'));
  assert.equal(result.status, 502);
  assert.doesNotMatch(await result.text(), /attacker|jwt|synthetic-capability/);
});
