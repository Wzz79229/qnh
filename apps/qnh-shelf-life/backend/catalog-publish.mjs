import { normalizeCatalog } from '../dist/catalog.mjs';
import { normalizeManifest } from './catalog-store.mjs';

const API = 'https://api.github.com';
const REPOSITORY = 'Wzz79229/bzq';
const REPOSITORY_API = `${API}/repos/${REPOSITORY}`;
const MANIFEST_PATH = 'data/catalog.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const encoder = new TextEncoder();
export const CATALOG_PUBLISH_LIMITS = Object.freeze({
  pageProducts: 500, pageBytes: 900_000, pages: 100,
  manifestBytes: 128 * 1024, requestBytes: 12 * 1024 * 1024, responseBytes: 128 * 1024,
});

// These are application bounds, not advertised GitHub mutation limits. The official
// FileChanges reference specifies unique paths and complete RFC 4648 base64 files,
// but does not publish a numeric file-count or total request-size limit:
// https://docs.github.com/en/graphql/reference/git#filechanges
// createCommitOnBranch commits the tree AND advances the branch with an atomic
// expectedHeadOid condition. Unlike REST update-ref, this is a strict CAS:
// https://docs.github.com/en/graphql/reference/commits#createcommitonbranch
const MUTATION = `mutation PublishCatalog($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    clientMutationId
    commit { oid parents(first: 2) { nodes { oid } } }
    ref { name target { oid } }
  }
}`;

export class CatalogPublishError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'CatalogPublishError';
    Object.assign(this, { status, code });
  }
}
function invalid() { return new CatalogPublishError(400, 'INVALID_CATALOG_SNAPSHOT', '商品快照无效，当前商品库未修改。'); }
function setup() { return new CatalogPublishError(503, 'SETUP_REQUIRED', '商品库同步服务尚未完成管理员配置。'); }
function conflict() { return new CatalogPublishError(409, 'CATALOG_PUBLISH_CONFLICT', '仓库已有新版本，当前同步未写入，请重新读取后再同步。'); }
function provider() { return new CatalogPublishError(502, 'CATALOG_PUBLISH_FAILED', 'GitHub 未接受商品库同步，当前商品库未修改。'); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function usableCrypto(value) { return typeof value?.subtle?.digest === 'function'; }
function base64(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}
async function file(path, text, cryptoImpl) {
  const bytes = encoder.encode(text);
  const prefix = encoder.encode(`blob ${bytes.length}\0`);
  const gitBlob = new Uint8Array(prefix.length + bytes.length);
  gitBlob.set(prefix); gitBlob.set(bytes, prefix.length);
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-1', gitBlob));
  if (digest.length !== 20) throw invalid();
  const sha = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
  return { path, sha, bytes: bytes.length, content: base64(bytes) };
}

/** Prepare fixed-path, immutable pages. There are no network or storage effects. */
export async function prepareCatalogSnapshot(input, { generation } = {}, cryptoImpl = globalThis.crypto) {
  if (!usableCrypto(cryptoImpl)) throw setup();
  let catalog;
  try { catalog = normalizeCatalog(input); } catch { throw invalid(); }
  if (generation === undefined) {
    if (typeof cryptoImpl.randomUUID !== 'function') throw setup();
    generation = cryptoImpl.randomUUID();
  }
  if (typeof generation !== 'string' || !UUID.test(generation)) throw invalid();
  const prefix = `{"schemaVersion":1,"source":${JSON.stringify(catalog.source)},"products":[`;
  const suffix = ']}\n';
  const overhead = encoder.encode(prefix + suffix).length;
  const files = [];
  const pages = [];
  let products = [];
  let byteCount = overhead;
  async function flush() {
    if (!products.length) return;
    if (pages.length >= CATALOG_PUBLISH_LIMITS.pages) throw invalid();
    const index = pages.length;
    const pageFile = await file(`data/catalog/${generation}/${index}.json`, prefix + products.join(',') + suffix, cryptoImpl);
    if (pageFile.bytes !== byteCount || pageFile.bytes > CATALOG_PUBLISH_LIMITS.pageBytes) throw invalid();
    pages.push({ index, count: products.length, path: pageFile.path, sha: pageFile.sha });
    files.push(pageFile);
    products = []; byteCount = overhead;
  }
  for (const product of catalog.products) {
    const serialized = JSON.stringify(product);
    const bytes = encoder.encode(serialized).length;
    if (overhead + bytes > CATALOG_PUBLISH_LIMITS.pageBytes) throw invalid();
    if (products.length >= CATALOG_PUBLISH_LIMITS.pageProducts
        || byteCount + bytes + (products.length ? 1 : 0) > CATALOG_PUBLISH_LIMITS.pageBytes) await flush();
    byteCount += bytes + (products.length ? 1 : 0);
    products.push(serialized);
  }
  await flush();
  const manifest = normalizeManifest({ schemaVersion: 1, source: catalog.source, generation, pages, total: catalog.products.length });
  const manifestFile = await file(MANIFEST_PATH, JSON.stringify(manifest) + '\n', cryptoImpl);
  if (manifestFile.bytes > CATALOG_PUBLISH_LIMITS.manifestBytes) throw invalid();
  files.push(manifestFile);
  return { manifest, files };
}

async function boundedJSON(response) {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > CATALOG_PUBLISH_LIMITS.responseBytes)) throw provider();
  if (!response.body) throw provider();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > CATALOG_PUBLISH_LIMITS.responseBytes) { await reader.cancel(); throw provider(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw provider(); }
}

