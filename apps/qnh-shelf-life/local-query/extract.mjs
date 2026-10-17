export const QNH_PRODUCT_URL = 'https://qnh.meituan.com/#/unifiedGoods/tenant/spu-list';
const SKU = /^[A-Za-z0-9._-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function normalizeSku(value) {
  if (typeof value !== 'string' || !SKU.test(value.trim())) throw new TypeError('INVALID_SKU');
  return value.trim();
}

function text(value, max, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value)) throw new TypeError('INVALID_PRODUCT');
  const result = value.trim();
  if (required && !result) throw new TypeError('INVALID_PRODUCT');
  return result;
}

export function safeImageUrl(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 2048 || /[?#\s\\]/u.test(value)) throw new TypeError('INVALID_IMAGE');
  let url;
  try { url = new URL(value); } catch { throw new TypeError('INVALID_IMAGE'); }
  if (url.protocol !== 'https:' || url.hostname !== 'img.meituan.net' || url.port || url.username || url.password) throw new TypeError('INVALID_IMAGE');
  return url.href;
}

export function sanitizeProduct(input, expectedSku) {
  if (!plain(input)) throw new TypeError('INVALID_PRODUCT');
  const sku = normalizeSku(input.sku);
  if (sku !== normalizeSku(expectedSku)) throw new TypeError('SKU_MISMATCH');
  const spu = normalizeSku(input.spu);
  const values = input.barcodes ?? [];
  if (!Array.isArray(values) || values.length > 32) throw new TypeError('INVALID_PRODUCT');
  const barcodes = [...new Set(values.map(value => text(value, 128, true)))];
  const product = {
    sku, spu, name: text(input.name, 200, true), spec: text(input.spec, 120),
    category: text(input.category, 200), barcodes, imageUrl: safeImageUrl(input.imageUrl),
  };
  if (new TextEncoder().encode(JSON.stringify(product)).byteLength > 8192) throw new TypeError('INVALID_PRODUCT');
  return product;
}

/** Resolve only the real SKU field; no barcode/SPU/name fallback, no ID coercion. */
export function resolveExactSku(input, requestedSku) {
  const sku = normalizeSku(requestedSku);
  if (!plain(input)) return { status: 'error', message: '商品页结果尚未确认，请重试。' };
  if (input.loginRequired === true) return { status: 'login_required', message: '请管理员在本机牵牛花浏览器中重新登录。' };
  if (input.complete !== true || !Array.isArray(input.rows)) return { status: 'error', message: '商品页结果尚未确认，请重试。' };
  const candidates = input.rows.filter(row => plain(row) && typeof row.sku === 'string' && row.sku.trim() === sku);
  if (input.rows.some(row => plain(row) && typeof row.sku !== 'string')) return { status: 'error', message: '商品编号格式无法确认，请在牵牛花核对后重试。' };
  if (!candidates.length) return { status: 'not_found', message: '牵牛花中没有此 SKU，请核对标签。' };
  const unique = new Map();
  try {
    for (const candidate of candidates) {
      const product = sanitizeProduct(candidate, sku);
      unique.set(JSON.stringify(product), product);
    }
  } catch {
    return { status: 'error', message: '商品资料不完整或图片地址无法确认，请在牵牛花核对。' };
  }
  if (unique.size !== 1) return { status: 'ambiguous', message: '牵牛花返回多个不同商品，请管理员核对 SKU。' };
  const product = unique.values().next().value;
  if (!product.imageUrl) return { status: 'error', message: '此 SKU 的商品主图缺失，请在牵牛花核对后重试。' };
  return { status: 'found', product };
}

/** Parse only the two observed product/specification cells, never price/operator cells. */
export function parseScopedCells({ productText, specText, imageUrls = [] }) {
  if (typeof productText !== 'string' || typeof specText !== 'string' || productText.length > 4000 || specText.length > 4000) throw new TypeError('INVALID_VISIBLE_ROW');
  const spus = [...productText.matchAll(/^\s*SPU[：:]\s*([A-Za-z0-9._-]{1,64})\s*$/gmu)];
  const skus = [...specText.matchAll(/^\s*SKU[：:]\s*([A-Za-z0-9._-]{1,64})\s*$/gmu)];
  if (spus.length !== 1 || skus.length !== 1 || !/商品条码[：:]/u.test(specText)) throw new TypeError('UNSCOPED_VISIBLE_ROW');
  const name = productText.slice(0, spus[0].index).split(/\r?\n/u).map(value => value.trim()).filter(value => value && value !== '预览').join(' ');
  const category = /商品类目[：:]\s*([^\r\n]*)/u.exec(productText)?.[1]?.trim() || '';
  const spec = specText.slice(0, skus[0].index).trim();
  const barcodeText = /商品条码[：:]\s*([\s\S]*?)(?:外部编码[：:]|$)/u.exec(specText)?.[1] || '';
  const barcodes = barcodeText.split(/[,，;；\s]+/u).map(value => value.trim()).filter(value => value && !/^-+$/u.test(value));
  const imageUrl = Array.isArray(imageUrls) ? imageUrls.find(value => typeof value === 'string' && value.startsWith('https://img.meituan.net/')) || '' : '';
  return sanitizeProduct({ sku: skus[0][1], spu: spus[0][1], name, category, spec, barcodes, imageUrl }, skus[0][1]);
}

/** This self-contained function is serialized by Playwright into a visible table read. */
export function readVisibleProductRows(tables) {
  const visible = element => {
    if (!element || element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const skuCount = value => [...value.matchAll(/^\s*SKU[：:]\s*[A-Za-z0-9._-]{1,64}\s*$/gmu)].length;
  const exactSkuLabel = element => /^\s*SKU[：:]\s*[A-Za-z0-9._-]{1,64}\s*$/u.test(element.innerText || '');
  const cells = [];
  let unscoped = false;
  for (const table of tables.filter(visible)) {
    for (const row of table.querySelectorAll('tbody tr')) {
      if (!visible(row) || row.closest('table') !== table) continue;
      const columns = Array.from(row.children).filter(element => element.tagName === 'TD');
      const productCell = columns[1];
      const specCell = columns[2];
      if (!visible(productCell) || !visible(specCell)) continue;
      const productText = productCell.innerText;
      if (!/SPU[：:]/u.test(productText)) continue;
      const imageUrls = Array.from(productCell.querySelectorAll('img')).filter(visible)
        .map(image => image.currentSrc || image.getAttribute('src'))
        .filter(value => typeof value === 'string' && value.startsWith('https://img.meituan.net/'));
      if (skuCount(specCell.innerText) === 1) {
        cells.push({ productText, specText: specCell.innerText, imageUrls });
        continue;
      }
      const labels = Array.from(specCell.querySelectorAll('*')).filter(visible).filter(exactSkuLabel)
        .filter(element => !Array.from(element.children).some(exactSkuLabel));
      if (!labels.length) { unscoped = true; continue; }
      const scopes = new Set();
      for (const label of labels) {
        let scope = label;
        while (scope !== specCell && scope.parentElement && specCell.contains(scope.parentElement)
          && skuCount(scope.parentElement.innerText) === 1) scope = scope.parentElement;
        if (!/商品条码[：:]/u.test(scope.innerText)) { unscoped = true; continue; }
        scopes.add(scope);
      }
      for (const scope of scopes) cells.push({ productText, specText: scope.innerText, imageUrls });
    }
  }
  return { cells, unscoped };
}

/** Adapter contract is injectable for unit tests. Only UI methods belong here. */
export function createQueryAdapter({ checkLogin, searchSku, readSearchResults }) {
  for (const method of [checkLogin, searchSku, readSearchResults]) if (typeof method !== 'function') throw new TypeError('INVALID_ADAPTER');
  return {
    async checkLogin() { return (await checkLogin()) === true; },
    async lookup(value, { deadline = Date.now() + 35000 } = {}) {
      const sku = normalizeSku(value);
      if (!await checkLogin()) return { status: 'login_required', message: '请管理员在本机牵牛花浏览器中重新登录。' };
      if (Date.now() >= deadline) return { status: 'error', message: '商品查询超时，请重试。' };
      await searchSku(sku, { deadline });
      const input = await readSearchResults(sku, { deadline });
      if (Date.now() >= deadline) return { status: 'error', message: '商品查询超时，请重试。' };
      return resolveExactSku(input, sku);
    },
  };
}

/** Observe only DOM changes in a visible table body; no network or application state. */
export async function observeTableRefresh(page, timeoutMs) {
  const handle = await page.evaluateHandle(({ timeoutMs }) => {
    let finishPromise;
    let finished = false;
    let observed = false;
    let quietTimer;
    let timeout;
    const promise = new Promise(resolve => { finishPromise = resolve; });
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
    const roots = [...new Set(Array.from(document.querySelectorAll('table')).filter(visible)
      .map(table => table.closest('.unifiedGoods-ant-spin-nested-loading') || table))];
    const loadingClasses = /(?:^|\s)\S*(?:spin-spinning|spin-dot(?:-item|-spin)?|anticon-loading|anticon-spin)(?:\s|$)/u;
    const loadingElement = element => element?.nodeType === 1 && loadingClasses.test(element.getAttribute('class') || '');
    const withinRoot = element => roots.some(root => root === element || root.contains(element));
    const loadingAncestor = element => {
      let current = element;
      while (current && withinRoot(current)) {
        if (loadingElement(current)) return true;
        if (roots.includes(current)) break;
        current = current.parentElement;
      }
      return false;
    };
    const loading = () => roots.some(root => Array.from(root.querySelectorAll('[class]'))
      .some(element => visible(element) && loadingElement(element)));
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(quietTimer);
      clearTimeout(timeout);
      observer.disconnect();
      finishPromise(value);
    };
    const relevant = record => {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (!target || !withinRoot(target)) return false;
      if (record.type === 'attributes') {
        const classes = `${record.oldValue || ''} ${target?.getAttribute('class') || ''}`;
        return loadingClasses.test(classes) || /(?:^|\s)\S*table-empty(?:\s|$)/u.test(classes);
      }
      const table = target?.closest('table');
      if (table && visible(table) && (target.closest('tbody') || target.tagName === 'TABLE')) return true;
      return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1
        && (node.matches('table,tbody') || node.querySelector('table,tbody') || loadingElement(node)
          || Array.from(node.querySelectorAll('[class]')).some(loadingElement)))
        || (record.type === 'childList' && loadingAncestor(target));
    };
    const observer = new MutationObserver(records => {
      if (!records.some(relevant)) return;
      observed = true;
      clearTimeout(quietTimer);
      if (!loading()) quietTimer = setTimeout(() => finish(observed && !loading()), 600);
    });
    for (const root of roots) observer.observe(root, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class'], attributeOldValue: true,
    });
    timeout = setTimeout(() => finish(false), timeoutMs);
    return { wait: () => promise, cancel: () => finish(false) };
  }, { timeoutMs });
  return {
    wait: () => handle.evaluate(value => value.wait()),
    async close() {
      await handle.evaluate(value => value.cancel()).catch(() => {});
      await handle.dispose().catch(() => {});
    },
  };
}

