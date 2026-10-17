import { QNH_PRODUCT_URL, normalizeSku, readVisibleProductRows, parseScopedCells, resolveExactSku } from '../local-query/extract.mjs';
import { createQnhProductReceipt } from './qnh-product-proof.mjs';

/** Guarded foundation: the HTTP router, global quota and observed tenant reader must be supplied by the server. */
export const QNH_BROWSER_LIMITS = Object.freeze({
  width: 1280, height: 900, loginMs: 180_000, sessionMs: 240_000,
  commandMs: 12_000, frameIntervalMs: 500, inputIntervalMs: 35,
  inputs: 600, textLength: 128, dragPoints: 32, frameBytes: 2_000_000,
});
export const QNH_PHONE_COOKIE = '__Host-qnh-phone';
const QNH_LOGIN_URL = 'https://qnh.meituan.com/';
const PHONE_TOKEN = /^[a-f0-9]{64}$/u;
const TENANT_ID = /^[1-9][0-9]{0,19}$/u;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length
  && Object.keys(value).every(key => expected.includes(key));
const safeKeys = new Set(['Backspace', 'Delete', 'Tab', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);
const keyCodes = Object.freeze({ Backspace: 8, Delete: 46, Tab: 9, Enter: 13, Escape: 27,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35 });

export class QnhBrowserError extends Error {
  constructor(status, code, message) { super(message); this.name = 'QnhBrowserError'; Object.assign(this, { status, code }); }
}
const failure = (status, code, message) => new QnhBrowserError(status, code, message);
const notConfigured = () => failure(503, 'QNH_BROWSER_NOT_CONFIGURED', '牵牛花手机登录连接尚未配置完成。');
const invalidInput = () => failure(400, 'INVALID_QNH_BROWSER_INPUT', '登录操作格式无效。');
const closed = () => failure(401, 'QNH_BROWSER_SESSION_EXPIRED', '牵牛花登录会话已结束，请重新登录。');
const unavailable = () => failure(502, 'QNH_BROWSER_UNAVAILABLE', '牵牛花连接暂时不可用，请重新登录。');
const browserDiagnostic = (phase, code) => console.warn('QNH_BROWSER_DIAGNOSTIC', phase, code);
const CDP_DIAGNOSTIC_METHODS = new Set(['Page.enable', 'Runtime.enable', 'Network.enable', 'Network.setCacheDisabled',
  'Network.setBypassServiceWorker', 'Network.getResponseBody', 'Emulation.setDeviceMetricsOverride', 'Runtime.evaluate',
  'Page.navigate', 'Page.getFrameTree', 'Page.captureScreenshot', 'Input.dispatchMouseEvent', 'Input.insertText', 'Input.dispatchKeyEvent']);
const diagnosticMethod = method => CDP_DIAGNOSTIC_METHODS.has(method) ? method : 'UNKNOWN_CDP_METHOD';
const diagnosticErrorCode = error => error instanceof QnhBrowserError
  && ['QNH_BROWSER_NOT_CONFIGURED', 'QNH_BROWSER_UNAVAILABLE', 'QNH_BROWSER_SESSION_EXPIRED',
    'QNH_BROWSER_DEMO_LIMIT', 'QNH_BROWSER_START_RATE'].includes(error.code)
  ? error.code : 'PROVIDER_FAILURE';

export function createQnhPhoneCookie(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.getRandomValues !== 'function') throw notConfigured();
  const token = Array.from(cryptoImpl.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');
  return { token, cookie: `${QNH_PHONE_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600` };
}

/** Duplicated or malformed cookies cannot select a different phone's Durable Object. */
export function readQnhPhoneCookie(request) {
  const header = request.headers.get('Cookie') || '';
  if (header.length > 4096) return null;
  const matches = header.split(';').map(value => value.trim()).filter(value => value.startsWith(`${QNH_PHONE_COOKIE}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(QNH_PHONE_COOKIE.length + 1);
  return PHONE_TOKEN.test(token) ? token : null;
}

export const clearQnhPhoneCookie = () => `${QNH_PHONE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;

/** This transport is same-origin only; cross-origin Pages clients must use the primary app origin. */
export function requireQnhBrowserOrigin(request, expectedOrigin) {
  let expected;
  try { expected = new URL(expectedOrigin); } catch { throw notConfigured(); }
  if (expected.protocol !== 'https:' || expected.origin !== expectedOrigin) throw notConfigured();
  const url = new URL(request.url);
  if (url.origin !== expectedOrigin
    || request.headers.get('Origin') !== expectedOrigin
    || !['same-origin', null].includes(request.headers.get('Sec-Fetch-Site'))) {
    throw failure(403, 'QNH_BROWSER_ORIGIN_DENIED', '请从保质期程序内重新打开登录。');
  }
}

function point(value) {
  if (!keys(value, ['x', 'y']) || !Number.isFinite(value.x) || !Number.isFinite(value.y)
    || value.x < 0 || value.x >= QNH_BROWSER_LIMITS.width || value.y < 0 || value.y >= QNH_BROWSER_LIMITS.height) throw invalidInput();
  return { x: Math.floor(value.x), y: Math.floor(value.y) };
}

/** No arbitrary CDP, URL, selector, JavaScript, modifier, browser shortcut or target capability is accepted. */
export function normalizeQnhViewerInput(input) {
  if (!object(input) || typeof input.type !== 'string') throw invalidInput();
  if (input.type === 'click' && keys(input, ['type', 'x', 'y'])) return { type: 'click', ...point({ x: input.x, y: input.y }) };
  if (input.type === 'text' && keys(input, ['type', 'text']) && typeof input.text === 'string'
    && input.text.length >= 1 && input.text.length <= QNH_BROWSER_LIMITS.textLength
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(input.text)) return { type: 'text', text: input.text };
  if (input.type === 'key' && keys(input, ['type', 'key']) && safeKeys.has(input.key)) return { type: 'key', key: input.key };
  if (input.type === 'scroll' && keys(input, ['type', 'x', 'y', 'deltaY']) && Number.isFinite(input.deltaY)
    && Math.abs(input.deltaY) <= QNH_BROWSER_LIMITS.height) return { type: 'scroll', ...point({ x: input.x, y: input.y }), deltaY: Math.round(input.deltaY) };
  if (input.type === 'drag' && keys(input, ['type', 'points']) && Array.isArray(input.points)
    && input.points.length >= 2 && input.points.length <= QNH_BROWSER_LIMITS.dragPoints) return { type: 'drag', points: input.points.map(point) };
  throw invalidInput();
}

function validTenantId(value) {
  if (typeof value !== 'string' || !TENANT_ID.test(value)) throw notConfigured();
  return value;
}

/**
 * One in-memory controller per phone DO. Eviction intentionally loses login, rather than persisting QNH credentials.
 * reserveBrowser() must atomically enforce the account-wide quota and return a release callback.
 * All operations are serialized; verification immediately freezes further input and drains accepted input first.
 */
export class ManagedQnhPhoneSession {
  constructor({ browserFactory, reserveBrowser, now = () => Date.now(), diagnostic = browserDiagnostic } = {}) {
    if (typeof browserFactory !== 'function' || typeof reserveBrowser !== 'function' || typeof now !== 'function') throw notConfigured();
    this.browserFactory = browserFactory; this.reserveBrowser = reserveBrowser; this.now = now;
    this.diagnostic = diagnostic;
    this.queue = Promise.resolve(); this.state = 'new'; this.browser = null; this.reservation = null;
    this.createdAt = 0; this.authorizedAt = 0; this.lastFrameAt = -Infinity; this.lastInputAt = -Infinity; this.inputCount = 0;
    this.frozen = false; this.verification = null;
  }

  serial(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  expiresAt() {
    return this.state === 'authorized' ? Math.min(this.createdAt + QNH_BROWSER_LIMITS.sessionMs,
      this.authorizedAt + QNH_BROWSER_LIMITS.sessionMs) : this.createdAt + QNH_BROWSER_LIMITS.loginMs;
  }

  async ensureAlive() {
    if (!this.browser || !['login', 'authorized'].includes(this.state)) throw closed();
    if (this.now() >= this.expiresAt()) { await this.end(); throw closed(); }
  }

  async end() {
    this.frozen = true; this.state = 'closed';
    const browser = this.browser; const reservation = this.reservation;
    this.browser = null; this.reservation = null;
    try { await browser?.close(); } catch { /* No provider errors, DOM, credentials or capabilities are reflected. */ }
    try { await reservation?.release(); } catch { /* Conservative quota implementations may retain the reservation until its absolute expiry. */ }
  }

  start() {
    return this.serial(async () => {
      if (['login', 'authorized'].includes(this.state)) { await this.ensureAlive(); return this.publicStatus(); }
      // Do not auto-recreate after expiry. The router must issue a new random phone cookie / DO.
      if (this.state !== 'new') throw closed();
      this.createdAt = this.now();
      try {
        const reservation = await this.reserveBrowser({ maximumMs: QNH_BROWSER_LIMITS.sessionMs });
        if (!object(reservation) || typeof reservation.release !== 'function') throw notConfigured();
        this.reservation = reservation;
        this.browser = await this.browserFactory();
        for (const method of ['frame', 'input', 'verifyAccess', 'lookup', 'close']) if (typeof this.browser?.[method] !== 'function') throw notConfigured();
        this.state = 'login';
        await this.ensureAlive();
        return this.publicStatus();
      } catch (error) {
        this.diagnostic('MANAGED_START', diagnosticErrorCode(error));
        await this.end();
        if (error instanceof QnhBrowserError) throw error;
        throw unavailable();
      }
    });
  }

  publicStatus() {
    const tenantId = this.state === 'authorized' && typeof this.browser?.tenantId === 'function' ? this.browser.tenantId() : null;
    return { authorized: this.state === 'authorized', loginMethod: 'qnh_browser',
      status: this.state === 'authorized' ? 'ready' : this.state === 'login' ? 'login' : 'expired',
      expiresAt: this.expiresAt(), viewport: { width: QNH_BROWSER_LIMITS.width, height: QNH_BROWSER_LIMITS.height },
      ...(typeof tenantId === 'string' && TENANT_ID.test(tenantId) ? { tenantId } : {}) };
  }

  frame() {
    return this.serial(async () => {
      await this.ensureAlive();
      if (this.state !== 'login' || this.frozen) throw failure(409, 'QNH_BROWSER_INPUT_FROZEN', '正在确认登录，请稍候。');
      if (this.now() - this.lastFrameAt < QNH_BROWSER_LIMITS.frameIntervalMs) throw failure(429, 'QNH_BROWSER_FRAME_RATE', '请稍候再刷新登录画面。');
      this.lastFrameAt = this.now();
      try {
        const frame = await this.browser.frame();
        if (!(frame instanceof Uint8Array) || frame.length < 4 || frame.length > QNH_BROWSER_LIMITS.frameBytes
          || frame[0] !== 0xff || frame[1] !== 0xd8 || frame.at(-2) !== 0xff || frame.at(-1) !== 0xd9) throw unavailable();
        await this.ensureAlive();
        return frame;
      } catch (error) { this.diagnostic('MANAGED_FRAME', diagnosticErrorCode(error)); await this.end(); throw error instanceof QnhBrowserError ? error : unavailable(); }
    });
  }

  input(value) {
    const input = normalizeQnhViewerInput(value);
    if (this.frozen || this.state !== 'login') return Promise.reject(failure(409, 'QNH_BROWSER_INPUT_FROZEN', '正在确认登录，请稍候。'));
    if (++this.inputCount > QNH_BROWSER_LIMITS.inputs || this.now() - this.lastInputAt < QNH_BROWSER_LIMITS.inputIntervalMs) {
      return Promise.reject(failure(429, 'QNH_BROWSER_INPUT_RATE', '登录操作过于频繁，请稍候重试。'));
    }
    this.lastInputAt = this.now();
    // Inputs already accepted before verify() are deliberately drained, even though verify sets frozen immediately.
    return this.serial(async () => {
      await this.ensureAlive();
      if (this.state !== 'login') throw failure(409, 'QNH_BROWSER_INPUT_FROZEN', '正在确认登录，请稍候。');
      try { await this.browser.input(input); await this.ensureAlive(); return { accepted: true }; }
      catch (error) { this.diagnostic('MANAGED_INPUT', diagnosticErrorCode(error)); await this.end(); throw error instanceof QnhBrowserError ? error : unavailable(); }
    });
  }

  verify() {
    if (this.verification) return this.verification;
    this.frozen = true;
    this.verification = this.serial(async () => {
      await this.ensureAlive();
      try {
        const accessible = await this.browser.verifyAccess();
        await this.ensureAlive();
        if (accessible !== true) {
          if (this.state === 'authorized') { await this.end(); throw closed(); }
          this.frozen = false;
          return this.publicStatus();
        }
        if (this.state !== 'authorized') this.authorizedAt = this.now();
        this.state = 'authorized';
        return this.publicStatus();
      } catch (error) { this.diagnostic('MANAGED_VERIFY', diagnosticErrorCode(error)); await this.end(); throw error instanceof QnhBrowserError ? error : unavailable(); }
    }).finally(() => { this.verification = null; });
    return this.verification;
  }

  /** An authenticated cookie alone is insufficient: callers must invoke status before protected data access. */
  status() { return this.verify(); }

  lookup(value) {
    const sku = normalizeSku(value);
    return this.serial(async () => {
      await this.ensureAlive();
      if (this.state !== 'authorized') throw failure(401, 'QNH_BROWSER_LOGIN_REQUIRED', '请先登录牵牛花。');
      try {
        if (await this.browser.verifyAccess() !== true) { await this.end(); throw closed(); }
        const result = await this.browser.lookup(sku);
        // Recheck tenancy and access after the query too; navigation/logout cannot reuse an old authorization.
        if (await this.browser.verifyAccess() !== true) { await this.end(); throw closed(); }
        await this.ensureAlive();
        if (!object(result) || !['found', 'not_found', 'ambiguous', 'error'].includes(result.status)) throw unavailable();
        // Browser-side parsing is not trusted as an output sanitizer.
        if (result.status === 'found') return resolveExactSku({ complete: true, rows: [result.product] }, sku);
        return { status: result.status, message: result.status === 'not_found' ? '牵牛花中没有此 SKU，请核对标签。'
          : result.status === 'ambiguous' ? '牵牛花返回多个不同商品，请核对 SKU。' : '商品资料尚未确认，请重试。' };
      } catch (error) { this.diagnostic('MANAGED_LOOKUP', diagnosticErrorCode(error)); await this.end(); throw error instanceof QnhBrowserError ? error : unavailable(); }
    });
  }

  close() { this.frozen = true; return this.serial(() => this.end()); }
}

/** CDP capabilities remain in the server closure; provider errors are intentionally discarded. */
function createPrivateCdp(socket, diagnostic = browserDiagnostic) {
  let nextId = 0; let ended = false;
  const pending = new Map();
  const listeners = new Map();
  const stop = (reason = 'CLOSED') => {
    ended = true;
    for (const item of pending.values()) {
      diagnostic(diagnosticMethod(item.method), reason);
      clearTimeout(item.timeout); item.reject(unavailable());
    }
    pending.clear();
    listeners.clear();
  };
  socket.addEventListener('close', () => stop('CLOSED'));
  socket.addEventListener('error', () => stop('SOCKET_ERROR'));
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string' || event.data.length > 4_000_000) { stop('MALFORMED_MESSAGE'); socket.close(); return; }
    let message;
    try { message = JSON.parse(event.data); } catch { stop('MALFORMED_MESSAGE'); socket.close(); return; }
    if (typeof message.method === 'string') {
      for (const listener of listeners.get(message.method) || []) {
        try { listener(message.params || {}); } catch { /* Events cannot expose provider diagnostics. */ }
      }
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timeout);
    if (message.error || !object(message.result)) {
      diagnostic(diagnosticMethod(item.method), message.error ? 'PROTOCOL_ERROR' : 'INVALID_RESULT');
      item.reject(unavailable());
    } else {
      if (item.method === 'Runtime.evaluate' && message.result.exceptionDetails) diagnostic('Runtime.evaluate', 'EVALUATION_EXCEPTION');
      item.resolve(message.result);
    }
  });
  return {
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(listener);
      return () => listeners.get(method)?.delete(listener);
    },
    send(method, params = {}) {
      if (ended) { diagnostic(diagnosticMethod(method), 'ALREADY_CLOSED'); return Promise.reject(unavailable()); }
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timeout = setTimeout(() => { pending.delete(id); diagnostic(diagnosticMethod(method), 'TIMEOUT'); reject(unavailable()); }, QNH_BROWSER_LIMITS.commandMs);
        pending.set(id, { resolve, reject, timeout, method });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch { pending.delete(id); clearTimeout(timeout); diagnostic(diagnosticMethod(method), 'SEND_FAILURE'); reject(unavailable()); }
      });
    },
    close() { stop(); try { socket.close(); } catch { /* Already disconnected. */ } },
  };
}

/** Self-contained reads only the observed visible product controls and exact official route. */
function readProductAccess() {
  const url = new URL(location.href);
  const visible = element => element && element.getClientRects().length > 0
    && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden';
  if (url.origin !== 'https://qnh.meituan.com' || !['/', '/home.html'].includes(url.pathname)
    || url.hash.split('?')[0] !== '#/unifiedGoods/tenant/spu-list') return false;
  const fields = Array.from(document.querySelectorAll('.unifiedGoods-ant-form-item-row'))
    .filter(element => /^SKU$/u.test(element.innerText.trim())).flatMap(element => Array.from(element.querySelectorAll('input[type="text"]'))).filter(visible);
  const queries = Array.from(document.querySelectorAll('button')).filter(visible).filter(element => element.innerText.trim() === '查询');
  const headers = Array.from(document.querySelectorAll('table')).filter(visible)
    .flatMap(table => Array.from(table.querySelectorAll('thead th')).map(cell => cell.innerText.trim()));
  return fields.length === 1 && queries.length === 1 && headers.includes('商品信息') && headers.includes('规格信息');
}

/** The official SPA's logged-in shell, not an HTTP status, client assertion, or product-query permission. */
export function readLoggedInQnhShell() {
  const url = new URL(location.href);
  if (url.origin !== 'https://qnh.meituan.com' || !['/', '/home.html'].includes(url.pathname)
    || /^#\/(?:login|logout)(?:\/|\?|$)/iu.test(url.hash)
    || !['interactive', 'complete'].includes(document.readyState)) return false;
  const visible = element => {
    if (!element?.getClientRects().length) return false;
    let current = element;
    while (current?.nodeType === 1) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      current = current.parentElement;
    }
    return true;
  };
  // These layout selectors and ancestry were observed on the real authenticated QNH page.
  // The tenant is also checked independently in the same browser task by readTenantId.
  const layouts = Array.from(document.querySelectorAll('.saas-platform-layout-wrapper')).filter(visible);
  const topBars = Array.from(document.querySelectorAll('.top-nav-base')).filter(visible);
  const mains = Array.from(document.querySelectorAll('.saas-platform-layout-main')).filter(visible);
  const headers = Array.from(document.querySelectorAll('span[class^="SearchLeftTenantId--"]'))
    .filter(element => visible(element) && !element.closest('[contenteditable],input,textarea'));
  return layouts.length === 1 && topBars.length === 1 && mains.length === 1 && headers.length === 1
    && layouts[0].contains(topBars[0]) && layouts[0].contains(mains[0]) && topBars[0].contains(headers[0])
    && /^（租户ID:\s*[1-9][0-9]{0,19}）$/u.test(headers[0].innerText.trim())
    && !Array.from(document.querySelectorAll('input[type="password"]')).some(visible);
}

