import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { browserConfiguration, profileMutexName, acquireProfileLock } from '../local-query/browser.mjs';
import { configuration } from '../local-query/agent.mjs';
import { runLocalConnection, connectMain } from '../local-query/connect.mjs';
import { QNH_PRODUCT_URL } from '../local-query/extract.mjs';

const SKU = '2110000000000000001';
const PRODUCT = { sku: SKU, spu: '2110000000000000000', name: '合成试查商品', spec: '100g', category: '测试', barcodes: [], imageUrl: 'https://img.meituan.net/empowerstoremanagement/synthetic-test.jpg@80w_80h_90Q' };

function inputs(values) {
  const prompts = [];
  return { prompts, async ask(prompt) { prompts.push(prompt); assert.ok(values.length, 'unexpected prompt'); return values.shift(); } };
}

test('browser settings share the exact bridge profile without needing cloud credentials', () => {
  const env = { LOCALAPPDATA: 'C:\\SyntheticLocal', QNH_BROWSER: 'msedge' };
  const browser = browserConfiguration(env);
  const bridge = configuration({ ...env, QNH_CONNECTOR_KEY: 'synthetic_key_only_012345678901234567890' });
  assert.equal(browser.profile, bridge.profile);
  assert.equal(browser.channel, bridge.channel);
  assert.match(browser.profile, /QnhShelfLife.*QueryBrowser-msedge$/);
});

test('browser configuration never reads any remote-service key or base URL', () => {
  const accessed = [];
  const env = new Proxy({ QNH_BROWSER: 'chrome', LOCALAPPDATA: 'C:\\SyntheticLocal' }, {
    get(target, key) { accessed.push(key); if (!['QNH_BROWSER', 'LOCALAPPDATA'].includes(key)) throw new Error('credential access forbidden'); return target[key]; },
  });
  assert.equal(browserConfiguration(env).channel, 'chrome');
  assert.deepEqual(accessed, ['QNH_BROWSER', 'LOCALAPPDATA']);
});

test('Windows profile mutex is case-stable IPC with no host or TCP port', async () => {
  assert.equal(profileMutexName('C:\\SyntheticLocal\\Profile'), profileMutexName('c:\\syntheticlocal\\profile'));
  let options;
  let closes = 0;
  let connection;
  const server = new EventEmitter();
  server.listen = value => { options = value; queueMicrotask(() => server.emit('listening')); };
  server.close = callback => { closes++; callback(); };
  const lock = await acquireProfileLock('C:\\SyntheticLocal\\Profile', { platform: 'win32', makeServer: handler => { connection = handler; return server; } });
  assert.ok(options.path.startsWith('\\\\.\\pipe\\qnh-shelf-life-profile-'));
  assert.equal(Object.hasOwn(options, 'port'), false);
  assert.equal(Object.hasOwn(options, 'host'), false);
  assert.equal(options.exclusive, true);
  assert.equal(options.readableAll, false);
  assert.equal(options.writableAll, false);
  let destroyed = 0;
  connection({ destroy() { destroyed++; } });
  assert.equal(destroyed, 1);
  await lock.release(); await lock.release();
  assert.equal(closes, 1);
});

test('a second running profile is refused without exposing an IPC error', async () => {
  const server = new EventEmitter();
  server.listen = () => queueMicrotask(() => server.emit('error', Object.assign(new Error('private raw details'), { code: 'EADDRINUSE' })));
  await assert.rejects(acquireProfileLock('C:\\SyntheticProfile', { platform: 'win32', makeServer: () => server }), error => error.code === 'PROFILE_IN_USE' && error.message === 'PROFILE_IN_USE');
});

