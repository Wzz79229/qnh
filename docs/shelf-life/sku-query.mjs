import { normalizeProduct } from './catalog.mjs';

export function normalizeSku(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value.trim())) throw new TypeError('请扫描完整的 SKU 码，不能使用商品名称或网址。');
  return value.trim();
}
function cancelled() { return new DOMException('查询已取消', 'AbortError'); }
function timedOut() {
  const error = new Error('暂未收到牵牛花结果，请重新登录牵牛花后重试。');error.code='QNH_QUERY_TIMEOUT';return error;
}
function completedResult(result, sku, direct=false) {
  if(result?.sku!==sku)throw new Error('查询结果与本次 SKU 不一致，已停止建档。');
  if(direct&&!['found','not_found','ambiguous','error'].includes(result.status)){
    const error=new Error('查询状态无效，请重新查询。');error.code='INVALID_QUERY_STATUS';throw error;
  }
  if(result.status==='found'){
    const product=normalizeProduct(result.product);
    if(product.sku!==sku)throw new Error('牵牛花返回的 SKU 不一致，已停止建档。');
    return product;
  }
  const messages={not_found:'牵牛花没有查到这个 SKU，请核对扫描的是否为 SKU 码。',ambiguous:'牵牛花返回多个对应商品，请管理员检查 SKU。',login_required:'牵牛花登录已失效，请重新登录牵牛花后重试。',expired:'牵牛花查询超时，请重新登录牵牛花后重试。',error:'牵牛花查询失败，请重新登录牵牛花后重试。'};
  const missingImage='此 SKU 的商品主图缺失，请在牵牛花核对后重试。';
  const error=new Error(result.status==='error'&&result.message===missingImage?missingImage:messages[result.status]||'查询状态无效，请重新查询。');
  error.code=result.status||'INVALID_QUERY_STATUS';throw error;
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(cancelled()); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
/** Each call creates a fresh query; no product snapshot or result cache is used. */
export async function lookupSku(store, value, { signal, onProgress, wait = delay, now = Date.now, timeoutMs = 120000 } = {}) {
  const sku = normalizeSku(value);
  if (signal?.aborted) throw cancelled();
  const start = now();
  const ensureActive = () => {
    if (signal?.aborted) throw cancelled();
    if (now() - start >= timeoutMs) throw timedOut();
  };
  const job = await store.createSkuQuery(sku);
  ensureActive();
  // Phone browser sessions finish a fresh query within the submission request.
  // Only an explicit direct response may bypass the legacy job/poll protocol.
  if(job?.mode==='direct')return completedResult(job,sku,true);
  if (typeof job?.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.id)) throw new Error('查询服务返回了无效任务，请重新查询。');
  while (now() - start < timeoutMs) {
    if (signal?.aborted) throw cancelled();
    const result = await store.skuQuery(job.id);
    ensureActive();
    if (result?.id !== job.id || result.sku !== sku) throw new Error('查询结果与本次 SKU 不一致，已停止建档。');
    if (!['pending', 'working'].includes(result.status)) return completedResult(result,sku);
    onProgress?.(result.status === 'working' ? '正在牵牛花查询此 SKU…' : '正在连接牵牛花查询，请保持登录有效…');
    await wait(3000, signal);
  }
  throw timedOut();
}
