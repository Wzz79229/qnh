import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVisibleQnhAdapter, normalizeSku, sanitizeProduct, QNH_PRODUCT_URL } from './extract.mjs';
import { browserConfiguration, acquireProfileLock } from './browser.mjs';

export const DEFAULT_API = 'https://qnh-shelf-life-api.w792294944.workers.dev';
const STATUSES = new Set(['found', 'not_found', 'ambiguous', 'login_required', 'error']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIXED_MESSAGES = {
  not_found: '牵牛花中没有此 SKU，请核对标签。',
  ambiguous: '牵牛花返回多个不同商品，请管理员核对 SKU。',
  login_required: '请管理员在本机牵牛花浏览器中重新登录。',
  error: '牵牛花商品查询未完成，请管理员检查本机查询程序。',
};

export function configuration(env = process.env) {
  const rawBase = env.QNH_API_BASE_URL || DEFAULT_API;
  let base;
  try { base = new URL(rawBase); } catch { throw new Error('INVALID_API_BASE'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) throw new Error('INVALID_API_BASE');
  const key = env.QNH_CONNECTOR_KEY;
  if (typeof key !== 'string' || key.length < 32 || key.length > 512 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(key)) throw new Error('CONNECTOR_KEY_REQUIRED');
  return { apiBase: base.origin, key, ...browserConfiguration(env), pollMs: 2000, requestMs: 8000 };
}

async function responseJson(response) {
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'BRIDGE_AUTH_REQUIRED' : response.status === 409 ? 'LEASE_EXPIRED' : 'BRIDGE_UNAVAILABLE');
  const declared = response.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 16384)) throw new Error('INVALID_BRIDGE_RESPONSE');
  if (!response.body) throw new Error('INVALID_BRIDGE_RESPONSE');
  const reader = response.body.getReader();
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 16384) throw new Error('INVALID_BRIDGE_RESPONSE');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('INVALID_BRIDGE_RESPONSE'); }
}

export function validateJob(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || !UUID.test(value.id)
    || typeof value.leaseToken !== 'string' || value.leaseToken.length < 16 || value.leaseToken.length > 512
    || /[\s\u0000-\u001f\u007f]/u.test(value.leaseToken)) throw new Error('INVALID_BRIDGE_RESPONSE');
  return { id: value.id, sku: normalizeSku(value.sku), leaseToken: value.leaseToken };
}

export function sanitizedResult(value, sku) {
  if (!value || typeof value !== 'object' || !STATUSES.has(value.status)) return { status: 'error', message: FIXED_MESSAGES.error };
  if (value.status === 'found') {
    try {
      const product = sanitizeProduct(value.product, sku);
      if (!product.imageUrl) throw new Error('MISSING_IMAGE');
      return { status: 'found', product };
    } catch { return { status: 'error', message: FIXED_MESSAGES.error }; }
  }
  // Preserve specific missing-image information, but never reflect arbitrary DOM/exception text.
  const missingImage = value.status === 'error' && value.message === '此 SKU 的商品主图缺失，请在牵牛花核对后重试。';
  return { status: value.status, message: missingImage ? value.message : FIXED_MESSAGES[value.status] };
}

