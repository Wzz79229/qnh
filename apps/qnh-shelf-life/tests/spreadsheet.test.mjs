import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { exportCSV, importCSV, importRows } from '../dist/core.mjs';

const require = createRequire(import.meta.url);
const XLSX = require('../dist/vendor/xlsx.full.min.js');
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

// These options match the actual browser import path, including formatted dates.
function browserRead(bytes) {
  const workbook = XLSX.read(Uint8Array.from(bytes).buffer, {
    type: 'array', cellDates: true, dateNF: 'yyyy-mm-dd',
  });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1, defval: '', raw: false, dateNF: 'yyyy-mm-dd',
  });
  return { workbook, sheet, rows };
}

test('real Excel date cells import with leading-zero barcode, derived expiry and zero stock', () => {
  assert.equal(XLSX.version, '0.20.3');
  const { workbook, sheet, rows } = browserRead(fixture('import-valid.xlsx'));
  assert.equal(workbook.SheetNames.length, 2);
  assert.equal(sheet.C2.t, 'd', 'production date must be a real Excel date, not date-looking text');
  assert.equal(rows[1][2], '2026-10-10');
  assert.equal(rows.length, 3, 'only the first worksheet supplies imported rows');
  const result = importRows(rows);
  assert.deepEqual(result.errors, []);
  assert.equal(result.records.length, 2);
  const [yogurt, zeroStock] = result.records;
  assert.equal(yogurt.name, '测试导入酸奶');
  assert.equal(yogurt.barcode, '0012345678901');
  assert.equal(yogurt.productionDate, '2026-10-10');
  assert.equal(yogurt.expiryDate, '2026-10-20');
  assert.equal(yogurt.quantity, 5);
  assert.equal(yogurt.unit, '杯');
  assert.equal(zeroStock.name, '测试零库存');
  assert.equal(zeroStock.barcode, '0000000000000');
  assert.equal(zeroStock.quantity, 0);
  assert.equal(zeroStock.expiryDate, '2026-12-01');
});

test('app CSV to XLSX export roundtrip preserves long text barcodes, dates and literal formulas', () => {
  const original = [{
    id: 'qa-xlsx-export', name: '@测试零库存', barcode: '0012345678901234567890',
    productionDate: '2026-10-10', shelfLife: 10, shelfUnit: 'day', expiryDate: '2026-10-20',
    quantity: 0, unit: '杯', category: '乳品', location: '冷藏 A1', batchCode: 'QA-ROUNDTRIP',
    note: '=HYPERLINK("https://example.test","仅为文字")', status: 'active',
    handledReason: '', handledAt: '', updatedAt: '2026-10-15T00:00:00.000Z',
  }];
  const csv = exportCSV(original);
  // The actual browser exporter reads CSV as raw text before writing Excel.
  const exported = XLSX.read(csv, { type: 'string', raw: true });
  const bytes = XLSX.write(exported, { bookType: 'xlsx', type: 'buffer' });
  const { sheet, rows } = browserRead(bytes);
  const noteColumn = rows[0].indexOf('备注');
  const noteCell = sheet[XLSX.utils.encode_cell({ r: 1, c: noteColumn })];
  assert.equal(noteCell.t, 's');
  assert.equal(noteCell.f, undefined, 'spreadsheet formulas must remain inert text');
  const result = importRows(rows);
  assert.deepEqual(result.errors, []);
  assert.equal(result.records.length, 1);
  for (const field of ['name', 'barcode', 'productionDate', 'expiryDate', 'quantity', 'note', 'batchCode']) {
    assert.equal(result.records[0][field], original[0][field], field);
  }
});

test('invalid CSV fixture reports exact bad rows while leaving valid rows available for preview', () => {
  const result = importCSV(fixture('import-invalid.csv').toString('utf8'));
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].name, '测试有效行');
  assert.deepEqual(result.errors.map((error) => error.row), [3, 4]);
  assert.match(result.errors[0].message, /到期日期无效/);
  assert.match(result.errors[1].message, /数量/);
});

test('duplicate record identifiers within one CSV file are rejected at the second row', () => {
  const result = importCSV(fixture('import-duplicate.csv').toString('utf8'));
  assert.equal(result.records.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].row, 3);
  assert.match(result.errors[0].message, /编号重复/);
});
