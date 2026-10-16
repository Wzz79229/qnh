import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_MAX_BYTES, CATALOG_MAX_PRODUCTS, PRODUCT_LIMITS, CatalogError,
  normalizeProduct, normalizeImageUrl, normalizeCatalog, parseCatalogJSON,
  searchProducts, matchBarcode, nameCandidates,
} from '../dist/catalog.mjs';

const product = (patch = {}) => ({
  sku: '9000000000000000001', spu: '8000000000000000001', name: '原味酸奶',
  spec: '200g / 杯', barcodes: ['0012345678901', 'SUPPLIER-ABC'], category: '乳品 / 冷藏',
  imageUrl: 'https://img.meituan.net/empowerstoremanagement/catalog-test.jpg@80w_80h_90Q',
  ...patch,
});
const document = (patch = {}) => ({
  schemaVersion: 1,
  source: { platform: 'meituan-qnh', syncedAt: '2026-10-16T01:00:00Z', scope: '测试商品库', complete: false },
  products: [product()], ...patch,
});
const errorCode = (expected) => (error) => error instanceof CatalogError && error.code === expected;

test('SKU and SPU stay independent 19-digit strings with leading zeros preserved', () => {
  const value = normalizeProduct(product({ sku: '0123456789012345678', spu: '1234567890123456789' }));
  assert.equal(value.sku, '0123456789012345678');
  assert.equal(value.spu, '1234567890123456789');
  assert.equal(typeof value.sku, 'string');
  assert.equal(typeof value.spu, 'string');
  assert.notEqual(value.sku, value.spu);
  for (const patch of [{ sku: 123 }, { spu: 123 }, { sku: 1234567890123456789n }, { spu: '' }, { sku: 'a b' }]) {
    assert.throws(() => normalizeProduct(product(patch)), CatalogError);
  }
  assert.throws(() => normalizeProduct({ sku: '123', name: '缺少SPU' }), /SPU/);
});

test('multiple barcodes are text, deduplicated in order, and need no EAN validation', () => {
  const value = normalizeProduct(product({ barcodes: [' 00123 ', 'SUP-X', '00123', 'abc', 'ABC', '自定义码'] }));
  assert.deepEqual(value.barcodes, ['00123', 'SUP-X', 'abc', 'ABC', '自定义码']);
  assert.deepEqual(normalizeProduct(product({ barcodes: undefined })).barcodes, []);
  assert.throws(() => normalizeProduct(product({ barcodes: '00123' })), /数组/);
  assert.throws(() => normalizeProduct(product({ barcodes: [123] })), /字符串/);
  assert.throws(() => normalizeProduct(product({ barcodes: [''] })), /不能为空/);
});

test('normalization copies only the declared product fields and does not mutate input', () => {
  const input = product({ name: ' 原味酸奶 ', privateInternalId: 'private', credentials: 'not-a-real-secret' });
  const value = normalizeProduct(input);
  assert.deepEqual(Object.keys(value), ['sku', 'spu', 'name', 'spec', 'barcodes', 'category', 'imageUrl']);
  assert.equal(value.name, '原味酸奶');
  assert.equal(input.name, ' 原味酸奶 ');
  input.barcodes.push('NEW');
  assert.equal(value.barcodes.includes('NEW'), false);
  const minimal = normalizeProduct({ sku: 'a', spu: 'b', name: '测试' });
  assert.deepEqual(minimal, { sku: 'a', spu: 'b', name: '测试', spec: '', barcodes: [], category: '', imageUrl: '' });
});

test('strict field and single-product byte limits reject oversized records', () => {
  for (const field of ['sku', 'spu', 'name', 'spec', 'category']) {
    assert.throws(() => normalizeProduct(product({ [field]: 'x'.repeat(PRODUCT_LIMITS[field] + 1) })), errorCode('FIELD_TOO_LONG'));
  }
  assert.throws(() => normalizeProduct(product({ barcodes: ['x'.repeat(PRODUCT_LIMITS.barcode + 1)] })), errorCode('FIELD_TOO_LONG'));
  assert.throws(() => normalizeProduct(product({ barcodes: Array.from({ length: 33 }, (_, index) => String(index)) })), errorCode('TOO_MANY_BARCODES'));
  const wideBarcodes = Array.from({ length: 32 }, (_, index) => '中'.repeat(126) + String(index).padStart(2, '0'));
  assert.throws(() => normalizeProduct(product({ barcodes: wideBarcodes })), errorCode('PRODUCT_TOO_LARGE'));
  assert.throws(() => normalizeProduct(product({ name: '商品\u0000名称' })), /控制字符/);
});

