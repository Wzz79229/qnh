import { calculateExpiry, daysUntil, parseDate, todayISO } from './core.mjs';

// The parser only reads labels. It never infers a product or a date from layout/branding.
const LABEL_SOURCE = [
  '产品名称', '商品名称', '品名', '名称',
  '生产许可证(?:编号|号)?', '食品生产许可证(?:编号|号)?', '许可证(?:编号|号)?',
  '注册(?:编号|号)?', '备案(?:编号|号)?', '执行标准(?:编号|号)?', '产品标准(?:编号|号)?',
  '生产批号', '批次(?:编号|号)?', '批号', '条形码', '条码',
  '生产日期', '制造日期', '生产(?=[ \\t:：]*(?:\\d|\\n|$))',
  '保质期至', '有效期至', '到期日期', '到期日', '失效日期',
  '保质期(?:限)?(?!至)',
  '净含量', '规格', '配料表', '配料', '贮存条件', '贮存方法', '储存条件', '储存方法',
  '储藏条件', '储藏方法', '生产商', '制造商', '生产厂家', '厂家', '地址', '产地', '电话', '品牌',
].join('|');
const DATE_SOURCE = '(?:\\d{4}[ \\t]*[-/.年][ \\t]*\\d{1,2}[ \\t]*[-/.月][ \\t]*\\d{1,2}[ \\t]*日?|\\d{8})';
const DURATION_SOURCE = '(\\d+(?:\\.\\d+)?)[ \\t]*(个[ \\t]*月|月|年|天|日)';
const IDENTIFIER_LABEL = /^(?:生产许可证|食品生产许可证|许可证|注册|备案|执行标准|产品标准|生产批号|批次|批号|条形码|条码|电话)/;
const NAME_LABEL = /^(?:产品名称|商品名称|品名|名称)$/;
const PRODUCTION_LABEL = /^(?:生产日期|制造日期|生产)$/;
const EXPIRY_LABEL = /^(?:保质期至|有效期至|到期日期|到期日|失效日期)$/;
const SHELF_LABEL = /^保质期(?:限)?$/;

function normalizeOCR(text) {
  return text.normalize('NFKC').replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200d\uFEFF]/g, '')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/(\d)[ \t]+(?=\d)/g, '$1')
    .split('\n').map(line => line.trim()).join('\n').trim();
}

