import { createBatchDraft } from '../mobile-validation/batch-domain.mjs';
import { todayISO } from '../dist/core.mjs';
import { safeImageUrl } from '../local-query/extract.mjs';

// Observed in the public official QNH home bundle on 2026-10-18. This is not an open-platform API contract.
const QNH_STATUS = 'https://qnh.meituan.com/api/v1/isLogined';
const PREFIX = '/api/mobile/';
const TENANT = /^[1-9][0-9]{0,19}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const IMAGE = /^([a-f0-9]{64})\.(jpg|png|webp)$/u;
const MAX_IMAGE = 2_000_000;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
class MobileError extends Error { constructor(status, code, message) { super(message); Object.assign(this, { status, code }); } }
const fail = (status, code, message) => new MobileError(status, code, message);
const authRequired = () => fail(401, 'MOBILE_AUTH_REQUIRED', '请重新连接牵牛花云端同步。');
const unavailable = () => fail(503, 'MOBILE_UNAVAILABLE', '云端服务暂时不可用，批次仍保留在手机，请稍后重试。');
const setupRequired = () => fail(503, 'MOBILE_SETUP_REQUIRED', '云端数据库或图片存储尚未配置，批次可先暂存手机。');
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
} }); }
async function boundedText(body, limit) {
  if (!body) throw fail(400, 'INVALID_MOBILE_DATA', '请求内容不能为空。');
  const reader = body.getReader(), chunks = []; let total = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > limit) { await reader.cancel(); throw fail(413, 'MOBILE_BODY_TOO_LARGE', '请求内容过大。'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const value of chunks) { bytes.set(value, offset); offset += value.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
async function readJson(request, allowed, limit = 16000) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get('Content-Type') || '') || request.headers.has('Content-Encoding')) throw fail(415, 'MOBILE_JSON_REQUIRED', '请求格式无效。');
  let value;
  try { value = JSON.parse(await boundedText(request.body, limit)); } catch (error) { if (error instanceof MobileError) throw error; throw fail(400, 'INVALID_MOBILE_DATA', '请求格式无效。'); }
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail(400, 'INVALID_MOBILE_FIELDS', '请求包含不支持的字段。');
  return value;
}
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const idString = value => typeof value === 'string' && TENANT.test(value) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;

