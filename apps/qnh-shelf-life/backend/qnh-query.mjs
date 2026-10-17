import { ConflictError, GitHubError } from '../dist/github.mjs';
import { normalizeImageUrl } from '../dist/catalog.mjs';

export const QNH_QUERY_PATH = 'data/qnh-queries.json';
export const QNH_QUERY_LIMITS = Object.freeze({ jobs: 20, ttlMs: 300_000, leaseMs: 60_000, attempts: 3, bytes: 200_000, productBytes: 8_192 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const SKU = /^[A-Za-z0-9._-]{1,64}$/;
const TERMINAL = new Set(['found', 'not_found', 'ambiguous', 'login_required', 'error']);
const STATUSES = new Set(['pending', 'working', ...TERMINAL, 'expired']);
const encoder = new TextEncoder();
const MISSING_IMAGE_MESSAGE = '此 SKU 的商品主图缺失，请在牵牛花核对后重试。';
const MESSAGES = Object.freeze({
  pending: '等待电脑连接并查询牵牛花，请保持本机连接程序运行。',
  working: '电脑正在牵牛花按 SKU 查询，请稍候。',
  found: '已按 SKU 查询到牵牛花商品。',
  not_found: '牵牛花中未找到完全匹配此 SKU 的商品。',
  ambiguous: '牵牛花返回多个匹配项，未自动选择商品。',
  login_required: '电脑上的牵牛花登录已失效，请在电脑浏览器重新登录。',
  error: '电脑未能完成牵牛花查询，请检查牵牛花页面后重试。',
  expired: '查询已超过 5 分钟，请重新查询 SKU，并确认电脑连接程序正在运行。',
});

export class QnhQueryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'QnhQueryError';
    Object.assign(this, { status, code });
  }
}
const failure = (status, code, message) => new QnhQueryError(status, code, message);
const invalid = () => failure(400, 'INVALID_QNH_QUERY', 'SKU 查询请求格式无效。');
const invalidQueue = () => failure(502, 'INVALID_QNH_QUEUE', '云端查询队列格式无效，已停止修改，请联系管理员。');
const conflict = () => failure(409, 'QNH_QUERY_CONFLICT', '查询队列正在被其他请求更新，请稍后重试。');
const leaseError = () => failure(409, 'QNH_QUERY_LEASE_EXPIRED', '查询任务已过期、已完成或已由其他连接领取，结果未写入。');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));

export function normalizeQuerySku(value) {
  if (typeof value !== 'string' || value.length > 128) throw invalid();
  const sku = value.trim();
  if (!SKU.test(sku)) throw invalid();
  return sku;
}

