(() => {
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
  function resolveExactSku(input, requestedSku) {
    const sku = normalizeSku(requestedSku);
    if (!plain(input)) return { status: "error", message: "\u5546\u54C1\u9875\u7ED3\u679C\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u91CD\u8BD5\u3002" };
    if (input.loginRequired === true) return { status: "login_required", message: "\u8BF7\u7BA1\u7406\u5458\u5728\u672C\u673A\u7275\u725B\u82B1\u6D4F\u89C8\u5668\u4E2D\u91CD\u65B0\u767B\u5F55\u3002" };
    if (input.complete !== true || !Array.isArray(input.rows)) return { status: "error", message: "\u5546\u54C1\u9875\u7ED3\u679C\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u91CD\u8BD5\u3002" };
    const candidates = input.rows.filter((row) => plain(row) && typeof row.sku === "string" && row.sku.trim() === sku);
    if (input.rows.some((row) => plain(row) && typeof row.sku !== "string")) return { status: "error", message: "\u5546\u54C1\u7F16\u53F7\u683C\u5F0F\u65E0\u6CD5\u786E\u8BA4\uFF0C\u8BF7\u5728\u7275\u725B\u82B1\u6838\u5BF9\u540E\u91CD\u8BD5\u3002" };
    if (!candidates.length) return { status: "not_found", message: "\u7275\u725B\u82B1\u4E2D\u6CA1\u6709\u6B64 SKU\uFF0C\u8BF7\u6838\u5BF9\u6807\u7B7E\u3002" };
    const unique = /* @__PURE__ */ new Map();
    try {
      for (const candidate of candidates) {
        const product2 = sanitizeProduct(candidate, sku);
        unique.set(JSON.stringify(product2), product2);
      }
    } catch {
      return { status: "error", message: "\u5546\u54C1\u8D44\u6599\u4E0D\u5B8C\u6574\u6216\u56FE\u7247\u5730\u5740\u65E0\u6CD5\u786E\u8BA4\uFF0C\u8BF7\u5728\u7275\u725B\u82B1\u6838\u5BF9\u3002" };
    }
    if (unique.size !== 1) return { status: "ambiguous", message: "\u7275\u725B\u82B1\u8FD4\u56DE\u591A\u4E2A\u4E0D\u540C\u5546\u54C1\uFF0C\u8BF7\u7BA1\u7406\u5458\u6838\u5BF9 SKU\u3002" };
    const product = unique.values().next().value;
    if (!product.imageUrl) return { status: "error", message: "\u6B64 SKU \u7684\u5546\u54C1\u4E3B\u56FE\u7F3A\u5931\uFF0C\u8BF7\u5728\u7275\u725B\u82B1\u6838\u5BF9\u540E\u91CD\u8BD5\u3002" };
    return { status: "found", product };
  }
  function parseScopedCells({ productText, specText, imageUrls = [] }) {
    var _a, _b, _c;
    if (typeof productText !== "string" || typeof specText !== "string" || productText.length > 4e3 || specText.length > 4e3) throw new TypeError("INVALID_VISIBLE_ROW");
    const spus = [...productText.matchAll(/^\s*SPU[：:]\s*([A-Za-z0-9._-]{1,64})\s*$/gmu)];
    const skus = [...specText.matchAll(/^\s*SKU[：:]\s*([A-Za-z0-9._-]{1,64})\s*$/gmu)];
    if (spus.length !== 1 || skus.length !== 1 || !/商品条码[：:]/u.test(specText)) throw new TypeError("UNSCOPED_VISIBLE_ROW");
    const name = productText.slice(0, spus[0].index).split(/\r?\n/u).map((value) => value.trim()).filter((value) => value && value !== "\u9884\u89C8").join(" ");
    const category = ((_b = (_a = /商品类目[：:]\s*([^\r\n]*)/u.exec(productText)) == null ? void 0 : _a[1]) == null ? void 0 : _b.trim()) || "";
    const spec = specText.slice(0, skus[0].index).trim();
    const barcodeText = ((_c = /商品条码[：:]\s*([\s\S]*?)(?:外部编码[：:]|$)/u.exec(specText)) == null ? void 0 : _c[1]) || "";
    const barcodes = barcodeText.split(/[,，;；\s]+/u).map((value) => value.trim()).filter((value) => value && !/^-+$/u.test(value));
    const imageUrl = Array.isArray(imageUrls) ? imageUrls.find((value) => typeof value === "string" && value.startsWith("https://img.meituan.net/")) || "" : "";
    return sanitizeProduct({ sku: skus[0][1], spu: spus[0][1], name, category, spec, barcodes, imageUrl }, skus[0][1]);
  }
  function readVisibleProductRows(tables) {
    const visible2 = (element) => {
      if (!element || element.getClientRects().length === 0) return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    };
    const skuCount = (value) => [...value.matchAll(/^\s*SKU[：:]\s*[A-Za-z0-9._-]{1,64}\s*$/gmu)].length;
    const exactSkuLabel = (element) => /^\s*SKU[：:]\s*[A-Za-z0-9._-]{1,64}\s*$/u.test(element.innerText || "");
    const cells = [];
    let unscoped = false;
    for (const table of tables.filter(visible2)) {
      for (const row of table.querySelectorAll("tbody tr")) {
        if (!visible2(row) || row.closest("table") !== table) continue;
        const columns = Array.from(row.children).filter((element) => element.tagName === "TD");
        const productCell = columns[1];
        const specCell = columns[2];
        if (!visible2(productCell) || !visible2(specCell)) continue;
        const productText = productCell.innerText;
        if (!/SPU[：:]/u.test(productText)) continue;
        const imageUrls = Array.from(productCell.querySelectorAll("img")).filter(visible2).map((image) => image.currentSrc || image.getAttribute("src")).filter((value) => typeof value === "string" && value.startsWith("https://img.meituan.net/"));
        if (skuCount(specCell.innerText) === 1) {
          cells.push({ productText, specText: specCell.innerText, imageUrls });
          continue;
        }
        const labels = Array.from(specCell.querySelectorAll("*")).filter(visible2).filter(exactSkuLabel).filter((element) => !Array.from(element.children).some(exactSkuLabel));
        if (!labels.length) {
          unscoped = true;
          continue;
        }
        const scopes = /* @__PURE__ */ new Set();
        for (const label of labels) {
          let scope = label;
          while (scope !== specCell && scope.parentElement && specCell.contains(scope.parentElement) && skuCount(scope.parentElement.innerText) === 1) scope = scope.parentElement;
          if (!/商品条码[：:]/u.test(scope.innerText)) {
            unscoped = true;
            continue;
          }
          scopes.add(scope);
        }
        for (const scope of scopes) cells.push({ productText, specText: scope.innerText, imageUrls });
      }
    }
    return { cells, unscoped };
  }

  // backend/qnh-browser-session.mjs
  var QNH_BROWSER_LIMITS = Object.freeze({
    width: 1280,
    height: 900,
    loginMs: 18e4,
    sessionMs: 24e4,
    commandMs: 12e3,
    frameIntervalMs: 500,
    inputIntervalMs: 35,
    inputs: 600,
    textLength: 128,
    dragPoints: 32,
    frameBytes: 2e6
  });
  var keyCodes = Object.freeze({
    Backspace: 8,
    Delete: 46,
    Tab: 9,
    Enter: 13,
    Escape: 27,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Home: 36,
    End: 35
  });
  function readLoggedInQnhShell() {
    const url = new URL(location.href);
    if (url.origin !== "https://qnh.meituan.com" || !["/", "/home.html"].includes(url.pathname) || /^#\/(?:login|logout)(?:\/|\?|$)/iu.test(url.hash) || !["interactive", "complete"].includes(document.readyState)) return false;
    const visible2 = (element) => {
      if (!(element == null ? void 0 : element.getClientRects().length)) return false;
      let current = element;
      while ((current == null ? void 0 : current.nodeType) === 1) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        current = current.parentElement;
      }
      return true;
    };
    const layouts = Array.from(document.querySelectorAll(".saas-platform-layout-wrapper")).filter(visible2);
    const topBars = Array.from(document.querySelectorAll(".top-nav-base")).filter(visible2);
    const mains = Array.from(document.querySelectorAll(".saas-platform-layout-main")).filter(visible2);
    const headers = Array.from(document.querySelectorAll('span[class^="SearchLeftTenantId--"]')).filter((element) => visible2(element) && !element.closest("[contenteditable],input,textarea"));
    return layouts.length === 1 && topBars.length === 1 && mains.length === 1 && headers.length === 1 && layouts[0].contains(topBars[0]) && layouts[0].contains(mains[0]) && topBars[0].contains(headers[0]) && /^（租户ID:\s*[1-9][0-9]{0,19}）$/u.test(headers[0].innerText.trim()) && !Array.from(document.querySelectorAll('input[type="password"]')).some(visible2);
  }
  function readObservedQnhTenantId() {
    var _a;
    const nodes = Array.from(document.querySelectorAll('span[class^="SearchLeftTenantId--"]')).filter((element) => {
      if (!element.getClientRects().length || element.closest("[contenteditable],input,textarea")) return false;
      let current = element;
      while ((current == null ? void 0 : current.nodeType) === 1) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        current = current.parentElement;
      }
      return true;
    });
    if (nodes.length !== 1) return null;
    return ((_a = /^（租户ID:\s*([1-9][0-9]{0,19})）$/u.exec(nodes[0].innerText.trim())) == null ? void 0 : _a[1]) || null;
  }

  // mobile-validation/phone-runtime.mjs
  var PRODUCT_HASH = "#/unifiedGoods/tenant/spu-list";
  var visible = (element) => element && element.getClientRects().length > 0 && getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden";
  function controls() {
    const fields = Array.from(document.querySelectorAll(".unifiedGoods-ant-form-item-row")).filter((element) => /^SKU$/u.test(element.innerText.trim())).flatMap((element) => Array.from(element.querySelectorAll('input[type="text"]'))).filter(visible);
    const buttons = Array.from(document.querySelectorAll("button")).filter(visible).filter((element) => element.innerText.trim() === "\u67E5\u8BE2");
    const tables = Array.from(document.querySelectorAll("table")).filter(visible);
    const headers = tables.flatMap((table) => Array.from(table.querySelectorAll("thead th")).map((element) => element.innerText.trim()));
    if (fields.length !== 1 || buttons.length !== 1 || !tables.length || !headers.includes("\u5546\u54C1\u4FE1\u606F") || !headers.includes("\u89C4\u683C\u4FE1\u606F")) return null;
    return { field: fields[0], button: buttons[0], tables };
  }
  function watchRefresh({ field, tables }, sku) {
    const roots = [...new Set(tables.map((table) => table.closest(".unifiedGoods-ant-spin-nested-loading") || table))];
    const loadingClass = /(?:^|\s)\S*(?:spin-spinning|spin-dot(?:-item|-spin)?|anticon-loading|anticon-spin)(?:\s|$)/u;
    const loading = () => roots.some((root) => Array.from(root.querySelectorAll("[class]")).some((element) => visible(element) && loadingClass.test(element.getAttribute("class") || "")));
    let finish, quiet, timeout, closed = false;
    const promise = new Promise((resolve) => {
      finish = (value) => {
        if (closed) return;
        closed = true;
        clearTimeout(quiet);
        clearTimeout(timeout);
        observer.disconnect();
        resolve(value);
      };
    });
    const observer = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (!target) return false;
        if (record.type === "attributes") return loadingClass.test(`${record.oldValue || ""} ${target.getAttribute("class") || ""}`) || /(?:^|\s)\S*table-empty(?:\s|$)/u.test(target.getAttribute("class") || "");
        return target.closest("tbody") || target.tagName === "TABLE" || [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === 1 && (node.matches("table,tbody") || node.querySelector("table,tbody")));
      });
      if (!relevant) return;
      clearTimeout(quiet);
      if (!loading()) quiet = setTimeout(() => finish(field.value === sku && !loading()), 600);
    });
    for (const root of roots) observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    timeout = setTimeout(() => finish(false), 12e3);
    return { promise, cancel: () => finish(false) };
  }
  function createPhoneRuntime({
    shell = readLoggedInQnhShell,
    tenant = readObservedQnhTenantId,
    getControls = controls,
    observe = watchRefresh,
    readRows = readVisibleProductRows
  } = {}) {
    let result = { status: "idle" }, generation = 0, watcher = null;
    const identity = () => {
      try {
        const url = new URL(location.href);
        if (url.origin !== "https://qnh.meituan.com" || !["/", "/home.html"].includes(url.pathname) || !shell()) return null;
        const value = tenant();
        return typeof value === "string" && /^[1-9][0-9]{0,19}$/u.test(value) ? value : null;
      } catch {
        return null;
      }
    };
    const productPage = () => location.hash.split("?")[0] === PRODUCT_HASH;
    const cancel = () => {
      generation++;
      watcher == null ? void 0 : watcher.cancel();
      watcher = null;
      result = { status: "idle" };
    };
    return Object.freeze({
      version: 1,
      inspect() {
        const tenantId = identity();
        if (!tenantId || result.tenantId && result.tenantId !== tenantId) cancel();
        return { authorized: Boolean(tenantId), tenantId: tenantId || "", productReady: Boolean(tenantId && productPage() && getControls()), ...result };
      },
      cancel,
      begin(requestId, value, expectedTenant) {
        let sku;
        try {
          sku = normalizeSku(value);
        } catch {
          return false;
        }
        const tenantId = identity(), control = productPage() ? getControls() : null;
        if (!/^[1-9][0-9]{0,15}$/u.test(String(requestId)) || tenantId !== expectedTenant || !tenantId || !control) return false;
        cancel();
        const current = generation;
        result = { status: "pending", requestId: String(requestId), sku, tenantId };
        (async () => {
          var _a;
          try {
            const setter = (_a = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")) == null ? void 0 : _a.set;
            if (!setter) throw Error("INPUT");
            setter.call(control.field, sku);
            control.field.dispatchEvent(new Event("input", { bubbles: true }));
            control.field.dispatchEvent(new Event("change", { bubbles: true }));
            if (control.field.value !== sku) throw Error("INPUT");
            watcher = observe(control, sku);
            const activeWatcher = watcher;
            control.button.click();
            const fresh = await activeWatcher.promise;
            if (current !== generation) return;
            watcher = null;
            if (!fresh || identity() !== tenantId || control.field.value !== sku) throw Error("STALE");
            const snapshot = readRows(Array.from(document.querySelectorAll("table")).filter(visible));
            if (snapshot.unscoped) throw Error("SCOPE");
            const rows = snapshot.cells.map(parseScopedCells);
            const empty = Array.from(document.querySelectorAll(".unifiedGoods-ant-empty, .unifiedGoods-ant-table-placeholder")).some(visible);
            if (empty && rows.length) throw Error("CONFLICT");
            const resolved = resolveExactSku({ complete: rows.length > 0 || empty, rows }, sku);
            if (identity() !== tenantId) throw Error("TENANT");
            result = {
              requestId: String(requestId),
              sku,
              tenantId,
              status: resolved.status,
              ...resolved.status === "found" ? { product: resolved.product } : {}
            };
          } catch {
            if (current === generation) result = { requestId: String(requestId), sku, tenantId, status: "error" };
          }
        })();
        return true;
      }
    });
  }

  // mobile-validation/phone-entry.mjs
  if (location.origin === "https://qnh.meituan.com" && !window.__xianqiPhoneValidation) {
    Object.defineProperty(window, "__xianqiPhoneValidation", { value: createPhoneRuntime(), configurable: true });
  }
})();
