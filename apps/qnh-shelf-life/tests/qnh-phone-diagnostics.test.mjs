import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudflareQnhBrowserFactory, ManagedQnhPhoneSession } from '../backend/qnh-browser-session.mjs';

const PRIVATE_TEXT = 'PRIVATE password=synthetic-secret wss://provider.invalid/?jwt=synthetic-credential';
const JPEG = Uint8Array.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);

function setup({ method, mode, acquireFailure = false } = {}) {
  const diagnostics = [];
  const diagnostic = (phase, code) => diagnostics.push([phase, code]);
  let closes = 0;
  const socket = new EventTarget();
  socket.accept = () => {};
  socket.close = () => {};
  socket.send = serialized => {
    const command = JSON.parse(serialized);
    if (command.method === method && mode === 'send') throw new Error(PRIVATE_TEXT);
    queueMicrotask(() => {
      if (command.method === method && ['close', 'socket'].includes(mode)) {
        socket.dispatchEvent(new Event(mode === 'close' ? 'close' : 'error'));
        return;
      }
      const body = command.method === method && mode === 'protocol' ? { error: { code: -32000, message: PRIVATE_TEXT } }
        : command.method === method && mode === 'evaluation' ? { result: { exceptionDetails: { text: PRIVATE_TEXT }, result: {} } }
          : { result: command.method === 'Runtime.evaluate' ? { result: { value: { access: true, tenantId: '1012619' } } }
            : command.method === 'Page.captureScreenshot' ? { data: Buffer.from(JPEG).toString('base64') } : {} };
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: command.id, ...body }) }));
    });
  };
  const binding = {
    async acquire() { if (acquireFailure) throw new Error(PRIVATE_TEXT); return { sessionId: 'synthetic-private-browser' }; },
    devtools: { async newTarget() { return { id: 'synthetic-private-target' }; } },
    async connectSession() { return { webSocket: { async fetch() { return { webSocket: socket }; } } }; },
    async closeSession() { closes++; },
  };
  const factory = createCloudflareQnhBrowserFactory(binding, { expectedTenantId: '1012619', allowedDomains: ['qnh.meituan.com'],
    async confirmProductAccess() { return true; }, diagnostic });
  const controller = new ManagedQnhPhoneSession({ browserFactory: factory, diagnostic,
    async reserveBrowser() { return { async release() {} }; } });
  return { controller, diagnostics, get closes() { return closes; } };
}

test('CDP frame protocol failure logs only fixed method/reason and is retained before managed session cleanup', async () => {
  const h = setup({ method: 'Page.captureScreenshot', mode: 'protocol' });
  await h.controller.start();
  await assert.rejects(h.controller.frame(), error => error.code === 'QNH_BROWSER_UNAVAILABLE' && !error.message.includes('PRIVATE'));
  assert.deepEqual(h.diagnostics, [['Page.captureScreenshot', 'PROTOCOL_ERROR'], ['MANAGED_FRAME', 'QNH_BROWSER_UNAVAILABLE']]);
  assert.equal(h.closes, 1);
});

test('Runtime evaluation exception is distinguishable without storing its exceptionDetails text', async () => {
  const h = setup({ method: 'Runtime.evaluate', mode: 'evaluation' });
  await h.controller.start();
  await assert.rejects(h.controller.verify(), error => error.code === 'QNH_BROWSER_UNAVAILABLE');
  assert.deepEqual(h.diagnostics, [['Runtime.evaluate', 'EVALUATION_EXCEPTION'], ['MANAGED_VERIFY', 'QNH_BROWSER_UNAVAILABLE']]);
  assert.equal(JSON.stringify(h.diagnostics).includes(PRIVATE_TEXT), false);
});

test('CDP closed, socket-error and synchronous send failures use fixed reason codes and omit control parameters', async () => {
  for (const [mode, reason] of [['close', 'CLOSED'], ['socket', 'SOCKET_ERROR'], ['send', 'SEND_FAILURE']]) {
    const h = setup({ method: 'Input.insertText', mode });
    await h.controller.start();
    await assert.rejects(h.controller.input({ type: 'text', text: 'synthetic-password-never-log' }), error => error.code === 'QNH_BROWSER_UNAVAILABLE');
    assert.deepEqual(h.diagnostics, [['Input.insertText', reason], ['MANAGED_INPUT', 'QNH_BROWSER_UNAVAILABLE']]);
    const logs = JSON.stringify(h.diagnostics);
    assert.equal(logs.includes('synthetic-password'), false);
    assert.equal(logs.includes('jwt'), false);
    assert.equal(logs.includes('PRIVATE'), false);
  }
});

test('provider acquisition errors reveal only the fixed factory stage and safe managed code', async () => {
  const h = setup({ acquireFailure: true });
  await assert.rejects(h.controller.start(), error => error.code === 'QNH_BROWSER_UNAVAILABLE');
  assert.deepEqual(h.diagnostics, [['ACQUIRE', 'FACTORY_UNAVAILABLE'], ['MANAGED_START', 'QNH_BROWSER_UNAVAILABLE']]);
  assert.equal(h.closes, 0);
});
