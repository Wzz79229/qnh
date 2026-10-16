/** Pure Meituan QianNiuHua catalog validation and explicit product lookup.
 * This module has no network, credentials, tenant defaults or storage side effects.
 */
export const CATALOG_MAX_BYTES = 8 * 1024 * 1024;
export const CATALOG_MAX_PRODUCTS = 50_000;
export const PRODUCT_LIMITS = Object.freeze({
  sku: 64, spu: 64, name: 200, spec: 120, category: 200,
  barcode: 128, barcodes: 32, imageUrl: 2048, bytes: 8 * 1024,
});
const CONTROL = /[\u0000-\u001f\u007f]/u;
const encoder = new TextEncoder();

export class CatalogError extends TypeError {
  constructor(message, code = 'INVALID_CATALOG', path = '') {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
    this.path = path;
  }
}

function fail(message, path, code = 'INVALID_CATALOG') { throw new CatalogError(message, code, path); }
function object(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function text(value, field, label, maximum, required = false) {
  if (value === undefined || value === null) {
    if (required) fail(`${label}不能为空，且必须使用字符串。`, field);
    return '';
  }
  if (typeof value !== 'string') fail(`${label}必须使用字符串，不能将数字转成编号或条码。`, field);
  if (CONTROL.test(value)) fail(`${label}包含控制字符。`, field);
  const normalized = value.trim();
  if (required && !normalized) fail(`${label}不能为空。`, field);
  if (normalized.length > maximum) fail(`${label}超过 ${maximum} 个字符。`, field, 'FIELD_TOO_LONG');
  return normalized;
}
function jsonBytes(value, path = '') {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail('商品库必须是可序列化的 JSON 数据。', path); }
  if (typeof serialized !== 'string') fail('商品库必须是 JSON 对象。', path);
  return encoder.encode(serialized).byteLength;
}