test('local login waits for the human and does not ask the terminal for credentials', async () => {
  const input = inputs(['', SKU, ':q']);
  const output = [];
  let loginChecks = 0;
  let queried;
  await runLocalConnection({
    adapter: { checkLogin: async () => ++loginChecks > 1, lookup: async sku => { queried = sku; return { status: 'found', product: PRODUCT }; } },
    ask: input.ask, write: value => output.push(value),
  });
  assert.equal(queried, SKU);
  assert.ok(output.some(value => value.includes('合成试查商品')));
  assert.ok(output.some(value => value.includes(PRODUCT.imageUrl)));
  assert.ok(output.some(value => value.includes('不代表手机 App')));
  assert.doesNotMatch(input.prompts.join('\n'), /请输入.*(?:密码|验证码|TOKEN|CONNECTOR_KEY)/i);
});

test('no login means no SKU search or product read', async () => {
  let queries = 0;
  const input = inputs([':q']);
  await runLocalConnection({ adapter: { checkLogin: async () => false, lookup: async () => queries++ }, ask: input.ask, write: () => {} });
  assert.equal(queries, 0);
});

test('local SKU input preserves leading zeroes and rejects invalid text without searching', async () => {
  const input = inputs(['invalid sku', '0000123', ':q']);
  const queries = [];
  await runLocalConnection({ adapter: { checkLogin: async () => true, lookup: async sku => { queries.push(sku); return { status: 'not_found' }; } }, ask: input.ask, write: () => {} });
  assert.deepEqual(queries, ['0000123']);
});

test('local result errors and mismatched SKUs never expose raw exception or wrong product', async () => {
  const output = [];
  const input = inputs([SKU, SKU, ':q']);
  let queries = 0;
  await runLocalConnection({
    adapter: { checkLogin: async () => true, lookup: async () => {
      if (++queries === 1) throw new Error('private_password_or_cookie');
      return { status: 'found', product: { ...PRODUCT, sku: 'wrong', name: 'wrong-product-do-not-show' } };
    } }, ask: input.ask, write: value => output.push(value),
  });
  assert.doesNotMatch(output.join('\n'), /private_password_or_cookie|wrong-product-do-not-show/);
});

test('missing-image diagnostic remains explicit and no screenshot is required', async () => {
  const output = [];
  const input = inputs([SKU, ':q']);
  await runLocalConnection({
    adapter: { checkLogin: async () => true, lookup: async () => ({ status: 'error', message: '此 SKU 的商品主图缺失，请在牵牛花核对后重试。' }) },
    ask: input.ask, write: value => output.push(value),
  });
  assert.ok(output.some(value => value.includes('主图缺失')));
});

function mainFixture({ busy = false, launchError = false } = {}) {
  const events = [];
  const output = [];
  const context = new EventEmitter();
  const page = { url: () => 'about:blank', async goto(url, options) { events.push(['goto', url, options]); } };
  context.pages = () => [page];
  context.close = async () => { events.push(['contextClose']); context.emit('close'); };
  const terminal = new EventEmitter();
  terminal.question = async () => ':q';
  terminal.close = () => { events.push(['terminalClose']); terminal.emit('close'); };
  const env = new Proxy({ QNH_BROWSER: 'msedge', LOCALAPPDATA: 'C:\\SyntheticLocal' }, { get(target, key) {
    if (!['QNH_BROWSER', 'LOCALAPPDATA'].includes(key)) throw new Error(`forbidden env access: ${String(key)}`);
    return target[key];
  } });
  return { events, output, context, terminal, options: {
    env, write: value => output.push(value),
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async (profile, settings) => {
      events.push(['launch', profile, settings]); if (launchError) throw new Error('private launch details'); return context;
    } } }),
    lockProfile: async profile => { events.push(['lock', profile]); if (busy) throw Object.assign(new Error('private lock details'), { code: 'PROFILE_IN_USE' }); return { release: async () => events.push(['release']) }; },
    makeTerminal: () => terminal,
    makeAdapter: value => { assert.equal(value, page); return { checkLogin: async () => true }; },
  } };
}

