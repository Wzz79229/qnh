/** Pure calendar, validation and CSV helpers shared by the PWA and its tests. */
export const DEFAULT_SETTINGS = Object.freeze({ urgentDays: 7, warningDays: 30 });
export const CSV_HEADERS = Object.freeze([
  '编号', '商品名称', '条码', '分类', '库位', '批次', '生产日期',
  '保质期', '保质期单位', '到期日期', '数量', '单位', '备注',
  '状态', '处理原因', '处理时间', '更新时间', '删除时间',
]);
const DAY = 86400000;
const FIELDS = [
  'id', 'name', 'barcode', 'category', 'location', 'batchCode', 'productionDate',
  'shelfLife', 'shelfUnit', 'expiryDate', 'quantity', 'unit', 'note',
  'status', 'handledReason', 'handledAt', 'updatedAt', 'deletedAt',
];
const UNITS = { day: '天', month: '月', year: '年' };
const TEXT_FIELDS = ['name', 'barcode', 'category', 'location', 'batchCode', 'unit', 'note', 'handledReason'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.prototype.toString.call(value) === '[object Object]';
}
function calendarDate(year, month, day) {
  if (!Number.isInteger(year) || year < 1 || year > 9999
      || !Number.isInteger(month) || month < 1 || month > 12
      || !Number.isInteger(day) || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function dateNumber(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(year, month - 1, day);
  return value.getTime();
}

/** Today's calendar date in China, independent of the browser/Node time zone. */
export function todayISO(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new TypeError('当前时间无效');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Parse a real date, common spreadsheet date text, or an Excel 1900 date serial. */
export function parseDate(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return calendarDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value === 'number') {
    // Excel serial 60 is the fictitious 1900-02-29, so it must not become a real date.
    const serial = Math.floor(value);
    if (!Number.isFinite(value) || serial < 1 || serial > 2958465 || serial === 60) return null;
    const epoch = serial < 60 ? dateNumber('1899-12-31') : dateNumber('1899-12-30');
    const date = new Date(epoch + serial * DAY);
    return calendarDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text)
    || /^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日?$/.exec(text)
    || /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match) return calendarDate(...match.slice(1).map(Number));
  if (/^\d{5,7}(?:\.\d+)?$/.test(text)) return parseDate(Number(text));
  return null;
}

export function addDays(value, days) {
  const iso = parseDate(value);
  if (!iso || !Number.isInteger(days)) throw new TypeError('日期或天数无效');
  const date = new Date(dateNumber(iso) + days * DAY);
  const result = calendarDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  if (!result) throw new RangeError('日期超出支持范围');
  return result;
}

/** Add the stated shelf life. Month/year additions clamp to that month's last day. */
export function calculateExpiry(productionDate, value, unit = 'day') {
  const iso = parseDate(productionDate);
  const amount = typeof value === 'number' ? value : Number(String(value).trim());
  if (!iso || !Number.isSafeInteger(amount) || amount < 1 || !['day', 'month', 'year'].includes(unit)) {
    throw new TypeError('生产日期、保质期或保质期单位无效');
  }
  if (unit === 'day') return addDays(iso, amount);
  const [year, month, day] = iso.split('-').map(Number);
  const totalMonths = year * 12 + month - 1 + amount * (unit === 'year' ? 12 : 1);
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = totalMonths % 12 + 1;
  if (!Number.isSafeInteger(totalMonths) || targetYear > 9999) throw new RangeError('到期日期超出支持范围');
  const monthEnd = new Date(0);
  monthEnd.setUTCHours(0, 0, 0, 0);
  monthEnd.setUTCFullYear(targetYear, targetMonth, 0);
  return calendarDate(targetYear, targetMonth, Math.min(day, monthEnd.getUTCDate()));
}

export function daysUntil(expiryDate, today = todayISO()) {
  const expiry = parseDate(expiryDate);
  const current = parseDate(today);
  return expiry && current ? Math.round((dateNumber(expiry) - dateNumber(current)) / DAY) : null;
}

export function classify(record, settings = DEFAULT_SETTINGS, today = todayISO()) {
  if (record?.status === 'handled') return 'handled';
  const remaining = daysUntil(record?.expiryDate, today);
  if (remaining === null) return 'normal';
  const urgent = Number.isInteger(settings?.urgentDays) && settings.urgentDays >= 0
    ? settings.urgentDays : DEFAULT_SETTINGS.urgentDays;
  const warning = Number.isInteger(settings?.warningDays) && settings.warningDays >= urgent
    ? settings.warningDays : Math.max(urgent, DEFAULT_SETTINGS.warningDays);
  if (remaining < 0) return 'expired';
  if (remaining === 0) return 'today';
  if (remaining <= urgent) return 'urgent';
  if (remaining <= warning) return 'warning';
  return 'normal';
}

function newId() {
  return globalThis.crypto?.randomUUID?.()
    || `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
function timestamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !parseDate(match[1]) || Number(match[2]) > 23
      || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
function textValue(value) {
  return value == null ? '' : typeof value === 'string' || typeof value === 'number' ? String(value).trim() : null;
}
function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const normalized = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text) ? text.replaceAll(',', '') : text;
  if (!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}
function normalizeUnit(value) {
  if (value != null && typeof value !== 'string') return null;
  const text = value?.trim().toLowerCase();
  if (!text) return 'day';
  if (['天', '日', 'day', 'days', 'd'].includes(text)) return 'day';
  if (['月', '个月', 'month', 'months', 'm'].includes(text)) return 'month';
  if (['年', 'year', 'years', 'y'].includes(text)) return 'year';
  return null;
}

/** Normalize a form/import row. Strict mode requires stored IDs, timestamps and enums. */
export function validateRecord(input, { strict = false } = {}) {
  const errors = [];
  if (!isObject(input)) return { valid: false, errors: ['商品记录必须是对象'], record: null };
  const record = {};
  for (const field of TEXT_FIELDS) {
    record[field] = textValue(input[field]);
    if (record[field] === null) errors.push(`${field} 必须为文字`);
    else if (record[field].length > (field === 'note' ? 20000 : 500)) errors.push(`${field} 内容过长`);
  }
  if (!record.name) errors.push('商品名称不能为空');
  record.unit = record.unit || '件';
  const id = textValue(input.id);
  if ((strict && !id) || (id && (id.length > 160 || /\s|[\u0000-\u001f]/.test(id)
      || ['__proto__', 'constructor', 'prototype'].includes(id)))) errors.push('记录编号无效');
  record.id = id || newId();
  record.productionDate = input.productionDate == null || input.productionDate === '' ? '' : parseDate(input.productionDate);
  if (record.productionDate === null) errors.push('生产日期无效');
  record.shelfUnit = normalizeUnit(input.shelfUnit);
  if (!record.shelfUnit || (strict && (typeof input.shelfUnit !== 'string' || !input.shelfUnit.trim()))) {
    errors.push('保质期单位必须为天、月或年');
  }
  const shelf = input.shelfLife;
  record.shelfLife = shelf == null || shelf === '' ? null : numericValue(shelf);
  if (record.shelfLife !== null && (!Number.isSafeInteger(record.shelfLife) || record.shelfLife < 1)) {
    errors.push('保质期必须为正整数');
  } else if (shelf != null && shelf !== '' && record.shelfLife === null) errors.push('保质期必须为正整数');
  const hasExpiry = input.expiryDate != null && input.expiryDate !== '';
  record.expiryDate = hasExpiry ? parseDate(input.expiryDate) : null;
  if (hasExpiry && !record.expiryDate) errors.push('到期日期无效');
  if (!hasExpiry && record.productionDate && record.shelfLife && record.shelfUnit) {
    try { record.expiryDate = calculateExpiry(record.productionDate, record.shelfLife, record.shelfUnit); }
    catch { errors.push('到期日期超出支持范围'); }
  }
  if (!record.expiryDate && !errors.includes('到期日期无效')) errors.push('请填写到期日期，或生产日期和保质期');
  if (record.productionDate && record.expiryDate && record.expiryDate < record.productionDate) errors.push('到期日期不能早于生产日期');
  record.quantity = numericValue(input.quantity);
  if (record.quantity === null || record.quantity < 0 || record.quantity > Number.MAX_SAFE_INTEGER) errors.push('数量必须为大于或等于 0 的有限数字');
  const status = input.status == null ? 'active'
    : typeof input.status === 'string' ? input.status.trim() || 'active' : null;
  record.status = ['active', '正常', '在库', '未处理'].includes(status) ? 'active'
    : ['handled', '已处理'].includes(status) ? 'handled' : null;
  if (!record.status || (strict && (typeof input.status !== 'string' || !input.status.trim()))) errors.push('商品状态无效');
  if (input.photoRefs !== undefined) {
    if (!Array.isArray(input.photoRefs) || input.photoRefs.length > 3) errors.push('包装照片引用最多为 3 张');
    else {
      const seen = new Set();
      record.photoRefs = [];
      for (const ref of input.photoRefs) {
        if (!isObject(ref) || typeof ref.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ref.id)
          || ref.path !== `photos/${ref.id}.jpg` || seen.has(ref.id)) errors.push('包装照片引用无效或重复');
        else { seen.add(ref.id); record.photoRefs.push({ id: ref.id, path: ref.path }); }
      }
    }
  }
  // Optional catalog association is a snapshot of identity and specification.
  // Production and expiry dates remain batch-specific packaging evidence.
  if (input.productSku !== undefined || input.productSpu !== undefined) {
    for (const field of ['productSku', 'productSpu']) {
      const value = input[field];
      if (typeof value !== 'string' || !value.trim() || value.trim().length > 64
          || /[\s\u0000-\u001f\u007f]/u.test(value.trim())) errors.push(`${field} 商品编号无效`);
      else record[field] = value.trim();
    }
  }
  if (input.spec !== undefined) {
    if (typeof input.spec !== 'string' || input.spec.trim().length > 120
        || /[\u0000-\u001f\u007f]/u.test(input.spec)) errors.push('商品规格无效');
    else record.spec = input.spec.trim();
  }
  for (const field of ['handledAt', 'updatedAt', 'deletedAt']) {
    const value = input[field];
    const absent = value == null || value === '';
    if (absent) {
      if (field === 'updatedAt') {
        if (strict) errors.push('更新时间不能为空');
        record.updatedAt = new Date().toISOString();
      } else if (field === 'handledAt') record.handledAt = '';
    } else {
      const normalized = timestamp(value);
      if (!normalized) errors.push(`${field} 时间格式无效`);
      else record[field] = normalized;
    }
  }
  return { valid: errors.length === 0, errors, record: errors.length ? null : record };
}

export function validateState(input) {
  const errors = [];
  if (!isObject(input)) return { valid: false, errors: ['数据文件必须是对象'], state: null };
  if (input.schemaVersion !== 1) errors.push('不支持的数据版本（需要 schemaVersion: 1）');
  const settings = input.settings;
  if (!isObject(settings) || !Number.isSafeInteger(settings.urgentDays) || settings.urgentDays < 0
      || !Number.isSafeInteger(settings.warningDays) || settings.warningDays < settings.urgentDays) {
    errors.push('提醒设置无效：预警天数应大于或等于紧急天数，且均为非负整数');
  }
  const updatedAt = timestamp(input.updatedAt);
  if (!updatedAt) errors.push('数据文件更新时间无效');
  const records = [];
  const ids = new Set();
  if (!Array.isArray(input.records)) errors.push('商品记录必须是数组');
  else input.records.forEach((entry, index) => {
    const result = validateRecord(entry, { strict: true });
    if (!result.valid) errors.push(`第 ${index + 1} 条记录：${result.errors.join('；')}`);
    else if (ids.has(result.record.id)) errors.push(`第 ${index + 1} 条记录：编号重复`);
    else { ids.add(result.record.id); records.push(result.record); }
  });
  return {
    valid: errors.length === 0,
    errors,
    state: errors.length ? null : {
      schemaVersion: 1, records,
      settings: { urgentDays: settings.urgentDays, warningDays: settings.warningDays }, updatedAt,
    },
  };
}

/** Drop unknown fields, normalize trusted shape, and reject invalid business data. */
export function sanitizeState(input) {
  const result = validateState(input);
  if (!result.valid) {
    const error = new TypeError(result.errors.join('；'));
    error.errors = result.errors;
    throw error;
  }
  return result.state;
}

/** RFC 4180-style CSV reader, including embedded line breaks and BOM. */
export function parseCSV(text) {
  if (typeof text !== 'string') throw new TypeError('CSV 内容必须为文字');
  text = text.replace(/^\uFEFF/, '');
  if (!text) return [];
  const rows = [];
  let row = [], field = '', quoted = false, closed = false, started = false;
  const fieldEnd = () => { row.push(field); field = ''; closed = false; started = false; };
  const rowEnd = () => { fieldEnd(); rows.push(row); row = []; };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; }
        else { quoted = false; closed = true; }
      } else field += char;
      continue;
    }
    if (closed && char !== ',' && char !== '\r' && char !== '\n') {
      throw new SyntaxError(`CSV 第 ${rows.length + 1} 行：引号后存在多余内容`);
    }
    if (char === ',') fieldEnd();
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      rowEnd();
    } else if (char === '"') {
      if (started || field) throw new SyntaxError(`CSV 第 ${rows.length + 1} 行：引号位置无效`);
      quoted = true; started = true;
    } else { field += char; started = true; }
  }
  if (quoted) throw new SyntaxError(`CSV 第 ${rows.length + 1} 行：引号未闭合`);
  if (field || started || closed || row.length) rowEnd();
  return rows;
}

const ALIASES = {
  id: ['编号', '记录编号', 'id'], name: ['商品名称', '商品名', '商品', '名称', '品名', 'name', 'productname'],
  barcode: ['条码', '商品条码', 'barcode'], category: ['分类', '商品分类', '类别', 'category'],
  location: ['库位', '位置', '仓库', '门店', 'location'], batchCode: ['批次', '批次号', 'batchcode', 'batch'],
  productionDate: ['生产日期', '生产时间', '出厂日期', 'productiondate'],
  shelfLife: ['保质期', '保质期数值', '保质期时长', 'shelflife'], shelfUnit: ['保质期单位', 'shelfunit'],
  expiryDate: ['到期日期', '到期日', '过期日期', '有效期至', '截止日期', 'expirydate'],
  quantity: ['数量', '库存', '库存数量', 'quantity'], unit: ['单位', '计量单位', 'unit'],
  note: ['备注', '说明', 'note'], status: ['状态', 'status'], handledReason: ['处理原因', 'handledreason'],
  handledAt: ['处理时间', 'handledat'], updatedAt: ['更新时间', 'updatedat'], deletedAt: ['删除时间', 'deletedat'],
};
const headerKey = (value) => String(value ?? '').replace(/^\uFEFF/, '').replace(/[\s_]/g, '').toLowerCase();
const ALIAS_MAP = new Map(Object.entries(ALIASES).flatMap(([field, aliases]) => aliases.map((alias) => [headerKey(alias), field])));
const dangerousCell = (value) => /^(?:[\t\r\n]|\s*[=+\-@])/.test(value);
function decodeSafeCell(value) {
  return typeof value === 'string' && value.startsWith("'") && dangerousCell(value.slice(1)) ? value.slice(1) : value;
}

/** Import row arrays (header first) or SheetJS-style arrays of objects. No partial mutation. */
export function importRows(rows, { existingRecords = [] } = {}) {
  const records = [], errors = [];
  if (!Array.isArray(rows) || !rows.length) return { records, errors: [{ row: 1, message: '文件没有数据', errors: ['文件没有数据'] }] };
  const objects = isObject(rows[0]);
  // Object-style spreadsheet exports may omit empty cells on the first data row.
  const headers = objects ? [...new Set(rows.filter(isObject).flatMap((row) => Object.keys(row)))] : rows[0];
  if (!Array.isArray(headers)) return { records, errors: [{ row: 1, message: '表头格式无效', errors: ['表头格式无效'] }] };
  const mapped = headers.map((header) => ALIAS_MAP.get(headerKey(header)) || null);
  const seen = new Set();
  for (const field of mapped.filter(Boolean)) {
    if (seen.has(field)) errors.push({ row: 1, message: `重复列：${field}`, errors: [`重复列：${field}`] });
    seen.add(field);
  }
  for (const [field, label] of [['name', '商品名称'], ['quantity', '数量']]) {
    if (!seen.has(field)) errors.push({ row: 1, message: `缺少“${label}”列`, errors: [`缺少“${label}”列`] });
  }
  if (!seen.has('expiryDate') && !(seen.has('productionDate') && seen.has('shelfLife'))) {
    errors.push({ row: 1, message: '缺少到期日期，或生产日期和保质期列', errors: ['缺少到期日期，或生产日期和保质期列'] });
  }
  if (errors.length) return { records, errors };
  const existingIds = new Set(existingRecords.map((record) => record.id));
  const importedIds = new Set();
  const dataRows = objects ? rows : rows.slice(1);
  dataRows.forEach((row, index) => {
    const rowNumber = index + 2;
    if ((!objects && !Array.isArray(row)) || (objects && !isObject(row))) {
      errors.push({ row: rowNumber, message: '数据行格式无效', errors: ['数据行格式无效'] }); return;
    }
    const values = objects ? headers.map((header) => row[header]) : row;
    if (values.every((value) => value == null || String(value).trim() === '')) return;
    if (!objects && values.length !== headers.length) {
      errors.push({ row: rowNumber, message: '列数与表头不一致', errors: ['列数与表头不一致'] }); return;
    }
    const input = {};
    mapped.forEach((field, column) => { if (field) input[field] = decodeSafeCell(values[column]); });
    if (typeof input.shelfLife === 'string') {
      const combined = /^\s*(\d+)\s*(天|日|个月|月|年|days?|months?|years?)\s*$/i.exec(input.shelfLife);
      if (combined) {
        if (input.shelfUnit && normalizeUnit(input.shelfUnit) !== normalizeUnit(combined[2])) {
          errors.push({ row: rowNumber, message: '保质期与保质期单位不一致', errors: ['保质期与保质期单位不一致'] }); return;
        }
        input.shelfLife = Number(combined[1]); input.shelfUnit = normalizeUnit(combined[2]);
      }
    }
    // Adding an exported batch to an existing list creates a fresh row, never overwrites it.
    if (existingIds.has(input.id)) input.id = newId();
    const result = validateRecord(input);
    if (!result.valid) errors.push({ row: rowNumber, message: result.errors.join('；'), errors: result.errors });
    else if (importedIds.has(result.record.id)) errors.push({ row: rowNumber, message: '记录编号重复', errors: ['记录编号重复'] });
    else { importedIds.add(result.record.id); records.push(result.record); }
  });
  if (!records.length && !errors.length) errors.push({ row: 2, message: '文件没有商品记录', errors: ['文件没有商品记录'] });
  return { records, errors };
}

export function importCSV(text, options) {
  try { return importRows(parseCSV(text), options); }
  catch (error) { return { records: [], errors: [{ row: 1, message: error.message, errors: [error.message] }] }; }
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (dangerousCell(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** BOM enables Chinese Excel import; leading formula characters are neutralized. */
export function exportCSV(records) {
  if (!Array.isArray(records)) throw new TypeError('商品记录必须是数组');
  const rows = records.map((input) => {
    const result = validateRecord(input);
    if (!result.valid) throw new TypeError(result.errors.join('；'));
    const record = result.record;
    return FIELDS.map((field) => field === 'shelfUnit' ? UNITS[record.shelfUnit]
      : field === 'status' ? record.status === 'handled' ? '已处理' : '在库' : record[field]);
  });
  return '\uFEFF' + [CSV_HEADERS, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