test('safe Meituan images preserve path transformations and normalize the hostname', () => {
  const value = normalizeImageUrl(' HTTPS://IMG.MEITUAN.NET/empowerstoremanagement/a.jpg@80w_80h_90Q ');
  assert.equal(value, 'https://img.meituan.net/empowerstoremanagement/a.jpg@80w_80h_90Q');
  assert.equal(normalizeImageUrl(''), '');
  assert.equal(normalizeImageUrl(undefined), '');
});

test('images reject credentials, all queries/fragments, HTTP, other hosts and nondefault ports', () => {
  for (const url of [
    'http://img.meituan.net/a.jpg', 'https://example.test/a.jpg',
    'https://img.meituan.net.evil.test/a.jpg', 'https://user:secret@img.meituan.net/a.jpg',
    'https://@img.meituan.net/a.jpg', 'https://img.meituan.net:444/a.jpg',
    'https://img.meituan.net/a.jpg?token=test', 'https://img.meituan.net/a.jpg?',
    'https://img.meituan.net/a.jpg#fragment', 'https://img.meituan.net/a.jpg#',
    'https://img.meituan.net/a b.jpg', 'data:image/png;base64,YQ==', '//img.meituan.net/a.jpg',
  ]) assert.throws(() => normalizeImageUrl(url), errorCode('UNSAFE_IMAGE_URL'), url);
  assert.throws(() => normalizeImageUrl('https://img.meituan.net/a\nb.jpg'), /控制字符/);
});

test('catalog source metadata needs no tenant ID and keeps the explicit incomplete flag', () => {
  const input = document();
  input.source.tenantId = 'must-not-be-persisted';
  input.source.auth = 'must-not-be-persisted';
  const value = normalizeCatalog(input);
  assert.deepEqual(value.source, {
    platform: 'meituan-qnh', syncedAt: '2026-10-16T01:00:00.000Z', scope: '测试商品库', complete: false,
  });
  assert.equal(value.products.length, 1);
  assert.equal(input.source.syncedAt, '2026-10-16T01:00:00Z');
  assert.equal(normalizeCatalog(document({ products: [] })).products.length, 0);
});

test('catalog schema, source, completeness and actual calendar timestamp are validated', () => {
  assert.throws(() => normalizeCatalog(document({ schemaVersion: 2 })), errorCode('UNSUPPORTED_SCHEMA'));
  assert.throws(() => normalizeCatalog(document({ products: {} })), /数组/);
  for (const patch of [{ platform: 'unknown' }, { complete: 'true' }, { syncedAt: '2026-02-30T00:00:00Z' }, { syncedAt: '2026-10-16' }]) {
    assert.throws(() => normalizeCatalog(document({ source: { ...document().source, ...patch } })), CatalogError);
  }
  const offsetTime = normalizeCatalog(document({ source: { ...document().source, syncedAt: '2026-10-16T09:00:00+08:00' } }));
  assert.equal(offsetTime.source.syncedAt, '2026-10-16T01:00:00.000Z');
});

test('duplicate SKU is rejected even across different SPUs or identical duplicate rows', () => {
  for (const second of [product(), product({ spu: 'different-spu', name: '另一个商品' })]) {
    assert.throws(() => normalizeCatalog(document({ products: [product(), second] })), (error) => {
      assert.equal(error.code, 'DUPLICATE_SKU');
      assert.equal(error.path, 'products[1].sku');
      return true;
    });
  }
  const value = normalizeCatalog(document({ products: [product(), product({ sku: 'second-sku' })] }));
  assert.equal(value.products.length, 2, 'one SPU may legitimately have multiple independent SKUs');
});

test('catalog enforces product count and the full UTF-8 document byte budget', () => {
  assert.equal(CATALOG_MAX_PRODUCTS, 50_000);
  assert.throws(() => normalizeCatalog(document({ products: Array(CATALOG_MAX_PRODUCTS + 1).fill(product()) })), errorCode('TOO_MANY_PRODUCTS'));
  assert.throws(() => normalizeCatalog(document({ ignoredMetadata: 'x'.repeat(CATALOG_MAX_BYTES) })), errorCode('CATALOG_TOO_LARGE'));
  assert.throws(() => normalizeCatalog(document({ ignoredMetadata: '中'.repeat(Math.ceil(CATALOG_MAX_BYTES / 3)) })), errorCode('CATALOG_TOO_LARGE'));
});