/** Observed on the real QNH product header, not inferred from a phone-supplied tenant or arbitrary body text. */
export function readObservedQnhTenantId() {
  const nodes = Array.from(document.querySelectorAll('span[class^="SearchLeftTenantId--"]')).filter(element => {
    if (!element.getClientRects().length || element.closest('[contenteditable],input,textarea')) return false;
    let current = element;
    while (current?.nodeType === 1) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      current = current.parentElement;
    }
    return true;
  });
  if (nodes.length !== 1) return null;
  return /^（租户ID:\s*([1-9][0-9]{0,19})）$/u.exec(nodes[0].innerText.trim())?.[1] || null;
}

/** A refresh receipt is required: an unchanged table cannot supply a previous SKU's result. */
async function searchVisibleSku(sku) {
  const visible = element => element && element.getClientRects().length > 0
    && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden';
  const fields = Array.from(document.querySelectorAll('.unifiedGoods-ant-form-item-row'))
    .filter(element => /^SKU$/u.test(element.innerText.trim())).flatMap(element => Array.from(element.querySelectorAll('input[type="text"]'))).filter(visible);
  const buttons = Array.from(document.querySelectorAll('button')).filter(visible).filter(element => element.innerText.trim() === '查询');
  if (fields.length !== 1 || buttons.length !== 1) return false;
  const field = fields[0];
  const roots = [...new Set(Array.from(document.querySelectorAll('table')).filter(visible)
    .map(table => table.closest('.unifiedGoods-ant-spin-nested-loading') || table))];
  if (!roots.length) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, sku);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  if (field.value !== sku) return false;
  return await new Promise(resolve => {
    let finished = false; let quietTimer;
    const loadingClass = /(?:^|\s)\S*(?:spin-spinning|spin-dot(?:-item|-spin)?|anticon-loading|anticon-spin)(?:\s|$)/u;
    const loading = () => roots.some(root => Array.from(root.querySelectorAll('[class]'))
      .some(element => visible(element) && loadingClass.test(element.getAttribute('class') || '')));
    const finish = value => { if (finished) return; finished = true; clearTimeout(timeout); clearTimeout(quietTimer); observer.disconnect(); resolve(value); };
    const observer = new MutationObserver(records => {
      const relevant = records.some(record => {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (record.type === 'attributes') return loadingClass.test(`${record.oldValue || ''} ${target?.getAttribute('class') || ''}`)
          || /(?:^|\s)\S*table-empty(?:\s|$)/u.test(target?.getAttribute('class') || '');
        return target?.closest('tbody') || target?.tagName === 'TABLE'
          || [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches('table,tbody') || node.querySelector('table,tbody')));
      });
      if (!relevant) return;
      clearTimeout(quietTimer);
      if (!loading()) quietTimer = setTimeout(() => finish(field.value === sku && !loading()), 600);
    });
    for (const root of roots) observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    const timeout = setTimeout(() => finish(false), 8_000);
    buttons[0].click();
  });
}

