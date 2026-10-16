import { GitHubStore, GitHubError, ConflictError } from '../dist/github.mjs';
import { sanitizeState } from '../dist/core.mjs';
import { CatalogStore, CatalogStoreError } from './catalog-store.mjs';

// There is deliberately no client-supplied GitHub owner, repository, branch, or URL.
const TARGET = Object.freeze({ owner: 'Wzz79229', repo: 'bzq', branch: 'main', path: 'data/shelf-life.json' });
const PAGES_ORIGIN = 'https://wzz79229.github.io';
const API_ROOT = 'https://api.github.com/repos/Wzz79229/bzq';
const COOKIE = '__Host-fresh-period-session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const MAX_PHOTO_BYTES = 400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

class ApiError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    Object.assign(this, { status, code, headers });
  }
}

function configuration(env) {
  if (!env || typeof env.GITHUB_TOKEN !== 'string' || !env.GITHUB_TOKEN.trim()
    || /[\s\x00-\x1f\x7f]/.test(env.GITHUB_TOKEN.trim()) || typeof env.TEAM_PASSWORD !== 'string'
    || env.TEAM_PASSWORD.length < 12 || env.TEAM_PASSWORD.length > 512 || typeof env.SESSION_SECRET !== 'string'
    || env.SESSION_SECRET.length < 32 || env.SESSION_SECRET === env.TEAM_PASSWORD
    || env.ALLOWED_ORIGIN !== PAGES_ORIGIN) {
    throw new ApiError(503, 'SETUP_REQUIRED', '团队数据服务尚未完成管理员配置，请联系管理员。');
  }
  return env;
}

function corsHeaders(request) {
  const headers = new Headers({
    'Cache-Control': 'private, no-store', 'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.headers.get('Origin') === PAGES_ORIGIN) {
    headers.set('Access-Control-Allow-Origin', PAGES_ORIGIN);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return headers;
}

function checkOrigin(request, mutation) {
  const ownOrigin = new URL(request.url).origin;
  const origin = request.headers.get('Origin');
  const trusted = origin === PAGES_ORIGIN || (origin === ownOrigin && ownOrigin.startsWith('https://'));
  if ((origin && !trusted) || (mutation && !trusted)
    || (!origin && ['cross-site', 'same-site'].includes(request.headers.get('Sec-Fetch-Site')))) {
    throw new ApiError(403, 'ORIGIN_DENIED', '请求来源无效，请从团队 App 打开。');
  }
}

function json(request, value, status = 200, additional = {}) {
  const headers = corsHeaders(request);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  for (const [key, value] of Object.entries(additional)) headers.set(key, value);
  return new Response(JSON.stringify(value), { status, headers });
}

async function readJSON(request, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    throw new ApiError(415, 'JSON_REQUIRED', '请求必须使用 JSON 格式。');
  }
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容过大，请减少照片或记录后重试。');
  if (!request.body) throw new ApiError(400, 'INVALID_JSON', '请求内容不能为空。');
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容过大，请减少照片或记录后重试。');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ApiError(400, 'INVALID_JSON', 'JSON 请求格式无效。'); }
}

function exactKeys(value, allowed) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ApiError(400, 'INVALID_FIELDS', '请求中包含不支持的字段。');
}

function base64url(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function unbase64url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid encoding');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
  if (base64url(bytes) !== value) throw new Error('noncanonical encoding');
  return bytes;
}

