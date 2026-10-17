import {
  ManagedQnhPhoneSession, QNH_BROWSER_LIMITS, QnhBrowserError,
  createCloudflareQnhBrowserFactory, createQnhPhoneCookie, readQnhPhoneCookie,
  clearQnhPhoneCookie, normalizeQnhViewerInput, requireQnhBrowserOrigin,
} from './qnh-browser-session.mjs';
import { normalizeSku } from '../local-query/extract.mjs';

const PHONE_INTERNAL = 'http://qnh-phone.internal';
const BUDGET_INTERNAL = 'http://qnh-browser-budget.internal';
const PREFIX = '/api/qnh/login/';
const PUBLIC_PATHS = new Set(['start', 'frame', 'input', 'verify', 'cancel']);
const TOKEN = /^[a-f0-9]{64}$/u;
const TENANT = /^[1-9][0-9]{0,19}$/u;
const BODY_LIMIT = 4096;
const DAY_MS = 86_400_000;
const ownObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, expected) => ownObject(value) && Object.keys(value).length === expected.length
  && Object.keys(value).every(key => expected.includes(key));

/** A deliberately bounded demonstration allowance, not capacity for a store's normal trading day. */
export const QNH_PHONE_DEMO_LIMITS = Object.freeze({
  dailyMs: 480_000, reservationMs: 240_000, cleanupMs: 15_000,
  concurrent: 2, newStartIntervalMs: 21_000, perIpAttempts: 2,
});

const fail = (status, code, message) => new QnhBrowserError(status, code, message);
const unavailable = () => fail(502, 'QNH_BROWSER_UNAVAILABLE', '牵牛花连接暂时不可用，请重新登录。');
const notConfigured = () => fail(503, 'QNH_BROWSER_NOT_CONFIGURED', '牵牛花手机登录连接尚未配置完成。');
const expired = () => fail(401, 'QNH_BROWSER_SESSION_EXPIRED', '牵牛花登录会话已结束，请重新登录。');
const invalid = () => fail(400, 'INVALID_QNH_BROWSER_INPUT', '登录操作格式无效。');
const unauthenticated = () => ({ authorized: false, loginMethod: 'qnh_browser', status: 'login_required' });

function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra,
  } });
}

function errorResponse(error) {
  const safe = error instanceof QnhBrowserError ? error : unavailable();
  const headers = {};
  if (Number.isInteger(safe.retryAfter) && safe.retryAfter > 0 && safe.retryAfter <= 86_400) headers['Retry-After'] = String(safe.retryAfter);
  return json({ error: safe.message, code: safe.code }, safe.status, headers);
}

