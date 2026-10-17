import test from 'node:test';
import assert from 'node:assert/strict';
import { openQnhLoginViewer, qnhViewerPoint, normalizeQnhViewerInput } from '../dist/qnh-login-viewer.mjs';

const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const jpeg = () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'Content-Type': 'image/jpeg' } });
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness(options = {}) {
  let time = 1_000_000, nextTimer = 0, nextURL = 0;
  const timers = new Map(), nodes = [], calls = [], created = [], revoked = [], authorized = [], closed = [];
  class Element {
    constructor(tag) { this.tagName = tag; this.attributes = new Map(); this.children = []; this.events = new Map(); this.textContent = ''; this.value = ''; this.disabled = false; this.open = false; this.removed = false; nodes.push(this); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'id') this.id = value; }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
    append(...items) { this.children.push(...items); }
    addEventListener(name, listener) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(listener); }
    removeEventListener(name, listener) { this.events.get(name)?.delete(listener); }
    emit(name, data = {}) { const event = { preventDefault() {}, ...data }; for (const listener of this.events.get(name) || []) listener(event); return event; }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
    remove() { this.removed = true; }
    getBoundingClientRect() { return { left: 10, top: 20, width: 640, height: 450 }; }
    setPointerCapture() {}
    releasePointerCapture() {}
  }
  const document = new Element('document');
  document.body = new Element('body'); document.hidden = false; document.createElement = tag => new Element(tag);
  const clock = {
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const status = extra => ({ authorized: false, loginMethod: 'qnh_browser', status: 'login', viewport: { width: 1280, height: 900 }, expiresAt: time + 180_000, ...extra });
  const fetchImpl = async (path, init) => {
    calls.push({ path, init });
    const custom = options.fetch?.(path, init, status);
    if (custom !== undefined) return custom;
    if (path === '/api/qnh/login/frame') return jpeg();
    if (path === '/api/qnh/login/input') return response({ accepted: true });
    if (path === '/api/qnh/login/cancel') return response({});
    return response(status());
  };
  const handle = openQnhLoginViewer({ onAuthorized: () => authorized.push(time), onClose: value => closed.push(value) }, {
    document, fetch: fetchImpl, timers: clock, now: () => time, AbortController,
    URL: { createObjectURL(blob) { assert.ok(blob instanceof Blob); const url = `blob:synthetic-${++nextURL}`; created.push(url); return url; }, revokeObjectURL: url => revoked.push(url) },
  });
  return {
    document, nodes, calls, timers, created, revoked, authorized, closed, handle,
    tag: tag => nodes.find(node => node.tagName === tag),
    button: text => nodes.find(node => node.tagName === 'button' && node.textContent === text),
    status: () => nodes.find(node => node.getAttribute('role') === 'status').textContent,
    requestCount: path => calls.filter(call => call.path === path).length,
    async advance(ms) {
      const target = time + ms;
      for (let count = 0; count < 500; count++) {
        const next = [...timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at; timers.delete(next[0]); next[1].callback(); await settle();
      }
      time = target; await settle();
    },
  };
}

test('login is rendered inside the app and only fixed same-origin transport is used', async () => {
  const app = harness(); await settle();
  assert.equal(app.tag('dialog').id, 'qnh-login-viewer');
  assert.equal(app.tag('dialog').open, true);
  assert.equal(app.nodes.some(node => ['iframe', 'a'].includes(node.tagName)), false);
  assert.deepEqual(app.calls.map(call => call.path), ['/api/qnh/login/start', '/api/qnh/login/frame']);
  for (const { path, init } of app.calls) {
    assert.match(path, /^\/api\/qnh\/login\/(?:start|frame)$/u);
    assert.equal(init.credentials, 'include'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.doesNotMatch(JSON.stringify(init), /webSocket|sessionId|jwt|devtools|evaluate/u);
  }
  assert.equal(app.calls[0].init.method, 'POST');
  assert.equal(app.calls[0].init.body, '{}');
  assert.equal(app.calls[1].init.method, 'GET');
  assert.equal(app.created.length, 1);
  app.handle.close();
});

test('pointer coordinates remain correct after scaling and reject points outside the page', () => {
  const rect = { left: 10, top: 20, width: 320, height: 225 };
  assert.deepEqual(qnhViewerPoint(170, 132.5, rect), { x: 640, y: 450 });
  assert.equal(qnhViewerPoint(330, 20, rect), null);
  assert.equal(qnhViewerPoint(-1, 20, rect), null);
  assert.deepEqual(qnhViewerPoint(400, -20, rect, true), { x: 1279, y: 0 });
  assert.equal(qnhViewerPoint(NaN, 1, rect), null);
  assert.equal(qnhViewerPoint(1, 1, { ...rect, width: 0 }), null);
});

test('input validation rejects scripts, navigation, modifiers, control characters, and overlong text or gestures', () => {
  for (const value of [
    { type: 'evaluate', expression: 'synthetic' }, { type: 'navigate', url: 'https://example.test' },
    { type: 'key', key: 'F12' }, { type: 'key', key: 'Enter', modifiers: 2 },
    { type: 'text', text: 'line\nline' }, { type: 'text', text: 'x'.repeat(129) }, { type: 'text', text: 'text\u202e' },
    { type: 'click', x: 1280, y: 0 }, { type: 'click', x: 2.5, y: 0 },
    { type: 'scroll', x: 1, y: 1, deltaY: 901 },
    { type: 'drag', points: Array.from({ length: 33 }, () => ({ x: 1, y: 1 })) },
    { type: 'drag', points: [{ x: 1, y: 1, expression: 'synthetic' }, { x: 2, y: 2 }] },
  ]) assert.equal(normalizeQnhViewerInput(value), null);
  assert.deepEqual(normalizeQnhViewerInput({ type: 'text', text: '甲'.repeat(128) }), { type: 'text', text: '甲'.repeat(128) });
  assert.deepEqual(normalizeQnhViewerInput({ type: 'key', key: 'Tab' }), { type: 'key', key: 'Tab' });
});

test('typed credentials are cleared immediately and only sent by explicit submit', async () => {
  const app = harness(); await settle();
  const field = app.tag('input');
  assert.equal(field.getAttribute('type'), 'password');
  assert.equal(field.getAttribute('autocomplete'), 'off');
  field.value = 'synthetic-input';
  assert.equal(app.requestCount('/api/qnh/login/input'), 0);
  app.tag('form').emit('submit');
  assert.equal(field.value, '');
  await settle();
  assert.deepEqual(JSON.parse(app.calls.find(call => call.path.endsWith('/input')).init.body), { type: 'text', text: 'synthetic-input' });
  field.value = 'x'.repeat(129); app.tag('form').emit('submit'); await settle();
  assert.equal(field.value, ''); assert.equal(app.requestCount('/api/qnh/login/input'), 1);
  assert.match(app.status(), /128/);
  app.handle.close();
});

test('only manual pointer gestures produce bounded click or drag messages', async () => {
  const app = harness(); await settle(); const image = app.tag('img');
  image.emit('pointerdown', { pointerId: 1, clientX: 110, clientY: 120, button: 0 });
  image.emit('pointerup', { pointerId: 1, clientX: 110, clientY: 120 }); await settle();
  assert.deepEqual(JSON.parse(app.calls.find(call => call.path.endsWith('/input')).init.body), { type: 'click', x: 200, y: 200 });
  image.emit('pointerdown', { pointerId: 2, clientX: 30, clientY: 100, button: 0 });
  for (let x = 31; x < 150; x++) image.emit('pointermove', { pointerId: 2, clientX: x, clientY: 100 });
  image.emit('pointerup', { pointerId: 2, clientX: 160, clientY: 100 }); await settle();
  const drag = JSON.parse(app.calls.filter(call => call.path.endsWith('/input')).at(-1).init.body);
  assert.equal(drag.type, 'drag'); assert.equal(drag.points.length, 32);
  assert.deepEqual(drag.points[0], { x: 40, y: 160 });
  assert.deepEqual(drag.points.at(-1), { x: 300, y: 160 });
  app.handle.close();
});

test('screenshot fetches remain serial when the network is slow', async () => {
  let resolveFrame;
  const app = harness({ fetch(path) {
    if (path.endsWith('/frame')) return new Promise(resolve => { resolveFrame = resolve; });
  } });
  await settle(); await app.advance(5000);
  assert.equal(app.requestCount('/api/qnh/login/frame'), 1);
  assert.equal(app.requestCount('/api/qnh/login/verify'), 0);
  resolveFrame(jpeg()); await settle(); await app.advance(1000);
  assert.equal(app.requestCount('/api/qnh/login/verify'), 1);
  assert.equal(app.requestCount('/api/qnh/login/frame'), 2);
  app.handle.close();
});

test('phone visibility pauses all refresh and verification and clears unfinished input', async () => {
  const app = harness(); await settle(); const field = app.tag('input');
  field.value = 'unfinished-synthetic';
  app.document.hidden = true; app.document.emit('visibilitychange');
  assert.equal(field.value, '');
  await app.advance(12_000);
  assert.equal(app.requestCount('/api/qnh/login/frame'), 1);
  assert.equal(app.requestCount('/api/qnh/login/verify'), 0);
  app.document.hidden = false; app.document.emit('visibilitychange'); await app.advance(0);
  assert.equal(app.requestCount('/api/qnh/login/verify'), 1);
  assert.equal(app.requestCount('/api/qnh/login/frame'), 2);
  app.handle.close();
});

test('verified server readiness alone triggers entry and destroys viewer without canceling authorized session', async () => {
  let ready = false;
  const app = harness({ fetch(path, init, status) { if (path.endsWith('/verify')) return response(status(ready ? { authorized: true, status: 'ready' } : {})); } });
  await settle(); await app.advance(5000);
  assert.equal(app.authorized.length, 0);
  ready = true; await app.advance(5000);
  assert.equal(app.authorized.length, 1); assert.equal(app.handle.authorized, true); assert.equal(app.handle.closed, true);
  assert.equal(app.tag('dialog').removed, true); assert.equal(app.tag('img').src, '');
  assert.deepEqual(app.revoked, app.created);
  assert.equal(app.requestCount('/api/qnh/login/cancel'), 0);
  assert.equal(app.timers.size, 0);
  await app.advance(60_000); app.handle.close();
  assert.equal(app.authorized.length, 1); assert.equal(app.requestCount('/api/qnh/login/cancel'), 0);
});

test('invalid or merely claimed authorized status never admits the user', async () => {
  for (const extra of [{ authorized: 'true', status: 'ready' }, { authorized: true, status: 'login' }, { authorized: true, status: 'ready', loginMethod: 'external' }]) {
    const app = harness({ fetch(path, init, status) { if (path.endsWith('/verify')) return response(status(extra)); } });
    await settle(); app.button('我已登录').emit('click'); await settle();
    assert.equal(app.authorized.length, 0); assert.equal(app.handle.closed, false);
    assert.match(app.status(), /连接暂时中断/);
    app.handle.close();
  }
});

test('a late authorized body cannot revive a viewer that the user already closed', async () => {
  let finishBody;
  const app = harness({ fetch(path, init, status) {
    if (path.endsWith('/verify')) return { ok: true, text: () => new Promise(resolve => { finishBody = () => resolve(JSON.stringify(status({ authorized: true, status: 'ready' }))); }) };
  } });
  await settle(); app.button('我已登录').emit('click'); await settle();
  app.handle.close(); finishBody(); await settle();
  assert.equal(app.authorized.length, 0); assert.equal(app.handle.authorized, false);
  assert.equal(app.requestCount('/api/qnh/login/cancel'), 1); assert.equal(app.timers.size, 0);
});

test('close aborts in-flight fetches, cancels server session, revokes images and removes every timer and listener', async () => {
  let signal;
  const app = harness({ fetch(path, init) {
    if (path.endsWith('/frame') && signal === undefined) { signal = init.signal; return jpeg(); }
    if (path.endsWith('/frame')) { signal = init.signal; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))); }
  } });
  await settle(); await app.advance(1000);
  assert.equal(signal.aborted, false);
  app.handle.close(); await settle();
  assert.equal(signal.aborted, true); assert.equal(app.requestCount('/api/qnh/login/cancel'), 1);
  assert.deepEqual(app.revoked, app.created); assert.equal(app.timers.size, 0);
  assert.equal(app.nodes.reduce((count, node) => count + [...node.events.values()].reduce((sum, listeners) => sum + listeners.size, 0), 0), 0);
  app.handle.close(); assert.equal(app.requestCount('/api/qnh/login/cancel'), 1);
  assert.equal(app.closed.length, 0, 'programmatic cleanup is silent');
});

