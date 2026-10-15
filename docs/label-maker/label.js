/** Browser-only label renderer. All identifiers remain strings. */
const WIDTH = 945;
const HEIGHT = 709;
const PX_PER_MM = 300 / 25.4;
const POINT = 300 / 72;
const FAMILY = 'Arial, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
const CODE128 = [
  'BaBbBb','BbBaBb','BbBbBa','AbAbBc','AbAcBb','AcAbBb','AbBbAc','AbBcAb','AcBbAb','BbAbAc','BbAcAb','BcAbAb',
  'AaBbCb','AbBaCb','AbBbCa','AaCbBb','AbCaBb','AbCbBa','BbCbAa','BbAaCb','BbAbCa','BaCbAb','BbCaAb','CaBaCa',
  'CaAbBb','CbAaBb','CbAbBa','CaBbAb','CbBaAb','CbBbAa','BaBaBc','BaBcBa','BcBaBa','AaAcBc','AcAaBc','AcAcBa',
  'AaBcAc','AcBaAc','AcBcAa','BaAcAc','BcAaAc','BcAcAa','AaBaCc','AaBcCa','AcBaCa','AaCaBc','AaCcBa','AcCaBa',
  'CaCaBa','BaAcCa','BcAaCa','BaCaAc','BaCcAa','BaCaCa','CaAaBc','CaAcBa','CcAaBa','CaBaAc','CaBcAa','CcBaAa',
  'CaDaAa','BbAdAa','DcAaAa','AaAbBd','AaAdBb','AbAaBd','AbAdBa','AdAaBb','AdAbBa','AaBbAd','AaBdAb','AbBaAd',
  'AbBdAa','AdBaAb','AdBbAa','BdAbAa','BbAaAd','DaCaAa','BdAaAb','AcDaAa','AaAbDb','AbAaDb','AbAbDa','AaDbAb',
  'AbDaAb','AbDbAa','DaAbAb','DbAaAb','DbAbAa','BaBaDa','BaDaBa','DaBaBa','AaAaDc','AaAcDa','AcAaDa','AaDaAc',
  'AaDcAa','DaAaAc','DaAcAa','AaCaDa','AaDaCa','CaAaDa','DaAaCa','BaAdAb','BaAbAd','BaAbCb','BcCaAaB'
];

function asString(value) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error('商品字段必须是文字，SKU 请粘贴完整数字，不要转换为数值。');
  return value.trim();
}

function barcodeFor(sku) {
  if (/\.\.\.|…|⋯/.test(sku)) throw new Error('SKU 中有省略号，请从牵牛花复制完整 SKU 后再生成。');
  if (!/^[\x20-\x7e]+$/.test(sku)) throw new Error('SKU 仅支持英文字母、数字和英文符号，请检查完整 SKU。');
  let codes;
  if (/^\d{4,}$/.test(sku)) {
    codes = [105];
    const pairedLength = sku.length - sku.length % 2;
    for (let index = 0; index < pairedLength; index += 2) codes.push(Number(sku.slice(index, index + 2)));
    if (pairedLength < sku.length) codes.push(100, sku.charCodeAt(pairedLength) - 32);
  } else {
    codes = [104, ...Array.from(sku, character => character.charCodeAt(0) - 32)];
  }
  let checksum = codes[0];
  for (let index = 1; index < codes.length; index++) checksum += codes[index] * index;
  codes.push(checksum % 103, 106);
  let modules = 20; // Ten quiet modules on both sides.
  for (const code of codes) for (const character of CODE128[code]) modules += character.toLowerCase().charCodeAt(0) - 96;
  if (modules * 0.25 > 52) throw new Error('SKU 太长，52 毫米条码区无法保持至少 0.25 毫米的条码模块宽度。');
  return {codes, modules, value: sku};
}

function font(context, size, weight = 700) {
  context.font = `${weight} ${size}px ${FAMILY}`;
}

