export const QNH_PRODUCTS_URL = 'https://qnh.meituan.com/home.html#/unifiedGoods/tenant/spu-list';
export const SESSION_MS = 5 * 60 * 1000;
const SESSION_KEY = 'active';
const BUDGET_KEY = 'dailyAttempt';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER = /^[0-9a-f]{64}$/;

function reply(body, status = 200) {
  return Response.json(body, { status, headers: {
    'Cache-Control': 'no-store, private', 'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  } });
}

export function allowedDomains(value) {
  const domains = new Set(['qnh.meituan.com', 'img.meituan.net']);
  if (value !== undefined && value !== '') {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid host configuration');
    for (const entry of value.split(',')) {
      const domain = entry.trim();
      if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:meituan\.com|meituan\.net|sankuai\.com|sankuai\.net|dianping\.com)$/.test(domain)) {
        throw new Error('Invalid host configuration');
      }
      domains.add(domain);
    }
  }
  if (domains.size > 50) throw new Error('Too many hosts');
  return [...domains];
}

export function validLiveView(value) {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://live.browser.run' && url.pathname === '/ui/view'
      && url.searchParams.get('mode') === 'tab' && !!url.searchParams.get('wss')
      && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

// Returns only a handful of booleans and a row count. Never read credentials,
// cookies, localStorage, application internals, network bodies, or full HTML.
export const CATALOG_PROBE = `(() => {
  const visible = element => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const correctRoute = location.origin === 'https://qnh.meituan.com'
    && location.pathname === '/home.html'
    && location.hash.split('?')[0] === '#/unifiedGoods/tenant/spu-list';
  const tableHeaders = Array.from(document.querySelectorAll('thead th,[role="columnheader"]'))
    .filter(visible).map(element => element.innerText.trim());
  const mainHeading = !!document.body && /商品主档/.test(document.body.innerText);
  const productHeader = tableHeaders.some(text => /商品名称|商品信息|SPU名称|商品主档/.test(text));
  const spuRows = Array.from(document.querySelectorAll('tbody tr,[role="row"]'))
    .filter(visible).filter(row => /SPU[：:]\\s*\\d{6,64}(?!\\d)/i.test(row.innerText)).length;
  const loginForm = Array.from(document.querySelectorAll('input[type="password"]')).some(visible);
  return { correctRoute, mainHeading, productHeader, spuRows, loginForm };
})()`;

export function classifyProbe(value) {
  if (!value || typeof value !== 'object') return 'login_unverified';
  if (value.loginForm === true) return 'needs_login';
  if (value.correctRoute === true && value.mainHeading === true && value.productHeader === true
    && Number.isSafeInteger(value.spuRows) && value.spuRows > 0 && value.spuRows < 5000) return 'catalog_ready';
  return 'login_unverified';
}

function cdpCall(socket, method, params, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const id = 1;
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onClose);
      error ? reject(error) : resolve(value);
    };
    const onMessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id !== id) return;
      if (message.error || message.result?.exceptionDetails) finish(new Error('Browser probe failed'));
      else finish(null, message.result?.result?.value);
    };
    const onClose = () => finish(new Error('Browser probe disconnected'));
    const timer = setTimeout(() => finish(new Error('Browser probe timed out')), timeoutMs);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onClose);
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch { finish(new Error('Browser probe unavailable')); }
  });
}