function text(value, maximum, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || /[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw invalid();
  const result = value.trim();
  if (result.length > maximum || required && !result) throw invalid();
  return result;
}

export function normalizeQueryProduct(input, expectedSku) {
  if (!keys(input, ['sku', 'spu', 'name', 'spec', 'category', 'barcodes', 'imageUrl'])) throw invalid();
  const sku = normalizeQuerySku(input.sku);
  if (sku !== expectedSku) throw invalid();
  const spu = normalizeQuerySku(input.spu);
  const name = text(input.name, 200, true);
  const spec = text(input.spec, 120);
  const category = text(input.category, 200);
  const rawBarcodes = input.barcodes ?? [];
  if (!Array.isArray(rawBarcodes) || rawBarcodes.length > 32) throw invalid();
  const barcodes = [...new Set(rawBarcodes.map(value => text(value, 128, true)))];
  let imageUrl;
  try { imageUrl = normalizeImageUrl(input.imageUrl); } catch { throw invalid(); }
  const product = { sku, spu, name, spec, category, barcodes, imageUrl };
  if (encoder.encode(JSON.stringify(product)).length > QNH_QUERY_LIMITS.productBytes) throw invalid();
  return product;
}

function normalizeResult(input, sku) {
  if (!keys(input, ['status', 'product', 'message']) || !TERMINAL.has(input.status)) throw invalid();
  // Provider errors may contain credentials or webpage HTML. Never persist them.
  if (input.message !== undefined && (typeof input.message !== 'string' || input.message.length > 500)) throw invalid();
  if (input.status !== 'found' && input.product !== undefined) throw invalid();
  return {
    status: input.status,
    ...(input.status === 'found' ? { product: normalizeQueryProduct(input.product, sku) } : {}),
    message: input.status === 'error' && input.message === MISSING_IMAGE_MESSAGE ? MISSING_IMAGE_MESSAGE : MESSAGES[input.status],
  };
}

function normalizeQueue(input) {
  if (input === null) return { schemaVersion: 1, jobs: [] };
  if (!keys(input, ['schemaVersion', 'jobs']) || input.schemaVersion !== 1
    || !Array.isArray(input.jobs) || input.jobs.length > QNH_QUERY_LIMITS.jobs
    || encoder.encode(JSON.stringify(input)).length > QNH_QUERY_LIMITS.bytes) throw invalidQueue();
  const seen = new Set();
  const jobs = input.jobs.map(value => {
    try {
      if (!keys(value, ['id', 'sku', 'createdAt', 'expiresAt', 'status', 'lease', 'product', 'message'])
        || !UUID.test(value.id || '') || seen.has(value.id) || !STATUSES.has(value.status)
        || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
        || value.expiresAt !== value.createdAt + QNH_QUERY_LIMITS.ttlMs) throw invalid();
      seen.add(value.id);
      const sku = normalizeQuerySku(value.sku);
      if (sku !== value.sku) throw invalid();
      const result = { id: value.id, sku, createdAt: value.createdAt, expiresAt: value.expiresAt, status: value.status };
      if (value.status === 'working' || TERMINAL.has(value.status)) {
        if (!keys(value.lease, ['tokenHash', 'expiresAt']) || !TOKEN.test(value.lease.tokenHash || '')
          || !Number.isSafeInteger(value.lease.expiresAt) || value.lease.expiresAt <= value.createdAt
          || value.lease.expiresAt > value.expiresAt) throw invalid();
        result.lease = { tokenHash: value.lease.tokenHash, expiresAt: value.lease.expiresAt };
      } else if (value.lease !== undefined) throw invalid();
      if (TERMINAL.has(value.status)) {
        const normalized = normalizeResult({ status: value.status,
          ...(value.product === undefined ? {} : { product: value.product }),
          ...(value.message === undefined ? {} : { message: value.message }) }, sku);
        Object.assign(result, normalized);
      } else if (value.product !== undefined || value.message !== undefined) throw invalid();
      return result;
    } catch { throw invalidQueue(); }
  });
  return { schemaVersion: 1, jobs };
}

function expired(job, time) {
  if (time < job.expiresAt || job.status === 'expired') return job;
  return { id: job.id, sku: job.sku, createdAt: job.createdAt, expiresAt: job.expiresAt, status: 'expired' };
}
function publicJob(job, time) {
  const current = expired(job, time);
  return { id: current.id, sku: current.sku, status: current.status,
    ...(current.product ? { product: current.product } : {}),
    message: current.status === 'error' && current.message === MISSING_IMAGE_MESSAGE ? MISSING_IMAGE_MESSAGE : MESSAGES[current.status] };
}

/** A bounded single-file queue. Only definite optimistic-concurrency conflicts retry. */
export class QnhQueryQueue {
  constructor(store, { now = () => Date.now(), cryptoImpl = globalThis.crypto } = {}) {
    if (typeof store?.read !== 'function' || typeof store?.write !== 'function'
      || typeof now !== 'function' || typeof cryptoImpl?.randomUUID !== 'function'
      || typeof cryptoImpl?.getRandomValues !== 'function' || typeof cryptoImpl?.subtle?.digest !== 'function') throw invalid();
    this.store = store; this.now = now; this.crypto = cryptoImpl;
  }

  async digest(token) {
    const bytes = new Uint8Array(await this.crypto.subtle.digest('SHA-256', encoder.encode(token)));
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  }

  async mutate(operation) {
    for (let attempt = 0; attempt < QNH_QUERY_LIMITS.attempts; attempt++) {
      const snapshot = await this.store.read();
      const queue = normalizeQueue(snapshot.data);
      const outcome = operation(queue, this.now());
      if (!outcome.changed) return outcome.value;
      try {
        await this.store.write(queue, snapshot.sha);
        return outcome.value;
      } catch (error) {
        if (error instanceof ConflictError && error.status === 409) {
          if (attempt + 1 < QNH_QUERY_LIMITS.attempts) continue;
          throw conflict();
        }
        if (error instanceof GitHubError && (['TIMEOUT', 'NETWORK_ERROR', 'SAVE_UNCONFIRMED', 'UNSAFE_REDIRECT'].includes(error.code)
          || error.code === 'HTTP_ERROR' && (error.status >= 500 || error.status === 408))) {
          throw failure(error.code === 'TIMEOUT' ? 504 : 502, 'QNH_QUERY_WRITE_UNCERTAIN', '无法确认查询队列是否已保存，未自动重试。请先检查查询状态再重新操作。');
        }
        throw error;
      }
    }
    throw conflict();
  }

  async enqueue(value) {
    const sku = normalizeQuerySku(value);
    const id = this.crypto.randomUUID();
    if (!UUID.test(id)) throw invalid();
    return this.mutate((queue, time) => {
      const existing = queue.jobs.find(job => job.sku === sku && ['pending', 'working'].includes(job.status) && job.expiresAt > time);
      if (existing) return { changed: false, value: { id: existing.id, status: 'pending' } };
      queue.jobs = queue.jobs.filter(job => job.expiresAt > time && job.status !== 'expired');
      if (queue.jobs.length >= QNH_QUERY_LIMITS.jobs) throw failure(429, 'QNH_QUERY_QUEUE_FULL', '当前 5 分钟内查询已达上限，请等待已有查询过期后再试。');
      queue.jobs.push({ id, sku, createdAt: time, expiresAt: time + QNH_QUERY_LIMITS.ttlMs, status: 'pending' });
      return { changed: true, value: { id, status: 'pending' } };
    });
  }

  async get(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw invalid();
    const snapshot = await this.store.read();
    const job = normalizeQueue(snapshot.data).jobs.find(value => value.id === id);
    if (!job) throw failure(404, 'QNH_QUERY_NOT_FOUND', '查询已过期或不存在，请重新查询 SKU。');
    return publicJob(job, this.now());
  }

  async claim() {
    const leaseToken = Array.from(this.crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');
    const tokenHash = await this.digest(leaseToken);
    return this.mutate((queue, time) => {
      let changed = false;
      queue.jobs = queue.jobs.map(job => {
        const current = expired(job, time);
        changed ||= current !== job;
        return current;
      });
      const job = queue.jobs.find(value => value.status === 'pending'
        || value.status === 'working' && value.lease.expiresAt <= time);
      if (!job) return { changed, value: { job: null } };
      job.status = 'working';
      job.lease = { tokenHash, expiresAt: Math.min(time + QNH_QUERY_LIMITS.leaseMs, job.expiresAt) };
      return { changed: true, value: { job: { id: job.id, sku: job.sku, leaseToken } } };
    });
  }

  async submit(input) {
    if (!keys(input, ['id', 'leaseToken', 'result']) || !UUID.test(input.id || '') || !TOKEN.test(input.leaseToken || '')) throw invalid();
    const tokenHash = await this.digest(input.leaseToken);
    return this.mutate((queue, time) => {
      const job = queue.jobs.find(value => value.id === input.id);
      if (!job || job.expiresAt <= time || job.lease?.tokenHash !== tokenHash) throw leaseError();
      const result = normalizeResult(input.result, job.sku);
      if (TERMINAL.has(job.status)) {
        const previous = { status: job.status, ...(job.product ? { product: job.product } : {}), message: job.message };
        if (JSON.stringify(previous) !== JSON.stringify(result)) throw leaseError();
        return { changed: false, value: publicJob(job, time) };
      }
      if (job.status !== 'working' || job.lease.expiresAt <= time) throw leaseError();
      Object.assign(job, result);
      return { changed: true, value: publicJob(job, time) };
    });
  }
}