function wrap(context, value, width) {
  const lines = [];
  for (const paragraph of value.split(/\r?\n/)) {
    if (!paragraph) { lines.push(''); continue; }
    let line = '';
    for (const character of Array.from(paragraph)) {
      if (line && context.measureText(line + character).width > width) {
        lines.push(line);
        line = character;
      } else {
        line += character;
      }
      if (context.measureText(character).width > width) throw new Error('商品名称中存在无法放入标签的字符。');
    }
    lines.push(line);
  }
  return lines;
}

function centeredText(context, text, x, y, width, lineHeight, scale = 1) {
  context.save();
  context.translate(x + width / 2, y + lineHeight / 2);
  context.scale(scale, 1);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, 0, 0);
  context.restore();
}

function drawBarcode(context, barcode, x, y, width, height) {
  const moduleWidth = width / barcode.modules;
  let module = 10;
  for (const code of barcode.codes) {
    for (const character of CODE128[code]) {
      const count = character.toLowerCase().charCodeAt(0) - 96;
      if (character === character.toUpperCase()) {
        const left = Math.round(x + module * moduleWidth);
        const right = Math.round(x + (module + count) * moduleWidth);
        context.fillRect(left, Math.round(y), right - left, Math.round(height));
      }
      module += count;
    }
  }
}