function labelsIn(text) {
  const matches = [];
  for (const match of text.matchAll(new RegExp(LABEL_SOURCE, 'g'))) {
    // A bare 名称 inside 公司名称 / 商标名称 is not a product-name label.
    if (match[0] === '名称' && /[A-Za-z0-9\u3400-\u9fff]/.test(text[match.index - 1] || '')) continue;
    matches.push({ label: match[0], start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

function labelValue(text, labels, index) {
  const label = labels[index];
  const nextLabel = labels[index + 1]?.start ?? text.length;
  let start = label.end;
  let lineEnd = text.indexOf('\n', start);
  if (lineEnd < 0) lineEnd = text.length;
  let end = Math.min(lineEnd, nextLabel);
  const removePrefix = () => {
    const prefix = /^[ \t:：=、;；)]*(?:为[ \t:：]*)?/.exec(text.slice(start, end))[0];
    start += prefix.length;
  };
  removePrefix();
  // A label printed on one line may have its value on the following nonblank line.
  if (!text.slice(start, end).trim() && end === lineEnd && lineEnd < nextLabel) {
    let next = lineEnd + 1;
    while (next < text.length && text[next] === '\n') next++;
    if (next < nextLabel) {
      start = next;
      const nextEnd = text.indexOf('\n', start);
      end = Math.min(nextEnd < 0 ? text.length : nextEnd, nextLabel);
      removePrefix();
    }
  }
  return { start, end, value: text.slice(start, end).trim(), evidence: text.slice(label.start, end).trim() };
}

function dateMatches(text, offset = 0) {
  const found = [];
  for (const match of text.matchAll(new RegExp(DATE_SOURCE, 'g'))) {
    const before = text[match.index - 1] || '';
    const after = text[match.index + match[0].length] || '';
    // Registration IDs, a larger numeric lot and barcode digits are not calendar dates.
    if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) continue;
    const raw = match[0];
    const separated = /^(\d{4})[ \t]*[-/.年][ \t]*(\d{1,2})[ \t]*[-/.月][ \t]*(\d{1,2})[ \t]*日?$/.exec(raw);
    found.push({
      raw, date: parseDate(separated ? `${separated[1]}-${separated[2]}-${separated[3]}` : raw),
      start: offset + match.index, end: offset + match.index + raw.length,
    });
  }
  return found;
}

function eanValid(code) {
  if (!/^(?:\d{8}|\d{13})$/.test(code)) return false;
  let sum = 0;
  for (let index = code.length - 2, position = 0; index >= 0; index--, position++) {
    sum += Number(code[index]) * (position % 2 === 0 ? 3 : 1);
  }
  return (10 - sum % 10) % 10 === Number(code.at(-1));
}

/**
 * Conservative local OCR parser. Missing or conflicting required evidence means retake.
 * Barcode ambiguity is optional and does not prevent an otherwise complete record.
 */
export function parsePackagingText(input, { today = todayISO(), requireName = true } = {}) {
  const result = {
    name: '', productionDate: '', shelfLife: null, shelfUnit: 'day', expiryDate: '', barcode: '',
    complete: false, issues: [], evidence: { name: [], productionDate: [], shelfLife: [], expiryDate: [], barcode: [] },
  };
  const current = parseDate(today);
  if (!current) throw new TypeError('今天的日期无效');
  if (typeof input !== 'string' || !input.trim()) {
    result.issues.push('没有读取到包装文字，请对准商品名称和日期信息重新拍照。');
    return result;
  }
  const text = normalizeOCR(input);
  const labels = labelsIn(text);
  const fields = labels.map((label, index) => ({ ...label, ...labelValue(text, labels, index) }));
  const consumedDates = [];
  const ignoredRanges = fields.filter(field => IDENTIFIER_LABEL.test(field.label));
  let blocked = false;
  const issue = (message, blocking = true) => {
    if (!result.issues.includes(message)) result.issues.push(message);
    if (blocking) blocked = true;
  };

  const names = new Set();
  for (const field of fields.filter(field => NAME_LABEL.test(field.label))) {
    if (field.evidence) result.evidence.name.push(field.evidence);
    const value = field.value.replace(/[ \t;；,，。]+$/, '').trim();
    if (value && value.length <= 80 && /[A-Za-z\u3400-\u9fff]/.test(value)
        && !/^(?:见|详见|参见|同上|待定|未标注|以.*为准)/.test(value)
        && !/^(?:SC\d|GB\s*\d)/i.test(value)) names.add(value);
  }
  if (names.size === 1) result.name = [...names][0];
  else if (names.size > 1) issue('识别到多个不同的商品名称，请只拍摄一件商品并重新拍照。');

  function labeledDates(matcher, fieldName, caption) {
    const dates = new Set();
    let invalid = false;
    for (const field of fields.filter(field => matcher.test(field.label))) {
      if (field.evidence) result.evidence[fieldName].push(field.evidence);
      const matches = dateMatches(field.value, field.start);
      consumedDates.push(...matches);
      for (const match of matches) {
        if (match.date) dates.add(match.date);
        else invalid = true;
      }
      // A truncated/corrupted numeric value after a date label must not be guessed.
      if (!matches.length && /^\d/.test(field.value)) invalid = true;
    }
    if (invalid) issue(`标注的${caption}不是有效完整日期，请拍清楚日期后重试。`);
    if (dates.size > 1) issue(`识别到多个不同的${caption}，请只拍摄当前批次并重新拍照。`);
    return { value: !invalid && dates.size === 1 ? [...dates][0] : '', ambiguous: invalid || dates.size > 1 };
  }

  const production = labeledDates(PRODUCTION_LABEL, 'productionDate', '生产日期');
  const expiry = labeledDates(EXPIRY_LABEL, 'expiryDate', '到期日期');
  result.productionDate = production.value;
  result.expiryDate = expiry.value;

  const durations = new Map();
  let invalidDuration = false;
  for (const field of fields.filter(field => SHELF_LABEL.test(field.label))) {
    if (field.evidence) result.evidence.shelfLife.push(field.evidence);
    if (field.value.split(/[，,；;。]/).some(part => new RegExp(DURATION_SOURCE).test(part)
      && /(?:开封|开启|打开|开瓶|拆封|解冻|冲调|冲泡|复热)后|至少|最多|不超过|不少于|不低于|大于|小于|左右|约\s*\d/.test(part))) {
      invalidDuration = true;
    }
    const matches = [...field.value.matchAll(new RegExp(DURATION_SOURCE, 'g'))];
    for (const match of matches) {
      if (/[\d.+\-/~至到]/.test(field.value[match.index - 1] || '')) { invalidDuration = true; continue; }
      const amount = Number(match[1]);
      const unit = ['天', '日'].includes(match[2]) ? 'day' : match[2] === '年' ? 'year' : 'month';
      if (!Number.isSafeInteger(amount) || amount < 1) invalidDuration = true;
      else durations.set(`${amount}:${unit}`, { amount, unit });
    }
    if (!matches.length && /^\d/.test(field.value)) invalidDuration = true;
  }
  if (invalidDuration) issue('标注的保质期不是有效的正整数天、月或年，请重新拍照。');
  if (durations.size > 1) issue('识别到多个不同的保质期，请拍清当前商品适用的保质期后重试。');
  if (!invalidDuration && durations.size === 1) {
    const duration = [...durations.values()][0];
    result.shelfLife = duration.amount;
    result.shelfUnit = duration.unit;
  }

  // Unlabelled dates are evidence of uncertainty; they are never promoted to production/expiry.
  const unlabelled = dateMatches(text).filter(date => (date.date || /[-/.年月]/.test(date.raw))
    && !consumedDates.some(used => date.start === used.start && date.end === used.end)
    && !ignoredRanges.some(range => date.start >= range.start && date.end <= range.end));
  if (unlabelled.length) issue('还有未标明含义的日期，无法确认是生产日期还是到期日期，请连同日期标签重新拍照。');

  if (result.productionDate && daysUntil(result.productionDate, current) > 0) {
    issue('识别到的生产日期晚于今天，请核对包装并重新拍照。');
  }
  if (result.productionDate && result.expiryDate && result.expiryDate < result.productionDate) {
    issue('到期日期早于生产日期，请拍清完整日期后重试。');
  }
  if (!result.expiryDate && !expiry.ambiguous && result.productionDate && result.shelfLife !== null) {
    try { result.expiryDate = calculateExpiry(result.productionDate, result.shelfLife, result.shelfUnit); }
    catch { issue('生产日期与保质期计算的到期日期超出支持范围，请重新拍照。'); }
  }

  const barcodes = new Set();
  const allDates = dateMatches(text);
  for (const match of text.matchAll(/\d{13}|\d{8}/g)) {
    const start = match.index, end = start + match[0].length;
    if (/[A-Za-z0-9]/.test(text[start - 1] || '') || /[A-Za-z0-9]/.test(text[end] || '')) continue;
    if (allDates.some(date => date.date && start >= date.start && end <= date.end)) continue;
    if (ignoredRanges.some(range => !/^(?:条形码|条码)$/.test(range.label) && start >= range.start && end <= range.end)) continue;
    if (eanValid(match[0])) { barcodes.add(match[0]); result.evidence.barcode.push(match[0]); }
  }
  if (barcodes.size === 1) result.barcode = [...barcodes][0];
  else if (barcodes.size > 1) issue('识别到多个有效条码，未自动选择条码；商品名称和日期信息仍可使用。', false);

  if (requireName && !result.name && names.size <= 1) issue('未识别到明确标注的商品名称，请拍清“产品名称”或“品名”标签。');
  if (!result.expiryDate && !expiry.ambiguous) {
    if (!result.productionDate && !production.ambiguous) issue('未识别到明确标注的生产日期或到期日期，请拍清日期及其标签。');
    else if (result.shelfLife === null && durations.size <= 1 && !invalidDuration) issue('未识别到明确标注的保质期，请拍清保质期数值和单位。');
  }
  result.complete = Boolean((!requireName || result.name) && result.expiryDate && !blocked);
  return result;
}
