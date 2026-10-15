import test from 'node:test';
import assert from 'node:assert/strict';
import {
  todayISO, parseDate, addDays, calculateExpiry, daysUntil, classify,
  validateRecord, validateState, sanitizeState, parseCSV, importCSV, importRows, exportCSV,
} from '../dist/core.mjs';

const NOW = '2026-10-15T08:00:00.000Z';
const baseRecord = (patch = {}) => ({
  id: 'batch-1', name: '纯牛奶', barcode: '06901234567890', category: '乳品', location: '冷藏 A1',
  batchCode: '20261001-A', productionDate: '2026-10-01', shelfLife: 30, shelfUnit: 'day',
  expiryDate: '2026-10-31', quantity: 12, unit: '盒', note: '', status: 'active',
  handledReason: '', handledAt: '', updatedAt: NOW, ...patch,
});
const baseState = (patch = {}) => ({
  schemaVersion: 1, records: [baseRecord()], settings: { urgentDays: 7, warningDays: 30 }, updatedAt: NOW, ...patch,
});

test('Shanghai today crosses UTC midnight without relying on host timezone', () => {
  assert.equal(todayISO('2026-10-14T16:00:00Z'), '2026-10-15');
  assert.equal(todayISO('2026-10-14T15:59:59Z'), '2026-10-14');
  assert.throws(() => todayISO('invalid'), /时间无效/);
});

