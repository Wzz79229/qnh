// Observe the official page's own inventory requests. Never replay requests,
// read credentials or retain unrelated responses.
export const STOCK_PATH = '/api/v1/comprehensive/stock/querystock';
const ORIGIN = 'https://qnh.meituan.com';
const ID = /^[A-Za-z0-9._-]{1,64}$/u;
const MAX_BODY = 4 * 1024 * 1024;
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max, empty = false) => {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/u.test(value) || !empty && !value.trim()) throw Error('FIELD');
  return value.trim();
};
const identifier = value => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string' || !ID.test(value)) throw Error('ID');
  return value;
};
// Some services emit identifiers as JSON integers. Quote long integer tokens
// before parsing, without touching strings, decimals or exponent notation.
export function parseStockJson(source) {
  if (typeof source !== 'string' || source.length > MAX_BODY) throw Error('SIZE');
  let output = '', index = 0;
  while (index < source.length) {
    const c = source[index];
    if (c === '"') {
      const start = index++;
      while (index < source.length) {
        const next = source[index++];
        if (next === '\\') index++;
        else if (next === '"') break;
      }
      output += source.slice(start, index);
    } else if (c === '-' || /[0-9]/u.test(c)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(source.slice(index));
      if (!match) throw Error('JSON');
      const value = match[0];
      output += /^-?[0-9]{16,}$/u.test(value) ? JSON.stringify(value) : value;
      index += value.length;
    } else { output += c; index++; }
  }
  return JSON.parse(output);
}
function query(href) {
  const url = new URL(href);
  if (url.origin !== ORIGIN || !['/', '/home.html'].includes(url.pathname) || url.hash.split('?')[0] !== '#/co-wms/non-erp/stock-query') throw Error('PAGE');
  return new URLSearchParams(url.hash.split('?')[1] || '');
}
function stores(href) {
  const values = query(href).getAll('repositoryList');
  if (values.length !== 1) throw Error('STORE');
  const parsed = parseStockJson(values[0]);
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 100) throw Error('STORE');
  const list = parsed.map(row => {
    if (!Array.isArray(row) || row.length !== 2) throw Error('STORE');
    const type = identifier(row[0]), id = identifier(row[1]);
    if (!/^[1-9][0-9]*$/u.test(type) || !/^[1-9][0-9]*$/u.test(id)) throw Error('STORE');
    return { type, id };
  });
  if (list.some(row => row.type !== list[0].type) || new Set(list.map(row => row.id)).size !== list.length) throw Error('STORE');
  return list;
}
function segments(value) {
  if (value == null) return ['', '', '', ''];
  if (!Array.isArray(value) || value.length > 4 || value.some(item => item != null && typeof item !== 'string')) throw Error('LOCATION');
  return [...value.map(item => item || ''), ...Array(4 - value.length).fill('')];
}
export function matchStockRequest(url, method, source, expected) {
  try {
    const target = new URL(url, expected.href);
    if (target.origin !== ORIGIN || target.pathname !== STOCK_PATH || target.search || target.username || target.password || method.toUpperCase() !== 'POST') return null;
    const body = typeof source === 'string' ? parseStockJson(source) : null;
    if (!plain(body)) return null;
    const scope = stores(expected.href), page = Number(body.page), pageSize = Number(body.pageSize);
    if (!Number.isInteger(page) || page !== expected.page || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) return null;
    if (identifier(body.repositoryId) !== scope[0].id || identifier(body.repositoryType) !== scope[0].type || !Array.isArray(body.repositoryIds)) return null;
    const actualIds = body.repositoryIds.map(identifier).sort(), expectedIds = scope.map(row => row.id).sort();
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) return null;
    for (const [key, field] of Object.entries({name:'skuNameKeyword',sku:'skuIdListStr',barcode:'upcKeyword',external:'externalGoodsCodeKeyword'})) {
      if ((body[field] ?? '') !== (expected.filters[key] || '')) return null;
    }
    if (JSON.stringify(segments(body.locationCodeSegmentList)) !== JSON.stringify(segments(expected.filters.loc ? expected.filters.loc.split('-') : []))) return null;
    if (body.locationTypeStrategyId !== 'EMPOWER') return null;
    return { body, page, pageSize, stores: scope };
  } catch { return null; }
}
function specOf(goods) {
  const spec = text(goods.spec ?? '', 200, true), unit = text(goods.baseUnit ?? '', 40, true);
  const weight = goods.weight;
  if (weight == null || !unit) return spec;
  if (!['string', 'number'].includes(typeof weight) || !/^[0-9]+(?:\.[0-9]+)?$/u.test(String(weight)) || String(weight).length > 30) throw Error('SPEC');
  return text(spec ? `${spec}(${weight}g/${unit})` : `${weight}g/${unit}`, 240, true);
}
export function normalizeStockResponse(source, request, expected) {
  const envelope = typeof source === 'string' ? parseStockJson(source) : source;
  if (!plain(envelope) || envelope.success === false || envelope.code != null && ![0, '0', 200, '200'].includes(envelope.code)) throw Error('STATUS');
  const data = envelope.data;
  if (!plain(data) || !Array.isArray(data.list) || data.list.length > request.pageSize || data.list.length > 500 || !Number.isSafeInteger(data.total) || data.total < 0 || data.total > 1000000) throw Error('DATA');
  if ((data.current != null && Number(data.current) !== request.page) || (data.page != null && Number(data.page) !== request.page) || (data.pageSize != null && Number(data.pageSize) !== request.pageSize)) throw Error('PAGE');
  if (data.tenantId != null && identifier(data.tenantId) !== expected.scope) throw Error('TENANT');
  const offset = (request.page - 1) * request.pageSize;
  if (data.list.length !== Math.max(0, Math.min(request.pageSize, data.total - offset))) throw Error('TOTAL');
  const rows = [], unique = new Set();
  for (const record of data.list) {
    if (!plain(record) || !plain(record.goodsInfo) || !plain(record.repositoryInfo) || !Array.isArray(record.storeLocationInfoList)) throw Error('ROW');
    if (record.tenantId != null && identifier(record.tenantId) !== expected.scope) throw Error('TENANT');
    const sku = identifier(record.skuId), name = text(record.goodsInfo.skuName, 200), spec = specOf(record.goodsInfo);
    if (expected.filters.sku && sku !== expected.filters.sku) throw Error('SKU');
    const repository = record.repositoryInfo, id = identifier(repository.repositoryId), type = identifier(repository.repositoryType);
    if (!request.stores.some(store => store.id === id && store.type === type)) throw Error('STORE');
    const store = text(`${text(repository.repositoryName, 260)}(${id})`, 300);
    if (record.storeLocationInfoList.length > 500) throw Error('LOCATIONS');
    for (const location of record.storeLocationInfoList) {
      if (!plain(location)) throw Error('LOCATION');
      const loc = text(location.locationCode, 27);
      if (!/^[A-Za-z]{1,3}[0-9]{1,3}(?:-[A-Za-z0-9]{1,6}){1,3}$/u.test(loc)) throw Error('LOCATION');
      const wanted = expected.filters.loc?.split('-') || [], actual = loc.split('-');
      if (wanted.some((value, index) => value.toUpperCase() !== actual[index]?.toUpperCase())) continue;
      const row = {sku, name, spec, store, loc}, key = JSON.stringify([id, type, sku, loc]);
      if (unique.has(key)) continue;
      unique.add(key); rows.push(row);
      if (rows.length > 500) throw Error('LIMIT');
    }
  }
  return {rows, pagination:{current:request.page, pageSize:request.pageSize, total:data.total, previous:request.page > 1, next:offset + request.pageSize < data.total}};
}
export function createStockResponseReader({browser=globalThis.window, identity=()=>'', now=()=>Date.now()}={}) {
  let active = null, revision = 0, installed = false;
  function cancel() { if (active) { active.resolve(null); active = null; } }
  function start(url, method, body) {
    let target; try { target = new URL(url, globalThis.location?.href); } catch { return null; }
    if (target.origin !== ORIGIN || target.pathname !== STOCK_PATH) return null;
    revision++;
    const ticket = active;
    const current = identity();
    if (!ticket || current && ticket.scope !== current || ticket.receiving) return null;
    const request = matchStockRequest(url, method, body, ticket);
    if (!request) return null;
    ticket.receiving = true; ticket.revision = revision;
    return {ticket, request, revision, started:now()};
  }
  function finish(capture, status, body) {
    if (!capture || active !== capture.ticket || capture.revision !== revision) return;
    const ticket = capture.ticket;
    try {
      const current = identity();
      if (status !== 200 || current && ticket.scope !== current) throw Error('RESPONSE');
      const result = normalizeStockResponse(body, capture.request, ticket);
      ticket.value = {...result, elapsedMs:Math.max(0, now() - capture.started)};
      ticket.resolve(ticket.value);
    } catch { ticket.resolve(null); }
  }
  function install() {
    if (installed || !browser) return;
    installed = true;
    const proto = browser.XMLHttpRequest?.prototype;
    if (proto && typeof proto.open === 'function' && typeof proto.send === 'function') {
      const open = proto.open, send = proto.send, requests = new WeakMap();
      proto.open = function(method, url, ...args) { requests.delete(this); const result = open.call(this, method, url, ...args); requests.set(this, {method:String(method), url:String(url)}); return result; };
      proto.send = function(body) {
        const meta = requests.get(this), capture = meta && start(meta.url, meta.method, body);
        if (capture) {
          const done = () => { this.removeEventListener('loadend', done); try { const source = !this.responseType || this.responseType === 'text' ? this.responseText : this.responseType === 'json' ? this.response : null; finish(capture, this.status, source); } catch { finish(capture, 0, null); } };
          this.addEventListener('loadend', done);
          try { return send.call(this, body); } catch (error) { this.removeEventListener('loadend', done); finish(capture, 0, null); throw error; }
        }
        return send.call(this, body);
      };
    }
    if (typeof browser.fetch === 'function') {
      const fetch = browser.fetch;
      browser.fetch = function(input, init) {
        const capture = start(typeof input === 'string' || input instanceof URL ? String(input) : input?.url, init?.method || input?.method || 'GET', init?.body);
        const result = fetch.apply(this, arguments);
        if (capture) Promise.resolve(result).then(response => {
          if (response.status !== 200) { finish(capture, response.status, null); return; }
          const clone = response.clone();
          // Consume a bounded copy; the original response remains untouched.
          if (!clone.body?.getReader) { finish(capture, 0, null); return; }
          const reader = clone.body.getReader(), decoder = new TextDecoder();
          (async()=>{let source='', bytes=0;try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>MAX_BODY)throw Error('SIZE');source+=decoder.decode(part.value,{stream:true});}source+=decoder.decode();finish(capture,response.status,source);}catch{void reader.cancel().catch(()=>{});finish(capture,0,null);}finally{reader.releaseLock();}})();
        }).catch(()=>finish(capture, 0, null));
        return result;
      };
    }
  }
  return {
    begin(expected) {
      cancel(); install();
      let resolve; const promise = new Promise(done => resolve = done);
      const ticket = {...expected, promise, resolve, value:null, receiving:false, revision:0};
      if (!expected.scope || expected.scope !== identity()) { resolve(null); return ticket; }
      active = ticket;
      return ticket;
    },
    current(ticket) { return Boolean(ticket && active === ticket && ticket.value && ticket.revision === revision && ticket.scope === identity()); },
    cancel,
  };
}
