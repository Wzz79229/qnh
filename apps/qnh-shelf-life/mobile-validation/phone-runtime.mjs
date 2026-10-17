import { readLoggedInQnhShell, readObservedQnhTenantId } from '../backend/qnh-browser-session.mjs';
import { normalizeSku, readVisibleProductRows, parseScopedCells, resolveExactSku } from '../local-query/extract.mjs';

const PRODUCT_HASH = '#/unifiedGoods/tenant/spu-list';
const visible = element => element && element.getClientRects().length > 0
  && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden';

function controls() {
  const fields = Array.from(document.querySelectorAll('.unifiedGoods-ant-form-item-row'))
    .filter(element => /^SKU$/u.test(element.innerText.trim()))
    .flatMap(element => Array.from(element.querySelectorAll('input[type="text"]'))).filter(visible);
  const buttons = Array.from(document.querySelectorAll('button')).filter(visible).filter(element => element.innerText.trim() === '查询');
  const tables = Array.from(document.querySelectorAll('table')).filter(visible);
  const headers = tables.flatMap(table => Array.from(table.querySelectorAll('thead th')).map(element => element.innerText.trim()));
  if (fields.length !== 1 || buttons.length !== 1 || !tables.length
    || !headers.includes('商品信息') || !headers.includes('规格信息')) return null;
  return { field: fields[0], button: buttons[0], tables };
}

/** Only a post-click table refresh can supply a result. No cookies or network bodies are inspected. */
function watchRefresh({ field, tables }, sku) {
  const roots = [...new Set(tables.map(table => table.closest('.unifiedGoods-ant-spin-nested-loading') || table))];
  const loadingClass = /(?:^|\s)\S*(?:spin-spinning|spin-dot(?:-item|-spin)?|anticon-loading|anticon-spin)(?:\s|$)/u;
  const loading = () => roots.some(root => Array.from(root.querySelectorAll('[class]'))
    .some(element => visible(element) && loadingClass.test(element.getAttribute('class') || '')));
  let finish, quiet, timeout, closed = false;
  const promise = new Promise(resolve => { finish = value => {
    if (closed) return;
    closed = true; clearTimeout(quiet); clearTimeout(timeout); observer.disconnect(); resolve(value);
  }; });
  const observer = new MutationObserver(records => {
    const relevant = records.some(record => {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (!target) return false;
      if (record.type === 'attributes') return loadingClass.test(`${record.oldValue || ''} ${target.getAttribute('class') || ''}`)
        || /(?:^|\s)\S*table-empty(?:\s|$)/u.test(target.getAttribute('class') || '');
      return target.closest('tbody') || target.tagName === 'TABLE'
        || [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches('table,tbody') || node.querySelector('table,tbody')));
    });
    if (!relevant) return;
    clearTimeout(quiet);
    if (!loading()) quiet = setTimeout(() => finish(field.value === sku && !loading()), 600);
  });
  for (const root of roots) observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  timeout = setTimeout(() => finish(false), 12_000);
  return { promise, cancel: () => finish(false) };
}

export function createPhoneRuntime({ shell = readLoggedInQnhShell, tenant = readObservedQnhTenantId,
  getControls = controls, observe = watchRefresh, readRows = readVisibleProductRows } = {}) {
  let result = { status: 'idle' }, generation = 0, watcher = null;
  const identity = () => {
    try {
      const url = new URL(location.href);
      if (url.origin !== 'https://qnh.meituan.com' || !['/', '/home.html'].includes(url.pathname) || !shell()) return null;
      const value = tenant();
      return typeof value === 'string' && /^[1-9][0-9]{0,19}$/u.test(value) ? value : null;
    } catch { return null; }
  };
  const productPage = () => location.hash.split('?')[0] === PRODUCT_HASH;
  const cancel = () => { generation++; watcher?.cancel(); watcher = null; result = { status: 'idle' }; };
  return Object.freeze({
    version: 1,
    inspect() {
      const tenantId = identity();
      if (!tenantId || result.tenantId && result.tenantId !== tenantId) cancel();
      return { authorized: Boolean(tenantId), tenantId: tenantId || '', productReady: Boolean(tenantId && productPage() && getControls()), ...result };
    },
    cancel,
    begin(requestId, value, expectedTenant) {
      let sku;
      try { sku = normalizeSku(value); } catch { return false; }
      const tenantId = identity(), control = productPage() ? getControls() : null;
      if (!/^[1-9][0-9]{0,15}$/u.test(String(requestId)) || tenantId !== expectedTenant || !tenantId || !control) return false;
      cancel(); const current = generation;
      result = { status: 'pending', requestId: String(requestId), sku, tenantId };
      (async () => {
        try {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (!setter) throw Error('INPUT');
          setter.call(control.field, sku);
          control.field.dispatchEvent(new Event('input', { bubbles: true }));
          control.field.dispatchEvent(new Event('change', { bubbles: true }));
          if (control.field.value !== sku) throw Error('INPUT');
          watcher = observe(control, sku);
          const activeWatcher = watcher;
          control.button.click();
          const fresh = await activeWatcher.promise;
          if (current !== generation) return;
          watcher = null;
          if (!fresh || identity() !== tenantId || control.field.value !== sku) throw Error('STALE');
          const snapshot = readRows(Array.from(document.querySelectorAll('table')).filter(visible));
          if (snapshot.unscoped) throw Error('SCOPE');
          const rows = snapshot.cells.map(parseScopedCells);
          const empty = Array.from(document.querySelectorAll('.unifiedGoods-ant-empty, .unifiedGoods-ant-table-placeholder')).some(visible);
          if (empty && rows.length) throw Error('CONFLICT');
          const resolved = resolveExactSku({ complete: rows.length > 0 || empty, rows }, sku);
          if (identity() !== tenantId) throw Error('TENANT');
          result = { requestId: String(requestId), sku, tenantId, status: resolved.status,
            ...(resolved.status === 'found' ? { product: resolved.product } : {}) };
        } catch {
          if (current === generation) result = { requestId: String(requestId), sku, tenantId, status: 'error' };
        }
      })();
      return true;
    },
  });
}