/** @param {{name:string,spec?:string,sku:string,loc:string}} record */
export function renderLabel(record) {
  if (!record || typeof record !== 'object') throw new Error('请先填写商品信息。');
  const fields = {
    name: asString(record.name), spec: asString(record.spec),
    sku: asString(record.sku), loc: asString(record.loc)
  };
  if (!fields.name) throw new Error('请填写商品名称。');
  if (!fields.sku) throw new Error('请填写完整 SKU。');
  if (!fields.loc) throw new Error('请填写库位。');
  if (/[\r\n]/.test(fields.loc)) throw new Error('库位应填写在同一行。');
  if (fields.name.length > 2000 || fields.spec.length > 2000 || fields.loc.length > 200) throw new Error('文字过长，请检查商品信息。');
  const barcode = barcodeFor(fields.sku);
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext('2d', {willReadFrequently: true});
  if (!context) throw new Error('浏览器无法创建标签图片，请尝试更新浏览器。');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = '#000';
  const warnings = [];
  const left = 2.5 * PX_PER_MM;
  const width = WIDTH - 2 * left;
  const gap = PX_PER_MM;
  const nameFont = 11 * POINT;
  const nameLineHeight = nameFont + 2 * PX_PER_MM;
  font(context, nameFont);
  const nameLines = wrap(context, fields.name, width);
  const nameHeight = nameLines.length * nameLineHeight;
  const specFont = 15 * POINT;
  const specLineHeight = specFont + 2 * PX_PER_MM;
  const specLines = fields.spec ? ('规格：' + fields.spec).split(/\r?\n/) : [];
  const specHeight = specLines.length * specLineHeight;
  const barcodeWidth = 52 * PX_PER_MM;
  const barcodeHeight = 8 * PX_PER_MM;
  const skuFont = 18 * POINT;
  const rowHeight = Math.max(barcodeHeight, skuFont * 1.1);
  const skuWidth = width - barcodeWidth - gap;
  const skuText = 'SKU:' + fields.sku.slice(-6);
  font(context, skuFont);
  const skuScale = Math.min(1, skuWidth / context.measureText(skuText).width);
  if (skuScale < 0.50) throw new Error('SKU 文字无法清晰放入标签，请检查 SKU 内容。');
  font(context, specFont);
  const specScales = specLines.map(line => Math.min(1, width / Math.max(1, context.measureText(line).width)));
  if (specScales.some(scale => scale < 0.60)) throw new Error('规格过长，请在规格中添加换行后再生成。');
  if (specScales.some(scale => scale < 1)) warnings.push('较长的规格文字已横向缩小，完整内容保留。');
  let padding = 4 * PX_PER_MM;
  let locationFont = 54 * POINT;
  font(context, locationFont, 900);
  locationFont *= Math.min(1, width / Math.max(1, context.measureText(fields.loc).width));
  const sections = specLines.length ? 4 : 3;
  const fixedHeight = nameHeight + specHeight + rowHeight + gap * (sections - 1);
  if (fixedHeight + locationFont + padding * 2 > HEIGHT) padding = 2.5 * PX_PER_MM;
  locationFont = Math.min(locationFont, HEIGHT - padding * 2 - fixedHeight);
  if (locationFont < 16 * POINT) throw new Error('内容超出 80×60 毫米标签，请精简商品名称或调整规格换行。');
  if (locationFont < 54 * POINT - 0.5) warnings.push('为保留全部内容，库位字号已自动缩小。');
  const totalHeight = fixedHeight + locationFont;
  let y = (HEIGHT - totalHeight) / 2;
  const layout = {
    width: WIDTH, height: HEIGHT, widthMm: 80, heightMm: 60, dpi: 300,
    nameLines: [...nameLines], locationFontPt: locationFont / POINT,
    skuText, fullSku: fields.sku, barcode: {type: 'Code128', value: fields.sku, modules: barcode.modules, x: left + skuWidth + gap, y: 0, width: barcodeWidth, height: barcodeHeight},
    fields: {...fields}
  };
  font(context, nameFont);
  for (const line of nameLines) { centeredText(context, line, left, y, width, nameLineHeight); y += nameLineHeight; }
  y += gap;
  if (specLines.length) {
    font(context, specFont);
    specLines.forEach((line, index) => { centeredText(context, line, left, y, width, specLineHeight, specScales[index]); y += specLineHeight; });
    y += gap;
  }
  font(context, skuFont);
  context.save();
  context.translate(left, y + rowHeight / 2);
  context.scale(skuScale, 1);
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText(skuText, 0, 0);
  context.restore();
  layout.barcode.y = y + (rowHeight - barcodeHeight) / 2;
  drawBarcode(context, barcode, layout.barcode.x, layout.barcode.y, barcodeWidth, barcodeHeight);
  y += rowHeight + gap;
  font(context, locationFont, 900);
  centeredText(context, fields.loc, left, y, width, locationFont);
  // Thermal-label output is strictly black and white; there is no gray dithering.
  const pixels = context.getImageData(0, 0, WIDTH, HEIGHT);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const shade = pixels.data[index] < 128 ? 0 : 255;
    pixels.data[index] = shade;
    pixels.data[index + 1] = shade;
    pixels.data[index + 2] = shade;
    pixels.data[index + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  return {canvas, warnings, layout};
}

const FIELD_ALIASES = {
  '商品名称': 'name', '货品名称': 'name', '名称': 'name', '商品': 'name', 'name': 'name',
  '规格': 'spec', 'spec': 'spec', 'sku': 'sku', 'sku码': 'sku', 'sku编号': 'sku',
  '库位': 'loc', '库位号': 'loc', '库位码': 'loc', 'loc': 'loc', 'location': 'loc',
  'upc': 'upc', 'upc码': 'upc', '商品条码': 'upc', '条码': 'upc'
};

const INCOMPLETE_SKU = /\.{2,}|…|⋯|。{2,}/;

function cleanIdentifier(value) {
  const text = String(value || '').replace(/[ \t]*(?:复制|copy)[ \t]*$/i, '').trim();
  // Whitespace is removed only inside a field known to be a numeric identifier.
  return /^[\d\s.…⋯。]+$/.test(text) ? text.replace(/\s+/g, '') : text;
}

function validSku(value) {
  return typeof value === 'string' && value.trim() !== '' && !INCOMPLETE_SKU.test(value) && /^[\x20-\x7e]+$/.test(value);
}

/** Parse explicit field labels only. UPC never fills an absent/truncated SKU. */
export function parseProductText(text) {
  if (typeof text !== 'string') throw new Error('请粘贴商品信息文字。');
  const result = {name: '', spec: '', sku: '', loc: '', upc: '', warnings: []};
  const expression = /(?:^|[\r\n;；])[ \t]*(商品名称|货品名称|名称|商品|规格|sku编号|sku码|sku|库位号|库位码|库位|location|loc|name|spec|upc码|upc|商品条码|条码)[ \t]*[:：][ \t]*/gi;
  const matches = [...text.matchAll(expression)];
  matches.forEach((match, index) => {
    const key = FIELD_ALIASES[match[1].toLowerCase()];
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const value = text.slice(match.index + match[0].length, end).trim();
    if (result[key] && result[key] !== value) result.warnings.push(`同一字段出现了不同内容：${match[1]}。请核对。`);
    result[key] = value;
  });
  if (!result.sku) {
    const explicitSku = text.match(/\bsku(?:码|编号)?[ \t]*(?:[:：=]|是|为)[ \t]*([^\r\n;；]+)/i);
    if (explicitSku) result.sku = explicitSku[1].trim();
  }
  result.sku = cleanIdentifier(result.sku);
  result.upc = cleanIdentifier(result.upc);
  if (!matches.length && !result.sku) result.warnings.push('未找到带字段名称的内容，请按“商品名称：…；规格：…；SKU：…；库位：…”补充文字。');
  if (INCOMPLETE_SKU.test(result.sku)) result.warnings.push('SKU 中含省略号，请复制完整 SKU；UPC 不会自动替代 SKU。');
  if (!result.sku && result.upc) result.warnings.push('只识别到 UPC，请补充完整 SKU。');
  return result;
}

function normalizedLocation(value) {
  const normalized = value.replace(/[‐‑‒–—−﹣－]/g, '-').trim();
  if (/^[A-Za-z]+[ \t]*\d+(?:[ \t]*-[ \t]*[A-Za-z0-9]+)*$/.test(normalized)) {
    return normalized.replace(/[ \t]+/g, '').toUpperCase();
  }
  return '';
}

function ocrControlLine(value) {
  return !value || /^(?:共\s*(?:找到|有).*?(?:条|个)|搜索\s*$|库存查询|商品库存\s*$|货品库存\s*$|返回\s*$|总\s*库\s*存|可用库存|锁定|长\s*宽\s*高|重\s*量\s*[:：]|设置长宽高|调整库存|调整库位|复制\s*$|\d+\s*张\s*$)/.test(value) || /^[\d\s:+*×%.\-]+$/.test(value);
}

/** Conservative extraction for one QNH product card. */
function parseSingleScreenshotText(text) {
  if (typeof text !== 'string') throw new Error('截图识别结果应为文字。');
  const result = {name: '', spec: '', sku: '', loc: '', upc: '', warnings: []};
  const lines = text.replace(/\u200b/g, '').split(/\r?\n|[；;]/).map(line => line.trim()).filter(Boolean);
  const captured = {name: [], spec: [], sku: [], loc: [], upc: []};
  const metadataIndexes = [];
  const locationIndexes = [];
  const marker = /(^|[ \t])(商品名称|货品名称|名称|规[ \t]*格|s[ \t]*k[ \t]*u(?:码|编号)?|库[ \t]*位(?:码|号)?|u[ \t]*p[ \t]*c(?:码)?)[ \t]*[:：]?[ \t]*/gi;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const matches = [...line.matchAll(marker)];
    for (let item = 0; item < matches.length; item++) {
      const match = matches[item];
      const label = match[2].replace(/[ \t]/g, '').toLowerCase();
      const key = FIELD_ALIASES[label];
      if (!key) continue;
      const end = item + 1 < matches.length ? matches[item + 1].index : line.length;
      let value = line.slice(match.index + match[0].length, end).trim();
      if (key === 'sku' || key === 'upc') {
        // Read only the immediately following value line after blank lines are removed.
        // Do not append subsequent inventory counts to a complete identifier.
        const next = lines[index + 1] || '';
        if (!value && /^\d[\d \t.…⋯。]*(?:[ \t]+(?:复制|copy|[A-Za-z|]+))?$/i.test(next) && (next.match(/\d/g) || []).length >= 6) value = next;
        value = cleanIdentifier(value);
      }
      if ((key === 'name' || key === 'spec') && item === matches.length - 1) {
        let next = index + 1;
        while (next < lines.length && !ocrControlLine(lines[next]) && ![...lines[next].matchAll(marker)].length && !normalizedLocation(lines[next])) {
          value += lines[next++];
        }
      }
      if (key === 'loc') {
        value = normalizedLocation(value) || (value ? '' : normalizedLocation(lines[index + 1] || ''));
        locationIndexes.push(index);
      } else if (key !== 'name') {
        metadataIndexes.push(index);
      }
      if (value) captured[key].push(value);
    }
  }
  for (const key of ['name', 'spec', 'sku', 'loc', 'upc']) {
    const values = [...new Set(captured[key])];
    if (values.length === 1) result[key] = values[0];
    else if (values.length > 1) result.warnings.push(`截图中有多个不同的${({name: '商品名称', spec: '规格', sku: 'SKU', loc: '库位', upc: 'UPC'})[key]}，请裁剪到单个商品后重试。`);
  }
  if (!result.loc && captured.loc.length === 0) {
    const candidates = lines.map(line => normalizedLocation(line.replace(/[ \t]*搜索[ \t]*$/, ''))).filter(Boolean);
    const unique = [...new Set(candidates)];
    if (unique.length === 1) result.loc = unique[0];
  }
  if (!result.name && captured.name.length === 0) {
    const end = metadataIndexes.length ? Math.min(...metadataIndexes) : lines.length;
    const before = locationIndexes.filter(index => index < end);
    const start = before.length ? Math.max(...before) + 1 : 0;
    const names = lines.slice(start, end).filter(line => {
      if (ocrControlLine(line)) return false;
      if (normalizedLocation(line.replace(/[ \t]*搜索[ \t]*$/, ''))) return false;
      return /[\p{L}]/u.test(line);
    });
    // Chinese line wrapping is rejoined without inventing a separator in the name.
    result.name = names.join('');
  }
  if (INCOMPLETE_SKU.test(result.sku)) {
    result.sku = '';
    result.warnings.push('截图中的 SKU 被省略，未采用 UPC 替代。请粘贴完整 SKU。');
  } else if (result.sku && (!validSku(result.sku) || /^\d[\d \t]*[ \t]+[A-Za-z|]+$/.test(result.sku))) {
    result.sku = '';
    result.warnings.push('截图中的 SKU 无法可靠识别，请粘贴完整 SKU。');
  }
  if (!result.sku && result.upc && !result.warnings.some(message => message.includes('SKU'))) result.warnings.push('截图只提供了可见 UPC，仍需完整 SKU；两者不会自动互换。');
  if (!result.name) result.warnings.push('未能可靠识别商品名称，请在整段文字中补充“商品名称：…”。');
  if (!result.loc) result.warnings.push('未能可靠识别库位，请在整段文字中补充“库位：…”。');
  if (captured.sku.length > 1 && new Set(captured.sku).size > 1 || captured.upc.length > 1 && new Set(captured.upc).size > 1) {
    result.sku = '';
    result.name = '';
  }
  result.warnings = [...new Set(result.warnings)];
  return result;
}