function cookie(value, expires = false) {
  // Partitioned helps browsers that support CHIPS. Other browsers may still block cross-site cookies.
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${expires ? 0 : SESSION_SECONDS}${expires ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : ''}`;
}

function photoRefs(data) {
  const refs = new Map();
  if (!Array.isArray(data?.records) || data.records.length > 5_000) throw new ApiError(400, 'INVALID_DATA', '商品批次数据格式无效或记录过多。');
  for (const record of data.records) {
    if (record?.photoRefs === undefined) continue;
    if (!Array.isArray(record.photoRefs) || record.photoRefs.length > 3) throw new ApiError(400, 'INVALID_PHOTOS', '每个商品批次最多保存 3 张照片。');
    const ids = new Set();
    for (const ref of record.photoRefs) {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref) || typeof ref.id !== 'string' || !UUID.test(ref.id)
        || ref.path !== `photos/${ref.id}.jpg` || Object.keys(ref).some(key => !['id', 'path'].includes(key)) || ids.has(ref.id)) {
        throw new ApiError(400, 'INVALID_PHOTOS', '照片引用无效，请重新上传照片。');
      }
      ids.add(ref.id);
      refs.set(ref.id, ref.path);
    }
  }
  return refs;
}

function cleanState(data) {
  photoRefs(data);
  try { return sanitizeState(data); }
  catch { throw new ApiError(400, 'INVALID_DATA', '商品批次数据格式无效，请检查日期、数量和照片信息。'); }
}

function jpegFromBase64(content) {
  const compact = typeof content === 'string' ? content.replace(/[\r\n]/g, '') : '';
  if (!compact || compact.length > 4 * Math.ceil(MAX_PHOTO_BYTES / 3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new ApiError(400, 'INVALID_PHOTO', '照片必须是压缩后的 JPEG，且不超过 400 KB。');
  }
  let bytes;
  try { bytes = Uint8Array.from(atob(compact), char => char.charCodeAt(0)); }
  catch { throw new ApiError(400, 'INVALID_PHOTO', '照片编码无效，请重新拍摄或选择照片。'); }
  if (bytes.length < 4 || bytes.length > MAX_PHOTO_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[2] !== 0xff || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new ApiError(400, 'INVALID_PHOTO', '照片必须是有效 JPEG，且不超过 400 KB。');
  }
  return { bytes, base64: compact };
}

function gitHubStatus(response, payload, writing) {
  const status = response.status;
  if (writing && (status === 409 || status === 422)) throw new ApiError(409, 'CONFLICT', '云端文件已变化或分支规则阻止保存，请保留草稿并拉取最新数据。');
  if (status === 403 || status === 429) {
    const limited = status === 429 || response.headers?.get('x-ratelimit-remaining') === '0'
      || response.headers?.get('retry-after') || /rate limit|abuse/i.test(typeof payload?.message === 'string' ? payload.message : '');
    throw new ApiError(limited ? 429 : 502, limited ? 'RATE_LIMITED' : 'GITHUB_FORBIDDEN', limited
      ? 'GitHub 请求次数暂时受限，请稍后重试。' : '数据服务的 GitHub 授权不足，请联系管理员检查仓库权限。');
  }
  throw new ApiError(502, status === 401 ? 'GITHUB_UNAUTHORIZED' : 'GITHUB_ERROR', '数据服务无法访问 GitHub，请联系管理员检查授权与仓库设置。');
}

export function createWorker({ fetchImpl = globalThis.fetch, now = () => Date.now(), cryptoImpl = globalThis.crypto } = {}) {
  const failures = new Map(); // Best-effort per-isolate throttling; not a global security boundary.

  async function hmacKey(secret) {
    return cryptoImpl.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  }

  async function authorized(request, env) {
    try {
      const candidates = (request.headers.get('Cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${COOKIE}=`));
      if (candidates.length !== 1) return false;
      const value = candidates[0].slice(COOKIE.length + 1);
      if (value.length > 512) return false;
      const pieces = value.split('.');
      if (pieces.length !== 2) return false;
      const signature = unbase64url(pieces[1]);
      if (signature.length !== 32 || !await cryptoImpl.subtle.verify('HMAC', await hmacKey(env.SESSION_SECRET), signature, encoder.encode(pieces[0]))) return false;
      const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(unbase64url(pieces[0])));
      const seconds = Math.floor(now() / 1000);
      return payload.v === 1 && Number.isSafeInteger(payload.iat) && Number.isSafeInteger(payload.exp)
        && payload.iat <= seconds + 60 && payload.exp > seconds && payload.exp - payload.iat === SESSION_SECONDS
        && /^[A-Za-z0-9_-]{22}$/.test(payload.nonce);
    } catch { return false; }
  }

  async function makeSession(secret) {
    const seconds = Math.floor(now() / 1000);
    const nonce = base64url(cryptoImpl.getRandomValues(new Uint8Array(16)));
    const payload = base64url(encoder.encode(JSON.stringify({ v: 1, iat: seconds, exp: seconds + SESSION_SECONDS, nonce })));
    const signature = await cryptoImpl.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
    return `${payload}.${base64url(new Uint8Array(signature))}`;
  }

  async function passwordMatches(input, expected) {
    const [left, right] = await Promise.all([input, expected].map(value => cryptoImpl.subtle.digest('SHA-256', encoder.encode(value))));
    const a = new Uint8Array(left), b = new Uint8Array(right);
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
    return difference === 0;
  }

  async function github(env, path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    try {
      const task = (async () => {
        const response = await fetchImpl(`${API_ROOT}${path}`, {
          method, headers: {
            Accept: 'application/vnd.github.object+json', Authorization: `Bearer ${env.GITHUB_TOKEN.trim()}`,
            'User-Agent': 'qnh-shelf-life-team-backend',
            'X-GitHub-Api-Version': '2026-03-10', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          }, body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error', cache: 'no-store', credentials: 'omit', signal: controller.signal,
        });
        if (response.redirected || response.status >= 300 && response.status < 400
          || response.url && new URL(response.url).origin !== 'https://api.github.com') throw new Error();
        let payload;
        try { payload = await response.json(); } catch { payload = null; }
        return { response, payload };
      })();
      return await Promise.race([task, new Promise((_, reject) => {
        timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new ApiError(504, 'TIMEOUT', '连接 GitHub 超时，请保留草稿并稍后确认云端结果。')); }, 20_000);
      })]);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (timedOut) throw new ApiError(504, 'TIMEOUT', '连接 GitHub 超时，请保留草稿并稍后确认云端结果。');
      throw new ApiError(502, 'GITHUB_NETWORK', '暂时无法连接 GitHub，请保留草稿并稍后重试。');
    } finally { clearTimeout(timer); }
  }

  async function readPhoto(env, id, missingAllowed = false) {
    const result = await github(env, `/contents/photos/${id}.jpg?ref=main`);
    if (result.response.status === 404) {
      if (missingAllowed) return null;
      throw new ApiError(404, 'PHOTO_NOT_FOUND', '未找到照片，请检查是否已完成上传。');
    }
    if (!result.response.ok) gitHubStatus(result.response, result.payload, false);
    const file = result.payload;
    if (file?.type !== 'file' || file.encoding !== 'base64' || file.size > MAX_PHOTO_BYTES || !file.sha) throw new ApiError(502, 'INVALID_STORED_PHOTO', 'GitHub 中的照片文件格式无效，请联系管理员。');
    try { return { ...jpegFromBase64(file.content), sha: file.sha }; }
    catch { throw new ApiError(502, 'INVALID_STORED_PHOTO', 'GitHub 中的照片文件格式无效，请联系管理员。'); }
  }

  function dataStore(env) {
    const serverFetch = (url, options) => fetchImpl(url, {
      ...options, headers: { ...options.headers, 'User-Agent': 'qnh-shelf-life-team-backend' },
    });
    return new GitHubStore({ ...TARGET, token: env.GITHUB_TOKEN, timeoutMs: 20_000 }, serverFetch);
  }

  return {
    async fetch(request, rawEnv = {}) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) {
        return rawEnv.ASSETS?.fetch ? rawEnv.ASSETS.fetch(request) : json(request, { code: 'NOT_FOUND', message: '未找到页面。' }, 404);
      }
      try {
        if (url.protocol !== 'https:') throw new ApiError(400, 'HTTPS_REQUIRED', '团队数据服务必须通过 HTTPS 访问。');
        const mutations = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
        checkOrigin(request, mutations || request.method === 'OPTIONS');
        const env = configuration(rawEnv);
        const methods = new Map([
          ['/api/session', ['GET']], ['/api/login', ['POST']], ['/api/logout', ['POST']],
          ['/api/state', ['GET', 'PUT']], ['/api/photos', ['POST']],
          ['/api/catalog', ['GET']],
        ]);
        const photoMatch = /^\/api\/photos\/([^/]+)$/.exec(url.pathname);
        const catalogPageMatch = /^\/api\/catalog\/pages\/(0|[1-9]\d?)$/.exec(url.pathname);
        const supported = methods.get(url.pathname) || (photoMatch || catalogPageMatch ? ['GET'] : null);
        if (!supported || url.search) throw new ApiError(404, 'NOT_FOUND', '未找到接口。');
        if (request.method === 'OPTIONS') {
          if (!supported.includes(request.headers.get('Access-Control-Request-Method'))
            || (request.headers.get('Access-Control-Request-Headers') || '').split(',').some(header => header.trim() && header.trim().toLowerCase() !== 'content-type')) {
            throw new ApiError(403, 'CORS_DENIED', '不支持此跨域请求。');
          }
          const headers = corsHeaders(request);
          headers.set('Access-Control-Allow-Methods', supported.join(', '));
          headers.set('Access-Control-Allow-Headers', 'Content-Type');
          headers.set('Access-Control-Max-Age', '600');
          return new Response(null, { status: 204, headers });
        }
        if (!supported.includes(request.method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', '不支持此请求方式。', { Allow: supported.join(', ') });
        const active = await authorized(request, env);
        if (url.pathname === '/api/session') return json(request, { configured: true, authorized: active });
        if (url.pathname === '/api/login') {
          const input = await readJSON(request, 2_048);
          exactKeys(input, ['password']);
          if (typeof input.password !== 'string' || input.password.length > 512) throw new ApiError(400, 'INVALID_PASSWORD', '请输入团队访问密码。');
          const ip = (request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 128);
          const time = now();
          for (const [key, value] of failures) if (value.until <= time) failures.delete(key);
          const failure = failures.get(ip);
          if (failure?.count >= 5) throw new ApiError(429, 'LOGIN_RATE_LIMIT', '密码尝试次数过多，请稍后再试。', { 'Retry-After': String(Math.ceil((failure.until - time) / 1000)) });
          if (!await passwordMatches(input.password, env.TEAM_PASSWORD)) {
            if (failures.size >= 2_000 && !failure) failures.delete(failures.keys().next().value);
            failures.set(ip, { count: (failure?.count || 0) + 1, until: failure?.until || time + 15 * 60_000 });
            throw new ApiError(401, 'INVALID_PASSWORD', '团队访问密码不正确。');
          }
          failures.delete(ip);
          return json(request, { configured: true, authorized: true }, 200, { 'Set-Cookie': cookie(await makeSession(env.SESSION_SECRET)) });
        }
        if (url.pathname === '/api/logout') return json(request, { configured: true, authorized: false }, 200, { 'Set-Cookie': cookie('', true) });
        if (!active) throw new ApiError(401, 'AUTH_REQUIRED', '请先输入团队访问密码。');
        if (url.pathname === '/api/catalog' || catalogPageMatch) {
          const catalog = new CatalogStore({ token: env.GITHUB_TOKEN }, fetchImpl, cryptoImpl);
          return json(request, catalogPageMatch ? await catalog.page(Number(catalogPageMatch[1])) : await catalog.read());
        }
        if (photoMatch) {
          const id = photoMatch[1];
          if (!UUID.test(id)) throw new ApiError(400, 'INVALID_PHOTO_ID', '照片编号无效。');
          const photo = await readPhoto(env, id);
          const headers = corsHeaders(request);
          headers.set('Content-Type', 'image/jpeg');
          headers.set('Content-Security-Policy', "default-src 'none'");
          return new Response(photo.bytes, { status: 200, headers });
        }
        if (url.pathname === '/api/photos') {
          const input = await readJSON(request, 540_000);
          exactKeys(input, ['id', 'imageDataUrl']);
          if (typeof input.id !== 'string' || !UUID.test(input.id)) throw new ApiError(400, 'INVALID_PHOTO_ID', '照片编号无效。');
          if (typeof input.imageDataUrl !== 'string' || !input.imageDataUrl.startsWith('data:image/jpeg;base64,')) throw new ApiError(400, 'INVALID_PHOTO', '请上传 JPEG 格式的照片。');
          const image = jpegFromBase64(input.imageDataUrl.slice('data:image/jpeg;base64,'.length));
          const existing = await readPhoto(env, input.id, true);
          if (existing) {
            if (existing.base64 !== image.base64) throw new ApiError(409, 'PHOTO_CONFLICT', '这个照片编号已被其他图片占用，请重新选择照片。');
            return json(request, { id: input.id, path: `photos/${input.id}.jpg` });
          }
          const result = await github(env, `/contents/photos/${input.id}.jpg`, { method: 'PUT', body: {
            message: '添加商品保质期照片', branch: 'main', content: image.base64,
          } });
          if (!result.response.ok) {
            // A concurrent identical upload is a safe, idempotent success.
            if ([409, 422].includes(result.response.status)) {
              const raced = await readPhoto(env, input.id, true);
              if (raced?.base64 === image.base64) return json(request, { id: input.id, path: `photos/${input.id}.jpg` });
            }
            gitHubStatus(result.response, result.payload, true);
          }
          if (!result.payload?.content?.sha) throw new ApiError(502, 'SAVE_UNCONFIRMED', '无法确认照片上传结果，请保留草稿并重试。');
          return json(request, { id: input.id, path: `photos/${input.id}.jpg` }, 201);
        }
        const store = dataStore(env);
        if (request.method === 'GET') {
          const snapshot = await store.read();
          return json(request, { data: snapshot.data === null ? null : cleanState(snapshot.data), sha: snapshot.sha });
        }
        const input = await readJSON(request, 1_020_000);
        exactKeys(input, ['data', 'expectedSha']);
        if (input.expectedSha !== null && (typeof input.expectedSha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.expectedSha))) {
          throw new ApiError(400, 'EXPECTED_SHA_REQUIRED', '请先拉取云端数据版本再保存。');
        }
        const data = cleanState(input.data);
        const current = await store.read();
        if (current.sha !== input.expectedSha) throw new ConflictError();
        const previousRefs = current.data === null ? new Map() : photoRefs(cleanState(current.data));
        const addedRefs = [...photoRefs(data).keys()].filter(id => !previousRefs.has(id));
        if (addedRefs.length > 12) throw new ApiError(400, 'TOO_MANY_NEW_PHOTOS', '一次最多新增 12 张照片，请分批保存。');
        for (const id of addedRefs) {
          if (!await readPhoto(env, id, true)) throw new ApiError(400, 'PHOTO_NOT_UPLOADED', '请先完成所有照片上传，再保存商品批次。');
        }
        return json(request, await store.write(data, input.expectedSha));
      } catch (error) {
        if (error instanceof ApiError) return json(request, { code: error.code, message: error.message }, error.status, error.headers);
        if (error instanceof CatalogStoreError) return json(request, { code: error.code, message: error.message }, error.status);
        if (error instanceof ConflictError) return json(request, { code: 'CONFLICT', message: '其他成员已修改数据，请保留本机草稿，拉取最新数据后再保存。' }, 409);
        if (error instanceof GitHubError) {
          const status = error.code === 'RATE_LIMITED' ? 429 : error.code === 'TIMEOUT' ? 504 : error.code === 'DATA_TOO_LARGE' ? 413 : 502;
          return json(request, { code: error.code, message: error.message }, status);
        }
        // Do not log or reflect thrown network errors, credentials, or provider response bodies.
        return json(request, { code: 'INTERNAL_ERROR', message: '数据服务暂时不可用，请保留草稿并联系管理员。' }, 500);
      }
    },
  };
}

export default createWorker();