export function createMobileCloud({ fetchImpl = globalThis.fetch, cryptoImpl = globalThis.crypto, now = () => Date.now() } = {}) {
  const digest = async value => hex(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', typeof value === 'string' ? new TextEncoder().encode(value) : value)));
  const configured = env => typeof env?.FRESH_DB?.prepare === 'function' && typeof env?.PRODUCT_IMAGES?.put === 'function' && typeof env?.PRODUCT_IMAGES?.get === 'function';
  async function verifyQnh(cookie, expectedTenant) {
    if (typeof cookie !== 'string' || cookie.length < 8 || cookie.length > 8192 || /[^\x20-\x7e]/u.test(cookie)
      || !TENANT.test(expectedTenant || '')) throw authRequired();
    let response, payload;
    try {
      response = await fetchImpl(QNH_STATUS, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Cookie': cookie,
          'Origin': 'https://qnh.meituan.com', 'Referer': 'https://qnh.meituan.com/', 'User-Agent': 'Xianqi-Tenant-Verification/1.0' }, body: '{}' });
      if (response.status !== 200 || !/application\/json/iu.test(response.headers.get('Content-Type') || '')) throw authRequired();
      payload = JSON.parse(await boundedText(response.body, 64000));
    } catch (error) { if (error instanceof MobileError) throw error; throw unavailable(); }
    const identity = payload?.data;
    if (payload?.code !== 0 || !plain(identity) || identity.logined !== true || !idString(identity.accountId)
      || idString(identity.tenantId) !== expectedTenant) throw authRequired();
    return expectedTenant;
  }
  async function authenticate(request, env) {
    const match = /^Bearer ([a-f0-9]{64})$/u.exec(request.headers.get('Authorization') || '');
    if (!match) throw authRequired();
    const row = await env.FRESH_DB.prepare('SELECT tenant_id,expires_at FROM mobile_sessions WHERE token_hash=?').bind(await digest(match[1])).first();
    if (!row || !TENANT.test(row.tenant_id) || row.expires_at <= now()) throw authRequired();
    if (request.headers.get('X-QNH-Tenant') !== row.tenant_id) throw fail(409, 'MOBILE_TENANT_CHANGED', '牵牛花租户已变化，请重新连接后操作。');
    return { tenantId: row.tenant_id, tokenHash: await digest(match[1]) };
  }
  function cleanBatch(body, tenantId) {
    try {
      const value = createBatchDraft({ id: body.id, tenantId, product: body.product,
        dates: { complete: true, productionDate: body.productionDate, shelfLife: body.shelfLife, shelfUnit: body.shelfUnit, expiryDate: body.expiryDate }, quantity: body.quantity },
      { today: todayISO(now()), now: new Date(now()).toISOString() });
      // The server owns tenant, timestamps and sync status, regardless of phone assertions.
      delete value.tenantId; delete value.syncStatus; return value;
    } catch { throw fail(400, 'INVALID_MOBILE_BATCH', '批次日期、商品资料或件数无效，请重新核对。'); }
  }
  async function imageObject(product, tenantId, env) {
    let url;
    try { url = safeImageUrl(product.imageUrl); if (!url) throw Error(); } catch { throw fail(400, 'INVALID_PRODUCT_IMAGE', '商品主图地址无效，请重新查询商品。'); }
    let response, bytes;
    try {
      response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { Accept: 'image/jpeg,image/png,image/webp' } });
      if (response.status !== 200 || Number(response.headers.get('Content-Length')) > MAX_IMAGE) throw Error();
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
        if (size > MAX_IMAGE) { await reader.cancel(); throw Error(); } chunks.push(value); } } finally { reader.releaseLock(); }
      bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    } catch { throw fail(502, 'PRODUCT_IMAGE_UNAVAILABLE', '商品主图未能归档，当前批次仍保留手机，请稍后重试。'); }
    let extension, contentType;
    if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) { extension = 'jpg'; contentType = 'image/jpeg'; }
    else if (bytes.length > 24 && [137,80,78,71,13,10,26,10].every((byte, index) => bytes[index] === byte)) { extension = 'png'; contentType = 'image/png'; }
    else if (bytes.length > 16 && new TextDecoder().decode(bytes.slice(0,4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8,12)) === 'WEBP') { extension = 'webp'; contentType = 'image/webp'; }
    else throw fail(502, 'PRODUCT_IMAGE_UNAVAILABLE', '商品图片格式无法确认，当前批次仍保留手机。');
    if (!response.headers.get('Content-Type')?.toLowerCase().startsWith(contentType)) throw fail(502, 'PRODUCT_IMAGE_UNAVAILABLE', '商品图片类型无法确认。');
    const name = `${await digest(bytes)}.${extension}`, key = `tenants/${tenantId}/product-images/${name}`;
    await env.PRODUCT_IMAGES.put(key, bytes, { httpMetadata: { contentType }, onlyIf: { etagDoesNotMatch: '*' } });
    return { key, imagePath: `${PREFIX}images/${name}` };
  }
  function output(row) { const value = JSON.parse(row.payload); return { ...value, syncStatus: 'cloud', imagePath: `${PREFIX}images/${row.image_key.split('/').at(-1)}` }; }
  return {
    async handle(request, env) {
      const url = new URL(request.url); if (!url.pathname.startsWith(PREFIX)) return null;
      try {
        if (url.protocol !== 'https:' || url.search) throw fail(400, 'INVALID_MOBILE_URL', '请求地址无效。');
        const origin = request.headers.get('Origin');
        if (origin && origin !== url.origin && origin !== 'https://wzz79229.github.io') throw fail(403, 'MOBILE_ORIGIN_DENIED', '请求来源无效。');
        if (request.method === 'GET' && url.pathname === `${PREFIX}config`) return json({ configured: configured(env), storage: 'cloudflare-d1-r2' });
        if (!configured(env)) throw setupRequired();
        if (request.method === 'POST' && url.pathname === `${PREFIX}sessions`) {
          const body = await readJson(request, ['tenantId', 'qnhCookie']);
          const bucket = await digest(`${Math.floor(now() / 60000)}:${request.headers.get('CF-Connecting-IP') || 'unknown'}`);
          const rate = await env.FRESH_DB.prepare('INSERT INTO mobile_auth_rate(bucket,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(bucket, now() + 120000).first();
          if (!rate || rate.attempts > 6) throw fail(429, 'MOBILE_AUTH_RATE', '连接请求较多，请稍候一分钟重试。');
          const tenantId = await verifyQnh(body.qnhCookie, body.tenantId);
          const token = hex(cryptoImpl.getRandomValues(new Uint8Array(32))), expiresAt = now() + 3600000;
          await env.FRESH_DB.prepare('INSERT INTO mobile_sessions(token_hash,tenant_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await digest(token), tenantId, expiresAt, now()).run();
          await env.FRESH_DB.prepare('DELETE FROM mobile_auth_rate WHERE expires_at<?').bind(now()).run();
          await env.FRESH_DB.prepare('DELETE FROM mobile_sessions WHERE expires_at<?').bind(now()).run();
          return json({ token, tenantId, expiresAt });
        }
        const auth = await authenticate(request, env);
        if (request.method === 'DELETE' && url.pathname === `${PREFIX}session`) {
          await env.FRESH_DB.prepare('DELETE FROM mobile_sessions WHERE token_hash=?').bind(auth.tokenHash).run(); return json({ authorized: false });
        }
        if (request.method === 'GET' && url.pathname === `${PREFIX}batches`) {
          const result = await env.FRESH_DB.prepare('SELECT payload,image_key FROM mobile_batches WHERE tenant_id=? ORDER BY created_at DESC,id DESC LIMIT 100').bind(auth.tenantId).all();
          return json({ tenantId: auth.tenantId, batches: result.results.map(output) });
        }
        if (request.method === 'POST' && url.pathname === `${PREFIX}batches`) {
          const body = await readJson(request, ['id', 'product', 'productionDate', 'shelfLife', 'shelfUnit', 'expiryDate', 'quantity']);
          const batch = cleanBatch(body, auth.tenantId);
          let old = await env.FRESH_DB.prepare('SELECT payload,image_key FROM mobile_batches WHERE tenant_id=? AND id=?').bind(auth.tenantId, batch.id).first();
          const comparable = value => { const copy = { ...value }; delete copy.createdAt; return JSON.stringify(copy); };
          if (old) { if (comparable(JSON.parse(old.payload)) !== comparable(batch)) throw fail(409, 'MOBILE_BATCH_CONFLICT', '该批次已存在且内容不同，请保留本机批次后核对。'); return json({ batch: output(old) }); }
          const archived = await imageObject(batch.product, auth.tenantId, env);
          await env.FRESH_DB.prepare('INSERT OR IGNORE INTO mobile_batches(tenant_id,id,sku,payload,image_key,created_at) VALUES(?,?,?,?,?,?)')
            .bind(auth.tenantId, batch.id, batch.product.sku, JSON.stringify(batch), archived.key, batch.createdAt).run();
          old = await env.FRESH_DB.prepare('SELECT payload,image_key FROM mobile_batches WHERE tenant_id=? AND id=?').bind(auth.tenantId, batch.id).first();
          if (!old || comparable(JSON.parse(old.payload)) !== comparable(batch)) throw fail(409, 'MOBILE_BATCH_CONFLICT', '云端批次已变化，请保留本机数据并核对。');
          return json({ batch: output(old) }, 201);
        }
        const imageName = url.pathname.startsWith(`${PREFIX}images/`) ? url.pathname.slice(`${PREFIX}images/`.length) : '';
        if (request.method === 'GET' && IMAGE.test(imageName)) {
          const key = `tenants/${auth.tenantId}/product-images/${imageName}`;
          const referenced = await env.FRESH_DB.prepare('SELECT id FROM mobile_batches WHERE tenant_id=? AND image_key=? LIMIT 1').bind(auth.tenantId, key).first();
          if (!referenced) throw fail(404, 'MOBILE_IMAGE_NOT_FOUND', '商品图片不存在。');
          const object = await env.PRODUCT_IMAGES.get(key); if (!object) throw fail(404, 'MOBILE_IMAGE_NOT_FOUND', '商品图片不存在。');
          return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
            'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
        }
        throw fail(404, 'MOBILE_NOT_FOUND', '请求不存在。');
      } catch (error) { const safe = error instanceof MobileError ? error : unavailable(); return json({ code: safe.code, message: safe.message }, safe.status); }
    },
  };
}
