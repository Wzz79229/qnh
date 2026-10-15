import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePackagingText } from '../dist/photo-parser.mjs';

const options = { today: '2026-10-15' };
const parse = text => parsePackagingText(text, options);

test('parses explicitly labeled product, production and shelf life, preserving evidence', () => {
  const result = parse('产品名称：纯牛奶\n生产日期：2026.10.01\n保质期：180天\n净含量：250mL');
  assert.equal(result.complete, true, result.issues.join(';'));
  assert.equal(result.name, '纯牛奶');
  assert.equal(result.productionDate, '2026-10-01');
  assert.equal(result.shelfLife, 180);
  assert.equal(result.shelfUnit, 'day');
  assert.equal(result.expiryDate, '2027-03-30');
  assert.match(result.evidence.productionDate[0], /生产日期/);
  assert.deepEqual(result.issues, []);
});

test('normalizes fullwidth OCR digits and spaces within calendar digits', () => {
  const result = parse('品名：全脂奶\n制造日期：２０２６ 年 １ ０ 月 ０ １ 日\n保质期：１ ２ 个 月');
  assert.equal(result.complete, true, result.issues.join(';'));
  assert.equal(result.productionDate, '2026-10-01');
  assert.equal(result.expiryDate, '2027-10-01');
  assert.equal(result.shelfUnit, 'month');
});

test('supports compact production date and labels with next-line values', () => {
  const result = parse('产品名称\n原味酸奶\n生产日期\n20261001\n保质期\n21天');
  assert.equal(result.complete, true, result.issues.join(';'));
  assert.equal(result.name, '原味酸奶');
  assert.equal(result.productionDate, '2026-10-01');
  assert.equal(result.expiryDate, '2026-10-22');
});

test('generic 生产 label is accepted only directly before a date', () => {
  const result = parse('品名：饼干\n生产 20260131\n保质期1个月');
  assert.equal(result.complete, true, result.issues.join(';'));
  assert.equal(result.expiryDate, '2026-02-28');
});

test('calendar month clamp and leap-year shelf life match core semantics', () => {
  const month = parse('名称：奶粉\n生产日期2024-01-31\n保质期1个月');
  assert.equal(month.expiryDate, '2024-02-29');
  assert.equal(month.complete, true);
  const year = parse('名称：罐头\n生产日期2024年2月29日\n保质期1年');
  assert.equal(year.expiryDate, '2025-02-28');
  assert.equal(year.shelfUnit, 'year');
});

test('explicit expiry alone is sufficient and stays authoritative over a calculated date', () => {
  const simple = parse('产品名称：白砂糖\n有效期至：2027-10-01');
  assert.equal(simple.complete, true, simple.issues.join(';'));
  assert.equal(simple.productionDate, '');
  const both = parse('品名：纯牛奶\n生产日期2026-10-01\n保质期30天\n到期日期2026-11-02');
  assert.equal(both.complete, true, both.issues.join(';'));
  assert.equal(both.expiryDate, '2026-11-02');
});

test('expiry label 保质期至 is not mistaken for a shelf life duration', () => {
  const result = parse('品名：茶饮料 保质期至：2027.02.10');
  assert.equal(result.complete, true, result.issues.join(';'));
  assert.equal(result.expiryDate, '2027-02-10');
  assert.equal(result.shelfLife, null);
});

test('same-line fields are separated before names or durations swallow other labels', () => {
  const result = parse('品名:纯牛奶 净含量:250mL 生产日期:20261001 保质期:6个月 贮存条件:常温');
  assert.equal(result.complete, true, result.issues.join(';'));
  assert.equal(result.name, '纯牛奶');
  assert.equal(result.expiryDate, '2027-04-01');
});

test('parenthesized explicit name aliases do not enter the extracted name', () => {
  const result = parse('产品名称（品名）：纯牛奶\n有效期至2027-01-01');
  assert.equal(result.complete, true, result.issues.join(';'));
  assert.equal(result.name, '纯牛奶');
});