function screenshotLocationLine(line) {
  const labelled = line.match(/^库[ \t]*位(?:码|号)?[ \t]*[:：]?[ \t]*(.*)$/);
  return normalizedLocation(labelled ? labelled[1] : line);
}

function screenshotCards(text) {
  const lines = text.replace(/\u200b/g, '').split(/\r?\n|[；;]/).map(line => line.trim()).filter(Boolean);
  const starts = [];
  const badge = /^库[ \t]*位(?:码|号)?[ \t]*[:：]?/;
  const hasBadges = lines.some((line, index) => badge.test(line) && (screenshotLocationLine(line) || normalizedLocation(lines[index + 1] || '')));
  for (let index = 0; index < lines.length; index++) {
    // A location typed in the search bar is not another product card.
    if (hasBadges && !badge.test(lines[index])) continue;
    let loc = screenshotLocationLine(lines[index]);
    // OCR sometimes puts the blue 库位 badge and its code on separate lines.
    if (!loc && /^库[ \t]*位(?:码|号)?[ \t]*[:：]?$/.test(lines[index])) loc = normalizedLocation(lines[index + 1] || '');
    if (!loc) continue;
    if (!hasBadges && !loc.includes('-')) continue;
    if (starts.length && starts[starts.length - 1].loc === loc && starts[starts.length - 1].index === index - 1) continue;
    starts.push({index, loc});
  }
  return starts.map((start, index) => {
    const cardText = lines.slice(start.index, starts[index + 1]?.index ?? lines.length).join('\n');
    const record = parseSingleScreenshotText(cardText);
    record.loc = start.loc;
    // This value is only evidence for selecting a card. It never fills a SKU.
    const skuLine = cardText.match(/(?:^|\n)[ \t]*s[ \t]*k[ \t]*u(?:码|编号)?[ \t]*[:：]?[ \t]*(?:\n[ \t]*)?([^\n]+)/i);
    const skuValue = skuLine ? skuLine[1].replace(/(?:复制|copy).*$/i, '').trim() : '';
    const numericSku = skuValue.match(/^(\d[\d \t]*(?:(?:\.{2,}|…+|⋯+|。{2,})[ \t]*\d[\d \t]*)?)/);
    // A missed/misread location can accidentally merge neighboring cards.
    // Never associate the first SKU in that merged region with its first location.
    const skuCount = [...cardText.matchAll(/(?:^|\n)[ \t]*s[ \t]*k[ \t]*u(?:码|编号)?[ \t]*[:：]?/gi)].length;
    const upcCount = [...cardText.matchAll(/(?:^|\n)[ \t]*u[ \t]*p[ \t]*c(?:码)?[ \t]*[:：]?/gi)].length;
    return {record, visibleSku: numericSku ? numericSku[1].replace(/[ \t]/g, '') : '', ambiguous: skuCount > 1 || upcCount > 1, text: cardText};
  });
}