test('date parsing validates leap years and rejects normalization of impossible dates', () => {
  assert.equal(parseDate('2024/2/29'), '2024-02-29');
  assert.equal(parseDate('2026年10月15日'), '2026-10-15');
  assert.equal(parseDate('20261015'), '2026-10-15');
  assert.equal(parseDate('2026.10.5'), '2026-10-05');
  for (const invalid of ['2026-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '', true, {}]) {
    assert.equal(parseDate(invalid), null);
  }
});

test('Excel dates account for its fictitious leap day', () => {
  assert.equal(parseDate(1), '1900-01-01');
  assert.equal(parseDate(59), '1900-02-28');
  assert.equal(parseDate(60), null);
  assert.equal(parseDate(61), '1900-03-01');
  assert.equal(parseDate(25569), '1970-01-01');
  assert.equal(parseDate(25569.5), '1970-01-01');
  assert.equal(parseDate(Infinity), null);
});

test('shelf life uses calendar addition, with month/year end clamping', () => {
  assert.equal(calculateExpiry('2024-01-31', 1, 'month'), '2024-02-29');
  assert.equal(calculateExpiry('2023-01-31', 1, 'month'), '2023-02-28');
  assert.equal(calculateExpiry('2024-02-29', 1, 'year'), '2025-02-28');
  assert.equal(calculateExpiry('2024-02-29', 4, 'year'), '2028-02-29');
  assert.equal(calculateExpiry('2026-12-31', 2, 'month'), '2027-02-28');
  assert.equal(calculateExpiry('2026-10-01', 30, 'day'), '2026-10-31');
  assert.equal(addDays('2024-02-28', 2), '2024-03-01');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  for (const [date, amount, unit] of [['bad', 1, 'day'], ['2026-10-01', 0, 'day'], ['2026-10-01', 1.5, 'month'], ['2026-10-01', 1, 'week']]) {
    assert.throws(() => calculateExpiry(date, amount, unit));
  }
  assert.throws(() => calculateExpiry('9999-12-31', 1, 'month'), /超出/);
});

test('remaining days and classification include all exact reminder boundaries', () => {
  const today = '2026-10-15';
  for (const [days, expected] of [[-1, 'expired'], [0, 'today'], [1, 'urgent'], [7, 'urgent'], [8, 'warning'], [30, 'warning'], [31, 'normal']]) {
    const record = baseRecord({ expiryDate: addDays(today, days) });
    assert.equal(daysUntil(record.expiryDate, today), days);
    assert.equal(classify(record, undefined, today), expected);
  }
  assert.equal(classify(baseRecord({ status: 'handled', expiryDate: '2000-01-01' }), undefined, today), 'handled');
  assert.equal(classify(baseRecord({ expiryDate: today }), { urgentDays: 0, warningDays: 0 }, today), 'today');
  assert.equal(classify(baseRecord({ expiryDate: addDays(today, 1) }), { urgentDays: 0, warningDays: 0 }, today), 'normal');
  assert.equal(daysUntil('2024-03-01', '2024-02-28'), 2);
  assert.equal(daysUntil('invalid', today), null);
});

test('record validation accepts zero stock and computes a missing expiry', () => {
  const result = validateRecord({ name: '  苹果  ', productionDate: '2026/10/15', shelfLife: '1', shelfUnit: '月', quantity: '0' });
  assert.equal(result.valid, true, result.errors.join(';'));
  assert.equal(result.record.name, '苹果');
  assert.equal(result.record.expiryDate, '2026-11-15');
  assert.equal(result.record.quantity, 0);
  assert.equal(result.record.shelfUnit, 'month');
  assert.equal(result.record.unit, '件');
  assert.equal(result.record.status, 'active');
  assert.ok(result.record.id);
});

test('explicit expiry stays authoritative, but invalid or earlier dates are rejected', () => {
  const result = validateRecord(baseRecord({ expiryDate: '2026-11-02' }));
  assert.equal(result.record.expiryDate, '2026-11-02');
  assert.equal(validateRecord(baseRecord({ expiryDate: '2026-09-30' })).valid, false);
  assert.equal(validateRecord(baseRecord({ expiryDate: 'bad' })).valid, false);
  assert.equal(validateRecord(baseRecord({ productionDate: 'bad' })).valid, false);
});

test('record validation rejects malformed business values rather than coercing them to zero', () => {
  const badPatches = [
    { name: '  ' }, { quantity: '' }, { quantity: 'abc' }, { quantity: -1 }, { quantity: Infinity },
    { quantity: true }, { shelfLife: 0 }, { shelfLife: 1.5 }, { shelfLife: 'abc' },
    { shelfUnit: 'week' }, { status: 'unknown' }, { note: {} }, { id: 'bad id' },
    { updatedAt: '2026-02-30T12:00:00Z' }, { deletedAt: 'yesterday' },
  ];
  for (const patch of badPatches) assert.equal(validateRecord(baseRecord(patch)).valid, false, JSON.stringify(patch));
  assert.equal(validateRecord(null).valid, false);
  assert.equal(validateRecord(baseRecord({ quantity: '1,200.5' })).record.quantity, 1200.5);
});

test('supplied enum values reject objects, arrays, booleans and numbers in forms and stored states', () => {
  for (const field of ['status', 'shelfUnit']) {
    for (const invalid of [{ bad: true }, [], true, false, 0, 1]) {
      const record = baseRecord({ [field]: invalid });
      assert.equal(validateRecord(record).valid, false, `${field}: ${JSON.stringify(invalid)}`);
      assert.equal(validateState(baseState({ records: [record] })).valid, false, `${field}: ${JSON.stringify(invalid)}`);
    }
  }
  const derived = validateRecord({ name: '牛奶', productionDate: '2026-10-01', shelfLife: 1, shelfUnit: {}, quantity: 1 });
  assert.equal(derived.valid, false, 'an invalid unit must not silently derive a day-based expiry');
});

test('new rows receive enum defaults while stored states require explicit nonempty enums', () => {
  const minimal = { name: '牛奶', expiryDate: '2026-10-31', quantity: 1 };
  assert.equal(validateRecord(minimal).record.status, 'active');
  assert.equal(validateRecord(minimal).record.shelfUnit, 'day');
  for (const field of ['status', 'shelfUnit']) {
    for (const missing of [undefined, null, '', '  ']) {
      const record = baseRecord({ [field]: missing });
      assert.equal(validateRecord(record).valid, true, `${field} remains optional for new form/import rows`);
      assert.equal(validateState(baseState({ records: [record] })).valid, false, `${field} is required in stored states`);
    }
  }
});

test('CSV parser supports BOM, quoted commas, quotes, multiline cells and trailing empty fields', () => {
  assert.deepEqual(parseCSV('\uFEFF商品名称,备注,数量\r\n"牛奶,纯","第一行\r\n第二行""引号",0\r\n'), [
    ['商品名称', '备注', '数量'], ['牛奶,纯', '第一行\r\n第二行"引号', '0'],
  ]);
  assert.deepEqual(parseCSV('a,b,\n1,2,'), [['a', 'b', ''], ['1', '2', '']]);
  assert.deepEqual(parseCSV(''), []);
});

test('CSV parser rejects malformed quote structure', () => {
  for (const input of ['"unclosed', 'a"b,c', '"a"junk,b']) assert.throws(() => parseCSV(input), SyntaxError);
  assert.throws(() => parseCSV({}), TypeError);
});

test('Chinese minimal CSV imports preserve barcode zeroes and zero quantity', () => {
  const imported = importCSV('商品名称,到期日期,数量,条码\n牛奶,2026/10/31,0,0012345\n');
  assert.deepEqual(imported.errors, []);
  assert.equal(imported.records[0].barcode, '0012345');
  assert.equal(imported.records[0].quantity, 0);
  assert.equal(imported.records[0].expiryDate, '2026-10-31');
});

test('spreadsheet object rows and combined shelf life units import without dependencies', () => {
  const imported = importRows([
    { 品名: '酸奶', 生产日期: '2024-01-31', 保质期: '1个月', 库存数量: 6, 库位: '冷藏' },
    { 品名: '饼干', 生产日期: 25569, 保质期: '1年', 库存数量: 2, 库位: '常温' },
  ]);
  assert.deepEqual(imported.errors, []);
  assert.equal(imported.records[0].expiryDate, '2024-02-29');
  assert.equal(imported.records[1].expiryDate, '1971-01-01');
});

test('optional spreadsheet columns appearing after the first data row are retained', () => {
  const imported = importRows([
    { 商品名称: 'A', 到期日期: '2026-10-31', 数量: 1 },
    { 商品名称: 'B', 到期日期: '2026-10-31', 数量: 2, 备注: '第二行备注', 条码: '00002' },
  ]);
  assert.deepEqual(imported.errors, []);
  assert.equal(imported.records[1].note, '第二行备注');
  assert.equal(imported.records[1].barcode, '00002');
});

test('malformed rows report their row numbers, while valid rows remain reviewable', () => {
  const imported = importCSV('商品名称,到期日期,数量\n牛奶,2026-10-31,3\n坏日期,2026-02-30,2\n坏数量,2026-11-01,abc\n缺列,2026-11-01\n');
  assert.equal(imported.records.length, 1);
  assert.deepEqual(imported.errors.map((error) => error.row), [3, 4, 5]);
  assert.match(imported.errors[0].message, /日期无效/);
  assert.equal(importCSV('品名,数量\n牛奶,1').records.length, 0);
  assert.match(importCSV('品名,数量\n牛奶,1').errors[0].message, /缺少到期/);
  assert.match(importCSV('商品名称,名称,到期日期,数量\na,a,2026-10-31,2').errors[0].message, /重复列/);
  assert.match(importCSV('商品名称,到期日期,数量\n"bad,2026-10-31,2').errors[0].message, /未闭合/);
  assert.match(importCSV('商品名称,到期日期,数量\n').errors[0].message, /没有商品/);
});

test('conflicting units and duplicate imported IDs are rejected', () => {
  const mixed = importRows([{ 商品名称: '牛奶', 生产日期: '2026-10-01', 保质期: '3个月', 保质期单位: '天', 数量: 1 }]);
  assert.match(mixed.errors[0].message, /不一致/);
  const duplicate = importRows([
    { id: 'same', name: 'A', expiryDate: '2026-10-31', quantity: 1 },
    { id: 'same', name: 'B', expiryDate: '2026-10-31', quantity: 2 },
  ]);
  assert.equal(duplicate.records.length, 1);
  assert.match(duplicate.errors[0].message, /编号重复/);
});

test('CSV export/import round trip preserves complete batch and handling metadata', () => {
  const source = baseRecord({ name: '牛奶,"纯"', note: '第一行\r\n第二行', status: 'handled', handledReason: '报损', handledAt: NOW, deletedAt: NOW });
  const csv = exportCSV([source]);
  assert.ok(csv.startsWith('\uFEFF'));
  const imported = importCSV(csv);
  assert.deepEqual(imported.errors, []);
  assert.deepEqual(imported.records, [source]);
});

test('CSV neutralizes formula injection and imports the original literal text', () => {
  const source = baseRecord({ name: '=HYPERLINK("https://example.test")', barcode: '+00123', note: '@SUM(1,2)', location: '-A1' });
  const csv = exportCSV([source]);
  const row = parseCSV(csv)[1];
  for (const column of [1, 2, 4, 12]) assert.ok(row[column].startsWith("'"), row[column]);
  const imported = importCSV(csv);
  assert.deepEqual(imported.errors, []);
  assert.deepEqual(imported.records, [source]);
});

test('import into an existing list assigns a fresh ID and does not alter the original', () => {
  const original = baseRecord();
  const imported = importCSV(exportCSV([original]), { existingRecords: [original] });
  assert.deepEqual(imported.errors, []);
  assert.notEqual(imported.records[0].id, original.id);
  assert.equal(original.id, 'batch-1');
});

test('state sanitization retains tombstones and removes unknown fields without mutating input', () => {
  const input = baseState({ extra: 'discard', records: [baseRecord({ deletedAt: NOW, extra: 'discard' })] });
  input.settings.extra = 1;
  const state = sanitizeState(input);
  assert.equal(state.records[0].deletedAt, NOW);
  assert.equal('extra' in state, false);
  assert.equal('extra' in state.records[0], false);
  assert.deepEqual(state.settings, { urgentDays: 7, warningDays: 30 });
  assert.equal(input.extra, 'discard');
  assert.notEqual(state.records[0], input.records[0]);
});

test('state validation rejects incompatible versions, duplicate IDs and invalid settings', () => {
  const patches = [
    { schemaVersion: 2 }, { records: {} }, { records: [baseRecord(), baseRecord()] },
    { settings: { urgentDays: -1, warningDays: 30 } }, { settings: { urgentDays: 8, warningDays: 7 } },
    { settings: { urgentDays: '7', warningDays: 30 } }, { updatedAt: 'bad' }, { updatedAt: '' },
    { records: [baseRecord({ id: '' })] }, { records: [baseRecord({ updatedAt: '' })] },
  ];
  for (const patch of patches) {
    const state = baseState(patch);
    assert.equal(validateState(state).valid, false, JSON.stringify(patch));
    assert.throws(() => sanitizeState(state), TypeError);
  }
  assert.equal(validateState(null).valid, false);
  assert.equal(validateState(baseState({ records: [] })).valid, true);
});