test('brand and random text cannot be guessed as the product name', () => {
  for (const text of [
    '某某牧场\n纯牛奶\n生产日期20261001\n保质期180天',
    '品牌：某某牌\n公司名称：某某食品有限公司\n生产日期20261001\n保质期180天',
  ]) {
    const result = parse(text);
    assert.equal(result.name, '');
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(issue => issue.includes('商品名称')));
  }
});

test('a next-line packaging label is never accepted as the product name', () => {
  const result = parse('产品名称：\n生产日期：20261001\n保质期：180天');
  assert.equal(result.name, '');
  assert.equal(result.complete, false);
});

test('placeholder name text requires retaking the name label', () => {
  const result = parse('产品名称：见正面\n有效期至2027-10-01');
  assert.equal(result.name, '');
  assert.equal(result.complete, false);
});

test('unlabelled dates are flagged and never promoted to production or expiry', () => {
  const result = parse('品名：纯牛奶\n20261001\n保质期180天');
  assert.equal(result.productionDate, '');
  assert.equal(result.expiryDate, '');
  assert.equal(result.complete, false);
  assert.ok(result.issues.some(issue => issue.includes('未标明含义')));
});

test('extra unlabelled dates block guessing even if another valid expiry is present', () => {
  const result = parse('品名：纯牛奶\n有效期至2027-10-01\n20261001');
  assert.equal(result.expiryDate, '2027-10-01');
  assert.equal(result.complete, false);
  assert.ok(result.issues.some(issue => issue.includes('未标明含义')));
});

test('registration, permit, batch and standard numbers do not become dates or barcode evidence', () => {
  const result = parse('品名：牛奶\n生产许可证编号：SC2026100100001\n备案号：20261001\n执行标准：GB20261015\n批号：20261001\n有效期至2027-01-01');
  assert.equal(result.complete, true, result.issues.join(';'));
  assert.equal(result.productionDate, '');
  assert.equal(result.barcode, '');
  assert.deepEqual(result.issues, []);
});

test('production permit digits cannot satisfy a production date requirement', () => {
  const result = parse('品名：牛奶\n生产许可证：SC20261001\n保质期12个月');
  assert.equal(result.productionDate, '');
  assert.equal(result.complete, false);
});

test('conflicting explicitly labeled production dates are rejected without selecting one', () => {
  const result = parse('品名：牛奶\n生产日期20261001\n制造日期20261002\n保质期30天');
  assert.equal(result.productionDate, '');
  assert.equal(result.expiryDate, '');
  assert.equal(result.complete, false);
  assert.ok(result.issues.some(issue => issue.includes('多个不同的生产日期')));
});

test('two dates after a single production label are also ambiguous', () => {
  const result = parse('品名：牛奶\n生产日期：2026-10-01 / 2026-10-02\n保质期30天');
  assert.equal(result.productionDate, '');
  assert.equal(result.complete, false);
});

test('repeated identical dates and durations are acceptable evidence', () => {
  const result = parse('品名：牛奶\n生产日期20261001\n制造日期2026.10.01\n保质期30天\n保质期30日');
  assert.equal(result.complete, true, result.issues.join(';'));
  assert.equal(result.expiryDate, '2026-10-31');
});

test('multiple shelf lives or conditional durations require a retake', () => {
  for (const durations of ['保质期6个月\n保质期12个月', '保质期：常温6个月，冷藏12个月']) {
    const result = parse(`品名：牛奶\n生产日期20261001\n${durations}`);
    assert.equal(result.shelfLife, null);
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(issue => issue.includes('多个不同的保质期')));
  }
});

test('conflicting explicit expiry dates never fall back to the derived expiry', () => {
  const result = parse('品名：牛奶\n生产日期20261001\n保质期30天\n有效期至20261031\n到期日期20261101');
  assert.equal(result.expiryDate, '');
  assert.equal(result.complete, false);
});