function visibleSkuMatches(visible, full) {
  if (!/^\d+$/.test(full) || !visible) return false;
  if (!INCOMPLETE_SKU.test(visible)) return visible === full;
  const parts = visible.split(/\.{2,}|…+|⋯+|。{2,}/);
  // Both independently visible ends are required; do not infer a missing ID.
  return parts.length === 2 && parts.every(part => /^\d{3,}$/.test(part)) && parts[0].length + parts[1].length >= 10 &&
    parts[0].length + parts[1].length < full.length && full.startsWith(parts[0]) && full.endsWith(parts[1]);
}

function comparableName(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function nameSimilarity(left, right) {
  const a = comparableName(left), b = comparableName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 8 && (a.includes(b) || b.includes(a))) return 0.98;
  const grams = value => new Set(Array.from({length: Math.max(0, value.length - 1)}, (_, index) => value.slice(index, index + 2)));
  const aa = grams(a), bb = grams(b);
  let shared = 0;
  for (const value of aa) if (bb.has(value)) shared++;
  return aa.size + bb.size ? 2 * shared / (aa.size + bb.size) : 0;
}

function readableComparableNames(target, detected) {
  // The fast English pass cannot read Chinese names. Its ASCII noise is not
  // contradictory product evidence when a long visible SKU already matches.
  return Boolean(target && detected) && !(/[\p{Script=Han}]/u.test(target) && !/[\p{Script=Han}]/u.test(detected));
}