/** Only the private bzq/main catalog is writable; state and photos are never named. */
export class CatalogPublisher {
  #token;
  #fetch;
  #crypto;
  #timeout;
  constructor({ token, timeoutMs = 20_000 } = {}, fetchImpl = globalThis.fetch, cryptoImpl = globalThis.crypto) {
    if (typeof token !== 'string' || !token.trim() || /[\s\x00-\x1f\x7f]/.test(token.trim())
        || typeof fetchImpl !== 'function' || !usableCrypto(cryptoImpl)
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw setup();
    this.#token = token.trim(); this.#fetch = fetchImpl.bind(globalThis); this.#crypto = cryptoImpl; this.#timeout = timeoutMs;
  }

  async #request(url, body, { allowMissing = false } = {}) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([(async () => {
        const response = await this.#fetch(url, {
          method: body === undefined ? 'GET' : 'POST', headers: {
            Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.#token}`,
            'Content-Type': 'application/json', 'User-Agent': 'qnh-shelf-life-catalog-publisher',
            'X-GitHub-Api-Version': '2026-03-10',
          }, ...(body === undefined ? {} : { body }),
          signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
        });
        if (response.redirected || response.status >= 300 && response.status < 400
            || response.url && new URL(response.url).origin !== API) throw provider();
        if (allowMissing && response.status === 404) return null;
        if (!response.ok) {
          if (response.status >= 500 || response.status === 408) throw provider();
          const error = response.status === 409 ? conflict()
            : response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' || response.headers.get('retry-after')
              ? new CatalogPublishError(429, 'RATE_LIMITED', 'GitHub 请求次数暂时受限，请稍后再同步。')
              : [401, 403].includes(response.status)
                ? new CatalogPublishError(502, 'CATALOG_ACCESS_DENIED', '商品库 GitHub 授权不足，请联系管理员检查私有仓库权限。') : provider();
          // Only a definite HTTP rejection is classified as no commit.
          error.definiteRejection = true;
          throw error;
        }
        return await boundedJSON(response);
      })(), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(provider()); }, this.#timeout);
      })]);
    } finally { clearTimeout(timer); }
  }

  /** Never retries a mutation. An uncertain outcome must be reconciled by reading.
   * clientMutationId labels the response; it is not an idempotency guarantee.
   */
  async publish(input, { expectedHead, generation } = {}) {
    if (expectedHead !== undefined && (typeof expectedHead !== 'string' || !SHA.test(expectedHead))) throw invalid();
    const snapshot = await prepareCatalogSnapshot(input, { generation }, this.#crypto);
    let head;
    try {
      const repo = await this.#request(REPOSITORY_API);
      if (!object(repo) || repo.full_name !== REPOSITORY || repo.private !== true) throw setup();
      const ref = await this.#request(`${REPOSITORY_API}/git/ref/heads/main`);
      if (!object(ref) || ref.ref !== 'refs/heads/main' || ref.object?.type !== 'commit'
          || typeof ref.object.sha !== 'string' || !SHA.test(ref.object.sha)) throw provider();
      head = ref.object.sha;
    } catch (error) {
      if (error instanceof CatalogPublishError) throw error;
      throw provider();
    }
    if (expectedHead !== undefined && expectedHead !== head) throw conflict();
    // A generation is immutable even when a caller supplies its UUID. Read from
    // the pinned head; any concurrent addition will fail the final head CAS.
    try {
      const existing = await this.#request(`${REPOSITORY_API}/contents/data/catalog/${snapshot.manifest.generation}?ref=${head}`, undefined, { allowMissing: true });
      if (existing !== null) throw new CatalogPublishError(409, 'CATALOG_GENERATION_EXISTS', '此商品库版本已存在，请读取结果后使用新的同步版本。');
    } catch (error) {
      if (error instanceof CatalogPublishError) throw error;
      throw provider();
    }
    const body = JSON.stringify({ query: MUTATION, variables: { input: {
      branch: { repositoryNameWithOwner: REPOSITORY, branchName: 'main' },
      expectedHeadOid: head, clientMutationId: snapshot.manifest.generation,
      message: { headline: `Sync QianNiuHua catalog ${snapshot.manifest.generation}` },
      fileChanges: { additions: snapshot.files.map(item => ({ path: item.path, contents: item.content })) },
    } } });
    if (encoder.encode(body).length > CATALOG_PUBLISH_LIMITS.requestBytes) throw invalid();
    const summary = {
      generation: snapshot.manifest.generation, expectedHead: head, total: snapshot.manifest.total,
      pageCount: snapshot.manifest.pages.length, source: snapshot.manifest.source,
    };
    let response;
    try { response = await this.#request(`${API}/graphql`, body); }
    catch (error) {
      if (error instanceof CatalogPublishError && error.definiteRejection) throw error;
      return { status: 'uncertain', code: 'CATALOG_PUBLISH_UNCERTAIN', ...summary };
    }
    const result = response?.data?.createCommitOnBranch;
    const errors = response?.errors;
    if (Array.isArray(errors) && errors.length) {
      // A root resolver rejection is distinct from errors resolving return fields
      // after a successful commit. Unknown/partial errors remain uncertain.
      const rootErrors = result === null && errors.every(error => object(error) && Array.isArray(error.path)
        && error.path.length === 1 && error.path[0] === 'createCommitOnBranch');
      if (rootErrors && errors.every(error => error.type === 'STALE_DATA')) throw conflict();
      if (rootErrors && errors.every(error => ['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND', 'UNPROCESSABLE'].includes(error.type))) throw provider();
      if (rootErrors && errors.every(error => error.type === 'RATE_LIMITED')) {
        throw new CatalogPublishError(429, 'RATE_LIMITED', 'GitHub 请求次数暂时受限，请稍后再同步。');
      }
      return { status: 'uncertain', code: 'CATALOG_PUBLISH_UNCERTAIN', ...summary };
    }
    const parents = result?.commit?.parents?.nodes;
    if (!object(result) || result.clientMutationId !== snapshot.manifest.generation
        || typeof result.commit?.oid !== 'string' || !SHA.test(result.commit.oid)
        || result.commit.oid === head || !Array.isArray(parents) || parents.length !== 1 || parents[0]?.oid !== head
        || result.ref?.name !== 'main' || result.ref.target?.oid !== result.commit.oid) {
      return { status: 'uncertain', code: 'CATALOG_PUBLISH_UNCERTAIN', ...summary };
    }
    return { status: 'published', commitSha: result.commit.oid, ...summary };
  }
}
