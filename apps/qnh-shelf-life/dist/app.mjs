import { DEFAULT_SETTINGS, todayISO, addDays, daysUntil, classify, validateRecord, exportCSV, sanitizeState } from './core.mjs';
import { ConflictError } from './github.mjs';
import { CloudStore } from './cloud.mjs';
import { openPhotoFlow } from './photo-flow.mjs';
import { previewByteLength } from './ocr.mjs';
import { syncPhotoState } from './photo-sync.mjs';
import { normalizeCatalog, searchProducts, matchBarcode, nameCandidates, CATALOG_MAX_PRODUCTS } from './catalog.mjs';

const $ = (s, root = document) => root.querySelector(s);
const e = (value = '') => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon = (name, extra = '') => `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const now = () => new Date().toISOString();
const emptyState = () => ({ schemaVersion: 1, records: [], settings: {...DEFAULT_SETTINGS}, updatedAt: now() });
const navItems = [['overview','grid','保质期总览','总览'],['catalog','catalog','牵牛花商品库','商品库'],['batches','box','商品批次','批次'],['tasks','clock','临期处理','待办'],['team','users','团队与同步','团队']];
const labels = {expired:'已过期',today:'今日到期',urgent:'紧急临期',warning:'即将临期',normal:'保质期内',handled:'已处理',removed:'已移除'};
let state = emptyState();
let page = 'overview', filter = 'all', search = '', category = '', sort = 'expiry', limit = 60;
let store = null, sha = null, connected = false, dirty = false, busy = false, demo = false, errorText = '', lastSync = '';
let installPrompt = null, toastTimer;
let config = {owner:'Wzz79229',repo:'bzq',branch:'main',path:'data/shelf-life.json',actor:'团队成员'};
let connectionIssue = '', needsLogin = false;
const pendingPhotos = new Map();
let catalog = null, catalogStatus = 'unloaded', catalogIssue = '', catalogProgress = '';
let catalogQuery = '', catalogPage = 1, catalogRequest = 0, catalogPromise = null;
let catalogSearchCache = null;
const CATALOG_PAGE_SIZE = 24;

function cancelCatalogLoad(clear = false) {
  catalogRequest++; catalogPromise = null; catalogProgress = '';
  if (clear) { catalog = null; catalogIssue = ''; catalogSearchCache = null; catalogPage = 1; }
  catalogStatus = catalog ? 'ready' : 'unloaded';
}
function catalogTime(value) {
  return new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
}
function productThumbnail(product, extra = '') {
  return `<span class="catalog-thumb ${extra}">${icon('box')}${product.imageUrl?`<img data-catalog-image src="${e(product.imageUrl)}" alt="${e(product.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`:'<span class="catalog-image-label">暂无图片</span>'}</span>`;
}
async function loadCatalog({force = false, background = false} = {}) {
  if (!connected || !store || demo) return null;
  if (catalog && !force) return catalog;
  if (catalogPromise && !force) return catalogPromise;
  const currentStore = store, request = ++catalogRequest;
  const active = () => request === catalogRequest && connected && store === currentStore && !demo;
  const update = () => { if (active() && page === 'catalog' && !document.querySelector('dialog[open]')) render(true); };
  catalogStatus = 'loading'; catalogIssue = ''; catalogProgress = '正在读取商品库索引…'; update();
  const promise = (async () => {
    try {
      // Authorization is checked by the session flow before connected can be true.
      const manifest = await currentStore.catalog();
      if (!active()) return null;
      if (manifest?.schemaVersion !== 1 || typeof manifest.generation !== 'string' || !manifest.generation || manifest.generation.length > 160
          || !Array.isArray(manifest.pages) || manifest.pages.length > 100
          || !Number.isSafeInteger(manifest.total) || manifest.total < 0 || manifest.total > CATALOG_MAX_PRODUCTS) throw new Error('商品库索引格式无效，请联系管理员重新同步。');
      const source = normalizeCatalog({schemaVersion:1,source:manifest.source,products:[]}).source;
      const seen = new Set(); let expected = 0;
      for (const part of manifest.pages) {
        if (!Number.isSafeInteger(part?.index) || part.index < 0 || part.index >= 100 || seen.has(part.index)
            || !Number.isSafeInteger(part.count) || part.count < 0 || part.count > CATALOG_MAX_PRODUCTS) throw new Error('商品库分页索引无效，请联系管理员重新同步。');
        seen.add(part.index); expected += part.count;
      }
      if (expected !== manifest.total) throw new Error('商品库索引数量不一致，请联系管理员重新同步。');
      const products = [];
      for (let i = 0; i < manifest.pages.length; i++) {
        if (!active()) return null;
        const part = manifest.pages[i]; catalogProgress = `正在读取商品库 ${i + 1} / ${manifest.pages.length} 页…`; update();
        const response = await currentStore.catalogPage(part.index);
        if (!active()) return null;
        if (response?.generation !== manifest.generation || response.index !== part.index) throw new Error('商品库同步版本已变化，请重新加载，避免混用不同快照。');
        const normalized = normalizeCatalog(response);
        if (JSON.stringify(normalized.source) !== JSON.stringify(source) || normalized.products.length !== part.count) throw new Error('商品库分页来源或数量不一致，请重新加载。');
        products.push(...normalized.products);
      }
      if (!active()) return null;
      catalog = normalizeCatalog({schemaVersion:1,source,products});
      catalogStatus = 'ready'; catalogIssue = ''; catalogProgress = ''; catalogPage = 1; catalogSearchCache = null;
      update(); return catalog;
    } catch (error) {
      if (!active()) return null;
      catalogStatus = 'error'; catalogIssue = error.message || '商品库读取失败，请稍后重试。'; catalogProgress = '';
      update(); if (!background && page !== 'catalog') notify(catalogIssue, true); return null;
    } finally { if (request === catalogRequest) catalogPromise = null; }
  })();
  catalogPromise = promise;
  return promise;
}
function catalogMatches() {
  if (!catalog) return [];
  if (catalogSearchCache?.catalog === catalog && catalogSearchCache.query === catalogQuery) return catalogSearchCache.products;
  const products = [];
  // The pure lookup caps each candidate group at 200. Search every group to paginate all results.
  for (let index = 0; index < catalog.products.length; index += 200) products.push(...searchProducts(catalog.products.slice(index,index+200),catalogQuery,{limit:200}));
  catalogSearchCache = {catalog,query:catalogQuery,products}; return products;
}
function catalogHTML() {
  let html = heading('牵牛花商品库','选择已同步商品，再拍包装上的生产日期和保质期。',`<button class="button" data-action="catalog-reload" ${!connected||demo||catalogStatus==='loading'?'disabled':''}>${icon('refresh')}重新加载</button>`,'CATALOG SNAPSHOT') + banners();
  if (!connected || demo) return html + `<div class="empty"><span class="empty-icon">${icon('catalog')}</span><h3>商品库尚未加载</h3><p>${demo?'示例体验不读取真实商品库。退出示例并连接团队后可查看牵牛花快照。':'先连接团队，再读取私有仓库中的牵牛花商品快照。此处尚未读取商品数量。'}</p><button class="button primary" data-action="${demo?'exit-demo':'team'}">${demo?'退出示例':'连接团队'}</button></div>`;
  if (catalogStatus === 'loading') html += `<div class="notice" role="status">${icon('refresh')}<p>${e(catalogProgress)}${catalog?'当前仍显示此前已加载的快照。':''}</p></div>`;
  if (catalogIssue) html += `<div class="notice warning" role="alert">${icon('alert')}<p>${e(catalogIssue)}${catalog?' 当前仍显示此前已加载的快照。':' 商品库尚未加载，不代表没有商品。'}</p><button class="button small" data-action="catalog-reload">重试</button></div>`;
  if (!catalog) return html + `<div class="empty"><span class="empty-icon">${icon('catalog')}</span><h3>${catalogStatus==='loading'?'正在加载商品库':'商品库尚未加载'}</h3><p>${catalogStatus==='loading'?'正在逐页核对同一份牵牛花快照，完成后显示商品。':'请重新加载，或联系管理员检查商品快照与团队连接。'}</p></div>`;
  const source = catalog.source, matches = catalogMatches();
  const pages = Math.max(1,Math.ceil(matches.length/CATALOG_PAGE_SIZE)); catalogPage = Math.min(Math.max(1,catalogPage),pages);
  html += `<section class="catalog-source"><div><strong>牵牛花快照</strong><span>上次同步：${e(catalogTime(source.syncedAt))}</span>${source.scope?`<span>同步范围：${e(source.scope)}</span>`:''}</div><span class="catalog-completeness ${source.complete?'complete':'partial'}">${source.complete?'来源标记为完整快照':'仅已采集部分 · 尚未确认完整'}</span><p>当前加载 ${catalog.products.length} 个 SKU。此为同步时的商品资料，后续变动需再次同步；图片由美团图片源提供。</p></section><div class="toolbar catalog-toolbar"><label class="search-field">${icon('search')}<input id="catalog-search" type="search" maxlength="300" placeholder="搜索名称、规格、条码或 SKU" value="${e(catalogQuery)}" aria-label="搜索商品库"></label><span class="count-label">找到 ${matches.length} 个 SKU</span></div>`;
  if (!matches.length) html += `<div class="empty"><span class="empty-icon">${icon('search')}</span><h3>${catalogQuery?'没有匹配的商品':'当前快照没有商品记录'}</h3><p>${catalogQuery?'试试完整条码、SKU 或较短的商品名称。':'这份已加载快照的商品列表为空；请核对同步范围。'}</p></div>`;
  else html += `<div class="catalog-grid">${matches.slice((catalogPage-1)*CATALOG_PAGE_SIZE,catalogPage*CATALOG_PAGE_SIZE).map(product=>`<article class="catalog-card">${productThumbnail(product)}<div class="catalog-product"><h2>${e(product.name)}</h2><p>${e(product.spec||'未提供规格')}</p>${product.category?`<span>${e(product.category)}</span>`:''}<dl><dt>SKU</dt><dd>${e(product.sku)}</dd><dt>条码</dt><dd>${e(product.barcodes.join(' / ')||'未提供条码')}</dd></dl></div><button class="button soft" data-action="catalog-photo" data-sku="${e(product.sku)}">${icon('camera')}选择并拍照</button></article>`).join('')}</div>`;
  if (matches.length) html += `<div class="catalog-pagination"><button class="button small" data-action="catalog-prev" ${catalogPage===1?'disabled':''}>上一页</button><span>第 ${catalogPage} / ${pages} 页 · 每页 ${CATALOG_PAGE_SIZE} 个</span><button class="button small" data-action="catalog-next" ${catalogPage===pages?'disabled':''}>下一页</button></div>`;
  return html;
}
async function resolveCatalogProduct(parsed) {
  if (!connected || demo) return {product:null,candidates:[],message:'商品库尚未加载，本次仅按包装照片建档。'};
  const loaded = await loadCatalog({background:true});
  if (!loaded) return {product:null,candidates:[],message:catalogIssue||'商品库尚未加载，本次无法自动关联。'};
  const matched = matchBarcode(loaded,parsed.barcode);
  if (matched.status === 'matched') return {product:matched.product,candidates:[],message:'已按包装条码唯一匹配商品，请核对图片和规格。'};
  if (matched.status === 'ambiguous') return {product:null,candidates:matched.candidates.slice(0,20),message:'这个条码对应多个商品，请核对图片和规格后明确选择，系统不会自动关联。'};
  const names = nameCandidates(loaded,parsed.name,{limit:20});
  return {product:null,candidates:names.candidates,message:names.total?'以下仅为名称候选，请点击确认商品和规格；不会根据名称自动关联。':'未在当前快照中找到对应商品，可按包装照片保存，或从商品库明确选择后补拍。'};
}


function records() { return state.records.filter(r => !r.deletedAt); }
function type(r) { return r.deletedAt ? 'removed' : classify(r, state.settings); }
function counts() {
  const all = records(), active = all.filter(r => r.status === 'active');
  const group = key => all.filter(r => type(r) === key).length;
  return {all:all.length,active:active.length,products:new Set(active.map(r => r.barcode || r.name)).size,expired:group('expired'),today:group('today'),urgent:group('urgent'),warning:group('warning'),normal:group('normal'),handled:group('handled'),removed:state.records.length-all.length};
}
function notify(message, error = false) {
  const el = $('#toast'); el.textContent = message; el.className = `toast visible${error?' error':''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), error ? 6500 : 3500);
}
function updateChrome() {
  const c = counts();
  for (const selector of ['.desktop-nav','.bottom-nav']) $(selector).innerHTML = navItems.map(([id,ic,label,short]) => `<button class="nav-item ${page===id?'active':''}" data-page="${id}" ${page===id?'aria-current="page"':''}>${icon(ic)}<span>${selector==='.bottom-nav'?short:label}</span>${id==='tasks'&&c.expired+c.today+c.urgent?`<span class="nav-count">${c.expired+c.today+c.urgent}</span>`:''}</button>`).join('');
  $('#page-label').textContent = navItems.find(item => item[0] === page)[2];
  const pill = $('#sync-pill');
  pill.className = `sync-pill ${errorText?'error':dirty?'dirty':connected?'connected':''}`;
  pill.innerHTML = `<span class="status-dot"></span><span>${busy?'正在同步…':demo?'示例体验':dirty?'草稿未同步':connected?'团队已连接':'尚未连接'}</span>`;
  $('#user-avatar').textContent = config.actor.slice(0,1) || '鲜';
}
function heading(title,desc,actions='',eyebrow='FRESHNESS MATTERS') { return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${desc}</p></div><div class="heading-actions${actions.includes('data-action="add"')?' single':''}">${actions}</div></div>`; }
function banners() {
  let html = demo ? `<div class="demo-strip">${icon('leaf')}当前为示例体验，所有记录仅用于演示。<button data-action="exit-demo">退出示例</button></div>` : '';
  if (errorText) html += `<div class="notice error">${icon('alert')}<p>${e(errorText)}</p><button class="button small" data-action="export-json">备份草稿</button></div>`;
  else if (dirty && !demo) html += `<div class="notice warning">${icon('alert')}<p>有尚未保存到 GitHub 的修改。请保持页面打开，连接后同步或先导出备份。</p><button class="button small" data-action="${connected?'sync':'team'}">${connected?'重试保存':'去连接'}</button></div>`;
  else if (!demo && !connected && connectionIssue) html += `<div class="notice warning">${icon('alert')}<p>${e(connectionIssue)} 拍照草稿暂留当前页面，尚未上传。</p><button class="button small" data-action="team">查看连接</button></div>`;
  return html;
}
function statsHTML() {
  const c = counts();
  return `<section class="stats" aria-label="保质期统计">
    <button class="stat" data-action="filter" data-filter="all"><span class="stat-top">在管商品批次<span class="stat-icon">${icon('box')}</span></span><strong>${c.active}<small>批次</small></strong><span class="stat-bottom">${c.products} 种商品 · 持续跟进中</span></button>
    <button class="stat critical" data-action="filter" data-filter="expired"><span class="stat-top">过期 / 今日到期<span class="stat-icon">${icon('alert')}</span></span><strong>${c.expired+c.today}<small>批次</small></strong><span class="stat-bottom">请优先检查并处理</span></button>
    <button class="stat urgent" data-action="filter" data-filter="urgent"><span class="stat-top">${state.settings.urgentDays} 天内到期<span class="stat-icon">${icon('clock')}</span></span><strong>${c.urgent}<small>批次</small></strong><span class="stat-bottom">提前安排 · 减少损耗</span></button>
    <button class="stat" data-action="filter" data-filter="handled"><span class="stat-top">累计已处理<span class="stat-icon">${icon('check')}</span></span><strong>${c.handled}<small>批次</small></strong><span class="stat-bottom">每一次处理都有记录</span></button>
  </section>`;
}
function remaining(r) {
  if (r.deletedAt) return '可恢复此记录';
  if (r.status === 'handled') return r.handledReason || '已完成处理';
  const days = daysUntil(r.expiryDate);
  return days<0?`已过期 ${Math.abs(days)} 天`:days===0?'请今日处理':`剩余 ${days} 天`;
}
function tableHTML(list,emptyTitle='还没有拍照批次',emptyDesc='拍下商品名称、生产日期和保质期，识别后核对确认。无需手动录入商品信息。',isDashboard=false) {
  if (!list.length) return `<div class="empty"><span class="empty-icon">${icon('camera')}</span><h3>${emptyTitle}</h3><p>${emptyDesc}</p><div class="action-row">${!records().length?`<button class="button primary" data-action="add">${icon('camera')}拍第一件商品</button>${!demo?'<button class="button ghost" data-action="demo">体验示例</button>':''}`:`<button class="button soft" data-action="filter" data-filter="all">查看全部批次</button>`}</div></div>`;
  return `<div class="batch-table"><div class="table-head"><span>商品 / 批次</span><span class="category-cell">分类 / 库位</span><span class="quantity-cell">数量</span><span>到期日期</span><span>保质期状态</span><span style="text-align:right">操作</span></div>${list.slice(0,isDashboard?5:limit).map((r,index) => {
    const t = type(r); let progress = 0;
    if(r.productionDate) { const total = daysUntil(r.expiryDate,r.productionDate); if(total>0) progress = Math.min(100,Math.max(0,100-daysUntil(r.expiryDate)/total*100)); }
    return `<article class="batch-row"><div class="product-info"><span class="product-icon tone-${index%4}">${icon(r.category?.includes('饮')?'leaf':'box')}</span><div><span class="product-name">${e(r.name)}</span><span class="product-code">${e(r.barcode || '未填写条码')} ${r.batchCode?`· 批次 ${e(r.batchCode)}`:''}</span></div></div><div class="category-cell">${e(r.category || '未分类')}<span class="cell-secondary">${e(r.location || '未填写库位')}</span></div><div class="quantity-cell">${e(r.quantity)} ${e(r.unit)}<span class="cell-secondary">${e(r.batchCode || '独立批次')}</span></div><div class="expiry-cell">${e(r.expiryDate)}<span class="cell-secondary">${r.productionDate?`生产 ${e(r.productionDate)}`:'按包装到期日期'}</span>${progress?`<div class="progress-track" aria-hidden="true"><span class="${t}" style="width:${progress}%"></span></div>`:''}</div><div class="status-cell"><span class="badge ${t}">${labels[t]}</span><span class="cell-secondary">${e(remaining(r))}</span></div><div class="row-actions">${t==='removed'?`<button class="icon-button handle" data-action="restore-deleted" data-id="${e(r.id)}" title="恢复记录" aria-label="恢复 ${e(r.name)}">${icon('refresh')}</button>`:`<button class="icon-button" data-action="edit" data-id="${e(r.id)}" title="查看包装档案" aria-label="查看 ${e(r.name)}">${icon('edit')}</button><button class="icon-button handle" data-action="${r.status==='handled'?'restore':'handle'}" data-id="${e(r.id)}" title="${r.status==='handled'?'恢复在管':'标记处理'}" aria-label="${r.status==='handled'?'恢复在管':'处理'} ${e(r.name)}">${icon(r.status==='handled'?'refresh':'check')}</button>`}</div></article>`;
  }).join('')}${!isDashboard&&list.length>limit?`<div class="table-tail"><span>已显示 ${limit} / ${list.length} 批次</span><button class="text-button" data-action="load-more">加载更多 ${icon('down')}</button></div>`:''}</div>`;
}
function overviewHTML() {
  const c = counts(), todo = c.expired+c.today+c.urgent;
  const attention = records().filter(r=>r.status==='active').sort((a,b)=>a.expiryDate.localeCompare(b.expiryDate));
  const date = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'long'}).format(new Date());
  return heading('保质期总览',`${date} <span class="desktop-only">· 拍包装，自动建立保质期档案</span>`,`<button class="button primary" data-action="add">${icon('camera')}拍照建档</button>`)+banners()+`<button class="button primary camera-start" data-action="add">${icon('camera')}拍商品包装，识别保质期 ${icon('arrow')}</button>`+statsHTML()+`
  <section class="hero-grid"><div class="inspection"><div class="inspection-top">${icon('leaf')}今日保质期巡检</div><h2>${todo?`有 ${todo} 批商品<br>需要优先关注`:'每一批新鲜，<br>都安排得刚刚好。'}</h2><p>${todo?'从临近到期的批次开始，及时检查、及时处理。':c.active?'当前没有紧急临期商品，记得每天查看商品状态。':'建立商品批次档案，到期前早一步发现、早一步处理。'}</p><button class="button" data-action="${todo?'tasks':'add'}">${todo?'去处理临期商品':'开始记录新鲜'} ${icon('arrow')}</button><div class="hero-art">${icon('leaf')}</div></div>
  <div class="quick-panel"><div><span class="panel-eyebrow">PHOTO FIRST</span><h3>拍清楚，就能记下来</h3></div><button class="quick-link" data-action="add">${icon('camera')}<span>拍照识别包装<small>名称、生产日期与保质期</small></span>${icon('arrow')}</button><button class="quick-link" data-action="team">${icon('users')}<span>团队自动同步<small>${connected?'私有 bzq 已连接':'查看后台连接状态'}</small></span>${icon('arrow')}</button></div></section>
  <div class="section-heading"><h2>即将到期的批次 <small>按到期时间排序</small></h2><button class="text-button" data-page="batches">全部批次 ${icon('arrow')}</button></div>
  ${tableHTML(attention,c.active?'当前暂无在管批次':'新鲜管理，从第一张照片开始',c.handled?'所有商品批次均已处理。新到货时，拍照建立新的批次。':undefined,true)}
  <div class="help-line">${icon('clock')}预警规则：${state.settings.urgentDays} 天内紧急临期，${state.settings.warningDays} 天内即将临期。到期当天优先处理。</div>`;
}
function filteredRecords() {
  let list = state.records.filter(r=>filter==='removed'?!!r.deletedAt:!r.deletedAt);
  if (page === 'tasks') list = list.filter(r=>r.status==='active'&&['expired','today','urgent','warning'].includes(type(r)));
  if(filter !== 'all' && filter !== 'removed') list = list.filter(r=>filter==='expired'?['expired','today'].includes(type(r)):type(r)===filter);
  const needle = search.trim().toLowerCase();
  if(needle) list = list.filter(r=>[r.name,r.spec,r.productSku,r.barcode,r.batchCode,r.location,r.note].some(v=>String(v||'').toLowerCase().includes(needle)));
  if(category) list = list.filter(r=>r.category===category);
  return list.sort((a,b)=>sort==='name'?a.name.localeCompare(b.name,'zh-CN'):sort==='updated'?b.updatedAt.localeCompare(a.updatedAt):a.expiryDate.localeCompare(b.expiryDate));
}
function batchesHTML(tasks=false) {
  const c = counts();
  const filters = tasks?[['all','全部待办'],['expired','过期 / 今日'],['urgent',`${state.settings.urgentDays}天内`],['warning',`${state.settings.warningDays}天内`]]:[['all','全部批次'],['expired','过期 / 今日'],['urgent','紧急临期'],['warning','即将临期'],['normal','保质期内'],['handled','已处理'],['removed','已移除']];
  const categories = [...new Set(records().map(r=>r.category).filter(Boolean))].sort();
  const list = filteredRecords();
  return heading(tasks?'临期处理':'商品批次',tasks?'先到期，先处理。让每次巡检都有结果。':'商品信息来自包装照片，按到期日期分别管理。',tasks?`<button class="button" data-action="export-json">${icon('down')}备份清单</button>`:`<button class="button primary" data-action="add">${icon('camera')}拍照建档</button>`,tasks?'TAKE ACTION':'BATCH BY BATCH')+banners()+
  (tasks?`<div class="task-intro"><span>当前有 <strong>${c.expired+c.today+c.urgent+c.warning} 批</strong> 商品需要关注。<br><small class="cell-secondary">处理后保留记录，方便团队查阅。</small></span>${icon('clock')}</div>`:'')+
  `<div class="filter-tabs" aria-label="保质期筛选">${filters.map(([id,label])=>`<button class="filter-tab ${filter===id?'active':''}" data-action="set-filter" data-filter="${id}">${label}${id==='all'?'':`<small>${id==='expired'?c.expired+c.today:c[id]}</small>`}</button>`).join('')}</div>
  <div class="toolbar"><label class="search-field">${icon('search')}<input id="search" type="search" placeholder="搜索商品、条码、批次或库位" value="${e(search)}" aria-label="搜索商品"></label><select id="category-filter" aria-label="筛选分类"><option value="">全部分类</option>${categories.map(v=>`<option ${category===v?'selected':''}>${e(v)}</option>`).join('')}</select><select id="sort-select" aria-label="排序方式"><option value="expiry" ${sort==='expiry'?'selected':''}>到期时间 ↑</option><option value="updated" ${sort==='updated'?'selected':''}>最近修改</option><option value="name" ${sort==='name'?'selected':''}>商品名称</option></select><span class="count-label">共 ${list.length} 批次</span></div>
  ${tableHTML(list,tasks?'没有待处理的临期商品':search||category||filter!=='all'?'没有符合条件的批次':'还没有商品批次',tasks?'当前没有到期或临期的批次。明天也记得来看看。':'试试调整筛选条件，或添加新的商品批次。')}
  <div class="help-line">${icon('check')}点击批次右侧查看照片或记录处理结果。信息需要更新时请补拍；已处理或已移除记录可恢复。</div>`;
}
function field(name,label,value='',options={}) {
  return `<label class="field ${options.full?'full':''}"><span>${label}${options.required?' <em>*</em>':''}</span><input name="${name}" type="${options.type||'text'}" value="${e(value)}" ${options.required?'required':''} ${options.attrs||''} ${options.placeholder?`placeholder="${e(options.placeholder)}"`:''}>${options.help?`<small>${options.help}</small>`:''}</label>`;
}
function teamHTML() {
  return heading('团队与同步','拍照建档，打开后自动连接团队。','','CONNECTED TOGETHER')+banners()+
    `<div class="team-layout"><div><section class="card"><h2>团队数据连接</h2><div class="connection-static">数据仓库：<b>Wzz79229 / bzq</b><br>数据文件：<code>data/shelf-life.json</code><br>照片文件：<code>photos/</code></div><div class="separator"></div>${connected?`<div class="team-status"><strong>已自动连接团队</strong><span>最后同步：${e(lastSync||'刚刚')}</span><div class="action-row" style="margin-top:12px"><button class="button small soft" data-action="refresh">${icon('refresh')}拉取最新</button>${dirty?'<button class="button small primary" data-action="sync">保存照片草稿</button>':''}<button class="button small ghost" data-action="disconnect">退出团队</button></div></div>`:needsLogin?`<p class="card-description">在此设备登录一次团队，下次打开会尝试自动连接。不需要 GitHub 令牌。</p><form id="team-login-form"><label class="field"><span>团队访问口令</span><input name="password" type="password" required autocomplete="current-password"></label><div id="connection-error" class="form-error" role="alert"></div><div class="form-actions"><button class="button primary" type="submit">登录团队</button></div></form>`:`<div class="notice warning"><p>${e(connectionIssue||'正在连接团队…')}</p></div><button class="button soft" data-action="auto-connect">${icon('refresh')}重新检查连接</button>`}<p class="form-note">成员不需要填写仓库信息或 GitHub 令牌。管理员在后台完成一次授权后，应用才能自动读取私有数据。</p></section><section class="card settings-card"><h2>照片草稿备份</h2><p class="card-description">保存失败时，请保持页面打开。完整备份包含当前记录与本页尚未上传的压缩照片。</p><button class="button" data-action="export-json">${icon('down')}下载完整备份</button><button class="button" data-action="restore-backup">恢复照片备份</button></section></div><section class="card"><span class="panel-eyebrow">PHOTO FIRST</span><h2 style="margin-top:10px">只拍照，不手动录入</h2><ol class="step-list"><li><b>拍商品名称</b>拍清完整产品名称或品名标签。</li><li><b>拍日期和保质期</b>可以补拍生产日期、保质期，或明确标注的到期日期。</li><li><b>核对后确认</b>识别结果只供核对。信息缺失或冲突时请补拍，系统不猜测日期。</li><li><b>自动保存到团队</b>授权后台连接成功后，记录与原始压缩照片一同保存到私有 bzq。</li></ol><button class="button primary" data-action="add">${icon('camera')}拍商品包装</button><div class="separator"></div><button class="text-button" data-action="install">${icon('down')}添加到手机桌面</button></section></div>`;
}
function render(preserveFocus=false) {
  let position,focus;
  if(preserveFocus){const el=document.activeElement;if(['search','catalog-search'].includes(el?.id)){position=el.selectionStart;focus=el.id;}}
  updateChrome(); $('#main').innerHTML = page==='overview'?overviewHTML():page==='team'?teamHTML():page==='catalog'?catalogHTML():batchesHTML(page==='tasks');
  if(focus){const el=$(`#${focus}`);if(el){el.focus({preventScroll:true});try{el.setSelectionRange(position,position);}catch{}}}
}
function go(next) { if(!navItems.some(item=>item[0]===next))return;if(page==='catalog'&&next!=='catalog'&&catalogStatus==='loading')cancelCatalogLoad();page=next;filter='all';search='';category='';limit=60;render();window.scrollTo({top:0,behavior:'instant'});if(next==='catalog'&&connected&&!demo)loadCatalog(); }
function showDialog(id,html) { const dialog=$(id);dialog.innerHTML=html;dialog.showModal();return dialog; }
function closeDialog(id) { $(id).close(); }
function confirmAction(title,message,actionText='继续',danger=false) {
  return new Promise(resolve => {
    const d=showDialog('#confirm-dialog',`<h2>${e(title)}</h2><p>${e(message)}</p><div class="action-row"><button class="button" data-confirm="cancel">取消</button><button class="button ${danger?'danger':'primary'}" data-confirm="ok">${e(actionText)}</button></div>`);
    let settled=false; const finish=value=>{if(settled)return;settled=true;d.close();d.removeEventListener('click',onClick);d.removeEventListener('cancel',onCancel);resolve(value);};
    const onClick=ev=>{const b=ev.target.closest('[data-confirm]');if(b)finish(b.dataset.confirm==='ok');};
    const onCancel=ev=>{ev.preventDefault();finish(false);};d.addEventListener('click',onClick);d.addEventListener('cancel',onCancel);
  });
}
function recordDialog(record=null,selectedProduct=null) {
  const linked=record?.productSku?(catalog?.products.find(product=>product.sku===record.productSku)||{sku:record.productSku,spu:record.productSpu||'',name:record.name,spec:record.spec||'',category:record.category||'',barcodes:record.barcode?[record.barcode]:[],imageUrl:''}):null;
  openPhotoFlow({existingRecord:record,selectedProduct:selectedProduct||linked,canSync:connected,resolveProduct:resolveCatalogProduct,onSave:async({parsed,previews,existingRecord,selectedProduct:product})=>{
    const input={...existingRecord,name:product?.name||parsed.name,spec:product?.spec||'',category:product?product.category:existingRecord?.category||'',...(product?{productSku:product.sku,productSpu:product.spu}:{}),barcode:parsed.barcode||(product?.barcodes.length===1?product.barcodes[0]:''),productionDate:parsed.productionDate,shelfLife:parsed.shelfLife,shelfUnit:parsed.shelfUnit,expiryDate:parsed.expiryDate,quantity:1,unit:'批',updatedAt:now(),photoRefs:previews.map(p=>({id:p.id,path:`photos/${p.id}.jpg`}))};
    if(!product){delete input.productSku;delete input.productSpu;}
    const validated=validateRecord(input);if(!validated.valid)throw new Error(validated.errors.join('；'));
    const r=validated.record;
    if(!existingRecord&&records().some(v=>v.name===r.name&&v.productionDate===r.productionDate&&v.expiryDate===r.expiryDate)&&!await confirmAction('发现相似拍照批次','已有同名商品的相同生产日期与到期日。确认是另一个批次时再继续。','仍然保存'))return false;
    for(const preview of previews)pendingPhotos.set(preview.id,preview);
    state.records=existingRecord?state.records.map(v=>v.id===existingRecord.id?r:v):[r,...state.records];
    await changed('拍照批次已保存');return true;
  }});
}
function viewRecord(r) {
  const linked=connected&&catalog?r.productSku&&catalog.products.find(product=>product.sku===r.productSku):null;
  const productHTML=r.productSku?`<div class="selected-catalog-product">${linked?productThumbnail(linked):''}<div><strong>${e(r.name)}</strong><span>${e(r.spec||'未提供规格')}</span><small>已关联 SKU ${e(r.productSku)}</small></div></div>`:'';
  const d=showDialog('#record-dialog',`<div class="dialog-heading"><div><h2>商品包装档案</h2><p>生产日期与到期信息来自包装照片。</p></div><button class="icon-button" data-close="record-dialog" aria-label="关闭">×</button></div><div class="dialog-body">${productHTML}<div class="photo-result"><h3>${e(r.name)}</h3><dl><dt>生产日期</dt><dd>${e(r.productionDate||'未标明')}</dd><dt>保质期</dt><dd>${r.shelfLife?e(r.shelfLife)+' '+({day:'天',month:'个月',year:'年'}[r.shelfUnit]):'按标注到期日'}</dd><dt>到期日期</dt><dd>${e(r.expiryDate)}</dd><dt>当前状态</dt><dd>${labels[type(r)]}</dd></dl></div><div id="saved-photos" class="record-photos"></div><div class="form-actions"><button class="button danger" data-action="delete" data-id="${e(r.id)}">移除批次</button><button class="button soft" data-action="retake" data-id="${e(r.id)}">补拍重新识别</button><button class="button" data-close="record-dialog">关闭</button></div></div>`);
  const urls=[];d.addEventListener('close',()=>urls.forEach(url=>URL.revokeObjectURL(url)),{once:true});
  for(const ref of r.photoRefs||[]){const img=document.createElement('img');img.alt='商品包装照片';$('#saved-photos',d).append(img);const pending=pendingPhotos.get(ref.id);if(pending)img.src=pending.dataUrl;else if(store&&connected)store.photo(ref.id).then(blob=>{if(!d.open)return;const url=URL.createObjectURL(blob);urls.push(url);img.src=url;}).catch(()=>{img.replaceWith(document.createTextNode('照片暂时无法读取，请稍后重试。'));});else img.replaceWith(document.createTextNode('连接团队后可查看已保存的包装照片。'));}
  if(!r.photoRefs?.length)$('#saved-photos',d).textContent='这是原有批次，没有包装照片，可补拍建立照片档案。';
}
async function changed(success) { state.updatedAt=now();dirty=true;errorText='';render();if(demo){dirty=false;notify(`${success}（示例）`);render();return;}if(connected)await save(success);else notify('已保留本页草稿，连接仓库后才能同步'); }
async function save(success='已同步到 GitHub') {
  if(!store||!connected||busy||demo)return;
  busy=true;updateChrome();
  try{const saved=await syncPhotoState(store,sanitizeState(state),sha,pendingPhotos,{onSha:next=>{sha=next;}});sha=saved.sha;dirty=false;pendingPhotos.clear();errorText='';lastSync=new Date().toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'});notify(success);}
  catch(err){errorText=err.message;notify(err.message,true);if(err instanceof ConflictError)conflictDialog();}
  finally{busy=false;render();}
}
function conflictDialog() {
  if($('#conflict-dialog').open)return;
  showDialog('#conflict-dialog',`<h2>团队数据有新版本</h2><p>另一位成员已经更新了商品记录。你的草稿仍保留在本页，没有覆盖团队数据。\n\n先导出草稿，再载入最新记录，可对照补回本次修改。</p><div class="action-row"><button class="button" data-close="conflict-dialog">保留草稿</button><button class="button primary" data-action="resolve-conflict">导出草稿并载入</button></div>`);
}
async function refresh(silent=false,discard=false) {
  if(!store||!connected||busy||demo)return;
  // Never advance the shared SHA underneath an editor that still holds an old record.
  if(silent && (document.querySelector('dialog[open]') || document.activeElement?.matches('input,select,textarea')))return;
  if(dirty&&!discard){if(silent)return;if(!await confirmAction('载入团队最新数据','本页有未同步的草稿。建议先导出备份。继续载入将替换本页记录。','载入最新'))return;}
  busy=true;updateChrome();
  try{const latest=await store.read();if(latest.data===null)throw new Error('团队数据文件已被移除，请先确认仓库中的数据文件。');const incoming=sanitizeState(latest.data);if(latest.sha!==sha||discard){state=incoming;sha=latest.sha;dirty=false;errorText='';if(!silent)notify('已载入团队最新数据');render();}else if(!silent)notify('已经是团队最新版本');lastSync=new Date().toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'});}
  catch(err){if(!silent){errorText=err.message;notify(err.message,true);render();}}
  finally{busy=false;updateChrome();}
}
async function autoConnect(password) {
  if(busy||demo)return;cancelCatalogLoad(true);busy=true;updateChrome();
  try {
    if(!store){const response=await fetch('./connection.json',{cache:'no-store'});if(!response.ok)throw new Error('无法读取团队连接设置。');const settings=await response.json();store=new CloudStore(settings.apiBase);}
    if(password)await store.login(password);
    const session=await store.session();needsLogin=!session.authorized;
    if(needsLogin){connectionIssue='请先登录团队。';connected=false;return;}
    const incoming=await store.read();if(!incoming.data)throw new Error('团队数据文件尚未初始化。');
    const remote=sanitizeState(incoming.data);let shouldSave=false;
    if(dirty){
      if(sha&&sha!==incoming.sha){connected=true;throw new ConflictError();}
      const remoteById=new Map(remote.records.map(r=>[r.id,r]));
      if(!sha)for(const r of state.records){const existing=remoteById.get(r.id);if(existing&&existing.updatedAt!==r.updatedAt){connected=true;throw new ConflictError();}}
      state={...remote,records:[...state.records,...remote.records.filter(r=>!state.records.some(local=>local.id===r.id))],updatedAt:now()};shouldSave=true;
    }else state=remote;
    sha=incoming.sha;connected=true;dirty=shouldSave;errorText='';connectionIssue='';lastSync=new Date().toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'});notify('已自动连接团队');
  }catch(error){if(error instanceof ConflictError){errorText=error.message;conflictDialog();}else connected=false;connectionIssue=error.message;needsLogin=error.code==='UNAUTHORIZED';if(page==='team')notify(error.message,true);}
  finally{busy=false;render();}
  if(connected&&dirty&&!errorText)await save('本页照片草稿已同步到团队');
  if(connected&&page==='catalog')loadCatalog();
}
function download(text,name,mime='text/plain;charset=utf-8') { const url=URL.createObjectURL(new Blob([text],{type:mime}));const link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),20000); }
function exportJSON() {download(JSON.stringify({...state,photoAttachments:[...pendingPhotos.values()]},null,2),`鲜期-照片草稿备份-${todayISO()}.json`,'application/json;charset=utf-8');notify('已导出记录与本页照片草稿');}
function restorePhotoBackup() {
  const input=document.createElement('input');input.type='file';input.accept='.json';
  input.onchange=async()=>{const file=input.files?.[0];if(!file)return;
    try{
      if(file.size>50*1024*1024)throw new Error('备份超过 50 MB，请联系管理员恢复。');
      const raw=JSON.parse(await file.text()),backup=sanitizeState(raw);
      const attachments=raw.photoAttachments??[];if(!Array.isArray(attachments)||attachments.length>200)throw new Error('照片草稿格式或数量无效。');
      const wanted=new Set(backup.records.flatMap(r=>(r.photoRefs||[]).map(p=>p.id)));const restored=new Map();
      for(const p of attachments){const size=previewByteLength(p?.dataUrl);if(!p||!wanted.has(p.id)||restored.has(p.id)||size===null||size>300*1024||!p.dataUrl.startsWith('data:image/jpeg;base64,/9j/'))throw new Error('备份中的照片不完整或格式无效。');restored.set(p.id,{id:p.id,dataUrl:p.dataUrl,width:p.width,height:p.height});}
      if(!await confirmAction('恢复为本页照片草稿','将替换本页记录与未上传照片，不会立即覆盖团队。请先备份当前草稿，恢复后再连接团队核对同步。','恢复草稿'))return;
      cancelCatalogLoad(true);state=backup;pendingPhotos.clear();for(const [id,p] of restored)pendingPhotos.set(id,p);dirty=true;sha=null;connected=false;demo=false;errorText='';connectionIssue='照片备份已恢复为本页草稿，请连接团队后核对同步。';render();notify('已恢复照片草稿，尚未上传');
    }catch(error){notify(error.message,true);}
  };input.click();
}
function exportSpreadsheet(xlsx=false) {
  const list=page==='batches'||page==='tasks'?filteredRecords():state.records;
  if(xlsx&&window.XLSX){const data=window.XLSX.read(exportCSV(list),{type:'string',raw:true});window.XLSX.writeFile(data,`鲜期-商品批次-${todayISO()}.xlsx`);}else download(exportCSV(list),`鲜期-商品批次-${todayISO()}.csv`,'text/csv;charset=utf-8');
  notify(`已导出 ${list.length} 批次`);
}
async function handleRecord(r) {
  const d=showDialog('#confirm-dialog',`<h2>记录批次处理</h2><p>${e(r.name)} · ${e(r.expiryDate)} 到期<br>本批次 ${e(r.quantity)} ${e(r.unit)}。处理后保留完整批次记录。</p><form id="handle-form"><label class="field"><span>处理结果</span><select name="reason"><option>已下架</option><option>已售出</option><option>已报损</option><option>已退货</option><option>其他处理</option></select></label><div class="action-row"><button type="button" class="button" data-close="confirm-dialog">取消</button><button type="submit" class="button primary">${icon('check')}确认处理整批</button></div></form>`);
  $('#handle-form',d).addEventListener('submit',async ev=>{ev.preventDefault();if(busy)return;r.status='handled';r.handledReason=new FormData(ev.currentTarget).get('reason');r.handledAt=now();r.updatedAt=now();d.close();await changed('已记录处理结果');});
}
function demoState() {
  const date=todayISO();
  const sample=[['纯牛奶 250mL','乳品','冷柜 A-01',-2,12,'盒'],['原味酸奶 200g','乳品','冷柜 A-02',0,8,'杯'],['鲜榨橙汁 300mL','饮料','饮品架 B-01',3,24,'瓶'],['全麦吐司 400g','烘焙','面包架 C-01',6,6,'袋'],['海盐苏打饼干 100g','零食','零食架 D-02',18,32,'包'],['茉莉绿茶 500mL','饮料','饮品架 B-02',90,48,'瓶']];
  const data=emptyState();data.records=sample.map(([name,category,location,days,quantity,unit],index)=>validateRecord({name,category,location,expiryDate:addDays(date,days),productionDate:addDays(date,days-180),shelfLife:180,shelfUnit:'day',quantity,unit,batchCode:`DEMO-${String(index+1).padStart(3,'0')}`,barcode:`069000000000${index+1}`,note:'示例数据，仅用于体验。',status:'active'}).record);return data;
}
async function demoStart() {
  if((connected||dirty)&&!await confirmAction('进入示例体验','示例数据与团队数据分别管理。进入后将替换本页显示，请先保存或备份当前草稿。','进入示例'))return;
  cancelCatalogLoad(true);store=null;connected=false;sha=null;demo=true;dirty=false;errorText='';pendingPhotos.clear();state=demoState();go('overview');notify('正在体验示例数据');
}
async function install() {
  if(installPrompt){await installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;return;}
  await confirmAction('添加鲜期到手机桌面','苹果：使用 Safari 打开正式 HTTPS 链接，点分享按钮 → 添加到主屏幕。\n\n安卓：使用 Chrome 等浏览器打开链接，在菜单中选择“安装应用”或“添加到主屏幕”。\n\n安装后可直接从桌面打开。'+(['localhost','127.0.0.1','::1'].includes(location.hostname)?'当前本机预览链接不能从手机访问。':''),'知道了');
}