export function createBridgeClient(config, fetchImpl = globalThis.fetch) {
  async function post(path, body, signal) {
    const timeout = AbortSignal.timeout(config.requestMs ?? 8000);
    const response = await fetchImpl(`${config.apiBase}${path}`, {
      method: 'POST', redirect: 'error', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Authorization: `Bearer ${config.key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return responseJson(response);
  }
  return {
    async claim({ signal } = {}) {
      const body = await post('/api/qnh/bridge/claim', null, signal);
      if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'job')) throw new Error('INVALID_BRIDGE_RESPONSE');
      return validateJob(body.job);
    },
    async submit(job, value, { signal } = {}) {
      const verified = validateJob(job);
      if (!verified) throw new Error('INVALID_JOB');
      const result = sanitizedResult(value, verified.sku);
      const acknowledgement = await post('/api/qnh/bridge/result', {
        id: verified.id, leaseToken: verified.leaseToken, result,
      }, signal);
      if (!acknowledgement || acknowledgement.id !== verified.id || acknowledgement.sku !== verified.sku
        || acknowledgement.status !== result.status) throw new Error('RESULT_UNCONFIRMED');
      return acknowledgement;
    },
  };
}

export async function processOne({ client, adapter, signal, notify = () => {} }) {
  if (signal?.aborted) return 'stopped';
  let loggedIn = false;
  try { loggedIn = await adapter.checkLogin(); } catch {}
  if (!loggedIn) {
    notify('login_required');
    const job = await client.claim({ signal });
    if (signal?.aborted) return 'stopped';
    if (job) await client.submit(job, { status: 'login_required' }, { signal });
    return 'login_required';
  }
  const job = await client.claim({ signal });
  if (!job) return 'idle';
  let result;
  try { result = await adapter.lookup(job.sku, { deadline: Date.now() + 35000, signal }); }
  catch { result = { status: 'error' }; }
  if (signal?.aborted) return 'stopped';
  await client.submit(job, result, { signal });
  notify(sanitizedResult(result, job.sku).status);
  return 'processed';
}

export function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export async function runAgent({ config, adapter, client = createBridgeClient(config), signal, notify = () => {}, pause = sleep }) {
  let lastStatus = '';
  const report = status => { if (status !== lastStatus) { lastStatus = status; notify(status); } };
  while (!signal?.aborted) {
    let delay = config.pollMs ?? 2000;
    try { await processOne({ client, adapter, signal, notify: report }); }
    catch (error) {
      report(error?.message === 'BRIDGE_AUTH_REQUIRED' ? 'bridge_auth_required' : error?.message === 'LEASE_EXPIRED' ? 'lease_expired' : 'bridge_unavailable');
      delay = 6000;
    }
    if (!signal?.aborted) await pause(delay, signal);
  }
}

const NOTICES = {
  login_required: '请在独立浏览器中登录牵牛花，并打开 商品 → 商品主档；登录密码和验证码不要发送到聊天。',
  found: '已返回商品名称、规格和图片，员工可在手机填写清点件数。',
  not_found: '该次查询未找到精确 SKU。', ambiguous: '该次查询出现多个不同商品，需要核对。',
  error: '该次商品查询未完成，请检查牵牛花页面。',
  bridge_auth_required: '连接密钥未通过验证，请核对本机与 Cloudflare 的 QNH_CONNECTOR_KEY。',
  lease_expired: '该次查询已超过领取期限，未提交过期结果。',
  bridge_unavailable: '暂时无法连接查询服务，稍后自动重试。',
};

export async function main(env = process.env) {
  let config;
  try { config = configuration(env); }
  catch {
    console.error('配置未完成：请按 README 配置 QNH_CONNECTOR_KEY（至少 32 位无空白），并核对 HTTPS 服务地址和浏览器类型。');
    process.exitCode = 1;
    return;
  }
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch {
    console.error('尚未安装 Playwright。请在 local-query 目录按 README 安装固定版本后再启动。');
    process.exitCode = 1;
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let context;
  let profileLock;
  try {
    profileLock = await acquireProfileLock(config.profile);
    context = await chromium.launchPersistentContext(config.profile, {
      channel: config.channel, headless: false, viewport: null,
    });
    context.once('close', stop);
    const page = context.pages().find(item => item.url().startsWith('https://qnh.meituan.com/')) || context.pages()[0] || await context.newPage();
    if (page.url() !== QNH_PRODUCT_URL) await page.goto(QNH_PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    console.log('本机查询程序已启动。此独立浏览器用于商品查询，请保持电脑联网和程序运行。按 Ctrl+C 停止。');
    await runAgent({ config, adapter: createVisibleQnhAdapter(page), signal: controller.signal, notify: status => {
      if (NOTICES[status]) console.log(NOTICES[status]);
    } });
  } catch (error) {
    if (error?.code === 'PROFILE_IN_USE') console.error('连接牵牛花或启动查询程序已经运行，请先关闭正在运行的程序和它的独立浏览器。');
    else console.error('本机查询程序未能继续。请确认已安装所选 Chrome/Edge，且没有其他程序占用本工具的独立浏览器目录。');
    process.exitCode = 1;
  } finally {
    controller.abort();
    if (context) await context.close().catch(() => {});
    if (profileLock) await profileLock.release().catch(() => {});
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
