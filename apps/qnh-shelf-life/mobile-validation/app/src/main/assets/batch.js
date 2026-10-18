(() => {
  // dist/core.mjs
  var DEFAULT_SETTINGS = Object.freeze({ urgentDays: 7, warningDays: 30 });
  var CSV_HEADERS = Object.freeze([
    "\u7F16\u53F7",
    "\u5546\u54C1\u540D\u79F0",
    "\u6761\u7801",
    "\u5206\u7C7B",
    "\u5E93\u4F4D",
    "\u6279\u6B21",
    "\u751F\u4EA7\u65E5\u671F",
    "\u4FDD\u8D28\u671F",
    "\u4FDD\u8D28\u671F\u5355\u4F4D",
    "\u5230\u671F\u65E5\u671F",
    "\u6570\u91CF",
    "\u5355\u4F4D",
    "\u5907\u6CE8",
    "\u72B6\u6001",
    "\u5904\u7406\u539F\u56E0",
    "\u5904\u7406\u65F6\u95F4",
    "\u66F4\u65B0\u65F6\u95F4",
    "\u5220\u9664\u65F6\u95F4"
  ]);
  var DAY = 864e5;
  function calendarDate(year, month, day) {
    if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) return null;
    const date = /* @__PURE__ */ new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  function dateNumber(iso) {
    const [year, month, day] = iso.split("-").map(Number);
    const value = /* @__PURE__ */ new Date(0);
    value.setUTCHours(0, 0, 0, 0);
    value.setUTCFullYear(year, month - 1, day);
    return value.getTime();
  }
  function todayISO(now = /* @__PURE__ */ new Date()) {
    const date = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(date.getTime())) throw new TypeError("\u5F53\u524D\u65F6\u95F4\u65E0\u6548");
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const get = (type) => {
      var _a;
      return (_a = parts.find((part) => part.type === type)) == null ? void 0 : _a.value;
    };
    return `${get("year")}-${get("month")}-${get("day")}`;
  }
  function parseDate(value) {
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) return null;
      return calendarDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
    }
    if (typeof value === "number") {
      const serial = Math.floor(value);
      if (!Number.isFinite(value) || serial < 1 || serial > 2958465 || serial === 60) return null;
      const epoch = serial < 60 ? dateNumber("1899-12-31") : dateNumber("1899-12-30");
      const date = new Date(epoch + serial * DAY);
      return calendarDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    }
    if (typeof value !== "string") return null;
    const text2 = value.trim();
    let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text2) || /^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日?$/.exec(text2) || /^(\d{4})(\d{2})(\d{2})$/.exec(text2);
    if (match) return calendarDate(...match.slice(1).map(Number));
    if (/^\d{5,7}(?:\.\d+)?$/.test(text2)) return parseDate(Number(text2));
    return null;
  }
  function addDays(value, days) {
    const iso = parseDate(value);
    if (!iso || !Number.isInteger(days)) throw new TypeError("\u65E5\u671F\u6216\u5929\u6570\u65E0\u6548");
    const date = new Date(dateNumber(iso) + days * DAY);
    const result = calendarDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    if (!result) throw new RangeError("\u65E5\u671F\u8D85\u51FA\u652F\u6301\u8303\u56F4");
    return result;
  }
  function calculateExpiry(productionDate, value, unit = "day") {
    const iso = parseDate(productionDate);
    const amount = typeof value === "number" ? value : Number(String(value).trim());
    if (!iso || !Number.isSafeInteger(amount) || amount < 1 || !["day", "month", "year"].includes(unit)) {
      throw new TypeError("\u751F\u4EA7\u65E5\u671F\u3001\u4FDD\u8D28\u671F\u6216\u4FDD\u8D28\u671F\u5355\u4F4D\u65E0\u6548");
    }
    if (unit === "day") return addDays(iso, amount);
    const [year, month, day] = iso.split("-").map(Number);
    const totalMonths = year * 12 + month - 1 + amount * (unit === "year" ? 12 : 1);
    const targetYear = Math.floor(totalMonths / 12);
    const targetMonth = totalMonths % 12 + 1;
    if (!Number.isSafeInteger(totalMonths) || targetYear > 9999) throw new RangeError("\u5230\u671F\u65E5\u671F\u8D85\u51FA\u652F\u6301\u8303\u56F4");
    const monthEnd = /* @__PURE__ */ new Date(0);
    monthEnd.setUTCHours(0, 0, 0, 0);
    monthEnd.setUTCFullYear(targetYear, targetMonth, 0);
    return calendarDate(targetYear, targetMonth, Math.min(day, monthEnd.getUTCDate()));
  }
  function daysUntil(expiryDate, today = todayISO()) {
    const expiry = parseDate(expiryDate);
    const current = parseDate(today);
    return expiry && current ? Math.round((dateNumber(expiry) - dateNumber(current)) / DAY) : null;
  }
  var ALIASES = {
    id: ["\u7F16\u53F7", "\u8BB0\u5F55\u7F16\u53F7", "id"],
    name: ["\u5546\u54C1\u540D\u79F0", "\u5546\u54C1\u540D", "\u5546\u54C1", "\u540D\u79F0", "\u54C1\u540D", "name", "productname"],
    barcode: ["\u6761\u7801", "\u5546\u54C1\u6761\u7801", "barcode"],
    category: ["\u5206\u7C7B", "\u5546\u54C1\u5206\u7C7B", "\u7C7B\u522B", "category"],
    location: ["\u5E93\u4F4D", "\u4F4D\u7F6E", "\u4ED3\u5E93", "\u95E8\u5E97", "location"],
    batchCode: ["\u6279\u6B21", "\u6279\u6B21\u53F7", "batchcode", "batch"],
    productionDate: ["\u751F\u4EA7\u65E5\u671F", "\u751F\u4EA7\u65F6\u95F4", "\u51FA\u5382\u65E5\u671F", "productiondate"],
    shelfLife: ["\u4FDD\u8D28\u671F", "\u4FDD\u8D28\u671F\u6570\u503C", "\u4FDD\u8D28\u671F\u65F6\u957F", "shelflife"],
    shelfUnit: ["\u4FDD\u8D28\u671F\u5355\u4F4D", "shelfunit"],
    expiryDate: ["\u5230\u671F\u65E5\u671F", "\u5230\u671F\u65E5", "\u8FC7\u671F\u65E5\u671F", "\u6709\u6548\u671F\u81F3", "\u622A\u6B62\u65E5\u671F", "expirydate"],
    quantity: ["\u6570\u91CF", "\u5E93\u5B58", "\u5E93\u5B58\u6570\u91CF", "quantity"],
    unit: ["\u5355\u4F4D", "\u8BA1\u91CF\u5355\u4F4D", "unit"],
    note: ["\u5907\u6CE8", "\u8BF4\u660E", "note"],
    status: ["\u72B6\u6001", "status"],
    handledReason: ["\u5904\u7406\u539F\u56E0", "handledreason"],
    handledAt: ["\u5904\u7406\u65F6\u95F4", "handledat"],
    updatedAt: ["\u66F4\u65B0\u65F6\u95F4", "updatedat"],
    deletedAt: ["\u5220\u9664\u65F6\u95F4", "deletedat"]
  };
  var headerKey = (value) => String(value ?? "").replace(/^\uFEFF/, "").replace(/[\s_]/g, "").toLowerCase();
  var ALIAS_MAP = new Map(Object.entries(ALIASES).flatMap(([field, aliases]) => aliases.map((alias) => [headerKey(alias), field])));

  // dist/photo-parser.mjs
  var LABEL_SOURCE = [
    "\u4EA7\u54C1\u540D\u79F0",
    "\u5546\u54C1\u540D\u79F0",
    "\u54C1\u540D",
    "\u540D\u79F0",
    "\u751F\u4EA7\u8BB8\u53EF\u8BC1(?:\u7F16\u53F7|\u53F7)?",
    "\u98DF\u54C1\u751F\u4EA7\u8BB8\u53EF\u8BC1(?:\u7F16\u53F7|\u53F7)?",
    "\u8BB8\u53EF\u8BC1(?:\u7F16\u53F7|\u53F7)?",
    "\u6CE8\u518C(?:\u7F16\u53F7|\u53F7)?",
    "\u5907\u6848(?:\u7F16\u53F7|\u53F7)?",
    "\u6267\u884C\u6807\u51C6(?:\u7F16\u53F7|\u53F7)?",
    "\u4EA7\u54C1\u6807\u51C6(?:\u7F16\u53F7|\u53F7)?",
    "\u751F\u4EA7\u6279\u53F7",
    "\u6279\u6B21(?:\u7F16\u53F7|\u53F7)?",
    "\u6279\u53F7",
    "\u6761\u5F62\u7801",
    "\u6761\u7801",
    "\u751F\u4EA7\u65E5\u671F",
    "\u5236\u9020\u65E5\u671F",
    "\u751F\u4EA7(?=[ \\t:\uFF1A]*(?:\\d|\\n|$))",
    "\u4FDD\u8D28\u671F\u81F3",
    "\u6709\u6548\u671F\u81F3",
    "\u5230\u671F\u65E5\u671F",
    "\u5230\u671F\u65E5",
    "\u5931\u6548\u65E5\u671F",
    "\u4FDD\u8D28\u671F(?:\u9650)?(?!\u81F3)",
    "\u51C0\u542B\u91CF",
    "\u89C4\u683C",
    "\u914D\u6599\u8868",
    "\u914D\u6599",
    "\u8D2E\u5B58\u6761\u4EF6",
    "\u8D2E\u5B58\u65B9\u6CD5",
    "\u50A8\u5B58\u6761\u4EF6",
    "\u50A8\u5B58\u65B9\u6CD5",
    "\u50A8\u85CF\u6761\u4EF6",
    "\u50A8\u85CF\u65B9\u6CD5",
    "\u751F\u4EA7\u5546",
    "\u5236\u9020\u5546",
    "\u751F\u4EA7\u5382\u5BB6",
    "\u5382\u5BB6",
    "\u5730\u5740",
    "\u4EA7\u5730",
    "\u7535\u8BDD",
    "\u54C1\u724C"
  ].join("|");
  var DATE_SOURCE = "(?:\\d{4}[ \\t]*[-/.\u5E74][ \\t]*\\d{1,2}[ \\t]*[-/.\u6708][ \\t]*\\d{1,2}[ \\t]*\u65E5?|\\d{8})";
  var DURATION_SOURCE = "(\\d+(?:\\.\\d+)?)[ \\t]*(\u4E2A[ \\t]*\u6708|\u6708|\u5E74|\u5929|\u65E5)";
  var IDENTIFIER_LABEL = /^(?:生产许可证|食品生产许可证|许可证|注册|备案|执行标准|产品标准|生产批号|批次|批号|条形码|条码|电话)/;
  var NAME_LABEL = /^(?:产品名称|商品名称|品名|名称)$/;
  var PRODUCTION_LABEL = /^(?:生产日期|制造日期|生产)$/;
  var EXPIRY_LABEL = /^(?:保质期至|有效期至|到期日期|到期日|失效日期)$/;
  var SHELF_LABEL = /^保质期(?:限)?$/;
  function normalizeOCR(text2) {
    return text2.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/[\u200b-\u200d\uFEFF]/g, "").replace(/[‐‑‒–—−]/g, "-").replace(/(\d)[ \t]+(?=\d)/g, "$1").split("\n").map((line) => line.trim()).join("\n").trim();
  }
  function labelsIn(text2) {
    const matches = [];
    for (const match of text2.matchAll(new RegExp(LABEL_SOURCE, "g"))) {
      if (match[0] === "\u540D\u79F0" && /[A-Za-z0-9\u3400-\u9fff]/.test(text2[match.index - 1] || "")) continue;
      matches.push({ label: match[0], start: match.index, end: match.index + match[0].length });
    }
    return matches;
  }
  function labelValue(text2, labels, index) {
    var _a;
    const label = labels[index];
    const nextLabel = ((_a = labels[index + 1]) == null ? void 0 : _a.start) ?? text2.length;
    let start = label.end;
    let lineEnd = text2.indexOf("\n", start);
    if (lineEnd < 0) lineEnd = text2.length;
    let end = Math.min(lineEnd, nextLabel);
    const removePrefix = () => {
      const prefix = /^[ \t:：=、;；)]*(?:为[ \t:：]*)?/.exec(text2.slice(start, end))[0];
      start += prefix.length;
    };
    removePrefix();
    if (!text2.slice(start, end).trim() && end === lineEnd && lineEnd < nextLabel) {
      let next = lineEnd + 1;
      while (next < text2.length && text2[next] === "\n") next++;
      if (next < nextLabel) {
        start = next;
        const nextEnd = text2.indexOf("\n", start);
        end = Math.min(nextEnd < 0 ? text2.length : nextEnd, nextLabel);
        removePrefix();
      }
    }
    return { start, end, value: text2.slice(start, end).trim(), evidence: text2.slice(label.start, end).trim() };
  }
  function dateMatches(text2, offset = 0) {
    const found = [];
    for (const match of text2.matchAll(new RegExp(DATE_SOURCE, "g"))) {
      const before = text2[match.index - 1] || "";
      const after = text2[match.index + match[0].length] || "";
      if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) continue;
      const raw = match[0];
      const separated = /^(\d{4})[ \t]*[-/.年][ \t]*(\d{1,2})[ \t]*[-/.月][ \t]*(\d{1,2})[ \t]*日?$/.exec(raw);
      found.push({
        raw,
        date: parseDate(separated ? `${separated[1]}-${separated[2]}-${separated[3]}` : raw),
        start: offset + match.index,
        end: offset + match.index + raw.length
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
  function parsePackagingText(input, { today = todayISO(), requireName = true } = {}) {
    const result = {
      name: "",
      productionDate: "",
      shelfLife: null,
      shelfUnit: "day",
      expiryDate: "",
      barcode: "",
      complete: false,
      issues: [],
      evidence: { name: [], productionDate: [], shelfLife: [], expiryDate: [], barcode: [] }
    };
    const current = parseDate(today);
    if (!current) throw new TypeError("\u4ECA\u5929\u7684\u65E5\u671F\u65E0\u6548");
    if (typeof input !== "string" || !input.trim()) {
      result.issues.push("\u6CA1\u6709\u8BFB\u53D6\u5230\u5305\u88C5\u6587\u5B57\uFF0C\u8BF7\u5BF9\u51C6\u5546\u54C1\u540D\u79F0\u548C\u65E5\u671F\u4FE1\u606F\u91CD\u65B0\u62CD\u7167\u3002");
      return result;
    }
    const text2 = normalizeOCR(input);
    const labels = labelsIn(text2);
    const fields = labels.map((label, index) => ({ ...label, ...labelValue(text2, labels, index) }));
    const consumedDates = [];
    const ignoredRanges = fields.filter((field) => IDENTIFIER_LABEL.test(field.label));
    let blocked = false;
    const issue = (message, blocking = true) => {
      if (!result.issues.includes(message)) result.issues.push(message);
      if (blocking) blocked = true;
    };
    const names = /* @__PURE__ */ new Set();
    for (const field of fields.filter((field2) => NAME_LABEL.test(field2.label))) {
      if (field.evidence) result.evidence.name.push(field.evidence);
      const value = field.value.replace(/[ \t;；,，。]+$/, "").trim();
      if (value && value.length <= 80 && /[A-Za-z\u3400-\u9fff]/.test(value) && !/^(?:见|详见|参见|同上|待定|未标注|以.*为准)/.test(value) && !/^(?:SC\d|GB\s*\d)/i.test(value)) names.add(value);
    }
    if (names.size === 1) result.name = [...names][0];
    else if (names.size > 1) issue("\u8BC6\u522B\u5230\u591A\u4E2A\u4E0D\u540C\u7684\u5546\u54C1\u540D\u79F0\uFF0C\u8BF7\u53EA\u62CD\u6444\u4E00\u4EF6\u5546\u54C1\u5E76\u91CD\u65B0\u62CD\u7167\u3002");
    function labeledDates(matcher, fieldName, caption) {
      const dates = /* @__PURE__ */ new Set();
      let invalid = false;
      for (const field of fields.filter((field2) => matcher.test(field2.label))) {
        if (field.evidence) result.evidence[fieldName].push(field.evidence);
        const matches = dateMatches(field.value, field.start);
        consumedDates.push(...matches);
        for (const match of matches) {
          if (match.date) dates.add(match.date);
          else invalid = true;
        }
        if (!matches.length && /^\d/.test(field.value)) invalid = true;
      }
      if (invalid) issue(`\u6807\u6CE8\u7684${caption}\u4E0D\u662F\u6709\u6548\u5B8C\u6574\u65E5\u671F\uFF0C\u8BF7\u62CD\u6E05\u695A\u65E5\u671F\u540E\u91CD\u8BD5\u3002`);
      if (dates.size > 1) issue(`\u8BC6\u522B\u5230\u591A\u4E2A\u4E0D\u540C\u7684${caption}\uFF0C\u8BF7\u53EA\u62CD\u6444\u5F53\u524D\u6279\u6B21\u5E76\u91CD\u65B0\u62CD\u7167\u3002`);
      return { value: !invalid && dates.size === 1 ? [...dates][0] : "", ambiguous: invalid || dates.size > 1 };
    }
    const production = labeledDates(PRODUCTION_LABEL, "productionDate", "\u751F\u4EA7\u65E5\u671F");
    const expiry = labeledDates(EXPIRY_LABEL, "expiryDate", "\u5230\u671F\u65E5\u671F");
    result.productionDate = production.value;
    result.expiryDate = expiry.value;
    const durations = /* @__PURE__ */ new Map();
    let invalidDuration = false;
    for (const field of fields.filter((field2) => SHELF_LABEL.test(field2.label))) {
      if (field.evidence) result.evidence.shelfLife.push(field.evidence);
      if (field.value.split(/[，,；;。]/).some((part) => new RegExp(DURATION_SOURCE).test(part) && /(?:开封|开启|打开|开瓶|拆封|解冻|冲调|冲泡|复热)后|至少|最多|不超过|不少于|不低于|大于|小于|左右|约\s*\d/.test(part))) {
        invalidDuration = true;
      }
      const matches = [...field.value.matchAll(new RegExp(DURATION_SOURCE, "g"))];
      for (const match of matches) {
        if (/[\d.+\-/~至到]/.test(field.value[match.index - 1] || "")) {
          invalidDuration = true;
          continue;
        }
        const amount = Number(match[1]);
        const unit = ["\u5929", "\u65E5"].includes(match[2]) ? "day" : match[2] === "\u5E74" ? "year" : "month";
        if (!Number.isSafeInteger(amount) || amount < 1) invalidDuration = true;
        else durations.set(`${amount}:${unit}`, { amount, unit });
      }
      if (!matches.length && /^\d/.test(field.value)) invalidDuration = true;
    }
    if (invalidDuration) issue("\u6807\u6CE8\u7684\u4FDD\u8D28\u671F\u4E0D\u662F\u6709\u6548\u7684\u6B63\u6574\u6570\u5929\u3001\u6708\u6216\u5E74\uFF0C\u8BF7\u91CD\u65B0\u62CD\u7167\u3002");
    if (durations.size > 1) issue("\u8BC6\u522B\u5230\u591A\u4E2A\u4E0D\u540C\u7684\u4FDD\u8D28\u671F\uFF0C\u8BF7\u62CD\u6E05\u5F53\u524D\u5546\u54C1\u9002\u7528\u7684\u4FDD\u8D28\u671F\u540E\u91CD\u8BD5\u3002");
    if (!invalidDuration && durations.size === 1) {
      const duration = [...durations.values()][0];
      result.shelfLife = duration.amount;
      result.shelfUnit = duration.unit;
    }
    const unlabelled = dateMatches(text2).filter((date) => (date.date || /[-/.年月]/.test(date.raw)) && !consumedDates.some((used) => date.start === used.start && date.end === used.end) && !ignoredRanges.some((range) => date.start >= range.start && date.end <= range.end));
    if (unlabelled.length) issue("\u8FD8\u6709\u672A\u6807\u660E\u542B\u4E49\u7684\u65E5\u671F\uFF0C\u65E0\u6CD5\u786E\u8BA4\u662F\u751F\u4EA7\u65E5\u671F\u8FD8\u662F\u5230\u671F\u65E5\u671F\uFF0C\u8BF7\u8FDE\u540C\u65E5\u671F\u6807\u7B7E\u91CD\u65B0\u62CD\u7167\u3002");
    if (result.productionDate && daysUntil(result.productionDate, current) > 0) {
      issue("\u8BC6\u522B\u5230\u7684\u751F\u4EA7\u65E5\u671F\u665A\u4E8E\u4ECA\u5929\uFF0C\u8BF7\u6838\u5BF9\u5305\u88C5\u5E76\u91CD\u65B0\u62CD\u7167\u3002");
    }
    if (result.productionDate && result.expiryDate && result.expiryDate < result.productionDate) {
      issue("\u5230\u671F\u65E5\u671F\u65E9\u4E8E\u751F\u4EA7\u65E5\u671F\uFF0C\u8BF7\u62CD\u6E05\u5B8C\u6574\u65E5\u671F\u540E\u91CD\u8BD5\u3002");
    }
    if (!result.expiryDate && !expiry.ambiguous && result.productionDate && result.shelfLife !== null) {
      try {
        result.expiryDate = calculateExpiry(result.productionDate, result.shelfLife, result.shelfUnit);
      } catch {
        issue("\u751F\u4EA7\u65E5\u671F\u4E0E\u4FDD\u8D28\u671F\u8BA1\u7B97\u7684\u5230\u671F\u65E5\u671F\u8D85\u51FA\u652F\u6301\u8303\u56F4\uFF0C\u8BF7\u91CD\u65B0\u62CD\u7167\u3002");
      }
    }
    const barcodes = /* @__PURE__ */ new Set();
    const allDates = dateMatches(text2);
    for (const match of text2.matchAll(/\d{13}|\d{8}/g)) {
      const start = match.index, end = start + match[0].length;
      if (/[A-Za-z0-9]/.test(text2[start - 1] || "") || /[A-Za-z0-9]/.test(text2[end] || "")) continue;
      if (allDates.some((date) => date.date && start >= date.start && end <= date.end)) continue;
      if (ignoredRanges.some((range) => !/^(?:条形码|条码)$/.test(range.label) && start >= range.start && end <= range.end)) continue;
      if (eanValid(match[0])) {
        barcodes.add(match[0]);
        result.evidence.barcode.push(match[0]);
      }
    }
    if (barcodes.size === 1) result.barcode = [...barcodes][0];
    else if (barcodes.size > 1) issue("\u8BC6\u522B\u5230\u591A\u4E2A\u6709\u6548\u6761\u7801\uFF0C\u672A\u81EA\u52A8\u9009\u62E9\u6761\u7801\uFF1B\u5546\u54C1\u540D\u79F0\u548C\u65E5\u671F\u4FE1\u606F\u4ECD\u53EF\u4F7F\u7528\u3002", false);
    if (requireName && !result.name && names.size <= 1) issue("\u672A\u8BC6\u522B\u5230\u660E\u786E\u6807\u6CE8\u7684\u5546\u54C1\u540D\u79F0\uFF0C\u8BF7\u62CD\u6E05\u201C\u4EA7\u54C1\u540D\u79F0\u201D\u6216\u201C\u54C1\u540D\u201D\u6807\u7B7E\u3002");
    if (!result.expiryDate && !expiry.ambiguous) {
      if (!result.productionDate && !production.ambiguous) issue("\u672A\u8BC6\u522B\u5230\u660E\u786E\u6807\u6CE8\u7684\u751F\u4EA7\u65E5\u671F\u6216\u5230\u671F\u65E5\u671F\uFF0C\u8BF7\u62CD\u6E05\u65E5\u671F\u53CA\u5176\u6807\u7B7E\u3002");
      else if (result.shelfLife === null && durations.size <= 1 && !invalidDuration) issue("\u672A\u8BC6\u522B\u5230\u660E\u786E\u6807\u6CE8\u7684\u4FDD\u8D28\u671F\uFF0C\u8BF7\u62CD\u6E05\u4FDD\u8D28\u671F\u6570\u503C\u548C\u5355\u4F4D\u3002");
    }
    result.complete = Boolean((!requireName || result.name) && result.expiryDate && !blocked);
    return result;
  }

  // local-query/extract.mjs
  var SKU = /^[A-Za-z0-9._-]{1,64}$/;
  var CONTROL = /[\u0000-\u001f\u007f]/u;
  var plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  function normalizeSku(value) {
    if (typeof value !== "string" || !SKU.test(value.trim())) throw new TypeError("INVALID_SKU");
    return value.trim();
  }
  function text(value, max, required = false) {
    if (value === void 0 || value === null) value = "";
    if (typeof value !== "string" || value.length > max || CONTROL.test(value)) throw new TypeError("INVALID_PRODUCT");
    const result = value.trim();
    if (required && !result) throw new TypeError("INVALID_PRODUCT");
    return result;
  }
  function safeImageUrl(value) {
    if (value === void 0 || value === null || value === "") return "";
    if (typeof value !== "string" || value.length > 2048 || /[?#\s\\]/u.test(value)) throw new TypeError("INVALID_IMAGE");
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError("INVALID_IMAGE");
    }
    if (url.protocol !== "https:" || url.hostname !== "img.meituan.net" || url.port || url.username || url.password) throw new TypeError("INVALID_IMAGE");
    return url.href;
  }
  function sanitizeProduct(input, expectedSku) {
    if (!plain(input)) throw new TypeError("INVALID_PRODUCT");
    const sku = normalizeSku(input.sku);
    if (sku !== normalizeSku(expectedSku)) throw new TypeError("SKU_MISMATCH");
    const spu = normalizeSku(input.spu);
    const values = input.barcodes ?? [];
    if (!Array.isArray(values) || values.length > 32) throw new TypeError("INVALID_PRODUCT");
    const barcodes = [...new Set(values.map((value) => text(value, 128, true)))];
    const product = {
      sku,
      spu,
      name: text(input.name, 200, true),
      spec: text(input.spec, 120),
      category: text(input.category, 200),
      barcodes,
      imageUrl: safeImageUrl(input.imageUrl)
    };
    if (new TextEncoder().encode(JSON.stringify(product)).byteLength > 8192) throw new TypeError("INVALID_PRODUCT");
    return product;
  }

  // mobile-validation/batch-domain.mjs
  function parseBatchDates(value, { today = todayISO() } = {}) {
    if (typeof value !== "string" || value.length > 24e3) return { complete: false, issues: ["\u8BC6\u522B\u6587\u5B57\u8FC7\u591A\uFF0C\u8BF7\u53EA\u62CD\u751F\u4EA7\u65E5\u671F\u548C\u4FDD\u8D28\u671F\u3002"] };
    const parsed = parsePackagingText(value, { today, requireName: false });
    const issues = [...parsed.issues];
    if (!parsed.productionDate) issues.push("\u8BF7\u62CD\u6E05\u751F\u4EA7\u65E5\u671F\u53CA\u5176\u6807\u7B7E\u3002");
    if (!parsed.shelfLife) issues.push("\u8BF7\u62CD\u6E05\u4FDD\u8D28\u671F\u6570\u503C\u548C\u5929\u3001\u6708\u6216\u5E74\u5355\u4F4D\u3002");
    let expiryDate = "";
    if (parsed.productionDate && parsed.shelfLife) {
      try {
        expiryDate = calculateExpiry(parsed.productionDate, parsed.shelfLife, parsed.shelfUnit);
      } catch {
        issues.push("\u5230\u671F\u65E5\u671F\u8D85\u51FA\u652F\u6301\u8303\u56F4\uFF0C\u8BF7\u91CD\u65B0\u62CD\u6444\u3002");
      }
    }
    if (expiryDate && parsed.expiryDate && expiryDate !== parsed.expiryDate) issues.push("\u5305\u88C5\u5230\u671F\u65E5\u671F\u4E0E\u751F\u4EA7\u65E5\u671F\u3001\u4FDD\u8D28\u671F\u8BA1\u7B97\u7ED3\u679C\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u6838\u5BF9\u3002");
    return {
      productionDate: parsed.productionDate,
      shelfLife: parsed.shelfLife,
      shelfUnit: parsed.shelfUnit,
      expiryDate,
      complete: Boolean(parsed.complete && parsed.productionDate && parsed.shelfLife && expiryDate && !issues.length),
      issues: [...new Set(issues)]
    };
  }
  function scanSkuValue(raw) {
    if (typeof raw !== "string" || raw.length > 128) throw new TypeError("\u8BF7\u5BF9\u51C6\u4E00\u4E2A SKU \u7801\u3002");
    return normalizeSku(raw.trim().replace(/^SKU\s*[:：]\s*/iu, ""));
  }
  function createBatchDraft({ id, tenantId, product, dates, quantity }, { today = todayISO(), now = (/* @__PURE__ */ new Date()).toISOString() } = {}) {
    if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(id) || typeof tenantId !== "string" || !/^[1-9][0-9]{0,19}$/u.test(tenantId)) throw new TypeError("\u8BF7\u91CD\u65B0\u767B\u5F55\u7275\u725B\u82B1\u540E\u5F55\u5165\u3002");
    const cleanProduct = sanitizeProduct(product, product == null ? void 0 : product.sku);
    const count = typeof quantity === "string" && /^[1-9][0-9]{0,6}$/u.test(quantity) ? Number(quantity) : quantity;
    if (!Number.isSafeInteger(count) || count < 1 || count > 1e6) throw new TypeError("\u4EF6\u6570\u5E94\u4E3A 1 \u5230 1000000 \u7684\u6574\u6570\u3002");
    if (!dates || dates.complete !== true || !/^\d{4}-\d{2}-\d{2}$/u.test(dates.productionDate || "") || parseDate(dates.productionDate) !== dates.productionDate || dates.productionDate > today || !Number.isSafeInteger(dates.shelfLife) || dates.shelfLife < 1) throw new TypeError("\u8BF7\u5148\u62CD\u6E05\u751F\u4EA7\u65E5\u671F\u548C\u4FDD\u8D28\u671F\u3002");
    const expiryDate = calculateExpiry(dates.productionDate, dates.shelfLife, dates.shelfUnit);
    if (expiryDate !== dates.expiryDate) throw new TypeError("\u5230\u671F\u65E5\u671F\u6821\u9A8C\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u8BC6\u522B\u3002");
    return {
      id: id.toLowerCase(),
      tenantId,
      product: cleanProduct,
      productionDate: dates.productionDate,
      shelfLife: dates.shelfLife,
      shelfUnit: dates.shelfUnit,
      expiryDate,
      quantity: count,
      unit: "\u4EF6",
      createdAt: now,
      syncStatus: "local"
    };
  }

  // mobile-validation/batch-entry.mjs
  Object.defineProperty(window, "__xianqiBatch", { value: Object.freeze({
    parse: (text2) => parseBatchDates(text2),
    draft: (value) => {
      try {
        return { ok: true, draft: createBatchDraft(value) };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    },
    scan: (text2) => {
      try {
        return { ok: true, sku: scanSkuValue(text2) };
      } catch {
        return { ok: false };
      }
    }
  }) });
})();