test('invalid and truncated date values are flagged instead of normalized or guessed', () => {
  for (const date of ['2026-02-30', '2026-13-01', '2026100', '202610011234']) {
    const result = parse(`品名：牛奶\n生产日期${date}\n保质期30天`);
    assert.equal(result.productionDate, '', date);
    assert.equal(result.complete, false, date);
    assert.ok(result.issues.some(issue => issue.includes('有效完整日期')), date);
  }
});

test('zero, fractional or missing-unit shelf lives do not become expiry dates', () => {
  for (const duration of ['0天', '1.5个月', '180', '-1天', '1/2年', '12至18个月', '12~18个月']) {
    const result = parse(`品名：牛奶\n生产日期20261001\n保质期${duration}`);
    assert.equal(result.shelfLife, null, duration);
    assert.equal(result.expiryDate, '', duration);
    assert.equal(result.complete, false, duration);
  }
});

test('after-opening instructions and approximate durations are not exact shelf life evidence', () => {
  for (const duration of ['开封后7天内饮用', '7天（开封后）', '至少12个月', '约12个月', '12个月左右']) {
    const result = parse(`品名：牛奶\n生产日期20261001\n保质期：${duration}`);
    assert.equal(result.shelfLife, null, duration);
    assert.equal(result.expiryDate, '', duration);
    assert.equal(result.complete, false, duration);
  }
  assert.equal(parse('品名：牛奶\n生产日期20261001\n保质期12个月，开封后尽快食用').complete, true);
});

test('future production dates and expiry before production require a retake', () => {
  const future = parse('品名：牛奶\n生产日期20261016\n保质期30天');
  assert.equal(future.complete, false);
  assert.ok(future.issues.some(issue => issue.includes('晚于今天')));
  const reverse = parse('品名：牛奶\n生产日期20261001\n有效期至20260930');
  assert.equal(reverse.complete, false);
  assert.ok(reverse.issues.some(issue => issue.includes('早于生产日期')));
});

test('today production and already expired packaging remain valid records', () => {
  assert.equal(parse('品名：牛奶\n生产日期20261015\n保质期1天').complete, true);
  assert.equal(parse('品名：牛奶\n有效期至2026-01-01').complete, true);
});

test('EAN-13 and EAN-8 require the correct check digit; barcode is optional', () => {
  const ean13 = parse('品名：牛奶\n有效期至2027-01-01\n条码：6901234567892');
  assert.equal(ean13.barcode, '6901234567892');
  assert.equal(ean13.complete, true);
  const ean8 = parse('品名：牛奶\n有效期至2027-01-01\n条码：96385074');
  assert.equal(ean8.barcode, '96385074');
  const bad = parse('品名：牛奶\n有效期至2027-01-01\n条码：6901234567891');
  assert.equal(bad.barcode, '');
  assert.equal(bad.complete, true);
  assert.equal(parse('品名：牛奶\n有效期至2027-01-01').complete, true);
});

test('multiple barcodes stay unset without blocking complete required fields', () => {
  const result = parse('品名：牛奶\n有效期至2027-01-01\n条码6901234567892\n96385074');
  assert.equal(result.barcode, '');
  assert.equal(result.complete, true);
  assert.ok(result.issues.some(issue => issue.includes('多个有效条码')));
});

test('multiple product names require a retake of one item', () => {
  const result = parse('品名：牛奶\n品名：酸奶\n有效期至2027-01-01');
  assert.equal(result.name, '');
  assert.equal(result.complete, false);
});

test('empty OCR and unsupported input return an actionable incomplete result', () => {
  for (const value of ['', '  ', null, {}, undefined]) {
    const result = parse(value);
    assert.equal(result.complete, false);
    assert.equal(result.issues.length, 1);
    assert.ok(result.issues[0].includes('重新拍照'));
  }
  assert.throws(() => parsePackagingText('品名：牛奶', { today: 'invalid' }), /日期无效/);
});