test('standalone startup uses the fixed visible browser with no fetch or cloud configuration', async t => {
  const previous = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('network bridge forbidden'); };
  t.after(() => { globalThis.fetch = previous; });
  const f = mainFixture();
  assert.equal(await connectMain(f.options), 0);
  const launch = f.events.find(value => value[0] === 'launch');
  assert.deepEqual(launch[2], { channel: 'msedge', headless: false, viewport: null });
  assert.equal(f.events.find(value => value[0] === 'goto')[1], QNH_PRODUCT_URL);
  assert.equal(requests, 0);
  assert.equal(f.events.filter(value => value[0] === 'contextClose').length, 1);
  assert.equal(f.events.filter(value => value[0] === 'release').length, 1);
});

test('profile in use blocks startup before launching a second browser', async () => {
  const f = mainFixture({ busy: true });
  assert.equal(await connectMain(f.options), 1);
  assert.equal(f.events.some(value => value[0] === 'launch'), false);
  assert.ok(f.output.some(value => value.includes('已经运行')));
  assert.doesNotMatch(f.output.join('\n'), /private lock details/);
});

test('browser startup failure releases the shared profile mutex', async () => {
  const f = mainFixture({ launchError: true });
  assert.equal(await connectMain(f.options), 1);
  assert.equal(f.events.filter(value => value[0] === 'release').length, 1);
  assert.doesNotMatch(f.output.join('\n'), /private launch details/);
});

test('closing the browser aborts a pending terminal prompt and releases resources', async () => {
  const f = mainFixture();
  f.terminal.question = (_prompt, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    queueMicrotask(() => f.context.emit('close'));
  });
  assert.equal(await connectMain(f.options), 0);
  assert.equal(f.events.filter(value => value[0] === 'release').length, 1);
});

function realReadlineFixture({ terminalMode = false } = {}) {
  const f = mainFixture();
  const input = new PassThrough();
  const output = new PassThrough();
  if (terminalMode) {
    input.isTTY = true;
    input.setRawMode = () => {};
    output.isTTY = true;
    output.columns = 80;
  }
  const terminal = createInterface({ input, output, terminal: terminalMode });
  let questionReady;
  const questionStarted = new Promise(resolve => { questionReady = resolve; });
  const question = terminal.question.bind(terminal);
  terminal.question = (prompt, options) => { questionReady(); return question(prompt, options); };
  f.options.makeTerminal = () => terminal;
  return { ...f, lines: f.output, input, output, terminal, questionStarted };
}

test('real readline EOF aborts a pending question and releases browser/profile resources', { timeout: 3000 }, async t => {
  const f = realReadlineFixture();
  t.after(() => { f.terminal.close(); f.input.destroy(); f.output.destroy(); });
  const running = connectMain(f.options);
  await f.questionStarted;
  f.input.end();
  assert.equal(await running, 0);
  assert.equal(f.events.filter(value => value[0] === 'contextClose').length, 1);
  assert.equal(f.events.filter(value => value[0] === 'release').length, 1);
  assert.equal(f.terminal.listenerCount('SIGINT'), 0);
});

test('real readline Ctrl+C aborts instead of hanging or recursively closing', { timeout: 3000 }, async t => {
  const f = realReadlineFixture({ terminalMode: true });
  t.after(() => { f.terminal.close(); f.input.destroy(); f.output.destroy(); });
  const running = connectMain(f.options);
  await f.questionStarted;
  f.input.write('\u0003');
  assert.equal(await running, 0);
  assert.equal(f.events.filter(value => value[0] === 'contextClose').length, 1);
  assert.equal(f.events.filter(value => value[0] === 'release').length, 1);
  assert.equal(f.terminal.listenerCount('SIGINT'), 0);
});

test('real readline input error exits safely without reflecting stream error details', { timeout: 3000 }, async t => {
  const f = realReadlineFixture();
  t.after(() => { f.terminal.close(); f.input.destroy(); f.output.destroy(); });
  const running = connectMain(f.options);
  await f.questionStarted;
  f.input.destroy(new Error('private-stream-error-details'));
  assert.equal(await running, 0);
  assert.equal(f.events.filter(value => value[0] === 'release').length, 1);
  assert.doesNotMatch(f.lines.join('\n'), /private-stream-error-details/);
});