/** Only credential-free, query-free HTTPS Meituan image URLs may be displayed. */
export function normalizeImageUrl(value) {
  const imageUrl = text(value, 'imageUrl', '商品图片地址', PRODUCT_LIMITS.imageUrl);
  if (!imageUrl) return '';
  let url;
  try { url = new URL(imageUrl); } catch { fail('商品图片地址无效。', 'imageUrl', 'UNSAFE_IMAGE_URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'img.meituan.net' || url.port
      || url.username || url.password || /[?#\s\\]/u.test(imageUrl)
      || /^https:\/\/[^/]*@/iu.test(imageUrl)) {
    fail('图片只允许无凭据、无查询参数和片段的 HTTPS img.meituan.net 地址。', 'imageUrl', 'UNSAFE_IMAGE_URL');
  }
  return url.href;
}

export function normalizeProduct(input) {
  if (!object(input)) fail('商品必须是 JSON 对象。', '');
  const sku = text(input.sku, 'sku', 'SKU', PRODUCT_LIMITS.sku, true);
  const spu = text(input.spu, 'spu', 'SPU', PRODUCT_LIMITS.spu, true);
  if (/\s/u.test(sku)) fail('SKU 不能包含空白字符。', 'sku');
  if (/\s/u.test(spu)) fail('SPU 不能包含空白字符。', 'spu');
  const name = text(input.name, 'name', '商品名称', PRODUCT_LIMITS.name, true);
  const spec = text(input.spec, 'spec', '商品规格', PRODUCT_LIMITS.spec);
  const category = text(input.category, 'category', '商品类目', PRODUCT_LIMITS.category);
  const values = input.barcodes ?? [];
  if (!Array.isArray(values)) fail('商品条码必须是字符串数组。', 'barcodes');
  if (values.length > PRODUCT_LIMITS.barcodes) fail(`每个商品最多 ${PRODUCT_LIMITS.barcodes} 个条码。`, 'barcodes', 'TOO_MANY_BARCODES');
  const barcodes = [];
  const seen = new Set();
  values.forEach((value, index) => {
    const barcode = text(value, `barcodes[${index}]`, '商品条码', PRODUCT_LIMITS.barcode, true);
    if (!seen.has(barcode)) { barcodes.push(barcode); seen.add(barcode); }
  });
  const product = { sku, spu, name, spec, barcodes, category, imageUrl: normalizeImageUrl(input.imageUrl) };
  if (jsonBytes(product) > PRODUCT_LIMITS.bytes) fail('单个商品数据超过 8 KiB。', '', 'PRODUCT_TOO_LARGE');
  return product;
}

function syncedTime(value) {
  const input = text(value, 'source.syncedAt', '商品库同步时间', 40, true);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.exec(input);
  const date = new Date(input);
  if (!match || !Number.isFinite(date.getTime())) fail('商品库同步时间必须是含时区的有效 ISO 日期时间。', 'source.syncedAt');
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (year < 1 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1
      || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
    fail('商品库同步时间不是有效日期。', 'source.syncedAt');
  }
  return date.toISOString();
}

/** Normalize whitelisted fields only. Unknown private API metadata is not copied. */
export function normalizeCatalog(input) {
  if (!object(input)) fail('商品库必须是 JSON 对象。', '');
  if (input.schemaVersion !== 1) fail('不支持此商品库版本。', 'schemaVersion', 'UNSUPPORTED_SCHEMA');
  if (!Array.isArray(input.products)) fail('商品库 products 必须是数组。', 'products');
  if (input.products.length > CATALOG_MAX_PRODUCTS) fail('商品库不能超过 50000 个 SKU。', 'products', 'TOO_MANY_PRODUCTS');
  if (jsonBytes(input) > CATALOG_MAX_BYTES) fail('商品库文档超过 8 MiB。', '', 'CATALOG_TOO_LARGE');
  if (!object(input.source) || input.source.platform !== 'meituan-qnh') fail('商品库来源必须是 meituan-qnh。', 'source.platform');
  if (typeof input.source.complete !== 'boolean') fail('商品库来源必须明确标记 complete 为 true 或 false。', 'source.complete');
  const source = {
    platform: 'meituan-qnh',
    syncedAt: syncedTime(input.source.syncedAt),
    scope: text(input.source.scope, 'source.scope', '商品库范围', 200),
    complete: input.source.complete,
  };
  const seen = new Set();
  const products = input.products.map((value, index) => {
    let product;
    try { product = normalizeProduct(value); } catch (error) {
      if (error instanceof CatalogError) error.path = `products[${index}]${error.path ? `.${error.path}` : ''}`;
      throw error;
    }
    if (seen.has(product.sku)) fail(`第 ${index + 1} 条商品的 SKU 重复，请核对来源数据。`, `products[${index}].sku`, 'DUPLICATE_SKU');
    seen.add(product.sku);
    return product;
  });
  const catalog = { schemaVersion: 1, source, products };
  if (jsonBytes(catalog) > CATALOG_MAX_BYTES) fail('规范化后的商品库文档超过 8 MiB。', '', 'CATALOG_TOO_LARGE');
  return catalog;
}

export function parseCatalogJSON(input) {
  if (typeof input !== 'string') fail('商品库 JSON 必须是文本。', '');
  if (encoder.encode(input).byteLength > CATALOG_MAX_BYTES) fail('商品库文档超过 8 MiB。', '', 'CATALOG_TOO_LARGE');
  let document;
  try { document = JSON.parse(input.replace(/^\uFEFF/u, '')); } catch { fail('商品库不是有效 JSON。', ''); }
  return normalizeCatalog(document);
}

function productsOf(input) {
  const products = Array.isArray(input) ? input : input?.products;
  if (!Array.isArray(products) || products.length > CATALOG_MAX_PRODUCTS) fail('请先加载有效商品库。', 'products');
  return products;
}
function resultLimit(value, fallback) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('候选数量必须为 1 至 200 的整数。', 'limit');
  return limit;
}
function queryText(value, maximum = 300) {
  if (value === undefined || value === null) return '';
  return text(value, 'query', '检索内容', maximum).normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ');
}
function searchable(value) { return typeof value === 'string' ? value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ').trim() : ''; }

/** Search is only a candidate list; it does not select or mutate a product. */
export function searchProducts(input, query = '', { limit } = {}) {
  const products = productsOf(input);
  const maximum = resultLimit(limit, 50);
  const normalized = queryText(query);
  if (!normalized) return products.slice(0, maximum);
  const words = normalized.split(' ');
  const matches = [];
  products.forEach((product, index) => {
    const barcodes = Array.isArray(product?.barcodes) ? product.barcodes.map(searchable) : [];
    const name = searchable(product?.name);
    const identifiers = [searchable(product?.sku), searchable(product?.spu), ...barcodes];
    const fields = [name, searchable(product?.spec), searchable(product?.category), ...identifiers];
    if (words.every((word) => fields.some((field) => field.includes(word)))) {
      const score = identifiers.includes(normalized) ? 0 : name === normalized ? 1 : name.startsWith(normalized) ? 2 : 3;
      matches.push({ product, score, index });
    }
  });
  matches.sort((left, right) => left.score - right.score || left.index - right.index);
  return matches.slice(0, maximum).map((match) => match.product);
}

/** Barcode comparison is exact and case-sensitive. SKU/SPU are never fallback barcodes. */
export function matchBarcode(input, value) {
  const products = productsOf(input);
  const barcode = text(value, 'barcode', '待匹配条码', PRODUCT_LIMITS.barcode);
  const candidates = barcode ? products.filter((product) => Array.isArray(product?.barcodes) && product.barcodes.includes(barcode)) : [];
  return {
    status: candidates.length === 1 ? 'matched' : candidates.length > 1 ? 'ambiguous' : 'none',
    product: candidates.length === 1 ? candidates[0] : null,
    candidates, total: candidates.length,
  };
}

/** Even one exact name is a candidate requiring a user's explicit choice. */
export function nameCandidates(input, value, { limit } = {}) {
  const products = productsOf(input);
  const maximum = resultLimit(limit, 20);
  const query = queryText(value, PRODUCT_LIMITS.name);
  const matches = query ? products.map((product, index) => ({ product, name: searchable(product?.name), index }))
    .filter((match) => match.name.includes(query)) : [];
  matches.sort((left, right) => Number(right.name === query) - Number(left.name === query) || left.index - right.index);
  return {
    status: matches.length > 1 ? 'ambiguous' : matches.length === 1 ? 'candidates' : 'none',
    product: null,
    candidates: matches.slice(0, maximum).map((match) => match.product),
    total: matches.length,
    truncated: matches.length > maximum,
  };
}