test('JSON parsing handles BOM, rejects malformed JSON and checks size before parsing', () => {
  assert.equal(parseCatalogJSON('\uFEFF' + JSON.stringify(document())).products[0].sku, product().sku);
  assert.throws(() => parseCatalogJSON('{bad'), /有效 JSON/);
  assert.throws(() => parseCatalogJSON(' '.repeat(CATALOG_MAX_BYTES + 1)), errorCode('CATALOG_TOO_LARGE'));
  assert.throws(() => parseCatalogJSON(document()), /文本/);
});

const catalogProducts = [
  normalizeProduct(product()),
  normalizeProduct(product({ sku: '9000000000000000002', name: '原味酸奶', spec: '100g', barcodes: ['SHARED'] })),
  normalizeProduct(product({ sku: '9000000000000000003', spu: 'other-spu', name: '草莓牛奶', spec: '250ml', category: '鲜奶', barcodes: ['SHARED', 'custom-bar'] })),
];

test('search covers name, SKU, SPU, every barcode, spec and category', () => {
  for (const query of ['原味', '9000000000000000001', '8000000000000000001', 'SUPPLIER-ABC', '200g', '冷藏']) {
    assert.ok(searchProducts(catalogProducts, query).some((item) => item.sku === catalogProducts[0].sku), query);
  }
  assert.deepEqual(searchProducts(catalogProducts, '酸奶 200g').map((item) => item.sku), [catalogProducts[0].sku]);
  assert.equal(searchProducts(catalogProducts, 'ＣＵＳＴＯＭ－ＢＡＲ')[0], catalogProducts[2]);
  assert.equal(searchProducts({ products: catalogProducts }, '250ML')[0], catalogProducts[2]);
  assert.equal(searchProducts(catalogProducts, '', { limit: 1 }).length, 1);
  assert.deepEqual(searchProducts(catalogProducts, '不存在的商品'), []);
  assert.throws(() => searchProducts(catalogProducts, 123), /字符串/);
});

test('barcode matching accepts arbitrary codes but never falls back to SKU or SPU', () => {
  const result = matchBarcode(catalogProducts, ' 0012345678901 ');
  assert.equal(result.status, 'matched');
  assert.equal(result.product, catalogProducts[0]);
  assert.deepEqual(result.candidates, [catalogProducts[0]]);
  assert.equal(matchBarcode(catalogProducts, 'custom-bar').product, catalogProducts[2]);
  for (const missing of ['', catalogProducts[0].sku, catalogProducts[0].spu, '12345678901', 'CUSTOM-BAR']) {
    const result = matchBarcode(catalogProducts, missing);
    assert.equal(result.status, 'none', missing);
    assert.equal(result.product, null);
  }
  assert.throws(() => matchBarcode(catalogProducts, 12345678901), /字符串/);
});

test('shared barcode reports all candidates and no automatic choice', () => {
  const result = matchBarcode(catalogProducts, 'SHARED');
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.product, null);
  assert.equal(result.total, 2);
  assert.deepEqual(result.candidates, catalogProducts.slice(1));
});

test('name lookup always requires explicit selection, including a single exact name', () => {
  const unique = nameCandidates(catalogProducts, '草莓牛奶');
  assert.equal(unique.status, 'candidates');
  assert.equal(unique.product, null);
  assert.deepEqual(unique.candidates, [catalogProducts[2]]);
  const ambiguous = nameCandidates(catalogProducts, '原味酸奶', { limit: 1 });
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.product, null);
  assert.equal(ambiguous.total, 2);
  assert.equal(ambiguous.truncated, true);
  assert.equal(ambiguous.candidates.length, 1);
  assert.equal(nameCandidates(catalogProducts, '原为酸奶').status, 'none', 'no edit-distance or fuzzy automatic correction');
  assert.equal(nameCandidates(catalogProducts, '').status, 'none');
});

test('lookup result limits are bounded and catalog values are never mutated', () => {
  const before = JSON.stringify(catalogProducts);
  searchProducts(catalogProducts, '原味');
  matchBarcode(catalogProducts, 'SHARED');
  nameCandidates(catalogProducts, '酸奶');
  assert.equal(JSON.stringify(catalogProducts), before);
  for (const limit of [0, -1, 201, 1.5, '10']) {
    assert.throws(() => searchProducts(catalogProducts, '', { limit }), /候选数量/);
    assert.throws(() => nameCandidates(catalogProducts, '酸奶', { limit }), /候选数量/);
  }
});