test('user closing and hidden-session expiry notify exactly once and cannot poll afterward', async () => {
  const closed = harness(); await settle(); closed.button('关闭').emit('click'); closed.handle.close();
  assert.equal(closed.closed.length, 1); assert.equal(closed.requestCount('/api/qnh/login/cancel'), 1);
  const expired = harness(); await settle(); expired.document.hidden = true; expired.document.emit('visibilitychange');
  await expired.advance(180_000);
  assert.equal(expired.handle.closed, true); assert.deepEqual(expired.closed, [{ reason: 'expired' }]);
  assert.equal(expired.requestCount('/api/qnh/login/frame'), 1); assert.equal(expired.requestCount('/api/qnh/login/cancel'), 1);
  assert.equal(expired.timers.size, 0);
});

test('frame content type and byte limit are enforced before constructing a display URL', async () => {
  for (const invalid of [
    () => new Response('<html>synthetic-error</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(new Uint8Array(4), { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '2000001' } }),
    () => new Response(new Uint8Array(2_000_001), { headers: { 'Content-Type': 'image/jpeg' } }),
  ]) {
    const app = harness({ fetch(path) { if (path.endsWith('/frame')) return invalid(); } });
    await settle(); assert.equal(app.created.length, 0); assert.match(app.status(), /连接暂时中断/); app.handle.close();
  }
});

test('upstream errors and configuration details never appear in the viewer', async () => {
  const app = harness({ fetch(path) { if (path.endsWith('/start')) return new Response('synthetic-secret GITHUB_APP_PRIVATE_KEY', { status: 503 }); } });
  await settle();
  assert.match(app.status(), /连接暂时中断/);
  assert.doesNotMatch(app.nodes.map(node => node.textContent).join(' '), /synthetic-secret|GITHUB_APP/u);
  assert.equal(app.requestCount('/api/qnh/login/frame'), 0); app.handle.close();
});
