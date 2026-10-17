import { normalizeCatalog } from '../dist/catalog.mjs';

// This reader never accepts a repository, branch, path or URL from the browser.
const ROOT = 'https://api.github.com/repos/Wzz79229/bzq/contents/';
const MANIFEST_PATH = 'data/catalog.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const MANIFEST_MAX_BYTES = 128 * 1024;
const PAGE_MAX_BYTES = 900_000;
const encoder = new TextEncoder();

export class CatalogStoreError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'CatalogStoreError';
    Object.assign(this, { status, code });
  }
}

function invalid() {
  return new CatalogStoreError(502, 'INVALID_CATALOG', '云端商品库格式无效，请联系管理员重新同步。');
}
function changed() {
  return new CatalogStoreError(409, 'CATALOG_CHANGED', '商品库版本已变化，请重新加载完整商品库。');
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sourceOf(source) {
  try { return normalizeCatalog({ schemaVersion: 1, source, products: [] }).source; }
  catch { throw invalid(); }
}

/** A manifest only names immutable files under its own generation. */
export function normalizeManifest(input) {
  if (!object(input) || input.schemaVersion !== 1 || typeof input.generation !== 'string'
      || !UUID.test(input.generation) || !Array.isArray(input.pages) || input.pages.length > 100
      || !Number.isSafeInteger(input.total) || input.total < 0 || input.total > 50_000) throw invalid();
  const source = sourceOf(input.source);
  let total = 0;
  const pages = input.pages.map((page, index) => {
    const path = `data/catalog/${input.generation}/${index}.json`;
    if (!object(page) || page.index !== index || !Number.isSafeInteger(page.count)
        || page.count < 1 || page.count > 500 || page.path !== path
        || typeof page.sha !== 'string' || !SHA.test(page.sha)) throw invalid();
    total += page.count;
    return { index, count: page.count, path, sha: page.sha };
  });
  if (total !== input.total) throw invalid();
  return { schemaVersion: 1, source, generation: input.generation, pages, total };
}

async function boundedJSON(response, limit) {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw invalid();
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw invalid(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
}

function providerError(response) {
  const limited = response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0'
    || Boolean(response.headers.get('retry-after'));
  if (limited) return new CatalogStoreError(429, 'RATE_LIMITED', 'GitHub 请求次数暂时受限，请稍后重试。');
  if ([401, 403].includes(response.status)) {
    return new CatalogStoreError(502, 'CATALOG_ACCESS_DENIED', '商品库的 GitHub 授权不足，请联系管理员检查私有仓库权限。');
  }
  return new CatalogStoreError(502, 'CATALOG_UNAVAILABLE', '暂时无法读取商品库，请稍后重试。');
}

export class CatalogStore {
  #token;
  #fetch;
  #crypto;
  #timeout;
  constructor({ token, timeoutMs = 20_000 } = {}, fetchImpl = globalThis.fetch, cryptoImpl = globalThis.crypto) {
    if (typeof token !== 'string' || !token.trim() || /[\s\x00-\x1f\x7f]/.test(token.trim())
        || typeof fetchImpl !== 'function' || !cryptoImpl?.subtle || !Number.isSafeInteger(timeoutMs)
        || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new CatalogStoreError(503, 'SETUP_REQUIRED', '团队数据服务尚未完成管理员配置，请联系管理员。');
    }
    this.#token = token.trim(); this.#fetch = fetchImpl.bind(globalThis); this.#crypto = cryptoImpl; this.#timeout = timeoutMs;
  }

  async #file(path, byteLimit, expectedSha) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([(async () => {
        const response = await this.#fetch(`${ROOT}${path}?ref=main`, {
          method: 'GET', headers: {
            Accept: 'application/vnd.github.object+json', Authorization: `Bearer ${this.#token}`,
            'User-Agent': 'qnh-shelf-life-team-backend', 'X-GitHub-Api-Version': '2026-03-10',
          }, cache: 'no-store', redirect: 'manual', signal: controller.signal,
        });
        if (response.redirected || response.status >= 300 && response.status < 400
            || response.url && new URL(response.url).origin !== 'https://api.github.com') throw invalid();
        if (response.status === 404) {
          if (path !== MANIFEST_PATH) throw changed();
          throw new CatalogStoreError(404, 'CATALOG_NOT_READY', '商品库尚未同步，请先由管理员同步牵牛花商品和图片。');
        }
        if (!response.ok) throw providerError(response);
        // Contents responses have base64 overhead; both the transport and decoded file are bounded.
        const file = await boundedJSON(response, 4 * Math.ceil(byteLimit / 3) + 65_536);
        if (!object(file) || file.type !== 'file' || file.encoding !== 'base64'
            || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > byteLimit
            || typeof file.sha !== 'string' || !SHA.test(file.sha)
            || file.path !== path || typeof file.content !== 'string') throw invalid();
        if (expectedSha && file.sha !== expectedSha) throw changed();
        const compact = file.content.replace(/[\r\n]/g, '');
        if (!compact || compact.length > 4 * Math.ceil(byteLimit / 3)
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) throw invalid();
        let bytes;
        try { bytes = Uint8Array.from(atob(compact), character => character.charCodeAt(0)); }
        catch { throw invalid(); }
        if (bytes.length !== file.size || bytes.length > byteLimit) throw invalid();
        const prefix = encoder.encode(`blob ${bytes.length}\0`);
        const blob = new Uint8Array(prefix.length + bytes.length);
        blob.set(prefix); blob.set(bytes, prefix.length);
        const digest = new Uint8Array(await this.#crypto.subtle.digest('SHA-1', blob));
        const actualSha = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
        if (actualSha !== file.sha) throw invalid();
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw invalid(); }
      })(), new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new CatalogStoreError(504, 'TIMEOUT', '读取商品库超时，请稍后重试。'));
        }, this.#timeout);
      })]);
    } catch (error) {
      if (error instanceof CatalogStoreError) throw error;
      // Never reflect provider bodies, network exception messages or credentials.
      throw new CatalogStoreError(502, 'CATALOG_NETWORK', '暂时无法连接商品库，请稍后重试。');
    } finally { clearTimeout(timer); }
  }

  async read() { return normalizeManifest(await this.#file(MANIFEST_PATH, MANIFEST_MAX_BYTES)); }

  async page(index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= 100) {
      throw new CatalogStoreError(400, 'INVALID_CATALOG_PAGE', '商品库页码无效。');
    }
    // Re-read the current manifest for every request; there is no business-data cache.
    const manifest = await this.read();
    const descriptor = manifest.pages[index];
    if (!descriptor) throw new CatalogStoreError(404, 'CATALOG_PAGE_NOT_FOUND', '未找到商品库分页，请重新加载商品库。');
    const input = await this.#file(descriptor.path, PAGE_MAX_BYTES, descriptor.sha);
    if (!object(input) || !Array.isArray(input.products) || input.products.length > 500) throw invalid();
    let page;
    try { page = normalizeCatalog(input); } catch { throw invalid(); }
    if (page.products.length !== descriptor.count || JSON.stringify(page.source) !== JSON.stringify(manifest.source)) throw changed();
    // The client must compare generation with the manifest before displaying any pages.
    return { ...page, generation: manifest.generation, index };
  }
}
