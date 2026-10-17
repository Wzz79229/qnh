const VIEWPORT = Object.freeze({ width: 1280, height: 900 });
const LIMITS = Object.freeze({ loginMs: 180_000, frameBytes: 2_000_000, textLength: 128, dragPoints: 32, inputs: 600 });
const KEYS = new Set(['Backspace', 'Delete', 'Tab', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);
const INPUT_PATH = '/api/qnh/login/input';
const controlCharacters = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const ERROR_MESSAGES = Object.freeze({
  QNH_BROWSER_PROVIDER_LIMIT: '云端浏览器服务额度或频率受限，请管理员检查 Cloudflare 用量。',
  QNH_BROWSER_BUSY: '当前登录窗口较多，请稍候重试。',
  QNH_BROWSER_START_RATE: '登录启动过于频繁，请稍候关闭此窗口后重新登录。',
  QNH_BROWSER_ORIGIN_DENIED: '登录来源校验失败，请从鲜期主地址重新打开程序。',
  QNH_BROWSER_NOT_CONFIGURED: '手机登录服务尚未完成配置，请联系管理员。',
  QNH_BROWSER_UNAVAILABLE: '牵牛花连接暂时不可用，请关闭此窗口后重试。',
  QNH_BROWSER_SESSION_EXPIRED: '牵牛花登录会话已结束，请关闭此窗口后重新登录。',
  QNH_BROWSER_LOGIN_REQUIRED: '请关闭此窗口后重新登录牵牛花。',
  QNH_BROWSER_INPUT_FROZEN: '正在确认登录，请稍候再操作。',
  QNH_BROWSER_FRAME_RATE: '登录画面刷新较快，请稍候。',
  QNH_BROWSER_INPUT_RATE: '操作较快，请稍候再输入。',
  INVALID_QNH_BROWSER_INPUT: '当前登录操作无效，请重新操作。',
});
const FATAL_CODES = new Set(['QNH_BROWSER_PROVIDER_LIMIT', 'QNH_BROWSER_BUSY', 'QNH_BROWSER_START_RATE', 'QNH_BROWSER_ORIGIN_DENIED', 'QNH_BROWSER_NOT_CONFIGURED', 'QNH_BROWSER_UNAVAILABLE']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));