async function visibleCatalogProbe(browser, sessionId, targetId) {
  const connection = await browser.connectSession(sessionId, { targetId });
  const response = await connection.webSocket.fetch('https://browser-binding.invalid', {
    headers: { Upgrade: 'websocket' },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error('No browser connection');
  socket.accept();
  try {
    return await cdpCall(socket, 'Runtime.evaluate', {
      expression: CATALOG_PROBE, returnByValue: true, awaitPromise: false,
    });
  } finally {
    // Closing this CDP connection must not close the browser during human login.
    socket.close();
  }
}

export class QnhConnectorSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.queue = Promise.resolve();
  }

  // Serialize all operations, including alarm, across external browser awaits.
  serial(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  fetch(request) {
    return this.serial(() => this.handle(request));
  }

  async handle(request) {
    const owner = request.headers.get('X-Connector-Owner');
    if (!OWNER.test(owner || '')) return reply({ code: 'ACCESS_REQUIRED' }, 403);
    const path = new URL(request.url).pathname;
    const method = { '/session/start': 'POST', '/session/status': 'GET', '/session/live-view': 'POST', '/session/stop': 'POST' }[path];
    if (!method || request.method !== method || request.body !== null) return reply({ code: 'INVALID_REQUEST' }, 400);
    let active = await this.state.storage.get(SESSION_KEY);
    if (active && active.owner !== owner) return reply({ code: 'SESSION_OWNED_BY_OTHER_ADMIN' }, 403);
    if (active && (Date.now() >= active.expiresAt || active.phase === 'closing')) {
      if (!await this.close(active)) return reply({ code: 'STOP_PENDING', status: 'stopping' }, 502);
      active = null;
    }

    if (path === '/session/start') {
      if (active) return reply(this.publicState(active));
      return this.start(owner);
    }
    if (path === '/session/stop') {
      if (active && !await this.close(active)) return reply({ code: 'STOP_PENDING', status: 'stopping' }, 502);
      return reply({ status: 'stopped' });
    }
    if (!active) return reply({ status: 'stopped' });
    if (!active.sessionId || !active.targetId) return reply(this.publicState(active));

    try {
      const session = await this.env.BROWSER.getSession(active.sessionId);
      if (!session) {
        await this.clearActive();
        return reply({ status: 'stopped' });
      }
      if (path === '/session/live-view') {
        const liveView = await this.env.BROWSER.getLiveView(active.sessionId, {
          targetId: active.targetId, mode: 'tab', expiresInMs: 60000,
        });
        if (!validLiveView(liveView?.devtoolsFrontendUrl)) throw new Error('Unexpected browser view');
        if (Date.now() >= active.expiresAt) {
          await this.close(active);
          return reply({ status: 'stopped' });
        }
        // This is the sole endpoint returning a Live View capability to its owner.
        return reply({ ...this.publicState(active), liveViewUrl: liveView.devtoolsFrontendUrl });
      }
      const result = await visibleCatalogProbe(this.env.BROWSER, active.sessionId, active.targetId);
      if (Date.now() >= active.expiresAt) {
        await this.close(active);
        return reply({ status: 'stopped' });
      }
      const status = classifyProbe(result);
      return reply({ ...this.publicState(active), status });
    } catch {
      return reply({ ...this.publicState(active), status: 'login_unverified', code: 'BROWSER_CHECK_UNAVAILABLE' }, 502);
    }
  }

  publicState(active) {
    return { status: 'login_unverified', expiresAt: new Date(active.expiresAt).toISOString() };
  }

  async start(owner) {
    const now = Date.now();
    const utcDay = new Date(now).toISOString().slice(0, 10);
    const budget = await this.state.storage.get(BUDGET_KEY);
    if (budget?.utcDay === utcDay) return reply({ code: 'DAILY_TEST_USED', message: '今天的连接测试已使用，请下个 UTC 日再试。' }, 429);
    let domains;
    try { domains = allowedDomains(this.env.QNH_ALLOWED_HOSTS); }
    catch { return reply({ code: 'SETUP_REQUIRED' }, 503); }
    const active = { owner, sessionId: null, targetId: null, startedAt: now, expiresAt: now + SESSION_MS, phase: 'starting' };
    // Reserve before calling the browser API; a failed attempt is deliberately not refunded.
    await this.state.storage.put({
      [BUDGET_KEY]: { utcDay, attemptedAt: now }, [SESSION_KEY]: active,
    });
    await this.state.storage.setAlarm(active.expiresAt);
    try {
      const session = await this.env.BROWSER.acquire({
        keepAlive: 60000, recording: false, guardrails: { allowedDomains: domains },
      });
      if (!UUID.test(session?.sessionId || '')) throw new Error('Invalid browser session');
      active.sessionId = session.sessionId;
      await this.state.storage.put(SESSION_KEY, active);
      if (Date.now() >= active.expiresAt) throw new Error('Expired browser session');
      const target = await this.env.BROWSER.devtools.newTarget(active.sessionId, QNH_PRODUCTS_URL);
      if (typeof target?.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(target.id)) throw new Error('Invalid page target');
      active.targetId = target.id;
      active.phase = 'open';
      await this.state.storage.put(SESSION_KEY, active);
      if (Date.now() >= active.expiresAt) throw new Error('Expired browser session');
      return reply(this.publicState(active));
    } catch {
      await this.close(active);
      return reply({ code: 'BROWSER_START_FAILED', status: 'login_unverified', message: '远程浏览器未能启动，未验证牵牛花登录。' }, 502);
    }
  }

  async clearActive() {
    await this.state.storage.delete(SESSION_KEY);
    await this.state.storage.deleteAlarm();
  }

  async close(active) {
    if (active.sessionId) {
      try {
        if (await this.env.BROWSER.getSession(active.sessionId)) {
          await this.env.BROWSER.closeSession(active.sessionId);
        }
        // closeSession may return "closing"; do not claim shutdown until absent.
        if (await this.env.BROWSER.getSession(active.sessionId)) throw new Error('Close not confirmed');
      }
      catch {
        await this.state.storage.put(SESSION_KEY, { ...active, phase: 'closing' });
        await this.state.storage.setAlarm(Date.now() + 15000);
        return false;
      }
    }
    await this.clearActive();
    return true;
  }

  alarm() {
    return this.serial(async () => {
      const active = await this.state.storage.get(SESSION_KEY);
      if (!active) return;
      if (active.phase !== 'closing' && Date.now() < active.expiresAt) {
        await this.state.storage.setAlarm(active.expiresAt);
        return;
      }
      await this.close(active);
    });
  }
}
