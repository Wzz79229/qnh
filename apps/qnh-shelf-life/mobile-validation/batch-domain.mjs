import { parsePackagingText } from '../dist/photo-parser.mjs';
import { calculateExpiry, parseDate, todayISO } from '../dist/core.mjs';
import { sanitizeProduct, normalizeSku } from '../local-query/extract.mjs';

export function parseBatchDates(value, { today = todayISO() } = {}) {
  if (typeof value !== 'string' || value.length > 24_000) return { complete: false, issues: ['识别文字过多，请只拍生产日期和保质期。'] };
  const parsed = parsePackagingText(value, { today, requireName: false });
  const issues = [...parsed.issues];
  if (!parsed.productionDate) issues.push('请拍清生产日期及其标签。');
  if (!parsed.shelfLife) issues.push('请拍清保质期数值和天、月或年单位。');
  let expiryDate = '';
  if (parsed.productionDate && parsed.shelfLife) {
    try { expiryDate = calculateExpiry(parsed.productionDate, parsed.shelfLife, parsed.shelfUnit); }
    catch { issues.push('到期日期超出支持范围，请重新拍摄。'); }
  }
  if (expiryDate && parsed.expiryDate && expiryDate !== parsed.expiryDate) issues.push('包装到期日期与生产日期、保质期计算结果不一致，请核对。');
  return { productionDate: parsed.productionDate, shelfLife: parsed.shelfLife, shelfUnit: parsed.shelfUnit,
    expiryDate, complete: Boolean(parsed.complete && parsed.productionDate && parsed.shelfLife && expiryDate && !issues.length), issues: [...new Set(issues)] };
}

export function scanSkuValue(raw) {
  if (typeof raw !== 'string' || raw.length > 128) throw new TypeError('请对准一个 SKU 码。');
  return normalizeSku(raw.trim().replace(/^SKU\s*[:：]\s*/iu, ''));
}

/** Device draft only: tenantId here is never proof of backend identity. No image/photo bytes or raw OCR text. */
export function createBatchDraft({ id, tenantId, product, dates, quantity }, { today = todayISO(), now = new Date().toISOString() } = {}) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(id)
    || typeof tenantId !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(tenantId)) throw new TypeError('请重新登录牵牛花后录入。');
  const cleanProduct = sanitizeProduct(product, product?.sku);
  const count = typeof quantity === 'string' && /^[1-9][0-9]{0,6}$/u.test(quantity) ? Number(quantity) : quantity;
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) throw new TypeError('件数应为 1 到 1000000 的整数。');
  if (!dates || dates.complete !== true || !/^\d{4}-\d{2}-\d{2}$/u.test(dates.productionDate || '')
    || parseDate(dates.productionDate) !== dates.productionDate || dates.productionDate > today
    || !Number.isSafeInteger(dates.shelfLife) || dates.shelfLife < 1) throw new TypeError('请先拍清生产日期和保质期。');
  const expiryDate = calculateExpiry(dates.productionDate, dates.shelfLife, dates.shelfUnit);
  if (expiryDate !== dates.expiryDate) throw new TypeError('到期日期校验失败，请重新识别。');
  return { id: id.toLowerCase(), tenantId, product: cleanProduct, productionDate: dates.productionDate,
    shelfLife: dates.shelfLife, shelfUnit: dates.shelfUnit, expiryDate, quantity: count, unit: '件', createdAt: now, syncStatus: 'local' };
}
