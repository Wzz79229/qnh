(() => {
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
    const visible3 = (element) => {
      if (!(element == null ? void 0 : element.getClientRects().length)) return false;
      let current = element;
      while ((current == null ? void 0 : current.nodeType) === 1) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        current = current.parentElement;
      }
      return true;
    };
    const layouts = Array.from(document.querySelectorAll(".saas-platform-layout-wrapper")).filter(visible3);
    const topBars = Array.from(document.querySelectorAll(".top-nav-base")).filter(visible3);
    const mains = Array.from(document.querySelectorAll(".saas-platform-layout-main")).filter(visible3);
    const headers = Array.from(document.querySelectorAll('span[class^="SearchLeftTenantId--"]')).filter((element) => visible3(element) && !element.closest("[contenteditable],input,textarea"));
    return layouts.length === 1 && topBars.length === 1 && mains.length === 1 && headers.length === 1 && layouts[0].contains(topBars[0]) && layouts[0].contains(mains[0]) && topBars[0].contains(headers[0]) && /^（租户ID:\s*[1-9][0-9]{0,19}）$/u.test(headers[0].innerText.trim()) && !Array.from(document.querySelectorAll('input[type="password"]')).some(visible3);
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

  // mobile-validation/inventory-query.mjs
  var INVENTORY_HASH = "#/co-wms/inventory-query-integration/list";
  var INVENTORY_URL = `https://qnh.meituan.com/${INVENTORY_HASH}?tab=goodsBatch`;
  var visible = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden";
  function inventoryPage(href) {
    try {
      const u = new URL(href), [path, query = ""] = u.hash.split("?");
      return u.origin === "https://qnh.meituan.com" && ["/", "/home.html"].includes(u.pathname) && path === INVENTORY_HASH && new URLSearchParams(query).get("tab") === "goodsBatch";
    } catch {
      return false;
    }
  }
  function observeInventory(control) {
    let done, quiet, timer, closed = false;
    const loading = () => Array.from(control.root.querySelectorAll("[class]")).some((e) => visible(e) && /(?:spin-spinning|anticon-loading|anticon-spin)/u.test(e.className || ""));
    const promise = new Promise((resolve) => {
      done = (ok) => {
        if (closed) return;
        closed = true;
        observer.disconnect();
        clearTimeout(quiet);
        clearTimeout(timer);
        resolve(ok);
      };
    });
    const observer = new MutationObserver((records) => {
      const relevant = records.some((r) => {
        const e = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        return e && (e.closest("tbody") || e.tagName === "TABLE" || /spin|loading|empty/u.test((r.oldValue || "") + " " + (e.getAttribute("class") || "")) || [...r.addedNodes, ...r.removedNodes].some((n) => n.nodeType === 1 && (n.matches("table,tbody") || /spin|loading|empty/u.test(n.className || "") || n.querySelector("table,tbody"))));
      });
      if (!relevant) return;
      clearTimeout(quiet);
      if (!loading()) quiet = setTimeout(() => done(!loading()), 650);
    });
    observer.observe(control.root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    timer = setTimeout(() => done(false), 15e3);
    return { promise, cancel: () => done(false) };
  }

  // mobile-validation/inventory-search.mjs
  var visible2 = (e) => Boolean(e && e.getClientRects().length && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden");
  var ID = /^[A-Za-z0-9._-]{1,64}$/u;
  var fields = { name: "skuNameKeyword", sku: "skuIdListStr", barcode: "upcKeyword", external: "externalGoodsCodeKeyword" };
  function normalizeInventoryFilters(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((k) => ![...Object.keys(fields), "loc"].includes(k))) throw Error("FILTER");
    const output = {};
    for (const key of [...Object.keys(fields), "loc"]) {
      const value = raw[key] ?? "";
      if (typeof value !== "string" || value.length > 100 || /[\x00-\x1f\x7f]/u.test(value)) throw Error("FILTER");
      output[key] = value.trim();
    }
    if (output.sku && !ID.test(output.sku)) throw Error("SKU");
    const location2 = output.loc ? output.loc.split("-") : [];
    if (location2.length > 4 || location2.some((v) => v.length > 6)) throw Error("LOCATION");
    if (!Object.values(output).some(Boolean)) throw Error("EMPTY");
    return output;
  }
  function queryOf(href) {
    return new URLSearchParams(new URL(href).hash.split("?")[1] || "");
  }
  function inventoryFilterReceipt(href, filters, page, previousStamp, requireNewStamp = true) {
    if (!inventoryPage(href)) return false;
    const q = queryOf(href), stamp = q.get("_t");
    if (!/^\d+$/u.test(stamp || "") || requireNewStamp && stamp === previousStamp || q.get("current") !== String(page)) return false;
    for (const [key, field] of Object.entries(fields)) {
      const values = q.getAll(field);
      if (values.length > 1 || (values[0] || "") !== filters[key]) return false;
    }
    const actual = q.getAll("locationCodeSegmentList"), expected = filters.loc ? filters.loc.split("-") : [];
    while (expected.length < 4) expected.push("");
    return actual.length === 0 ? expected.every((v) => !v) : actual.length === 4 && actual.every((v, i) => v === expected[i]);
  }
  function searchControls() {
    const panels = Array.from(document.querySelectorAll('[id$="-panel-goodsBatch"]')).filter(visible2);
    if (panels.length !== 1) return null;
    const root = panels[0];
    const inputs = {};
    for (const [key, id] of Object.entries(fields)) {
      const found = Array.from(root.querySelectorAll("input#" + id)).filter(visible2);
      if (found.length !== 1) return null;
      inputs[key] = found[0];
    }
    const locations = Array.from(root.querySelectorAll(".wms-wand-storage-location-input-select input")).filter(visible2);
    if (locations.length !== 4) return null;
    const buttons = Array.from(root.querySelectorAll("button")).filter((e) => visible2(e) && e.innerText.replace(/\s+/gu, "") === "\u67E5\u8BE2");
    if (buttons.length !== 1) return null;
    const headers = Array.from(root.querySelectorAll("thead th")).filter(visible2).map((e) => e.innerText.trim());
    if (!["\u5546\u54C1\u4FE1\u606F", "\u95E8\u5E97/\u4ED3", "\u5E93\u4F4D"].every((v) => headers.includes(v))) return null;
    return { root, inputs, locations, headers, button: buttons[0] };
  }
  function readSearchRows(control) {
    var _a, _b, _c;
    const rows = [];
    for (const element of control.root.querySelectorAll("tbody tr")) {
      if (!visible2(element) || element.getBoundingClientRect().height < 1) continue;
      const cells = Array.from(element.children).filter((e) => e.tagName === "TD");
      const product = (_a = cells[0]) == null ? void 0 : _a.querySelector(".wms-wand-goods-info-goods-name-text"), store = cells[control.headers.indexOf("\u95E8\u5E97/\u4ED3")], loc = cells[control.headers.indexOf("\u5E93\u4F4D")];
      if (!visible2(product) || !store || !loc) continue;
      const row = { name: product.innerText.trim(), spec: ((_c = (_b = /(?:^|\n)\s*规格[：:]\s*([^\n]*)/u.exec(cells[0].innerText)) == null ? void 0 : _b[1]) == null ? void 0 : _c.trim()) || "", store: store.innerText.trim(), loc: loc.innerText.trim() };
      if (!row.name || !row.store || Object.values(row).some((v) => v.length > 300 || /[\x00-\x08\x0b-\x1f\x7f]/u.test(v))) throw Error("ROW");
      const links = Array.from(element.querySelectorAll("a")).filter((e) => visible2(e) && e.innerText.trim() === "\u67E5\u8BE2\u6D41\u6C34");
      if (links.length !== 1) throw Error("LINK");
      rows.push({ data: row, element, link: links[0] });
    }
    const empty = Array.from(control.root.querySelectorAll(".wms-ant-empty, .wms-ant-table-placeholder")).some((e) => visible2(e) && /暂无数据|暂无内容/u.test(e.innerText));
    if (rows.length > 100 || !rows.length && !empty || rows.length && empty) throw Error("ROWS");
    return rows;
  }
  function sameInputs(control, filters) {
    return Object.keys(fields).every((k) => control.inputs[k].value === filters[k]) && control.locations.every((e, i) => e.value === (filters.loc.split("-")[i] || ""));
  }
  function pagination(control) {
    const button = (key) => control.root.querySelector(".wms-ant-pagination-" + key + " button");
    const prev = button("prev"), next = button("next");
    return { current: Number(queryOf(location.href).get("current") || "1"), previous: Boolean(prev && !prev.disabled), next: Boolean(next && !next.disabled) };
  }
  function flowSkuReceipt(href, card, selected, expectedSku = "") {
    var _a;
    try {
      const url = new URL(href), [path, query] = url.hash.split("?"), q = new URLSearchParams(query);
      if (url.origin !== "https://qnh.meituan.com" || !["/", "/home.html"].includes(url.pathname) || path !== "#/co-wms/non-erp/goods-flow/list" || q.getAll("skuIdKeyword").length !== 1) return "";
      const sku = q.get("skuIdKeyword");
      if (!ID.test(sku || "") || expectedSku && sku !== expectedSku || !card || card.name !== selected.name || card.sku !== sku) return "";
      const storeId = (_a = /[（(](\d+)[)）]\s*$/u.exec(selected.store)) == null ? void 0 : _a[1];
      if (storeId && q.get("repositoryId") !== storeId) return "";
      return sku;
    } catch {
      return "";
    }
  }
  function readFlowCard() {
    var _a;
    const cards = Array.from(document.querySelectorAll(".wms-wand-goods-info")).filter(visible2);
    if (cards.length !== 1) return null;
    const card = cards[0], name = (_a = card.querySelector(".wms-wand-goods-info-goods-name-text")) == null ? void 0 : _a.innerText.trim();
    const ids = Array.from(card.querySelectorAll(".wms-wand-goods-info-rest-info-non-tooltip")).map((e) => {
      var _a2;
      return (_a2 = /^SKU[：:]\s*([A-Za-z0-9._-]{1,64})\s*$/u.exec(e.innerText.trim())) == null ? void 0 : _a2[1];
    }).filter(Boolean);
    return name && ids.length === 1 ? { name, sku: ids[0] } : null;
  }
  function setInput(input, value) {
    var _a;
    const setter = (_a = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")) == null ? void 0 : _a.set;
    if (!setter) throw Error("INPUT");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function storeToggle() {
    var _a;
    return (_a = searchControls()) == null ? void 0 : _a.root.querySelector(".wms-roo-wand-storepicker-bizqnh-multi-cascader-picker .wms-roo-multi-cascader-toggle");
  }
  function storeColumns() {
    return Array.from(document.querySelectorAll(".wms-roo-wand-storepicker-bizqnh-multi-cascader-picker-dropdown .wms-roo-picker-cascader-menu-column")).filter(visible2);
  }
  function createInventorySearch({ shell = readLoggedInQnhShell, tenant = readObservedQnhTenantId, controls = searchControls, observe = observeInventory, readRows = readSearchRows, readCard = readFlowCard, now = () => Date.now() } = {}) {
    let state = { status: "idle" }, generation = 0, watcher = null, receipt = "", selected = null;
    const identity = () => {
      try {
        const u = new URL(location.href), id = tenant();
        return u.origin === "https://qnh.meituan.com" && ["/", "/home.html"].includes(u.pathname) && shell() && typeof id === "string" && /^[1-9][0-9]{0,19}$/u.test(id) ? id : "";
      } catch {
        return "";
      }
    };
    const cancel = () => {
      generation++;
      watcher == null ? void 0 : watcher.cancel();
      watcher = null;
      state = { status: "idle" };
      receipt = "";
      selected = null;
    };
    const matches = (scope) => Boolean(identity() && identity() === scope);
    function execute(requestId, filters, scope, page, click, newStamp) {
      const control = controls();
      if (!matches(scope) || !inventoryPage(location.href) || !control || !/^\d{1,15}$/u.test(String(requestId))) return false;
      cancel();
      const current = generation, stamp = queryOf(location.href).get("_t");
      state = { status: "pending", requestId: String(requestId), tenantId: scope, filters };
      (async () => {
        try {
          if (page === 1 && newStamp) {
            for (const key of Object.keys(fields)) setInput(control.inputs[key], filters[key]);
            for (let i = 0; i < 4; i++) setInput(control.locations[i], filters.loc.split("-")[i] || "");
          }
          if (!sameInputs(control, filters)) throw Error("INPUT");
          watcher = observe(control);
          const active = watcher;
          click(control);
          const fresh = await active.promise;
          if (current !== generation) return;
          watcher = null;
          if (!fresh || !matches(scope) || !sameInputs(control, filters) || !inventoryFilterReceipt(location.href, filters, page, stamp, newStamp)) throw Error("STALE");
          const rows = readRows(control).map((row) => row.data);
          receipt = location.href;
          state = { ...state, status: rows.length ? "found" : "not_found", rows, pagination: pagination(control) };
        } catch {
          if (current === generation) state = { status: "error", requestId: String(requestId), tenantId: scope };
        }
      })();
      return true;
    }
    return Object.freeze({
      version: 2,
      cancel,
      inspect() {
        var _a;
        const id = identity();
        if (!id || state.tenantId && state.tenantId !== id) cancel();
        if (state.status === "resolving" && selected) {
          const sku = flowSkuReceipt(location.href, readCard(), selected.data, state.filters.sku);
          if (sku) state = { ...state, status: "selected", row: { ...selected.data, sku } };
          else if (now() > selected.deadline) state = { ...state, status: "error" };
        }
        const control = id && inventoryPage(location.href) ? controls() : null;
        return { ...state, authorized: Boolean(id), tenantId: id, productReady: Boolean(id && control), store: ((_a = control == null ? void 0 : control.root.querySelector(".wms-roo-picker-value-list")) == null ? void 0 : _a.innerText.trim()) || "" };
      },
      search(requestId, raw, scope) {
        let filters;
        try {
          filters = normalizeInventoryFilters(raw);
        } catch {
          return false;
        }
        return execute(requestId, filters, scope, 1, (c) => c.button.click(), true);
      },
      page(requestId, direction, scope) {
        if (state.status !== "found" && state.status !== "not_found" || ![-1, 1].includes(direction) || !matches(scope) || location.href !== receipt) return false;
        const control = controls(), button = control == null ? void 0 : control.root.querySelector(".wms-ant-pagination-" + (direction === 1 ? "next" : "prev") + " button");
        if (!button || button.disabled) return false;
        return execute(requestId, state.filters, scope, Number(queryOf(location.href).get("current")) + direction, () => button.click(), false);
      },
      select(requestId, index, scope) {
        if (state.status !== "found" || String(requestId) !== state.requestId || !matches(scope) || location.href !== receipt || !Number.isInteger(index) || index < 0 || index >= state.rows.length) return false;
        try {
          const control = controls();
          if (!control || !sameInputs(control, state.filters)) return false;
          const rows = readRows(control), row = rows[index];
          if (!row || JSON.stringify(row.data) !== JSON.stringify(state.rows[index])) return false;
          selected = { data: row.data, deadline: now() + 2e4 };
          state = { ...state, status: "resolving" };
          row.link.click();
          return true;
        } catch {
          return false;
        }
      },
      openStores() {
        var _a;
        if (!identity() || !inventoryPage(location.href)) return false;
        cancel();
        if (!storeColumns().length) (_a = storeToggle()) == null ? void 0 : _a.click();
        return true;
      },
      stores() {
        if (!identity()) return [];
        return storeColumns().map((column, depth) => ({ depth, options: Array.from(column.querySelectorAll('li[role="menuitem"]')).filter(visible2).map((e, index) => {
          var _a, _b;
          return { index, key: ((_a = e.querySelector('input[type="checkbox"]')) == null ? void 0 : _a.value) || "", label: e.innerText.trim(), children: e.classList.contains("wms-roo-picker-cascader-menu-has-children"), checked: Boolean((_b = e.querySelector('input[type="checkbox"]')) == null ? void 0 : _b.checked) };
        }) }));
      },
      chooseStore(depth, index, key, label) {
        var _a, _b, _c;
        if (!identity() || !Number.isInteger(depth) || !Number.isInteger(index)) return false;
        const column = storeColumns()[depth], row = column && Array.from(column.querySelectorAll('li[role="menuitem"]')).filter(visible2)[index];
        if (!row || row.innerText.trim() !== label || ((_a = row.querySelector('input[type="checkbox"]')) == null ? void 0 : _a.value) !== key) return false;
        cancel();
        if (row.classList.contains("wms-roo-picker-cascader-menu-has-children")) (_b = row.querySelector("i.roo-icon-chevron-right-new")) == null ? void 0 : _b.click();
        else (_c = row.querySelector('input[type="checkbox"]')) == null ? void 0 : _c.click();
        return true;
      },
      scrollStores(depth, direction) {
        var _a;
        if (!identity() || !Number.isInteger(depth) || ![-1, 1].includes(direction)) return false;
        const holder = (_a = storeColumns()[depth]) == null ? void 0 : _a.querySelector(".rc-virtual-list-holder");
        if (!holder) return false;
        holder.scrollBy(0, direction * holder.clientHeight * 0.8);
        return true;
      },
      closeStores() {
        var _a;
        if (identity()) (_a = controls()) == null ? void 0 : _a.inputs.name.click();
      }
    });
  }

  // mobile-validation/inventory-entry.mjs
  if (location.origin === "https://qnh.meituan.com" && !window.__kuguanInventory) {
    Object.defineProperty(window, "__kuguanInventory", { value: createInventorySearch(), configurable: true });
  }
})();
