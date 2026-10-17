// Server-only evidence from a newly issued product query. No headers, request
// bodies, cookies, browser IDs or provider response bodies leave this module.
const MAX_BODY = 2_000_000;
const skuKey = /^(?:sku|skuId|skuCode|sku_id)$/i;
const nameKey = /^(?:name|spuName|skuName|goodsName|productName|goods_name)$/i;
const querySkuKey = /^(?:sku|skuId|skuCode|sku_id|skus|skuIds|skuList)$/i;

export function requestSelectsSku(request, sku) {
  if (typeof sku !== 'string' || !sku) return false;
  const matches = value => typeof value === 'string' && value === sku
    || Array.isArray(value) && value.length === 1 && value[0] === sku;
  const entriesMatch = entries => [...entries].some(([key, value]) => querySkuKey.test(key) && matches(value));
  try { if (entriesMatch(new URL(request.url).searchParams.entries())) return true; } catch { return false; }
  if (typeof request.postData !== 'string' || request.postData.length > 4096) return false;
  let body;
  try { body = JSON.parse(request.postData); }
  catch { return entriesMatch(new URLSearchParams(request.postData).entries()); }
  const queue = [body]; let count = 0;
  while (queue.length && ++count <= 256) {
    const item = queue.pop();
    if (!item || typeof item !== 'object') continue;
    if (!Array.isArray(item) && entriesMatch(Object.entries(item))) return true;
    for (const value of Object.values(item)) if (value && typeof value === 'object') queue.push(value);
  }
  return false;
}

export function freshEmptyMatches(payload) {
  if (!payload || typeof payload !== 'object' || payload.success === false
    || !([0, 200, '0', '200'].includes(payload.code) || payload.success === true)) return false;
  const data = payload.data;
  if (Array.isArray(data)) return data.length === 0;
  if (!data || typeof data !== 'object') return false;
  if (['total', 'totalCount', 'count'].some(key => data[key] !== undefined && data[key] !== 0 && data[key] !== '0')) return false;
  return ['list', 'records', 'items', 'skuList', 'spuList'].some(key => Array.isArray(data[key]) && data[key].length === 0);
}

function productEndpoint(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://qnh.meituan.com' && !url.username && !url.password
      && /(?:goods|spu|sku|commodity|product)/i.test(url.pathname)
      && !/(?:collect|report|analytics|tracking|telemetry|logger)/i.test(url.pathname);
  } catch { return false; }
}

export function freshProductMatches(payload, product) {
  if (!payload || typeof payload !== 'object' || !product || typeof product.sku !== 'string'
    || typeof product.name !== 'string' || !product.name.trim()) return false;
  if (payload.success === false || payload.code !== undefined && ![0, 200, '0', '200'].includes(payload.code)) return false;
  const exactSku = item => item && typeof item === 'object' && !Array.isArray(item)
    && Object.entries(item).some(([key, value]) => skuKey.test(key) && typeof value === 'string' && value === product.sku);
  const associatedSku = item => exactSku(item) || Object.entries(item).some(([key, value]) =>
    /^(?:skus|skuList|skuInfos|skuInfoList|skuDetails|skuDetailList|skuDTOList|skuVoList)$/i.test(key)
      && Array.isArray(value) && value.length <= 256 && value.some(exactSku));
  const queue = [payload]; let seen = 0;
  while (queue.length) {
    const item = queue.pop();
    if (++seen > 30_000) return false;
    if (!item || typeof item !== 'object') continue;
    const sameName = !Array.isArray(item) && Object.entries(item).some(([key, value]) =>
      nameKey.test(key) && typeof value === 'string' && value.trim() === product.name.trim());
    if (sameName && associatedSku(item)) return true;
    for (const [key, value] of Object.entries(item)) {
      // Large SKU values must remain strings; rounding a JSON number never proves a match.
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return false;
}

export function createQnhProductReceipt(cdp, { frameId, sku } = {}) {
  const requests = new Map(), reads = [], payloads = [];
  let stopped = false, disposed = false;
  const removeRequest = cdp.on('Network.requestWillBeSent', event => {
    if (stopped || requests.size >= 24 || !['Fetch', 'XHR'].includes(event.type)
      || frameId && event.frameId !== frameId
      || !['GET', 'POST'].includes(event.request?.method) || !productEndpoint(event.request?.url)) return;
    // A redirect chain cannot inherit a previously accepted request ID.
    if (event.redirectResponse) { requests.delete(event.requestId); return; }
    requests.set(event.requestId, { ok: false, url: event.request.url, type: event.type,
      selectsSku: requestSelectsSku(event.request, sku) });
  });
  const removeResponse = cdp.on('Network.responseReceived', event => {
    const entry = requests.get(event.requestId), response = event.response;
    if (!entry || !response) return;
    entry.ok = response.status >= 200 && response.status < 300 && productEndpoint(response.url)
      && response.url === entry.url && event.type === entry.type && (!frameId || event.frameId === frameId)
      && !response.fromDiskCache && !response.fromServiceWorker && !response.fromPrefetchCache
      && /(?:application|text)\/(?:[a-z0-9.+-]*\+)?json/i.test(response.mimeType || '');
  });
  const removeFailed = cdp.on('Network.loadingFailed', event => { requests.delete(event.requestId); });
  const removeCached = cdp.on('Network.requestServedFromCache', event => { requests.delete(event.requestId); });
  const removeFinished = cdp.on('Network.loadingFinished', event => {
    const entry = requests.get(event.requestId); requests.delete(event.requestId);
    if (stopped || !entry?.ok || event.encodedDataLength > MAX_BODY || reads.length >= 16) return;
    reads.push((async () => {
      try {
        const result = await cdp.send('Network.getResponseBody', { requestId: event.requestId });
        if (typeof result.body !== 'string' || result.body.length > MAX_BODY) return;
        const text = result.base64Encoded
          ? new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(result.body), value => value.charCodeAt(0)))
          : result.body;
        if (text.length > MAX_BODY) return;
        const payload = JSON.parse(text);
        if (!disposed && payload && typeof payload === 'object') payloads.push({ payload, selectsSku: entry.selectsSku });
      } catch { /* An incomplete or non-JSON response cannot authorize. */ }
    })());
  });
  const remove = () => { stopped = true; removeRequest(); removeResponse(); removeFailed(); removeCached(); removeFinished(); requests.clear(); };
  return {
    async matches(product) {
      remove();
      await Promise.all(reads);
      const matched = payloads.some(item => freshProductMatches(item.payload, product));
      payloads.length = 0;
      return matched;
    },
    async empty() {
      remove(); await Promise.all(reads);
      const matched = payloads.some(item => item.selectsSku && freshEmptyMatches(item.payload));
      payloads.length = 0;
      return matched;
    },
    close() { disposed = true; remove(); payloads.length = 0; },
  };
}
