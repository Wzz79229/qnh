import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

// Exercise actual bundled server functions and the exact Runtime.evaluate strings
// they send. The remote page deliberately has no Worker/esbuild runtime helpers.
const entry = fileURLToPath(new URL('../backend/qnh-browser-session.mjs', import.meta.url));
const wrangler = await readFile(new URL('../backend/wrangler.toml', import.meta.url), 'utf8');
const configuredKeepNames = /^keep_names\s*=\s*(true|false)\s*(?:#.*)?$/mu.exec(wrangler)?.[1];

async function bundledFactory(keepNames) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'cjs',
    platform: 'neutral', target: 'es2022', keepNames, logLevel: 'silent' });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, setTimeout, clearTimeout, TextDecoder, TextEncoder,
    Uint8Array, URL, atob, btoa, console,
  }, { timeout: 2000, filename: 'bundled-qnh-browser-session.cjs' });
  return module.exports.createCloudflareQnhBrowserFactory;
}

function remoteLoggedInPage() {
  const visible = extras => ({ nodeType: 1, parentElement: null, innerText: '',
    getClientRects: () => [{}], closest: () => null, ...extras });
  const tenant = visible({ innerText: '（租户ID: 1012619）' });
  const topBar = visible({ contains: element => element === tenant });
  const main = visible();
  const layout = visible({ contains: element => [topBar, main, tenant].includes(element) });
  topBar.parentElement = layout; main.parentElement = layout; tenant.parentElement = topBar;
  const password = visible(), page = { passwordVisible: false, selectors: [], tenant };
  return vm.createContext({
    URL, location: new URL('https://qnh.meituan.com/'), testPage: page,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    document: { readyState: 'complete', querySelectorAll(selector) {
      page.selectors.push(selector);
      if (selector === 'span[class^="SearchLeftTenantId--"]') return [tenant];
      if (selector === '.top-nav-base') return [topBar];
      if (selector === '.saas-platform-layout-wrapper') return [layout];
      if (selector === '.saas-platform-layout-main') return [main];
      if (selector === 'input[type="password"]') return page.passwordVisible ? [password] : [];
      throw new Error('Login must not inspect product fields, tables or SKU data');
    } },
  });
}

function privateBinding(remote) {
  const listeners = new Map(), commands = [], expressions = [], exceptions = [], diagnostics = [];
  let closed = false;
  const emit = (name, event) => { for (const listener of listeners.get(name) || []) listener(event); };
  const socket = {
    accept() {},
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(listener); },
    close() { if (!closed) { closed = true; emit('close', {}); } },
    send(serialized) {
      const command = JSON.parse(serialized);
      commands.push(command);
      (async () => {
        let result = {};
        if (command.method === 'Page.navigate') remote.location = new URL(command.params.url);
        if (command.method === 'Runtime.evaluate') {
          expressions.push(command.params.expression);
          try {
            const value = await vm.runInContext(command.params.expression, remote, { timeout: 1000 });
            result = { result: { type: typeof value, value } };
          } catch (error) {
            exceptions.push(error);
            result = { result: { type: 'undefined' }, exceptionDetails: { text: 'Synthetic remote exception' } };
          }
        }
        emit('message', { data: JSON.stringify({ id: command.id, result }) });
      })();
    },
  };
  return {
    commands, expressions, exceptions, diagnostics,
    binding: {
      acquire: async () => ({ sessionId: 'synthetic-private-session' }),
      devtools: { newTarget: async () => ({ id: 'synthetic-private-target' }) },
      connectSession: async () => ({ webSocket: { fetch: async () => ({ webSocket: socket }) } }),
      closeSession: async () => {},
    },
    diagnostic: (...event) => diagnostics.push(event),
  };
}

async function startBundledBrowser(keepNames) {
  const create = await bundledFactory(keepNames);
  const remote = remoteLoggedInPage(), harness = privateBinding(remote);
  assert.equal(vm.runInContext('typeof __name', remote), 'undefined');
  const browser = await create(harness.binding, { perTenant: true,
    allowedDomains: ['qnh.meituan.com'],
    diagnostic: harness.diagnostic })();
  return { browser, remote, ...harness };
}

test('name-preserving bundling reproduces a remote evaluation failure on the first login verification', async () => {
  const app = await startBundledBrowser(true);
  try {
    await assert.rejects(app.browser.verifyAccess(), error => error.code === 'QNH_BROWSER_UNAVAILABLE');
    assert.equal(app.expressions.length, 1);
    assert.equal(app.exceptions.length, 1);
    assert.match(app.exceptions[0].message, /__name is not defined/u);
    assert.match(app.expressions[0], /__name\(/u, 'the serialized function references a helper that exists only in the Worker');
    assert.ok(app.diagnostics.some(event => event.includes('EVALUATION_EXCEPTION')));
  } finally { await app.browser.close(); }
});

test('the configured production bundle runs its real serialized login readers in an isolated page', async () => {
  assert.equal(configuredKeepNames, 'false', 'keep_names must be disabled for self-contained remote functions');
  const app = await startBundledBrowser(configuredKeepNames === 'true');
  try {
    assert.equal(await app.browser.verifyAccess(), true);
    assert.equal(app.browser.tenantId(), '1012619');
    assert.equal(app.exceptions.length, 0);
    assert.equal(app.expressions.length, 2, 'logged-in shell and trusted tenant are confirmed twice');
    for (const expression of app.expressions) {
      assert.doesNotMatch(expression, /__name\(/u);
      assert.equal(vm.runInContext(expression, app.remote).tenantId, '1012619');
    }
    assert.equal(vm.runInContext('typeof __name', app.remote), 'undefined', 'fix must not inject build helpers into the external login page');
    assert.deepEqual(app.commands.filter(command => command.method === 'Page.navigate').map(command => command.params.url), ['https://qnh.meituan.com/']);
    assert.equal(app.commands.some(command => ['Network.getResponseBody', 'Page.getFrameTree'].includes(command.method)), false);
    assert.equal(app.remote.testPage.selectors.some(selector => /SKU|table|unifiedGoods/u.test(selector)), false, 'login admission must not require a product lookup');
  } finally { await app.browser.close(); }
});

test('the configured bundle rejects a visible login form and cannot switch its bound tenant', async () => {
  const app = await startBundledBrowser(configuredKeepNames === 'true');
  try {
    app.remote.testPage.passwordVisible = true;
    assert.equal(await app.browser.verifyAccess(), false);
    assert.equal(app.browser.tenantId(), null);
    app.remote.testPage.passwordVisible = false;
    assert.equal(await app.browser.verifyAccess(), true);
    assert.equal(app.browser.tenantId(), '1012619');
    app.remote.testPage.tenant.innerText = '（租户ID: 2026220）';
    assert.equal(await app.browser.verifyAccess(), false);
    assert.equal(app.browser.tenantId(), '1012619', 'a different tenant must never inherit the existing browser authorization');
    assert.equal(app.exceptions.length, 0);
  } finally { await app.browser.close(); }
});
