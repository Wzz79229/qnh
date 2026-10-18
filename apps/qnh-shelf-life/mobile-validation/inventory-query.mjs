import { readLoggedInQnhShell, readObservedQnhTenantId } from '../backend/qnh-browser-session.mjs';

export const INVENTORY_HASH = '#/co-wms/inventory-query-integration/list';
export const LEGACY_INVENTORY_HASH = '#/co-wms/non-erp/stock-query';
export const LEGACY_INVENTORY_URL = `https://qnh.meituan.com/home.html${LEGACY_INVENTORY_HASH}?tab=list&pageSize=50`;
export function legacyInventoryPage(href){try{const u=new URL(href),[path,query='']=u.hash.split('?'),tab=new URLSearchParams(query).get('tab');return u.origin==='https://qnh.meituan.com'&&['/','/home.html'].includes(u.pathname)&&path===LEGACY_INVENTORY_HASH&&(!tab||tab==='list');}catch{return false;}}
export const INVENTORY_URL = `https://qnh.meituan.com/${INVENTORY_HASH}?tab=goodsBatch`;
const visible = e => e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
export function inventoryPage(href) {
  try { const u = new URL(href), [path, query = ''] = u.hash.split('?');
    return legacyInventoryPage(href) || u.origin === 'https://qnh.meituan.com' && ['/', '/home.html'].includes(u.pathname)
      && path === INVENTORY_HASH && new URLSearchParams(query).get('tab') === 'goodsBatch';
  } catch { return false; }
}
export function exactInventoryReceipt(href, sku, previousStamp) {
  if (!inventoryPage(href)) return false;
  const q = new URLSearchParams(new URL(href).hash.split('?')[1]);
  return q.getAll('skuIdListStr').length === 1 && q.get('skuIdListStr') === sku
    && /^\d+$/u.test(q.get('_t') || '') && q.get('_t') !== previousStamp && q.get('current') === '1';
}
export function inventoryControls() {
  const panels = Array.from(document.querySelectorAll('[id$="-panel-goodsBatch"]')).filter(visible);
  if (panels.length !== 1) return null;
  const root = panels[0], fields = Array.from(root.querySelectorAll('input#skuIdListStr')).filter(visible);
  const buttons = Array.from(root.querySelectorAll('button')).filter(visible).filter(e => e.innerText.replace(/\s+/gu, '') === '查询');
  const tables = Array.from(root.querySelectorAll('table')).filter(visible);
  const headers = tables.flatMap(t => Array.from(t.querySelectorAll('thead th')).map(e => e.innerText.trim()));
  if (fields.length !== 1 || buttons.length !== 1 || !headers.includes('商品信息') || !headers.includes('门店/仓') || !headers.includes('库位')) return null;
  return { root, field: fields[0], button: buttons[0], tables, headers };
}
export function readInventoryRows({ root, headers }) {
  const rows = [], locationIndex = headers.indexOf('库位'), storeIndex = headers.indexOf('门店/仓');
  for (const row of root.querySelectorAll('tbody tr')) {
    if (!visible(row) || row.getBoundingClientRect().height < 1) continue;
    const cells = Array.from(row.children).filter(e => e.tagName === 'TD');
    const product = cells[0]?.querySelector('.wms-wand-goods-info-goods-name-text');
    if (!visible(product) || !cells[locationIndex] || !cells[storeIndex]) continue;
    const text = cells[0].innerText, spec = /(?:^|\n)\s*规格[：:]\s*([^\n]*)/u.exec(text)?.[1] || '';
    rows.push({ name: product.innerText.trim(), spec: spec.trim(), loc: cells[locationIndex].innerText.trim(), store: cells[storeIndex].innerText.trim() });
  }
  const empty = Array.from(root.querySelectorAll('.wms-ant-empty, .wms-ant-table-placeholder')).some(e => visible(e) && /暂无数据|暂无内容/u.test(e.innerText));
  return { rows, empty };
}
export function normalizeInventoryRows(snapshot, sku) {
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(sku) || !snapshot || !Array.isArray(snapshot.rows) || snapshot.rows.length > 100) throw Error('ROWS');
  if (snapshot.empty && snapshot.rows.length) throw Error('CONFLICT');
  if (!snapshot.rows.length && !snapshot.empty) throw Error('UNCONFIRMED');
  const unique = new Map();
  for (const raw of snapshot.rows) {
    if (!raw || Object.values(raw).some(v => typeof v !== 'string' || v.length > 300 || /[\x00-\x08\x0b-\x1f\x7f]/u.test(v))) throw Error('ROW');
    if (!raw.name?.trim() || !raw.store?.trim()) throw Error('ROW');
    // SKU comes from the exact SKU field plus a fresh official URL filter receipt;
    // this inventory UI does not display an independent SKU field in its rows.
    // Never infer it from the product barcode or invent an SPU.
    const value = { sku, name: raw.name.trim(), spec: raw.spec.trim(), loc: raw.loc.trim(), store: raw.store.trim() };
    unique.set(JSON.stringify(value), value);
  }
  return [...unique.values()];
}
export function observeInventory(control) {
  let done, quiet, timer, closed = false;
  const loading = () => Array.from(control.root.querySelectorAll('[class]')).some(e => visible(e) && /(?:spin-spinning|anticon-loading|anticon-spin)/u.test(e.className || ''));
  const promise = new Promise(resolve => { done = ok => { if (closed) return; closed = true; observer.disconnect(); clearTimeout(quiet); clearTimeout(timer); resolve(ok); }; });
  const observer = new MutationObserver(records => {
    const relevant = records.some(r => { const e = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      return e && (e.closest('tbody') || e.tagName === 'TABLE' || /spin|loading|empty/u.test((r.oldValue || '') + ' ' + (e.getAttribute('class') || ''))
        || [...r.addedNodes, ...r.removedNodes].some(n => n.nodeType === 1 && (n.matches('table,tbody') || /spin|loading|empty/u.test(n.className || '') || n.querySelector('table,tbody')))); });
    if (!relevant) return; clearTimeout(quiet); if (!loading()) quiet = setTimeout(() => done(!loading()), 350);
  });
  observer.observe(control.root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  timer = setTimeout(() => done(false), 15000); return { promise, cancel: () => done(false) };
}
export function createInventoryRuntime({ shell = readLoggedInQnhShell, tenant = readObservedQnhTenantId, controls = inventoryControls,
  observe = observeInventory, readRows = readInventoryRows } = {}) {
  let result = { status: 'idle' }, generation = 0, watcher;
  const identity = () => { try { const u = new URL(location.href), id = tenant(); return u.origin === 'https://qnh.meituan.com' && ['/', '/home.html'].includes(u.pathname) && shell() && typeof id === 'string' && /^[1-9][0-9]{0,19}$/u.test(id) ? id : ''; } catch { return ''; } };
  const cancel = () => { generation++; watcher?.cancel(); watcher = null; result = { status: 'idle' }; };
  return Object.freeze({ version: 1, cancel, inspect() {
    const id = identity(); if (!id || result.tenantId && result.tenantId !== id) cancel();
    return { ...result, authorized: Boolean(id), tenantId: id, productReady: Boolean(id && inventoryPage(location.href) && controls()) };
  }, begin(requestId, sku, expectedTenant) {
    const id = identity(), control = inventoryPage(location.href) ? controls() : null;
    if (!id || id !== expectedTenant || !control || typeof sku !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/u.test(sku) || !/^[1-9][0-9]{0,15}$/u.test(String(requestId))) return false;
    cancel(); const current = generation, stamp = new URLSearchParams(new URL(location.href).hash.split('?')[1]).get('_t');
    result = { status: 'pending', requestId: String(requestId), tenantId: id, sku };
    (async () => { try {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; if (!setter) throw Error('INPUT');
      setter.call(control.field, sku); control.field.dispatchEvent(new Event('input', { bubbles: true })); control.field.dispatchEvent(new Event('change', { bubbles: true }));
      if (control.field.value !== sku) throw Error('INPUT'); watcher = observe(control); const active = watcher; control.button.click();
      const fresh = await active.promise; if (generation !== current) return; watcher = null;
      if (!fresh || identity() !== id || control.field.value !== sku || !exactInventoryReceipt(location.href, sku, stamp)) throw Error('STALE');
      const rows = normalizeInventoryRows(readRows(control), sku);
      if (identity() !== id || control.field.value !== sku) throw Error('STALE');
      result = { status: rows.length ? 'found' : 'not_found', requestId: String(requestId), tenantId: id, sku, rows };
    } catch { if (current === generation) result = { status: 'error', requestId: String(requestId), tenantId: id, sku }; } })(); return true;
  } });
}