function validateDomains(input) {
  if (!Array.isArray(input) || !input.length || input.length > 30 || !input.includes('qnh.meituan.com')) throw notConfigured();
  // Server configuration can narrow this list, but cannot make the login browser an arbitrary Internet relay.
  for (const domain of input) if (typeof domain !== 'string' || !/^(?:\*\.)?(?:[a-z0-9-]+\.)*(?:meituan\.com|meituan\.net|sankuai\.com|dianping\.com)$/u.test(domain)) throw notConfigured();
  return [...new Set(input)];
}

/**
 * Cloudflare typed binding, no API token and no Live View capability. NOT enabled by default.
 * readTenantId is a self-contained, audited DOM reader of an observed, non-editable official tenant identity.
 * Never implement it from an input field, URL supplied by the phone, client JSON, or an assumed default merchant.
 * Login verifies the observed official logged-in shell and tenant only; it never selects a SKU or queries product JSON.
 * SKU scanning separately navigates to the fixed product route and requires fresh response/visible-row integrity.
 * expectedTenantId remains an optional fixed-tenant compatibility mode; perTenant binds the real observed login tenant.
 */
export function createCloudflareQnhBrowserFactory(binding, { expectedTenantId, readTenantId = readObservedQnhTenantId,
  allowedDomains, perTenant = false, diagnostic = browserDiagnostic } = {}) {
  const tenantId = perTenant === true ? null : validTenantId(expectedTenantId);
  const domains = validateDomains(allowedDomains);
  if (typeof binding?.acquire !== 'function' || typeof binding?.connectSession !== 'function'
    || typeof binding?.closeSession !== 'function' || typeof binding?.devtools?.newTarget !== 'function'
    || typeof readTenantId !== 'function') throw notConfigured();
  return async () => {
    let browserSessionId; let cdp; let phase = 'ACQUIRE';
    try {
      const acquired = await binding.acquire({ keepAlive: 60_000, recording: false, guardrails: { allowedDomains: domains } });
      if (!object(acquired) || typeof acquired.sessionId !== 'string' || !acquired.sessionId || acquired.sessionId.length > 200) throw unavailable();
      browserSessionId = acquired.sessionId;
      phase = 'NEW_TARGET';
      const target = await binding.devtools.newTarget(browserSessionId, 'about:blank');
      if (!object(target) || typeof target.id !== 'string' || !target.id || target.id.length > 200) throw unavailable();
      phase = 'CONNECT_SESSION';
      const connection = await binding.connectSession(browserSessionId, { targetId: target.id });
      phase = 'OPEN_SOCKET';
      const response = await connection.webSocket.fetch('https://browser-binding.invalid', { headers: { Upgrade: 'websocket' } });
      if (!response.webSocket) throw unavailable();
      response.webSocket.accept(); cdp = createPrivateCdp(response.webSocket, diagnostic);
      phase = 'CDP_SETUP';
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Network.enable', { maxTotalBufferSize: 4_000_000, maxResourceBufferSize: 2_000_000 });
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      await cdp.send('Network.setBypassServiceWorker', { bypass: true });
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: QNH_BROWSER_LIMITS.width,
        height: QNH_BROWSER_LIMITS.height, deviceScaleFactor: 1, mobile: false });
      const evaluateExpression = async expression => {
        const result = await cdp.send('Runtime.evaluate', { expression,
          returnByValue: true, awaitPromise: true, userGesture: false, timeout: 10_000 });
        if (result.exceptionDetails || !object(result.result) || !Object.hasOwn(result.result, 'value')) throw unavailable();
        return result.result.value;
      };
      const evaluate = async (fn, argument) => {
        // This function is private to audited server code, never dispatched from a phone request.
        if (typeof fn !== 'function') throw notConfigured();
        return evaluateExpression(`(${fn.toString()})(${JSON.stringify(argument) ?? ''})`);
      };
      await cdp.send('Page.navigate', { url: QNH_LOGIN_URL });
      let ended = false, boundTenantId = null;
      const approvedTenant = value => typeof value === 'string' && TENANT_ID.test(value)
        && (!tenantId || tenantId === value) && (!boundTenantId || boundTenantId === value);
      const productsInPage = async () => {
        const rows = await evaluateExpression(`(${readVisibleProductRows.toString()})(Array.from(document.querySelectorAll('table')))`);
        if (!object(rows) || rows.unscoped || !Array.isArray(rows.cells)) return null;
        try { return rows.cells.map(parseScopedCells); } catch { return null; }
      };
      const freshLookup = async sku => {
        const frame = await cdp.send('Page.getFrameTree');
        const frameId = frame?.frameTree?.frame?.id;
        if (typeof frameId !== 'string' || !frameId || frameId.length > 200) return { status: 'error' };
        const receipt = createQnhProductReceipt(cdp, { frameId, sku });
        try {
          if (await evaluate(searchVisibleSku, sku) !== true) return { status: 'error' };
          const products = await productsInPage();
          if (!products) return { status: 'error' };
          if (products.length === 0) {
            const empty = await evaluate(() => Array.from(document.querySelectorAll('.unifiedGoods-ant-table-empty'))
              .some(element => element.getClientRects().length && (element.innerText || '').includes('暂无内容')));
            return empty === true && await receipt.empty() ? { status: 'not_found' } : { status: 'error' };
          }
          const result = resolveExactSku({ complete: products.length > 0, rows: products }, sku);
          if (result.status !== 'found' || !await receipt.matches(result.product)) return { status: 'error' };
          return result;
        } finally { receipt.close(); }
      };
      const verifyAccess = async () => {
        if (ended) return false;
        // Official origin, visible logged-in shell and tenant are read atomically in each page task.
        const readProof = () => evaluateExpression(`({origin:location.origin,shell:(${readLoggedInQnhShell.toString()})(),tenantId:(${readTenantId.toString()})()})`);
        const before = await readProof();
        if (before?.origin !== 'https://qnh.meituan.com' || before.shell !== true || !approvedTenant(before.tenantId)) return false;
        const after = await readProof();
        const valid = after?.origin === 'https://qnh.meituan.com' && after.shell === true
          && after.tenantId === before.tenantId && approvedTenant(after.tenantId);
        if (valid) boundTenantId = after.tenantId;
        return valid;
      };
      const readProductProof = () => evaluateExpression(`({origin:location.origin,access:(${readProductAccess.toString()})(),tenantId:(${readTenantId.toString()})()})`);
      const productReady = proof => proof?.origin === 'https://qnh.meituan.com' && proof.access === true
        && Boolean(boundTenantId) && proof.tenantId === boundTenantId;
      const enterProductPage = async () => {
        if (productReady(await readProductProof())) return true;
        await cdp.send('Page.navigate', { url: QNH_PRODUCT_URL });
        for (let attempt = 0; attempt < 12; attempt++) {
          if (productReady(await readProductProof())) return true;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        return false;
      };
      return {
        tenantId() { return boundTenantId; },
        async frame() {
          const result = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 65, fromSurface: true, captureBeyondViewport: false });
          if (typeof result.data !== 'string' || result.data.length > Math.ceil(QNH_BROWSER_LIMITS.frameBytes / 3) * 4
            || !/^[A-Za-z0-9+/]+={0,2}$/u.test(result.data)) throw unavailable();
          const raw = atob(result.data);
          return Uint8Array.from(raw, char => char.charCodeAt(0));
        },
        async input(value) {
          const input = normalizeQnhViewerInput(value);
          const mouse = (type, position, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, ...position, ...extra });
          if (input.type === 'text') await cdp.send('Input.insertText', { text: input.text });
          else if (input.type === 'key') {
            const params = { key: input.key, code: input.key, windowsVirtualKeyCode: keyCodes[input.key], nativeVirtualKeyCode: keyCodes[input.key], modifiers: 0 };
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
          } else if (input.type === 'click') {
            const position = { x: input.x, y: input.y };
            await mouse('mousePressed', position, { button: 'left', buttons: 1, clickCount: 1 });
            await mouse('mouseReleased', position, { button: 'left', buttons: 0, clickCount: 1 });
          } else if (input.type === 'scroll') await mouse('mouseWheel', { x: input.x, y: input.y }, { deltaX: 0, deltaY: input.deltaY });
          else if (input.type === 'drag') {
            await mouse('mousePressed', input.points[0], { button: 'left', buttons: 1, clickCount: 1 });
            for (const position of input.points.slice(1)) await mouse('mouseMoved', position, { button: 'left', buttons: 1 });
            await mouse('mouseReleased', input.points.at(-1), { button: 'left', buttons: 0, clickCount: 1 });
          }
        },
        verifyAccess,
        async lookup(value) {
          const sku = normalizeSku(value);
          if (!await verifyAccess()) return { status: 'login_required' };
          if (!await enterProductPage()) return { status: 'error' };
          const result = await freshLookup(sku);
          if (!productReady(await readProductProof())) return { status: 'login_required' };
          return result;
        },
        async close() {
          if (ended) return;
          ended = true; cdp.close();
          await binding.closeSession(browserSessionId);
        },
      };
    } catch {
      diagnostic(phase, 'FACTORY_UNAVAILABLE');
      cdp?.close();
      if (browserSessionId) try { await binding.closeSession(browserSessionId); } catch { /* Safe generic failure only. */ }
      throw unavailable();
    }
  };
}