function unmatchedScreenshot(message) {
  return {name: '', spec: '', sku: '', loc: '', upc: '', warnings: [message], matchError: message};
}

/** Match one card in a multi-product screenshot using the user's whole-text fields. */
export function parseScreenshotText(text, {product = {}} = {}) {
  if (typeof text !== 'string') throw new Error('截图识别结果应为文字。');
  const cards = screenshotCards(text);
  const targetSku = typeof product.sku === 'string' && validSku(product.sku) ? cleanIdentifier(product.sku) : '';
  const targetName = typeof product.name === 'string' ? product.name : '';
  if (cards.length < 2) {
    if (cards[0]?.ambiguous) return unmatchedScreenshot('截图中的商品边界未能可靠识别，未选取库位。请换一张更清晰的截图，或裁剪到目标商品后重试。');
    const record = cards[0]?.record || parseSingleScreenshotText(text);
    const visible = cards[0]?.visibleSku || '';
    if (targetSku && visible && !visibleSkuMatches(visible, targetSku)) {
      return unmatchedScreenshot('截图中商品的可见 SKU 与文字不符，未选取库位。请核对完整 SKU 或更换截图。');
    }
    const skuMatches = targetSku && visibleSkuMatches(visible, targetSku);
    if (targetName && record.name && (!skuMatches || readableComparableNames(targetName, record.name)) && nameSimilarity(targetName, record.name) < (skuMatches ? 0.55 : 0.90)) {
      return unmatchedScreenshot('截图中商品名称与文字不一致，未选取库位。请核对商品文字或更换截图。');
    }
    if (skuMatches) record.matchedBy = 'sku';
    else if (targetName && record.name && nameSimilarity(targetName, record.name) >= 0.90) record.matchedBy = 'name';
    return record;
  }
  const scores = cards.map(card => card.ambiguous ? 0 : nameSimilarity(targetName, card.record.name));
  const skuMatches = targetSku ? cards.map((card, index) => !card.ambiguous && visibleSkuMatches(card.visibleSku, targetSku) ? index : -1).filter(index => index >= 0) : [];
  let selected = -1;
  let method = '';
  if (skuMatches.length === 1) {
    selected = skuMatches[0];
    // A contradictory name is evidence that OCR fields or the supplied text need correction.
    const bestOther = Math.max(0, ...scores.filter((_, index) => index !== selected));
    if (readableComparableNames(targetName, cards[selected].record.name) && (scores[selected] < 0.55 || bestOther > scores[selected] + 0.06)) {
      return unmatchedScreenshot('截图中匹配 SKU 的商品名称与文字不一致，未选取库位。请核对商品文字，或换一张包含对应商品的截图。');
    }
    method = '完整 SKU';
  } else if (skuMatches.length > 1) {
    return unmatchedScreenshot('截图中有多个商品的可见 SKU 与文字相符，无法唯一确定库位。请裁剪到目标商品，或在整段文字中补充准确“库位：…”。');
  } else if (targetName) {
    const ranked = scores.map((score, index) => ({score, index})).sort((a, b) => b.score - a.score);
    if (ranked[0].score >= 0.90 && ranked[0].score - ranked[1].score >= 0.08) {
      selected = ranked[0].index;
      const visible = cards[selected].visibleSku;
      if (targetSku && visible && !visibleSkuMatches(visible, targetSku)) {
        return unmatchedScreenshot('截图中同名商品的可见 SKU 与文字不符，未选取库位。请核对完整 SKU 或更换截图。');
      }
      method = '商品名称';
    }
  }
  if (selected < 0) {
    return unmatchedScreenshot('截图中有多个商品，未能按文字中的完整 SKU 或商品名称唯一匹配库位。请核对商品文字、裁剪到目标商品，或在整段文字中补充准确“库位：…”。');
  }
  const record = cards[selected].record;
  record.matchedBy = method === '完整 SKU' ? 'sku' : 'name';
  record.warnings.unshift(`已按${method}匹配到“${targetName || record.name || '对应商品'}”，库位为 ${record.loc}。`);
  return record;
}