/** Coordinates always refer to the fixed server viewport, including when the phone zooms the image. */
export function qnhViewerPoint(clientX, clientY, rect, clamp = false) {
  if (![clientX, clientY, rect?.left, rect?.top, rect?.width, rect?.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  const x = (clientX - rect.left) * VIEWPORT.width / rect.width;
  const y = (clientY - rect.top) * VIEWPORT.height / rect.height;
  if (!clamp && (x < 0 || y < 0 || x >= VIEWPORT.width || y >= VIEWPORT.height)) return null;
  return { x: Math.min(VIEWPORT.width - 1, Math.max(0, Math.floor(x))), y: Math.min(VIEWPORT.height - 1, Math.max(0, Math.floor(y))) };
}

function validPoint(value) {
  return exactKeys(value, ['x', 'y']) && Number.isInteger(value.x) && Number.isInteger(value.y)
    && value.x >= 0 && value.x < VIEWPORT.width && value.y >= 0 && value.y < VIEWPORT.height;
}

/** Defense in depth only: the server independently validates every operation. */
export function normalizeQnhViewerInput(value) {
  if (!object(value)) return null;
  if (value.type === 'click' && exactKeys(value, ['type', 'x', 'y']) && validPoint({ x: value.x, y: value.y })) return { ...value };
  if (value.type === 'text' && exactKeys(value, ['type', 'text']) && typeof value.text === 'string'
    && value.text.length > 0 && value.text.length <= LIMITS.textLength && !controlCharacters.test(value.text)) return { ...value };
  if (value.type === 'key' && exactKeys(value, ['type', 'key']) && KEYS.has(value.key)) return { ...value };
  if (value.type === 'scroll' && exactKeys(value, ['type', 'x', 'y', 'deltaY']) && validPoint({ x: value.x, y: value.y })
    && Number.isFinite(value.deltaY) && Math.abs(value.deltaY) <= VIEWPORT.height) return { ...value, deltaY: Math.round(value.deltaY) };
  if (value.type === 'drag' && exactKeys(value, ['type', 'points']) && Array.isArray(value.points)
    && value.points.length >= 2 && value.points.length <= LIMITS.dragPoints && value.points.every(validPoint)) return { type: 'drag', points: value.points.map(point => ({ ...point })) };
  return null;
}

const CSS = `
#qnh-login-viewer{position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;box-sizing:border-box;width:100%;max-width:none;height:100dvh;max-height:none;margin:0;padding:0;border:0;background:#f6f8f6;color:#172a26;font:14px/1.5 system-ui,sans-serif;overflow:hidden}
#qnh-login-viewer *{box-sizing:border-box}#qnh-login-viewer [hidden]{display:none!important}#qnh-login-viewer::backdrop{background:#13272088}
#qnh-login-viewer header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid #dce5df;background:white}
#qnh-login-viewer h2{margin:0;font-size:19px}#qnh-login-viewer p{margin:0}#qnh-login-viewer .qnh-viewer-help{padding:9px 16px;font-size:12px;color:#52665d}
#qnh-login-viewer button{min-height:40px;border:1px solid #c8d9ce;border-radius:9px;padding:7px 12px;background:#fff;color:#203e30;font:inherit;cursor:pointer}
#qnh-login-viewer button:disabled{opacity:.5;cursor:wait}#qnh-login-viewer .qnh-viewer-primary{background:#236446;color:#fff;border-color:#236446}
#qnh-login-viewer .qnh-viewer-screen{flex:1;min-height:120px;overflow:auto;background:#e8eeea;overscroll-behavior:contain;position:relative}
#qnh-login-viewer img{display:block;width:100%;height:auto;min-height:1px;touch-action:none;user-select:none;-webkit-user-drag:none;background:#fff}
#qnh-login-viewer .qnh-viewer-screen[data-error="true"]{display:grid;place-items:center;padding:24px;text-align:center;background:#f6f8f6}#qnh-login-viewer .qnh-viewer-error{max-width:340px;font-size:16px;line-height:1.9;color:#52665d}
#qnh-login-viewer .qnh-viewer-screen[data-zoom="true"] img{width:1280px;max-width:none}
#qnh-login-viewer .qnh-viewer-toolbar{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px;background:#fff;border-top:1px solid #dce5df}
#qnh-login-viewer form{display:flex;gap:8px;align-items:center;padding:0 12px 9px;background:#fff}
#qnh-login-viewer input{flex:1;min-width:0;min-height:43px;border:1px solid #b8ccc0;border-radius:9px;padding:9px 11px;font:16px system-ui,sans-serif}
#qnh-login-viewer .qnh-viewer-status{padding:5px 16px 10px;font-size:12px;min-height:30px;background:#fff;color:#52665d}
@media(min-width:900px){#qnh-login-viewer{inset:3vh auto auto 50%;transform:translateX(-50%);width:min(1280px,96vw);height:94dvh;border-radius:16px;box-shadow:0 12px 60px #14281f44}#qnh-login-viewer .qnh-viewer-screen{min-height:180px}}
`;

/**
 * The login page remains inside the app. Only images and narrow user-input messages cross the boundary.
 * No provider URL, browser identifier, websocket capability, password storage, or page-script API exists here.
 * Test-only dependencies make cancellation and timing behavior reproducible without a live account.
 */
export function openQnhLoginViewer({ onAuthorized = () => {}, onClose = () => {} } = {}, dependencies = {}) {
  const document = dependencies.document || globalThis.document;
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const timers = dependencies.timers || globalThis;
  const urlAPI = dependencies.URL || globalThis.URL;
  const now = dependencies.now || (() => Date.now());
  const AbortControllerImpl = dependencies.AbortController || globalThis.AbortController;
  if (!document?.body || typeof fetchImpl !== 'function') throw new Error('无法打开牵牛花登录。');
  const create = (tag, text, attributes = {}) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  };
  const dialog = create('dialog', '', { id: 'qnh-login-viewer', 'aria-labelledby': 'qnh-viewer-title', 'aria-describedby': 'qnh-viewer-help' });
  const style = create('style', CSS);
  const header = create('header');
  const title = create('h2', '登录牵牛花', { id: 'qnh-viewer-title' });
  const exit = create('button', '关闭', { type: 'button', 'aria-label': '关闭牵牛花登录' });
  header.append(title, exit);
  const help = create('p', '在下面的牵牛花页面登录，登录成功后自动进入保质期管理。先点页面中的输入框，再在下方输入并发送。验证码和滑块请亲自完成。', { id: 'qnh-viewer-help', class: 'qnh-viewer-help' });
  const screen = create('div', '', { class: 'qnh-viewer-screen', 'data-zoom': 'false' });
  const image = create('img', '', { alt: '牵牛花官方登录页面，点击或拖动进行操作', draggable: 'false', tabindex: '0' });
  screen.append(image);
  const toolbar = create('div', '', { class: 'qnh-viewer-toolbar', 'aria-label': '登录页面操作' });
  const zoom = create('button', '放大页面', { type: 'button' });
  const previous = create('button', '下一栏', { type: 'button' });
  const remove = create('button', '退格', { type: 'button' });
  const enter = create('button', '回车', { type: 'button' });
  const up = create('button', '↑ 滚动', { type: 'button', 'aria-label': '向上滚动牵牛花页面' });
  const down = create('button', '↓ 滚动', { type: 'button', 'aria-label': '向下滚动牵牛花页面' });
  toolbar.append(zoom, previous, remove, enter, up, down);
  const form = create('form', '', { autocomplete: 'off' });
  const text = create('input', '', { type: 'password', placeholder: '输入账号、密码或验证码', 'aria-label': '发送到已选中的牵牛花输入框', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: LIMITS.textLength });
  const send = create('button', '发送输入', { type: 'submit', class: 'qnh-viewer-primary' });
  form.append(text, send);
  const status = create('p', '正在打开牵牛花登录…', { class: 'qnh-viewer-status', role: 'status', 'aria-live': 'polite' });
  dialog.append(style, header, help, screen, toolbar, form, status);
  const controls = [previous, remove, enter, up, down, text, send];
  let closed = false, halted = false, cancellationSent = false, started = false, busy = true, authorized = false, currentFrame = null, timer = null, expiryTimer = null;
  let deadline = now() + LIMITS.loginMs, lastVerify = now(), inputCount = 0, activePointer = null, gesture = [];
  const requests = new Set(), listeners = [];
  const listen = (node, name, listener, options) => { node.addEventListener(name, listener, options); listeners.push(() => node.removeEventListener(name, listener, options)); };
  const setBusy = value => { busy = value; for (const control of controls) control.disabled = value || !started || closed || halted; };
  setBusy(true);
  const safelyNotify = callback => { try { Promise.resolve(callback()).catch(() => {}); } catch { /* A caller failure must not revive a closed viewer. */ } };
  const revokeFrame = () => { if (currentFrame) { urlAPI.revokeObjectURL(currentFrame); currentFrame = null; } image.removeAttribute('src'); };
  const cancelSession = () => {
    if (cancellationSent) return;
    cancellationSent = true;
    // Fixed same-origin endpoint. The cancellation carries no password, browser ID, or client auth claim.
    try {
      Promise.resolve(fetchImpl('/api/qnh/login/cancel', { method: 'POST', credentials: 'include', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true })).catch(() => {});
    } catch { /* A synchronous transport failure must not interrupt local cleanup. */ }
  };

  function finish({ cancel = true, notify = false, message } = {}) {
    if (closed) return;
    closed = true;
    timers.clearTimeout(timer); timers.clearTimeout(expiryTimer);
    for (const request of requests) request.abort();
    requests.clear(); text.value = ''; gesture = []; activePointer = null;
    for (const removeListener of listeners) removeListener();
    revokeFrame();
    if (dialog.open && typeof dialog.close === 'function') dialog.close();
    dialog.remove();
    if (cancel) cancelSession();
    if (notify) safelyNotify(() => onClose({ reason: message || 'closed' }));
  }

  function expire() { finish({ notify: true, message: 'expired' }); }
  function haltWithMessage(message) {
    if (closed || halted) return;
    halted = true; started = false;
    timers.clearTimeout(timer); timers.clearTimeout(expiryTimer);
    for (const request of requests) request.abort();
    requests.clear(); text.value = ''; activePointer = null; gesture = [];
    revokeFrame(); setBusy(false); cancelSession();
    // Keep the dialog open: deleting it immediately on an initial 401/410 looked like an unresponsive login button.
    status.textContent = message;
    image.hidden = true; help.hidden = true; toolbar.hidden = true; form.hidden = true; status.hidden = true;
    screen.setAttribute('data-error', 'true');
    screen.append(create('p', message, { class: 'qnh-viewer-error', role: 'alert' }));
  }
  const showExpired = () => haltWithMessage(ERROR_MESSAGES.QNH_BROWSER_SESSION_EXPIRED);
  function applyStatus(value) {
    // A body read may finish after its fetch was aborted or its DOM was removed.
    if (closed || halted) return true;
    if (!object(value) || value.loginMethod !== 'qnh_browser' || !object(value.viewport)
      || value.viewport.width !== VIEWPORT.width || value.viewport.height !== VIEWPORT.height
      || !Number.isFinite(value.expiresAt) || value.expiresAt <= now()) throw new Error('invalid-status');
    if (value.authorized === true && value.status === 'ready') {
      authorized = true;
      finish({ cancel: false });
      safelyNotify(onAuthorized);
      return true;
    }
    if (value.authorized !== false || value.status !== 'login') throw new Error('invalid-status');
    deadline = Math.min(deadline, value.expiresAt, now() + LIMITS.loginMs);
    timers.clearTimeout(expiryTimer);
    expiryTimer = timers.setTimeout(expire, Math.max(0, deadline - now()));
    return false;
  }

  async function request(path, { method = 'POST', body } = {}, consume = response => response) {
    if (closed || halted) throw new Error('closed');
    const controller = new AbortControllerImpl();
    requests.add(controller);
    const timeout = timers.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetchImpl(path, { method, credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal,
        ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) } : {}) });
      if (closed) throw new Error('closed');
      if (!response.ok) {
        const error = new Error('request-failed');
        error.expired = response.status === 401 || response.status === 410;
        error.code = await safeErrorCode(response);
        // Fixed operation names and public codes only; never log input, response text or session identifiers.
        const phase = path === '/api/qnh/login/start' ? 'start' : path === '/api/qnh/login/frame' ? 'frame' : path === '/api/qnh/login/verify' ? 'verify' : 'input';
        console.warn('QNH_LOGIN_REQUEST_FAILED', phase, response.status, error.code || 'UNKNOWN');
        const retry = response.headers?.get('Retry-After');
        if (/^\d{1,5}$/u.test(retry || '') && Number(retry) > 0 && Number(retry) <= 86_400) error.retryAfter = Number(retry);
        throw error;
      }
      return await consume(response);
    } finally { timers.clearTimeout(timeout); requests.delete(controller); }
  }
  async function safeErrorCode(response) {
    // Read at most 4 KiB and extract only a fixed code. Provider text is never shown or logged.
    const reader = response.body?.getReader?.();
    if (!reader) return undefined;
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) { await reader.cancel(); return undefined; }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      return object(value) && typeof value.code === 'string' && Object.hasOwn(ERROR_MESSAGES, value.code) ? value.code : undefined;
    } catch { return undefined; }
    finally { reader.releaseLock(); }
  }
  async function json(path, body) {
    return request(path, { body }, async response => {
      const content = await response.text();
      if (content.length > 4096) throw new Error('invalid-status');
      return JSON.parse(content);
    });
  }
  function failed(error, starting = false) {
    if (closed || halted) return;
    gesture = []; activePointer = null;
    if (error?.expired) { showExpired(); return; }
    if (now() >= deadline) { expire(); return; }
    let message = ERROR_MESSAGES[error?.code];
    if (error?.code === 'QNH_BROWSER_START_RATE' && error.retryAfter) message = `登录启动过于频繁，请等待${error.retryAfter}秒，关闭此窗口后重新登录。`;
    if (starting || FATAL_CODES.has(error?.code)) {
      haltWithMessage(message || '暂时无法打开牵牛花登录，请关闭此窗口后重试。');
      return;
    }
    // Never reflect an upstream response, account name, stack, URL or configuration detail.
    status.textContent = message || '连接暂时中断，请稍候。若持续无法连接，请关闭后重新登录。';
  }
  async function frame() {
    const blob = await request('/api/qnh/login/frame', { method: 'GET' }, async response => {
      if (!/^image\/jpeg(?:\s*;|$)/iu.test(response.headers.get('Content-Type') || '')) throw new Error('invalid-frame');
      const length = response.headers.get('Content-Length');
      if (length && (!/^\d+$/u.test(length) || Number(length) > LIMITS.frameBytes)) throw new Error('invalid-frame');
      return response.blob();
    });
    if (closed) return;
    if (blob.size < 4 || blob.size > LIMITS.frameBytes) throw new Error('invalid-frame');
    const newFrame = urlAPI.createObjectURL(blob), oldFrame = currentFrame;
    currentFrame = newFrame; image.src = newFrame;
    if (oldFrame) urlAPI.revokeObjectURL(oldFrame);
  }
  async function check() {
    status.textContent = '正在确认牵牛花登录状态与所属商家…';
    activePointer = null; gesture = [];
    lastVerify = now();
    if (applyStatus(await json('/api/qnh/login/verify'))) return;
    status.textContent = '请在上方完成牵牛花登录，登录成功后会自动进入保质期管理。';
  }
  async function run(operation) {
    if (closed || halted || busy || !started || document.hidden) return false;
    if (now() >= deadline) { expire(); return false; }
    setBusy(true);
    try { await operation(); return true; } catch (error) { failed(error); return false; }
    finally { if (!closed) setBusy(false); }
  }
  function schedule(delay = 1000) {
    timers.clearTimeout(timer);
    if (!closed && !halted) timer = timers.setTimeout(tick, delay);
  }
  async function tick() {
    if (closed || halted) return;
    if (now() >= deadline) { expire(); return; }
    if (!document.hidden && !busy && !activePointer) {
      await run(async () => {
        if (now() - lastVerify >= 5000) await check();
        if (!closed) await frame();
      });
    }
    schedule();
  }
  async function input(value) {
    const normalized = normalizeQnhViewerInput(value);
    if (!normalized || closed || busy || !started || document.hidden) return false;
    if (++inputCount > LIMITS.inputs) { expire(); return false; }
    return run(async () => {
      await json(INPUT_PATH, normalized);
      if (!closed) status.textContent = '已发送操作。请继续完成牵牛花登录。';
    });
  }
  const point = (event, clamp = false) => qnhViewerPoint(event.clientX, event.clientY, image.getBoundingClientRect(), clamp);
  listen(exit, 'click', () => finish({ notify: true }));
  listen(dialog, 'cancel', event => { event.preventDefault(); finish({ notify: true }); });
  listen(dialog, 'close', () => { if (!closed) finish({ notify: true }); });
  listen(zoom, 'click', () => { const magnified = screen.getAttribute('data-zoom') !== 'true'; screen.setAttribute('data-zoom', String(magnified)); zoom.textContent = magnified ? '适应屏幕' : '放大页面'; });
  listen(previous, 'click', () => input({ type: 'key', key: 'Tab' }));
  listen(remove, 'click', () => input({ type: 'key', key: 'Backspace' }));
  listen(enter, 'click', () => input({ type: 'key', key: 'Enter' }));
  listen(up, 'click', () => input({ type: 'scroll', x: 640, y: 450, deltaY: -450 }));
  listen(down, 'click', () => input({ type: 'scroll', x: 640, y: 450, deltaY: 450 }));
  listen(form, 'submit', event => {
    event.preventDefault();
    if (busy || !started || closed || document.hidden) return;
    const value = text.value;
    text.value = '';
    if (!normalizeQnhViewerInput({ type: 'text', text: value })) { status.textContent = '请输入不超过128个字符的账号、密码或验证码。'; return; }
    input({ type: 'text', text: value });
  });
  listen(image, 'keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !KEYS.has(event.key)) return;
    event.preventDefault(); input({ type: 'key', key: event.key });
  });
  listen(image, 'pointerdown', event => {
    if (closed || busy || !started || document.hidden || activePointer !== null || !currentFrame
      || (event.button !== undefined && event.button !== 0)) return;
    const position = point(event);
    if (!position) return;
    event.preventDefault(); activePointer = event.pointerId; gesture = [position];
    image.setPointerCapture?.(event.pointerId);
  });
  listen(image, 'pointermove', event => {
    if (activePointer !== event.pointerId || busy || closed) return;
    event.preventDefault();
    const position = point(event, true), previousPoint = gesture.at(-1);
    if (!position || (previousPoint && position.x === previousPoint.x && position.y === previousPoint.y)) return;
    // Preserve the first point and most recent movement while keeping the strict server bound.
    if (gesture.length >= LIMITS.dragPoints) gesture.splice(1, 1);
    gesture.push(position);
  });
  listen(image, 'pointerup', event => {
    if (activePointer !== event.pointerId) return;
    event.preventDefault();
    const position = point(event, true), points = gesture;
    activePointer = null; gesture = [];
    image.releasePointerCapture?.(event.pointerId);
    if (!position || !points.length || busy || closed) return;
    if (points.length === 1 && Math.hypot(position.x - points[0].x, position.y - points[0].y) < 4) input({ type: 'click', ...points[0] });
    else {
      if (points.length >= LIMITS.dragPoints) points.splice(1, 1);
      points.push(position); input({ type: 'drag', points });
    }
  });
  listen(image, 'pointercancel', () => { activePointer = null; gesture = []; });
  listen(image, 'wheel', event => {
    const position = point(event);
    if (!position) return;
    event.preventDefault();
    input({ type: 'scroll', ...position, deltaY: Math.max(-VIEWPORT.height, Math.min(VIEWPORT.height, event.deltaY)) });
  }, { passive: false });
  listen(document, 'visibilitychange', () => {
    text.value = ''; activePointer = null; gesture = [];
    if (!document.hidden && !closed) schedule(0);
  });
  document.body.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  expiryTimer = timers.setTimeout(expire, LIMITS.loginMs);
  (async () => {
    try {
      if (applyStatus(await json('/api/qnh/login/start'))) return;
      if (closed) return;
      started = true;
      status.textContent = '请在上方完成牵牛花登录，登录成功后会自动进入保质期管理。';
      await frame();
    } catch (error) { failed(error, true); }
    finally { if (!closed) { setBusy(false); schedule(); } }
  })();
  return Object.freeze({ close: () => finish(), get closed() { return closed; }, get authorized() { return authorized; } });
}