async function readJson(request, expectedKeys) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get('Content-Type') || '')
    || request.headers.has('Content-Encoding')) throw invalid();
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d{1,10}$/u.test(length) || Number(length) > BODY_LIMIT)) throw invalid();
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  let count = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > BODY_LIMIT) { await reader.cancel(); throw invalid(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
  if (!ownObject(value) || (expectedKeys && !exactKeys(value, expectedKeys))) throw invalid();
  return value;
}

function internalRequest(origin, path, body) {
  return new Request(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function internalPath(request, origin, paths) {
  const url = new URL(request.url);
  if (url.origin !== origin || url.search || request.method !== 'POST' || !paths.includes(url.pathname)) throw invalid();
  return url.pathname;
}

function namespace(value) {
  return typeof value?.idFromName === 'function' && typeof value?.get === 'function';
}

function browserConfigured(env, options = {}) {
  const binding = env?.BROWSER;
  const perTenant = env?.QNH_TENANT_MODE === 'per_tenant';
  const hasVerifier = typeof options.confirmProductAccess === 'function'
    || (typeof env?.QNH_AUTH_PROBE_SKU === 'string' && /^[0-9]{1,64}$/u.test(env.QNH_AUTH_PROBE_SKU));
  return namespace(env?.QNH_PHONE_SESSIONS) && namespace(env?.QNH_BROWSER_BUDGET)
    && typeof binding?.acquire === 'function' && typeof binding?.connectSession === 'function'
    && typeof binding?.closeSession === 'function' && typeof binding?.devtools?.newTarget === 'function'
    && (perTenant || (typeof env.QNH_EXPECTED_TENANT_ID === 'string' && TENANT.test(env.QNH_EXPECTED_TENANT_ID) && hasVerifier))
    && typeof env.QNH_BROWSER_ALLOWED_DOMAINS === 'string' && env.QNH_BROWSER_ALLOWED_DOMAINS.split(',').map(value => value.trim()).includes('qnh.meituan.com')
    && (env.QNH_TENANT_MODE === undefined || ['fixed', 'per_tenant'].includes(env.QNH_TENANT_MODE));
}

async function unwrap(response) {
  if (!(response instanceof Response)) throw unavailable();
  let value;
  try {
    // Only our own fixed DO contracts can reach here; still bound any accidental provider reflection.
    const text = await response.text();
    if (text.length > 32_768) throw unavailable();
    value = JSON.parse(text);
  } catch { throw unavailable(); }
  if (!ownObject(value)) throw unavailable();
  if (!response.ok) {
    const safeCodes = new Set(['QNH_BROWSER_SESSION_EXPIRED', 'QNH_BROWSER_LOGIN_REQUIRED', 'QNH_BROWSER_INPUT_FROZEN',
      'QNH_BROWSER_FRAME_RATE', 'QNH_BROWSER_INPUT_RATE', 'QNH_BROWSER_NOT_CONFIGURED', 'QNH_BROWSER_UNAVAILABLE',
      'INVALID_QNH_BROWSER_INPUT', 'QNH_BROWSER_DEMO_LIMIT', 'QNH_BROWSER_START_RATE']);
    if (!safeCodes.has(value.code)) throw unavailable();
    const messages = {
      QNH_BROWSER_SESSION_EXPIRED: '牵牛花登录会话已结束，请重新登录。', QNH_BROWSER_LOGIN_REQUIRED: '请先登录牵牛花。',
      QNH_BROWSER_INPUT_FROZEN: '正在确认登录，请稍候。', QNH_BROWSER_FRAME_RATE: '请稍候再刷新登录画面。',
      QNH_BROWSER_INPUT_RATE: '登录操作过于频繁，请稍候重试。', QNH_BROWSER_NOT_CONFIGURED: '牵牛花手机登录连接尚未配置完成。',
      QNH_BROWSER_UNAVAILABLE: '牵牛花连接暂时不可用，请重新登录。', INVALID_QNH_BROWSER_INPUT: '登录操作格式无效。',
      QNH_BROWSER_DEMO_LIMIT: '今日手机登录试用额度已用完，请联系管理员。', QNH_BROWSER_START_RATE: '登录启动过于频繁，请稍候重试。',
    };
    const error = fail(response.status, value.code, messages[value.code]);
    const retry = response.headers.get('Retry-After');
    if (retry && /^\d{1,5}$/u.test(retry) && Number(retry) <= 86_400) error.retryAfter = Number(retry);
    throw error;
  }
  return value;
}

function requireFrameOrigin(request, origin) {
  const url = new URL(request.url);
  if (url.origin !== origin || (request.headers.has('Origin') && request.headers.get('Origin') !== origin)
    || request.headers.get('Sec-Fetch-Site') !== 'same-origin'
    || request.headers.get('Sec-Fetch-Dest') !== 'empty') {
    throw fail(403, 'QNH_BROWSER_ORIGIN_DENIED', '请从保质期程序内重新打开登录。');
  }
}

function requireMutationOrigin(request, origin) {
  requireQnhBrowserOrigin(request, origin);
  if (request.headers.get('Sec-Fetch-Site') !== 'same-origin'
    || request.headers.get('Sec-Fetch-Dest') !== 'empty') {
    throw fail(403, 'QNH_BROWSER_ORIGIN_DENIED', '请从保质期程序内重新打开登录。');
  }
}

/** Public phone traffic never receives a provider URL, CDP capability or Cloudflare browser/session identifier. */
export function createQnhPhoneRouter(env, { origin, now = () => Date.now(), cryptoImpl = globalThis.crypto,
  confirmProductAccess } = {}) {
  let validOrigin = false;
  try { const url = new URL(origin); validOrigin = url.protocol === 'https:' && url.origin === origin; } catch { /* Fail closed. */ }
  const configured = validOrigin && browserConfigured(env, { confirmProductAccess });
  const call = async (token, path, body = {}) => {
    if (!configured) throw notConfigured();
    if (!TOKEN.test(token || '')) throw expired();
    const stub = env.QNH_PHONE_SESSIONS.get(env.QNH_PHONE_SESSIONS.idFromName(token));
    return stub.fetch(internalRequest(PHONE_INTERNAL, path, body));
  };
  const status = async request => {
    const token = readQnhPhoneCookie(request);
    if (!token) return unauthenticated(); // No DO, browser or quota allocation for a public status preflight.
    requireFrameOrigin(request, origin);
    try { return await unwrap(await call(token, '/status')); }
    catch (error) {
      if (error instanceof QnhBrowserError && ['QNH_BROWSER_SESSION_EXPIRED', 'QNH_BROWSER_LOGIN_REQUIRED'].includes(error.code)) return unauthenticated();
      throw error;
    }
  };
  const cancel = async request => {
    const token = readQnhPhoneCookie(request);
    if (token && configured) await unwrap(await call(token, '/cancel'));
    return { authorized: false, loginMethod: 'qnh_browser', status: 'expired' };
  };
  const hashClient = async request => {
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip || ip.length > 64 || !/^[a-f0-9:.]+$/iu.test(ip)) return 'unknown';
    if (typeof cryptoImpl?.subtle?.digest !== 'function') throw notConfigured();
    const day = Math.floor(now() / DAY_MS);
    const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(`qnh-phone-attempt:${day}:${ip}`));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  };
  return {
    configured, status, cancel,
    async lookup(request, sku) {
      requireFrameOrigin(request, origin);
      return unwrap(await call(readQnhPhoneCookie(request), '/lookup', { sku: normalizeSku(sku) }));
    },
    async handle(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(PREFIX) || !PUBLIC_PATHS.has(url.pathname.slice(PREFIX.length))) return null;
      try {
        const action = url.pathname.slice(PREFIX.length);
        if (url.search) throw invalid();
        if (action === 'frame') {
          if (request.method !== 'GET') throw fail(405, 'INVALID_QNH_BROWSER_INPUT', '登录操作格式无效。');
          requireFrameOrigin(request, origin);
          const response = await call(readQnhPhoneCookie(request), '/frame');
          if (!response.ok) await unwrap(response);
          if (response.headers.get('Content-Type') !== 'image/jpeg') throw unavailable();
          return new Response(response.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
        }
        if (request.method !== 'POST') throw fail(405, 'INVALID_QNH_BROWSER_INPUT', '登录操作格式无效。');
        requireMutationOrigin(request, origin);
        const body = await readJson(request, action === 'input' ? undefined : []);
        if (action === 'cancel') return json(await cancel(request), 200, { 'Set-Cookie': clearQnhPhoneCookie() });
        if (!configured) throw notConfigured();
        if (action === 'start') {
          const previous = readQnhPhoneCookie(request);
          if (previous) {
            try { return json(await unwrap(await call(previous, '/start', { ipHash: await hashClient(request) }))); }
            catch (error) { if (!(error instanceof QnhBrowserError) || error.code !== 'QNH_BROWSER_SESSION_EXPIRED') throw error; }
          }
          const phone = createQnhPhoneCookie(cryptoImpl);
          const result = await unwrap(await call(phone.token, '/start', { ipHash: await hashClient(request) }));
          return json(result, 200, { 'Set-Cookie': phone.cookie });
        }
        const token = readQnhPhoneCookie(request);
        return json(await unwrap(await call(token, action === 'input' ? '/input' : '/verify',
          action === 'input' ? normalizeQnhViewerInput(body) : {})));
      } catch (error) { return errorResponse(error); }
    },
  };
}

/** Only opaque lease IDs and daily IP hashes are persisted; releases never refund the browser-time allowance. */
export class QnhBrowserBudget {
  constructor(state, env, { now = () => Date.now() } = {}) {
    this.storage = state.storage; this.now = now; this.queue = Promise.resolve();
  }
  serial(operation) { const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result; }
  async load() {
    const day = Math.floor(this.now() / DAY_MS);
    const saved = await this.storage.get('budget');
    if (saved && (!ownObject(saved) || !Number.isInteger(saved.day) || !Number.isInteger(saved.usedMs)
      || saved.usedMs < 0 || !Number.isFinite(saved.lastStartedAt) || !ownObject(saved.attempts) || !Array.isArray(saved.active))) throw notConfigured();
    const value = !saved || saved.day !== day ? { day, usedMs: 0, lastStartedAt: saved?.lastStartedAt || 0, attempts: {}, active: [] } : saved;
    value.active = value.active.filter(lease => TOKEN.test(lease.id || '') && Number.isFinite(lease.expiresAt) && lease.expiresAt > this.now());
    return value;
  }
  async save(value) {
    await this.storage.put('budget', value);
    if (value.active.length) await this.storage.setAlarm(Math.min(...value.active.map(lease => lease.expiresAt)));
    else await this.storage.deleteAlarm();
  }
  fetch(request) {
    return this.serial(async () => {
      try {
        const path = internalPath(request, BUDGET_INTERNAL, ['/reserve', '/release']);
        const body = await readJson(request, path === '/reserve' ? ['leaseId', 'ipHash', 'maximumMs'] : ['leaseId']);
        if (!TOKEN.test(body.leaseId || '')) throw invalid();
        const value = await this.load();
        if (path === '/release') {
          value.active = value.active.filter(lease => lease.id !== body.leaseId);
          await this.save(value);
          return json({ released: true });
        }
        if (!(TOKEN.test(body.ipHash || '') || body.ipHash === 'unknown')
          || body.maximumMs !== QNH_PHONE_DEMO_LIMITS.reservationMs) throw invalid();
        const now = this.now();
        const dayEnd = (value.day + 1) * DAY_MS;
        const reservedMs = Math.min(QNH_PHONE_DEMO_LIMITS.reservationMs, dayEnd - now);
        const deny = (code, retryMs) => {
          const error = fail(429, code, code === 'QNH_BROWSER_START_RATE'
            ? '登录启动过于频繁，请稍候重试。' : '今日手机登录试用额度已用完，请联系管理员。');
          error.retryAfter = Math.max(1, Math.min(86_400, Math.ceil(retryMs / 1000)));
          throw error;
        };
        if (value.active.some(lease => lease.id === body.leaseId)) throw invalid();
        if (reservedMs <= QNH_PHONE_DEMO_LIMITS.cleanupMs || value.usedMs + reservedMs > QNH_PHONE_DEMO_LIMITS.dailyMs
          || value.active.length >= QNH_PHONE_DEMO_LIMITS.concurrent
          || (value.attempts[body.ipHash] || 0) >= QNH_PHONE_DEMO_LIMITS.perIpAttempts) deny('QNH_BROWSER_DEMO_LIMIT', dayEnd - now);
        if (value.lastStartedAt && now - value.lastStartedAt < QNH_PHONE_DEMO_LIMITS.newStartIntervalMs) {
          deny('QNH_BROWSER_START_RATE', QNH_PHONE_DEMO_LIMITS.newStartIntervalMs - (now - value.lastStartedAt));
        }
        value.usedMs += reservedMs;
        value.lastStartedAt = now;
        value.attempts[body.ipHash] = (value.attempts[body.ipHash] || 0) + 1;
        const expiresAt = now + reservedMs;
        value.active.push({ id: body.leaseId, expiresAt });
        await this.save(value); // Persist before the caller is allowed to attempt a provider acquisition.
        return json({ reserved: true, expiresAt: expiresAt - QNH_PHONE_DEMO_LIMITS.cleanupMs });
      } catch (error) { return errorResponse(error); }
    });
  }
  alarm() { return this.serial(async () => { const value = await this.load(); await this.save(value); }); }
}

/** One instance is addressed only by the 256-bit HttpOnly phone cookie; it never restores QNH credentials. */
export class QnhPhoneSession {
  constructor(state, env, { now = () => Date.now(), cryptoImpl = globalThis.crypto, browserFactory, confirmProductAccess } = {}) {
    this.storage = state.storage; this.env = env; this.now = now; this.crypto = cryptoImpl;
    this.browserFactory = browserFactory; this.confirmProductAccess = confirmProductAccess;
    this.controller = null; this.marker = null; this.boundTenantId = null; this.retired = false; this.queue = Promise.resolve();
    this.ready = Promise.all([this.storage.get('session'), this.storage.get('retired')]).then(([marker, retired]) => {
      this.marker = marker || null;
      this.retired = retired === true || Boolean(marker);
    });
  }
  serial(operation) { const result = this.queue.then(() => this.ready).then(operation); this.queue = result.catch(() => {}); return result; }
  async budget(path, body) {
    const binding = this.env.QNH_BROWSER_BUDGET;
    if (!namespace(binding)) throw notConfigured();
    const stub = binding.get(binding.idFromName('qnh-browser-demo-budget-v1'));
    return unwrap(await stub.fetch(internalRequest(BUDGET_INTERNAL, path, body)));
  }
  async stop() {
    const controller = this.controller;
    this.controller = null;
    this.boundTenantId = null;
    this.retired = true;
    const marker = this.marker;
    this.marker = null;
    try { await controller?.close(); }
    finally {
      // On eviction we cannot reconnect to the old browser. Its private transport closes and the provider's short idle timeout expires it.
      // A persisted lease permits conservative quota cleanup, never session/credential restoration.
      // An evicted object cannot prove the old remote browser is closed, so retain that lease until its absolute expiry.
      if (controller && marker?.leaseId) try { await this.budget('/release', { leaseId: marker.leaseId }); } catch { /* Original reservation remains charged. */ }
      // Keep a capability-free tombstone so a stale cookie cannot silently recreate this phone object after eviction.
      await this.storage.put('retired', true);
      await this.storage.delete('session');
      await this.storage.deleteAlarm();
    }
  }
  async live() {
    if (!this.controller || !this.marker || this.now() >= this.marker.expiresAt) { await this.stop(); throw expired(); }
  }
  async publishStatus(value) {
    if (!ownObject(value) || typeof value.authorized !== 'boolean' || value.loginMethod !== 'qnh_browser'
      || value.status !== (value.authorized ? 'ready' : 'login') || !Number.isFinite(value.expiresAt)) throw unavailable();
    if (value.authorized) {
      if (typeof value.tenantId !== 'string' || !TENANT.test(value.tenantId)) { await this.stop(); throw unavailable(); }
      if (this.boundTenantId && value.tenantId !== this.boundTenantId) { await this.stop(); throw expired(); }
      this.boundTenantId = value.tenantId;
    } else if (this.boundTenantId) { await this.stop(); throw expired(); }
    this.marker.expiresAt = Math.min(this.marker.absoluteExpiresAt, value.expiresAt);
    await this.storage.put('session', this.marker);
    await this.storage.setAlarm(this.marker.expiresAt);
    return { authorized: value.authorized, loginMethod: 'qnh_browser', status: value.status,
      expiresAt: this.marker.expiresAt, viewport: { width: QNH_BROWSER_LIMITS.width, height: QNH_BROWSER_LIMITS.height },
      ...(value.authorized ? { tenantId: this.boundTenantId } : {}) };
  }
  async start(ipHash) {
    if (this.controller) { await this.live(); return this.publishStatus(this.controller.publicStatus()); }
    // A cold/evicted object intentionally rejects the previous cookie; the public router can issue a fresh one.
    if (this.retired || this.marker) { await this.stop(); throw expired(); }
    const factory = this.browserFactory || createCloudflareQnhBrowserFactory(this.env.BROWSER, {
      perTenant: this.env.QNH_TENANT_MODE === 'per_tenant',
      expectedTenantId: this.env.QNH_EXPECTED_TENANT_ID,
      probeSku: this.env.QNH_AUTH_PROBE_SKU,
      allowedDomains: (this.env.QNH_BROWSER_ALLOWED_DOMAINS || '').split(',').map(value => value.trim()).filter(Boolean),
      confirmProductAccess: this.confirmProductAccess,
    });
    this.retired = true;
    await this.storage.put('retired', true);
    this.controller = new ManagedQnhPhoneSession({ browserFactory: factory, now: this.now,
      reserveBrowser: async ({ maximumMs }) => {
        const leaseId = createQnhPhoneCookie(this.crypto).token;
        const grant = await this.budget('/reserve', { leaseId, ipHash, maximumMs });
        if (grant.reserved !== true || !Number.isFinite(grant.expiresAt)
          || grant.expiresAt <= this.now() || grant.expiresAt > this.now() + QNH_PHONE_DEMO_LIMITS.reservationMs) throw unavailable();
        this.marker = { leaseId, absoluteExpiresAt: grant.expiresAt,
          expiresAt: Math.min(grant.expiresAt, this.now() + QNH_BROWSER_LIMITS.loginMs) };
        await this.storage.put('session', this.marker);
        await this.storage.setAlarm(this.marker.expiresAt);
        return { release: async () => { await this.budget('/release', { leaseId }); } };
      },
    });
    try { return this.publishStatus(await this.controller.start()); }
    catch (error) { await this.stop(); throw error; }
  }
  fetch(request) {
    return this.serial(async () => {
      try {
        const path = internalPath(request, PHONE_INTERNAL, ['/start', '/frame', '/input', '/verify', '/cancel', '/status', '/lookup']);
        const body = await readJson(request, path === '/input' ? undefined : path === '/start' ? ['ipHash'] : path === '/lookup' ? ['sku'] : []);
        if (path === '/cancel') { await this.stop(); return json({ authorized: false, loginMethod: 'qnh_browser', status: 'expired' }); }
        if (path === '/start') {
          if (!(TOKEN.test(body.ipHash || '') || body.ipHash === 'unknown')) throw invalid();
          return json(await this.start(body.ipHash));
        }
        await this.live();
        if (path === '/frame') {
          const frame = await this.controller.frame();
          await this.live();
          return new Response(frame, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
        }
        if (path === '/input') return json(await this.controller.input(normalizeQnhViewerInput(body)));
        if (path === '/lookup') {
          if (this.controller.publicStatus().authorized === true) await this.publishStatus(this.controller.publicStatus());
          const result = await this.controller.lookup(normalizeSku(body.sku));
          await this.live();
          await this.publishStatus(this.controller.publicStatus());
          return json(result);
        }
        const result = await this.controller.status();
        await this.live();
        return json(await this.publishStatus(result));
      } catch (error) {
        if (error instanceof QnhBrowserError && error.status >= 500) await this.stop();
        return errorResponse(error);
      }
    });
  }
  alarm() { return this.serial(async () => { await this.stop(); }); }
}