/** All selectors here come from the actual inspected QNH product-page DOM. */
export function createVisibleQnhAdapter(page, { watchRefresh = observeTableRefresh } = {}) {
  const field = page.locator('.unifiedGoods-ant-form-item-row').filter({ hasText: /^SKU$/u }).locator('input[type="text"]');
  const query = page.getByRole('button', { name: '查询', exact: true });
  const tables = page.getByRole('table');
  const emptyTable = page.locator('.unifiedGoods-ant-table-empty').filter({ hasText: '暂无内容' });
  let receipt = null;
  const remaining = deadline => Math.max(1, Math.min(10000, deadline - Date.now()));
  const checkLogin = async () => {
    try {
      const url = new URL(page.url());
      if (url.origin !== 'https://qnh.meituan.com' || !['/', '/home.html'].includes(url.pathname)
        || url.hash.split('?')[0] !== '#/unifiedGoods/tenant/spu-list') return false;
      if (await field.count() !== 1 || await query.count() !== 1 || !await field.isVisible() || !await query.isVisible()) return false;
      const headers = await tables.evaluateAll(values => values.filter(table => table.getClientRects().length)
        .flatMap(table => Array.from(table.querySelectorAll('thead th')).map(cell => cell.innerText.trim())));
      return headers.includes('商品信息') && headers.includes('规格信息');
    } catch { return false; }
  };
  return createQueryAdapter({
    checkLogin,
    async searchSku(sku, { deadline }) {
      receipt = null;
      await field.fill(sku, { timeout: remaining(deadline) });
      if (await field.inputValue() !== sku) throw new Error('SKU_INPUT_UNCONFIRMED');
      const watcher = await watchRefresh(page, Math.max(1, Math.min(15000, deadline - Date.now())));
      try {
        await query.click({ timeout: remaining(deadline) });
        const complete = await watcher.wait();
        receipt = { sku, complete: complete === true };
      } finally { await watcher.close(); }
    },
    async readSearchResults(sku) {
      if (!await checkLogin()) return { complete: false, rows: [], loginRequired: true };
      if (!receipt?.complete || receipt.sku !== sku || await field.inputValue() !== sku) return { complete: false, rows: [] };
      const snapshot = await tables.evaluateAll(readVisibleProductRows);
      if (snapshot.unscoped) return { complete: false, rows: [] };
      try {
        const rows = snapshot.cells.map(parseScopedCells);
        const empty = await emptyTable.count() > 0 && await emptyTable.first().isVisible();
        if (empty && rows.length) return { complete: false, rows: [] };
        return { complete: rows.length > 0 || empty, rows };
      } catch { return { complete: false, rows: [] }; }
    },
  });
}