function comparableField(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/** Explicit whole-text fields take priority; OCR fills only missing valid fields. */
export function mergeProductSources(textResult, imageResult) {
  const text = textResult || {};
  const image = imageResult || {};
  const merged = {name: '', spec: '', sku: '', loc: '', upc: '', warnings: [], sources: {}};
  const labels = {name: '商品名称', spec: '规格', sku: 'SKU', loc: '库位', upc: 'UPC'};
  for (const key of ['name', 'spec', 'sku', 'loc', 'upc']) {
    const textValue = typeof text[key] === 'string' ? text[key].trim() : '';
    const imageValue = typeof image[key] === 'string' ? image[key].trim() : '';
    const hasText = Boolean(textValue) && (key !== 'sku' || validSku(textValue));
    const hasImage = Boolean(imageValue) && (key !== 'sku' || validSku(imageValue));
    merged[key] = hasText ? textValue : hasImage ? imageValue : '';
    merged.sources[key] = hasText ? 'text' : hasImage ? 'image' : '';
    if (hasText && hasImage && comparableField(textValue) !== comparableField(imageValue)) merged.warnings.push(`${labels[key]}的文字与截图识别结果不同，已采用文字内容，请核对。`);
  }
  for (const warning of [...(text.warnings || []), ...(image.warnings || [])]) {
    if (merged.name && warning.startsWith('未能可靠识别商品名称')) continue;
    if (merged.loc && warning.startsWith('未能可靠识别库位')) continue;
    if (merged.sku && /SKU/i.test(warning) && /(?:省略|被省略|不完整|补充|粘贴|复制|仍需)/.test(warning)) {
      if (merged.sources.sku === 'text' && /截图|UPC/.test(warning)) merged.warnings.push('已采用文字中的完整 SKU，截图中的 UPC 未用作 SKU。');
      continue;
    }
    merged.warnings.push(warning);
  }
  merged.warnings = [...new Set(merged.warnings)];
  return merged;
}

/** Serialize for correction in one composer, never as individual editable fields. */
export function formatProductText(record) {
  const value = record || {};
  const lines = [
    `商品名称：${typeof value.name === 'string' ? value.name : ''}`,
    `规格：${typeof value.spec === 'string' ? value.spec : ''}`,
    `SKU：${typeof value.sku === 'string' ? value.sku : ''}`,
    `库位：${typeof value.loc === 'string' ? value.loc : ''}`
  ];
  if (typeof value.upc === 'string' && value.upc) lines.push(`UPC：${value.upc}`);
  return lines.join('\n');
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function resolutionChunk() {
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([112, 72, 89, 115], 4); // pHYs
  view.setUint32(8, 11811); // 300 dpi expressed as pixels per meter.
  view.setUint32(12, 11811);
  chunk[16] = 1;
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  return chunk;
}

/** Produce a PNG Blob with a verified 300 dpi physical-resolution chunk. */
export async function encodePng(canvas) {
  if (!canvas || canvas.width !== WIDTH || canvas.height !== HEIGHT) throw new Error('标签图片尺寸应为 945×709 像素。');
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(value => value ? resolve(value) : reject(new Error('无法导出图片，请重试。')), 'image/png');
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => bytes[index] === byte)) throw new Error('浏览器未返回有效 PNG 图片。');
  const pieces = [bytes.subarray(0, 8)];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let added = false;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('PNG 图片数据不完整。');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type !== 'pHYs') pieces.push(bytes.subarray(offset, end));
    if (type === 'IHDR') { pieces.push(resolutionChunk()); added = true; }
    offset = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!added || !ended) throw new Error('PNG 图片缺少必要数据。');
  return new Blob(pieces, {type: 'image/png'});
}