document.addEventListener('click',async ev=>{
  const b=ev.target.closest('button,[data-page]');if(!b)return;
  if(b.dataset.close){closeDialog(`#${b.dataset.close}`);return;}
  if(b.dataset.page){go(b.dataset.page);return;}
  const action=b.dataset.action;if(!action)return;
  if(busy&&!['export-json','export-csv','export-xlsx','team','install'].includes(action)){notify('正在同步，请稍候');return;}
  const r=state.records.find(item=>item.id===b.dataset.id);
  if(action==='add')recordDialog();
  else if(action==='catalog-reload')loadCatalog({force:true});
  else if(action==='catalog-photo'){const product=connected&&catalog?.products.find(item=>item.sku===b.dataset.sku);if(product)recordDialog(null,product);}
  else if(action==='catalog-prev'){catalogPage=Math.max(1,catalogPage-1);render();$('#catalog-search')?.scrollIntoView({block:'start'});}
  else if(action==='catalog-next'){catalogPage++;render();$('#catalog-search')?.scrollIntoView({block:'start'});}
  else if(action==='edit'&&r)viewRecord(r);
  else if(action==='retake'&&r){const d=$('#record-dialog');d.addEventListener('close',()=>recordDialog(r),{once:true});d.close();}
  else if(action==='filter'){go('batches');filter=b.dataset.filter;render();}
  else if(action==='set-filter'){filter=b.dataset.filter;limit=60;render();}
  else if(action==='tasks')go('tasks');
  else if(action==='team')go('team');
  else if(action==='import')recordDialog();
  else if(action==='auto-connect')autoConnect();
  else if(action==='handle'&&r)handleRecord(r);
  else if(action==='restore'&&r){if(await confirmAction('恢复为在管批次',`将 ${r.name} 恢复为在管状态，并重新参与临期提醒。`,'恢复在管')){r.status='active';r.handledReason='';r.handledAt='';r.updatedAt=now();await changed('已恢复为在管批次');}}
  else if(action==='delete'&&r){if(await confirmAction('移除商品批次',`将 ${r.name} 从在管清单移除。可在“已移除”筛选中恢复，GitHub 历史也会保留。`,'移除批次',true)){r.deletedAt=now();r.updatedAt=now();closeDialog('#record-dialog');await changed('批次已移除，可恢复');}}
  else if(action==='restore-deleted'&&r){r.deletedAt='';r.updatedAt=now();await changed('已恢复批次记录');}
  else if(action==='sync')save();
  else if(action==='refresh')refresh();
  else if(action==='disconnect'){if(dirty&&!await confirmAction('退出团队','本页有未同步照片，请先备份。退出后将清除本页记录与照片草稿。','退出团队'))return;try{await store?.logout();}catch(error){notify(error.message,true);return;}cancelCatalogLoad(true);store=null;connected=false;sha=null;state=emptyState();pendingPhotos.clear();dirty=false;errorText='';needsLogin=true;render();notify('已退出团队');}
  else if(action==='export-json')exportJSON();
  else if(action==='restore-backup')restorePhotoBackup();
  else if(action==='export-csv')exportSpreadsheet();
  else if(action==='export-xlsx')exportSpreadsheet(true);
  else if(action==='resolve-conflict'){exportJSON();closeDialog('#conflict-dialog');await refresh(false,true);}
  else if(action==='demo')demoStart();
  else if(action==='exit-demo'){cancelCatalogLoad(true);demo=false;dirty=false;pendingPhotos.clear();state=emptyState();errorText='';go('overview');autoConnect();}
  else if(action==='load-more'){limit+=60;render();}
  else if(action==='install')install();
});
document.addEventListener('input',ev=>{if(ev.target.id==='search'){search=ev.target.value;limit=60;render(true);}else if(ev.target.id==='catalog-search'){catalogQuery=ev.target.value.replace(/[\u0000-\u001f\u007f]/g,'');catalogPage=1;render(true);}});
document.addEventListener('error',ev=>{const img=ev.target;if(img instanceof HTMLImageElement&&img.matches('[data-catalog-image]')){img.hidden=true;img.parentElement.classList.add('image-failed');img.parentElement.setAttribute('title','图片暂时无法加载');}},true);
document.addEventListener('change',ev=>{if(ev.target.id==='category-filter'){category=ev.target.value;limit=60;render();}else if(ev.target.id==='sort-select'){sort=ev.target.value;render();}});
document.addEventListener('submit',async ev=>{
  if(ev.target.id==='team-login-form'){ev.preventDefault();await autoConnect(new FormData(ev.target).get('password'));}
  else if(ev.target.id==='settings-form'){
    ev.preventDefault();if(busy)return;const data=new FormData(ev.target);const urgentDays=Number(data.get('urgentDays')),warningDays=Number(data.get('warningDays'));
    if(!Number.isInteger(urgentDays)||!Number.isInteger(warningDays)||urgentDays<1||warningDays<urgentDays||warningDays>3650){notify('提醒天数须为整数，紧急临期不超过即将临期，最多 3650 天。',true);return;}
    state.settings={urgentDays,warningDays};await changed('提醒规则已保存');
  }
});
window.addEventListener('beforeunload',ev=>{if(dirty&&!demo){ev.preventDefault();ev.returnValue='';}});
window.addEventListener('beforeinstallprompt',ev=>{ev.preventDefault();installPrompt=ev;});
window.addEventListener('online',()=>{notify('网络已恢复');if(connected&&!dirty)refresh(true);});
window.addEventListener('offline',()=>{notify('当前离线，操作将暂留本页，联网后请同步',true);updateChrome();});
setInterval(()=>{if(connected&&!dirty&&!busy&&!document.hidden&&!document.querySelector('dialog[open]'))refresh(true);},60000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&connected&&!dirty&&!document.querySelector('dialog[open]'))refresh(true);});
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
if(new URLSearchParams(location.search).get('demo')==='1'){demo=true;state=demoState();}
render();

if(!demo)autoConnect();
