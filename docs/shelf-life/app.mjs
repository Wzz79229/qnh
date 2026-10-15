import { DEFAULT_SETTINGS, todayISO, addDays, calculateExpiry, daysUntil, classify, validateRecord, importCSV, importRows, exportCSV, sanitizeState } from './core.mjs';
import { GitHubStore, ConflictError } from './github.mjs';

const $ = (s, root = document) => root.querySelector(s);
const e = (value = '') => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon = (name, extra = '') => `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const now = () => new Date().toISOString();
const emptyState = () => ({ schemaVersion: 1, records: [], settings: {...DEFAULT_SETTINGS}, updatedAt: now() });
const navItems = [['overview','grid','保质期总览','总览'],['batches','box','商品批次','批次'],['tasks','clock','临期处理','待办'],['team','users','团队与同步','团队']];
const labels = {expired:'已过期',today:'今日到期',urgent:'紧急临期',warning:'即将临期',normal:'保质期内',handled:'已处理',removed:'已移除'};
let state = emptyState();
let page = 'overview', filter = 'all', search = '', category = '', sort = 'expiry', limit = 60;
let store = null, sha = null, connected = false, dirty = false, busy = false, demo = false, errorText = '', lastSync = '';
let importResult = null, installPrompt = null, toastTimer, importVersion = 0;
let config = {owner:'Wzz79229',repo:'bzq',branch:'main',path:'data/shelf-life.json',actor:''};
try {
  const saved = JSON.parse(localStorage.getItem('fresh-period-connection') || 'null');
  if (saved && typeof saved === 'object') {
    for (const key of Object.keys(config)) if (typeof saved[key] === 'string') config[key] = saved[key];
    // Move only the complete former default; keep intentionally customized connections.
    if (saved.owner?.toLowerCase?.() === 'wzz79229' && saved.repo?.toLowerCase?.() === 'qnh-shelf-life-data'
      && saved.branch === 'main' && saved.path === 'data/shelf-life.json') {
      config.repo = 'bzq';
      localStorage.setItem('fresh-period-connection', JSON.stringify(config));
    }
  }
} catch {}

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
function tableHTML(list,emptyTitle='还没有商品批次',emptyDesc='先录入第一批商品，或导入已有的商品表格。鲜期会帮你按到期日期整理。',isDashboard=false) {
  if (!list.length) return `<div class="empty"><span class="empty-icon">${icon('leaf')}</span><h3>${emptyTitle}</h3><p>${emptyDesc}</p><div class="action-row">${!records().length?`<button class="button primary" data-action="add">${icon('plus')}录入第一批</button><button class="button" data-action="${demo?'import':'team'}">${demo?'导入表格':'连接团队仓库'}</button>${!demo?'<button class="button ghost" data-action="demo">体验示例</button>':''}`:`<button class="button soft" data-action="filter" data-filter="all">查看全部批次</button>`}</div></div>`;
  return `<div class="batch-table"><div class="table-head"><span>商品 / 批次</span><span class="category-cell">分类 / 库位</span><span class="quantity-cell">数量</span><span>到期日期</span><span>保质期状态</span><span style="text-align:right">操作</span></div>${list.slice(0,isDashboard?5:limit).map((r,index) => {
    const t = type(r); let progress = 0;
    if(r.productionDate) { const total = daysUntil(r.expiryDate,r.productionDate); if(total>0) progress = Math.min(100,Math.max(0,100-daysUntil(r.expiryDate)/total*100)); }
    return `<article class="batch-row"><div class="product-info"><span class="product-icon tone-${index%4}">${icon(r.category?.includes('饮')?'leaf':'box')}</span><div><span class="product-name">${e(r.name)}</span><span class="product-code">${e(r.barcode || '未填写条码')} ${r.batchCode?`· 批次 ${e(r.batchCode)}`:''}</span></div></div><div class="category-cell">${e(r.category || '未分类')}<span class="cell-secondary">${e(r.location || '未填写库位')}</span></div><div class="quantity-cell">${e(r.quantity)} ${e(r.unit)}<span class="cell-secondary">${e(r.batchCode || '独立批次')}</span></div><div class="expiry-cell">${e(r.expiryDate)}<span class="cell-secondary">${r.productionDate?`生产 ${e(r.productionDate)}`:'按包装到期日期'}</span>${progress?`<div class="progress-track" aria-hidden="true"><span class="${t}" style="width:${progress}%"></span></div>`:''}</div><div class="status-cell"><span class="badge ${t}">${labels[t]}</span><span class="cell-secondary">${e(remaining(r))}</span></div><div class="row-actions">${t==='removed'?`<button class="icon-button handle" data-action="restore-deleted" data-id="${e(r.id)}" title="恢复记录" aria-label="恢复 ${e(r.name)}">${icon('refresh')}</button>`:`<button class="icon-button" data-action="edit" data-id="${e(r.id)}" title="编辑批次" aria-label="编辑 ${e(r.name)}">${icon('edit')}</button><button class="icon-button handle" data-action="${r.status==='handled'?'restore':'handle'}" data-id="${e(r.id)}" title="${r.status==='handled'?'恢复在管':'标记处理'}" aria-label="${r.status==='handled'?'恢复在管':'处理'} ${e(r.name)}">${icon(r.status==='handled'?'refresh':'check')}</button>`}</div></article>`;
  }).join('')}${!isDashboard&&list.length>limit?`<div class="table-tail"><span>已显示 ${limit} / ${list.length} 批次</span><button class="text-button" data-action="load-more">加载更多 ${icon('down')}</button></div>`:''}</div>`;
}
function overviewHTML() {
  const c = counts(), todo = c.expired+c.today+c.urgent;
  const attention = records().filter(r=>r.status==='active').sort((a,b)=>a.expiryDate.localeCompare(b.expiryDate));
  const date = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'long'}).format(new Date());
  return heading('保质期总览',`${date} <span class="desktop-only">· 今天也是保持新鲜的一天</span>`,`<button class="button desktop-only" data-action="import">${icon('up')}导入表格</button><button class="button primary" data-action="add">${icon('plus')}新增批次</button>`)+banners()+statsHTML()+`
  <section class="hero-grid"><div class="inspection"><div class="inspection-top">${icon('leaf')}今日保质期巡检</div><h2>${todo?`有 ${todo} 批商品<br>需要优先关注`:'每一批新鲜，<br>都安排得刚刚好。'}</h2><p>${todo?'从临近到期的批次开始，及时检查、及时处理。':c.active?'当前没有紧急临期商品，记得每天查看商品状态。':'建立商品批次档案，到期前早一步发现、早一步处理。'}</p><button class="button" data-action="${todo?'tasks':'add'}">${todo?'去处理临期商品':'开始记录新鲜'} ${icon('arrow')}</button><div class="hero-art">${icon('leaf')}</div></div>
  <div class="quick-panel"><div><span class="panel-eyebrow">KEEP IT SIMPLE</span><h3>日常管理，轻松一点</h3></div><button class="quick-link" data-action="import">${icon('up')}<span>批量导入商品<small>支持 Excel / CSV 表格</small></span>${icon('arrow')}</button><button class="quick-link" data-action="team">${icon('users')}<span>与团队一起管理<small>${connected?`${e(config.owner)}/${e(config.repo)}`:'连接 GitHub 团队仓库'}</small></span>${icon('arrow')}</button></div></section>
  <div class="section-heading"><h2>即将到期的批次 <small>按到期时间排序</small></h2><button class="text-button" data-page="batches">全部批次 ${icon('arrow')}</button></div>
  ${tableHTML(attention,c.active?'当前暂无在管批次':'新鲜管理，从第一批开始',c.handled?'所有商品批次均已处理。新到货时，记得添加新的批次。':undefined,true)}
  <div class="help-line">${icon('clock')}预警规则：${state.settings.urgentDays} 天内紧急临期，${state.settings.warningDays} 天内即将临期。到期当天优先处理。<button class="text-button" data-page="team">调整规则</button></div>`;
}
function filteredRecords() {
  let list = state.records.filter(r=>filter==='removed'?!!r.deletedAt:!r.deletedAt);
  if (page === 'tasks') list = list.filter(r=>r.status==='active'&&['expired','today','urgent','warning'].includes(type(r)));
  if(filter !== 'all' && filter !== 'removed') list = list.filter(r=>filter==='expired'?['expired','today'].includes(type(r)):type(r)===filter);
  const needle = search.trim().toLowerCase();
  if(needle) list = list.filter(r=>[r.name,r.barcode,r.batchCode,r.location,r.note].some(v=>String(v||'').toLowerCase().includes(needle)));
  if(category) list = list.filter(r=>r.category===category);
  return list.sort((a,b)=>sort==='name'?a.name.localeCompare(b.name,'zh-CN'):sort==='updated'?b.updatedAt.localeCompare(a.updatedAt):a.expiryDate.localeCompare(b.expiryDate));
}
function batchesHTML(tasks=false) {
  const c = counts();
  const filters = tasks?[['all','全部待办'],['expired','过期 / 今日'],['urgent',`${state.settings.urgentDays}天内`],['warning',`${state.settings.warningDays}天内`]]:[['all','全部批次'],['expired','过期 / 今日'],['urgent','紧急临期'],['warning','即将临期'],['normal','保质期内'],['handled','已处理'],['removed','已移除']];
  const categories = [...new Set(records().map(r=>r.category).filter(Boolean))].sort();
  const list = filteredRecords();
  return heading(tasks?'临期处理':'商品批次',tasks?'先到期，先处理。让每次巡检都有结果。':'按批次记录保质期，同一件商品也能分别管理。',tasks?`<button class="button" data-action="export-csv">${icon('down')}导出清单</button>`:`<button class="button desktop-only" data-action="import">${icon('up')}导入表格</button><button class="button primary" data-action="add">${icon('plus')}新增批次</button>`,tasks?'TAKE ACTION':'BATCH BY BATCH')+banners()+
  (tasks?`<div class="task-intro"><span>当前有 <strong>${c.expired+c.today+c.urgent+c.warning} 批</strong> 商品需要关注。<br><small class="cell-secondary">处理后保留记录，方便团队查阅。</small></span>${icon('clock')}</div>`:'')+
  `<div class="filter-tabs" aria-label="保质期筛选">${filters.map(([id,label])=>`<button class="filter-tab ${filter===id?'active':''}" data-action="set-filter" data-filter="${id}">${label}${id==='all'?'':`<small>${id==='expired'?c.expired+c.today:c[id]}</small>`}</button>`).join('')}</div>
  <div class="toolbar"><label class="search-field">${icon('search')}<input id="search" type="search" placeholder="搜索商品、条码、批次或库位" value="${e(search)}" aria-label="搜索商品"></label><select id="category-filter" aria-label="筛选分类"><option value="">全部分类</option>${categories.map(v=>`<option ${category===v?'selected':''}>${e(v)}</option>`).join('')}</select><select id="sort-select" aria-label="排序方式"><option value="expiry" ${sort==='expiry'?'selected':''}>到期时间 ↑</option><option value="updated" ${sort==='updated'?'selected':''}>最近修改</option><option value="name" ${sort==='name'?'selected':''}>商品名称</option></select><span class="count-label">共 ${list.length} 批次</span></div>
  ${tableHTML(list,tasks?'没有待处理的临期商品':search||category||filter!=='all'?'没有符合条件的批次':'还没有商品批次',tasks?'当前没有到期或临期的批次。明天也记得来看看。':'试试调整筛选条件，或添加新的商品批次。')}
  <div class="help-line">${icon('check')}点击批次右侧的勾号记录处理结果；编辑页面可移除批次。已处理或已移除记录均可恢复。</div>`;
}
function field(name,label,value='',options={}) {
  return `<label class="field ${options.full?'full':''}"><span>${label}${options.required?' <em>*</em>':''}</span><input name="${name}" type="${options.type||'text'}" value="${e(value)}" ${options.required?'required':''} ${options.attrs||''} ${options.placeholder?`placeholder="${e(options.placeholder)}"`:''}>${options.help?`<small>${options.help}</small>`:''}</label>`;
}
function teamHTML() {
  return heading('团队与同步','连接同一个仓库，让每位成员看到同一本商品账。','','CONNECTED TOGETHER')+banners()+`<div class="team-layout"><div><section class="card"><h2>${icon('github')} 团队数据仓库</h2><p class="card-description">源代码与商品数据均可保存在 GitHub。连接后每次操作都会尝试保存；发现团队版本变化时会暂停覆盖。</p>
  ${connected?`<div class="team-status"><strong>${e(config.owner)} / ${e(config.repo)}</strong><code>${e(config.branch)} · ${e(config.path)}</code><div class="last-sync">${lastSync?`最后同步：${e(lastSync)}`:''}</div><div class="action-row" style="margin-top:12px"><button class="button small soft" data-action="refresh">${icon('refresh')}拉取最新</button>${dirty?'<button class="button small primary" data-action="sync">保存草稿</button>':''}<button class="button small ghost" data-action="disconnect">断开连接</button></div></div>`:''}
  <form id="connection-form"><div class="form-grid">${field('owner','仓库所有者',config.owner,{required:true,attrs:'autocomplete="off" autocapitalize="none" spellcheck="false"'})}${field('repo','数据仓库名称',config.repo,{required:true,placeholder:'bzq',attrs:'autocomplete="off" autocapitalize="none" spellcheck="false"'})}${field('branch','分支',config.branch,{required:true,attrs:'autocomplete="off" autocapitalize="none" spellcheck="false"'})}${field('actor','你的显示名称',config.actor,{required:true,placeholder:'例如：小王',attrs:'maxlength="40" autocomplete="nickname"'})}${field('path','数据文件路径',config.path,{required:true,full:true,attrs:'autocomplete="off" autocapitalize="none" spellcheck="false"'})}${field('token','GitHub 访问令牌','',{required:true,type:'password',full:true,placeholder:'粘贴本人的访问令牌',attrs:'autocomplete="off" autocapitalize="none" spellcheck="false"',help:'令牌只在当前打开的页面中使用；刷新或关闭后需重新输入。请勿把令牌发给他人。'})}</div><div id="connection-error" class="form-error" role="alert"></div><div class="form-actions"><button class="button primary" type="submit" ${busy?'disabled':''}>${icon('github')}${busy?'正在连接…':'连接并载入团队数据'}</button></div></form>
  <p class="connection-hint">连接后会先载入团队已有记录，再进行修改。首次连接其他仓库时，须确保仓库及 ${e(config.branch)} 分支已存在；数据文件不存在时会创建空文件。</p></section>
  <section class="card settings-card"><h2>临期提醒规则</h2><p class="card-description">统一规则保存在团队数据中。日期以中国标准时间计算；提醒显示在 App 页面内。</p><form id="settings-form"><div class="form-grid">${field('urgentDays','紧急临期（天）',state.settings.urgentDays,{type:'number',required:true,attrs:'min="1" max="3650" inputmode="numeric"'})}${field('warningDays','即将临期（天）',state.settings.warningDays,{type:'number',required:true,attrs:'min="1" max="3650" inputmode="numeric"'})}</div><div class="form-actions"><button class="button soft" type="submit" ${busy?'disabled':''}>保存提醒规则</button></div></form></section></div>
  <div><section class="card"><span class="panel-eyebrow">TEAM SETUP</span><h2 style="margin-top:10px">让团队开始使用</h2><ol class="step-list"><li><b>团队数据仓库已就绪</b>使用私有仓库 <code>Wzz79229/bzq</code>，商品记录存放在 <code>data/shelf-life.json</code>。</li><li><b>添加团队成员</b>在 GitHub 仓库 Settings → Collaborators 添加成员，由成员接受邀请。</li><li><b>每人使用自己的令牌</b>仓库所有者可选细粒度令牌，授予本仓库 Contents 读写权限；外部协作者请按 GitHub 的令牌限制选择可用类型。</li><li><b>在手机上连接同一仓库</b>填写上面的仓库信息。每分钟自动检查团队更新；有未同步草稿时暂停自动载入。</li></ol><a class="text-button" href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens" target="_blank" rel="noopener noreferrer">查看 GitHub 令牌说明 ${icon('arrow')}</a></section>
  <section class="card settings-card"><h2>数据备份</h2><p class="card-description">可随时导出当前页面中的记录。JSON 保留完整批次与处理信息，Excel 便于日常查看。</p><div class="export-options"><button class="button small" data-action="export-xlsx">${icon('down')}Excel</button><button class="button small" data-action="export-csv">${icon('down')}CSV</button><button class="button small" data-action="export-json">${icon('down')}完整 JSON</button></div><div class="separator"></div><button class="text-button" data-action="install">${icon('down')} 添加到手机桌面</button><p class="form-note">App 可离线打开界面；业务记录以 GitHub 为准。当前页面未关闭时可以保留草稿，刷新前请先同步或备份。</p></section></div></div>`;
}
function render(preserveFocus=false) {
  let position,focus;
  if(preserveFocus){const el=document.activeElement;if(el?.id==='search'){position=el.selectionStart;focus='search';}}
  updateChrome(); $('#main').innerHTML = page==='overview'?overviewHTML():page==='team'?teamHTML():batchesHTML(page==='tasks');
  if(focus){const el=$('#search');el.focus({preventScroll:true});try{el.setSelectionRange(position,position);}catch{}}
}
function go(next) { page=next;filter='all';search='';category='';limit=60;render();window.scrollTo({top:0,behavior:'instant'}); }
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
function recordDialog(record=null) {
  const r=record||{name:'',barcode:'',category:'',location:'',batchCode:'',productionDate:'',shelfLife:'',shelfUnit:'day',expiryDate:'',quantity:1,unit:'件',note:''};
  const d=showDialog('#record-dialog',`<div class="dialog-heading"><div><h2>${record?'编辑商品批次':'新增商品批次'}</h2><p>同一商品的不同生产日期，请分别建立批次。</p></div><button class="icon-button" data-close="record-dialog" aria-label="关闭">${icon('close')}</button></div><div class="dialog-body"><form id="record-form" data-id="${e(record?.id||'')}"><div class="form-grid">${field('name','商品名称',r.name,{required:true,full:true,placeholder:'输入商品名称',attrs:'maxlength="200"'})}${field('barcode','商品条码',r.barcode,{attrs:'inputmode="numeric" maxlength="100"',placeholder:'可选，保留前导零'})}${field('batchCode','批次编号',r.batchCode,{placeholder:'可选，如 20261015-A',attrs:'maxlength="100"'})}${field('category','商品分类',r.category,{placeholder:'如乳品、饮料、零食',attrs:'maxlength="100"'})}${field('location','存放库位',r.location,{placeholder:'如冷柜 A-01',attrs:'maxlength="100"'})}${field('productionDate','生产日期',r.productionDate,{type:'date'})}<label class="field"><span>保质期</span><div class="inline-fields"><input name="shelfLife" type="number" min="1" step="1" value="${e(r.shelfLife)}" inputmode="numeric" placeholder="可选"><select name="shelfUnit" aria-label="保质期单位"><option value="day" ${r.shelfUnit==='day'?'selected':''}>天</option><option value="month" ${r.shelfUnit==='month'?'selected':''}>月</option><option value="year" ${r.shelfUnit==='year'?'selected':''}>年</option></select></div></label>${field('expiryDate','到期日期',r.expiryDate,{type:'date',required:true,help:'可根据生产日期与保质期计算，最终请核对商品包装。'})}${field('quantity','批次数量',r.quantity,{type:'number',required:true,attrs:'min="0" step="any" inputmode="decimal"'})}${field('unit','数量单位',r.unit,{required:true,placeholder:'件 / 盒 / 瓶',attrs:'maxlength="20"'})}<div class="field"><span>到期日期辅助计算</span><button type="button" class="button soft" id="calculate-expiry">${icon('calendar')}按保质期计算</button></div><label class="field full"><span>备注</span><textarea name="note" maxlength="2000" placeholder="可记录供应商、货架位置或其他补充信息">${e(r.note)}</textarea></label></div><div id="record-error" class="form-error" role="alert"></div><div class="form-actions">${record?`<button class="button danger" type="button" data-action="delete" data-id="${e(record.id)}">${icon('trash')}移除批次</button>`:''}<button class="button" type="button" data-close="record-dialog">取消</button><button class="button primary" type="submit" ${busy?'disabled':''}>${icon('check')}保存批次</button></div></form></div>`);
  $('#calculate-expiry',d).addEventListener('click',()=>{const form=$('#record-form');try{form.elements.expiryDate.value=calculateExpiry(form.elements.productionDate.value,form.elements.shelfLife.value,form.elements.shelfUnit.value);$('#record-error').textContent='';notify('已计算到期日期，请核对包装');}catch(err){$('#record-error').textContent=err.message;}});
  $('#record-form',d).addEventListener('submit',async ev=>{
    ev.preventDefault();if(busy)return;const form=ev.currentTarget;
    const input={...record,...Object.fromEntries(new FormData(form)),updatedAt:now()};
    const result=validateRecord(input);
    if(!result.valid){$('#record-error').textContent=result.errors.join('\n');return;}
    if(!record && records().some(item=>item.name===result.record.name&&item.barcode===result.record.barcode&&item.expiryDate===result.record.expiryDate&&item.batchCode===result.record.batchCode&&item.location===result.record.location)){
      if(!await confirmAction('发现相似批次','已存在名称、批次、库位和到期日期相同的记录。仍要新增一条独立记录吗？','仍然新增'))return;
    }
    const r=result.record;state.records=record?state.records.map(item=>item.id===record.id?r:item):[r,...state.records];closeDialog('#record-dialog');await changed('批次已保存');
  });
}
async function changed(success) { state.updatedAt=now();dirty=true;errorText='';render();if(demo){dirty=false;notify(`${success}（示例）`);render();return;}if(connected)await save(success);else notify('已保留本页草稿，连接仓库后才能同步'); }
async function save(success='已同步到 GitHub') {
  if(!store||!connected||busy||demo)return;
  busy=true;updateChrome();
  try{const snapshot=sanitizeState(state);const saved=await store.write(snapshot,sha);sha=saved.sha;dirty=false;errorText='';lastSync=new Date().toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'});notify(success);}
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
async function connect(form) {
  if(busy)return;
  const values=Object.fromEntries(new FormData(form));
  if((dirty||demo)&&!await confirmAction('载入团队数据','将载入仓库中的商品记录并替换当前页面。当前草稿或示例不会自动上传到团队。需要保留时请先导出备份。','载入团队数据'))return;
  busy=true;updateChrome();const button=$('button[type=submit]',form);button.disabled=true;button.textContent='正在连接…';
  try {
    const next=new GitHubStore(values);let snapshot=await next.read();
    if(snapshot.data===null){snapshot=await next.write(emptyState(),null);}
    const incoming=sanitizeState(snapshot.data);
    config={owner:values.owner.trim(),repo:values.repo.trim(),branch:values.branch,path:values.path,actor:values.actor.trim()};
    try{localStorage.setItem('fresh-period-connection',JSON.stringify(config));}catch{}
    form.elements.token.value='';store=next;sha=snapshot.sha;state=incoming;connected=true;dirty=false;demo=false;errorText='';lastSync=new Date().toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'});notify('团队仓库已连接');
  }catch(err){$('#connection-error').textContent=err.message;notify(err.message,true);return;}
  finally{busy=false;updateChrome();if(button.isConnected){button.disabled=false;button.innerHTML=`${icon('github')}连接并载入团队数据`;}}
  render();
}
function download(text,name,mime='text/plain;charset=utf-8') { const url=URL.createObjectURL(new Blob([text],{type:mime}));const link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),20000); }
function exportJSON() {download(JSON.stringify(state,null,2),`鲜期-完整备份-${todayISO()}.json`,'application/json;charset=utf-8');notify('已导出完整备份');}
function exportSpreadsheet(xlsx=false) {
  const list=page==='batches'||page==='tasks'?filteredRecords():state.records;
  if(xlsx&&window.XLSX){const data=window.XLSX.read(exportCSV(list),{type:'string',raw:true});window.XLSX.writeFile(data,`鲜期-商品批次-${todayISO()}.xlsx`);}else download(exportCSV(list),`鲜期-商品批次-${todayISO()}.csv`,'text/csv;charset=utf-8');
  notify(`已导出 ${list.length} 批次`);
}
function importDialog() {
  importResult=null;
  const d=showDialog('#import-dialog',`<div class="dialog-heading"><div><h2>批量导入商品</h2><p>先预览，再追加导入，不会替换已有批次。</p></div><button class="icon-button" data-close="import-dialog" aria-label="关闭">${icon('close')}</button></div><div class="dialog-body"><label class="drop-zone">${icon('up')}<strong>选择商品表格</strong><small>支持 .xlsx / .xls / .csv / 鲜期备份 .json<br>单次最多 5 MB，Excel 读取第一个工作表</small><input id="import-file" type="file" accept=".xlsx,.xls,.csv,.json" aria-label="选择商品表格"></label><p class="form-note">必需列：商品名称、到期日期、数量。也可填写生产日期和保质期，由系统计算到期日期。请将条码列设为文本，保留前导零。</p><a class="text-button" href="./import-template.csv" download>下载空白导入模板 ${icon('down')}</a><div id="import-preview" class="import-preview"></div><div id="import-error" class="form-error" role="alert"></div><div class="form-actions"><button class="button" data-close="import-dialog">取消</button><button class="button primary" id="confirm-import" disabled>追加导入</button></div></div>`);
  $('#import-file',d).addEventListener('change',async ev=>{
    const file=ev.target.files[0];if(!file)return;const version=++importVersion;const preview=$('#import-preview');const err=$('#import-error');const button=$('#confirm-import');button.disabled=true;err.textContent='';preview.textContent='正在读取表格…';importResult=null;
    try{
      if(file.size>5*1024*1024)throw new Error('文件超过 5 MB，请拆分为较小的表格后导入。');
      const ext=file.name.split('.').pop().toLowerCase();let result;
      if(ext==='json'){const backup=sanitizeState(JSON.parse(await file.text()));result={records:backup.records,errors:[]};for(const r of result.records){r.id=crypto.randomUUID();r.updatedAt=now();}}
      else if(ext==='csv'){const bytes=await file.arrayBuffer();let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{text=new TextDecoder('gb18030').decode(bytes);}result=importCSV(text,{existingRecords:state.records});}
      else if(['xlsx','xls'].includes(ext)){if(!window.XLSX)throw new Error('Excel 解析组件未加载，请刷新页面后重试。');const book=window.XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:true,dateNF:'yyyy-mm-dd'});if(!book.SheetNames.length)throw new Error('Excel 表格没有工作表。');const rows=window.XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,defval:'',raw:false,dateNF:'yyyy-mm-dd'});result=importRows(rows,{existingRecords:state.records});}
      else throw new Error('请选择 Excel、CSV 表格或鲜期 JSON 备份。');
      if(version!==importVersion || !d.open)return;
      if(result.records.length>2000)throw new Error('单次导入不能超过 2000 批次，请拆分表格。');
      if(result.errors.length){err.textContent=result.errors.slice(0,12).map(v=>`第 ${v.row} 行：${v.message||v.errors?.join('；')}`).join('\n')+(result.errors.length>12?`\n另有 ${result.errors.length-12} 处错误。`:'')+'\n请修正错误后重新选择文件，本次尚未导入任何数据。';}
      if(!result.records.length){preview.textContent='没有可导入的批次，请填写模板后重新选择。';return;}
      const identities=new Set();const key=r=>[r.barcode||r.name,r.batchCode,r.expiryDate,r.location].join('\u0000');for(const r of records())identities.add(key(r));
      let duplicates=0;const unique=[];for(const r of result.records){if(identities.has(key(r)))duplicates++;else unique.push(r);identities.add(key(r));}
      result.uniqueRecords=unique;
      importResult=result;
      preview.innerHTML=`<h3>预览 ${result.records.length} 个批次${duplicates?` · ${duplicates} 条可能重复`:''}</h3><div class="import-list">${result.records.slice(0,8).map(r=>`<div class="import-item"><span>${e(r.name)}<small> · ${e(r.quantity)} ${e(r.unit)}</small></span><small>${e(r.expiryDate)}</small></div>`).join('')}</div>${result.records.length>8?'<p class="form-note">仅显示前 8 条预览。</p>':''}${duplicates?'<label class="form-note duplicate-option"><input id="skip-duplicates" type="checkbox" checked> 跳过可能重复的批次（名称或条码、批次、库位、到期日均相同）</label>':''}`;
      const updateImportButton=()=>{const n=$('#skip-duplicates')?.checked?unique.length:result.records.length;button.disabled=!!result.errors.length||!n;button.textContent=`确认追加 ${n} 批次`;};
      $('#skip-duplicates')?.addEventListener('change',updateImportButton);updateImportButton();
    }catch(error){if(version!==importVersion || !d.open)return;preview.textContent='';err.textContent=error.message;}
  });
  $('#confirm-import',d).addEventListener('click',async()=>{if(!importResult||importResult.errors.length||busy)return;const incoming=$('#skip-duplicates')?.checked?importResult.uniqueRecords:importResult.records;const n=incoming.length;if(!n)return;state.records=[...incoming,...state.records];closeDialog('#import-dialog');importResult=null;await changed(`已导入 ${n} 个批次`);});
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
  store=null;connected=false;sha=null;demo=true;dirty=false;errorText='';state=demoState();go('overview');notify('正在体验示例数据');
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
  else if(action==='edit'&&r)recordDialog(r);
  else if(action==='filter'){go('batches');filter=b.dataset.filter;render();}
  else if(action==='set-filter'){filter=b.dataset.filter;limit=60;render();}
  else if(action==='tasks')go('tasks');
  else if(action==='team')go('team');
  else if(action==='import')importDialog();
  else if(action==='handle'&&r)handleRecord(r);
  else if(action==='restore'&&r){if(await confirmAction('恢复为在管批次',`将 ${r.name} 恢复为在管状态，并重新参与临期提醒。`,'恢复在管')){r.status='active';r.handledReason='';r.handledAt='';r.updatedAt=now();await changed('已恢复为在管批次');}}
  else if(action==='delete'&&r){if(await confirmAction('移除商品批次',`将 ${r.name} 从在管清单移除。可在“已移除”筛选中恢复，GitHub 历史也会保留。`,'移除批次',true)){r.deletedAt=now();r.updatedAt=now();closeDialog('#record-dialog');await changed('批次已移除，可恢复');}}
  else if(action==='restore-deleted'&&r){r.deletedAt='';r.updatedAt=now();await changed('已恢复批次记录');}
  else if(action==='sync')save();
  else if(action==='refresh')refresh();
  else if(action==='disconnect'){if(dirty&&!await confirmAction('断开团队连接','本页有未同步草稿。断开后仍可在当前页保留并导出，刷新后无法恢复。','断开连接'))return;store=null;connected=false;sha=null;errorText='';render();notify('已断开，访问令牌已从本页释放');}
  else if(action==='export-json')exportJSON();
  else if(action==='export-csv')exportSpreadsheet();
  else if(action==='export-xlsx')exportSpreadsheet(true);
  else if(action==='resolve-conflict'){exportJSON();closeDialog('#conflict-dialog');await refresh(false,true);}
  else if(action==='demo')demoStart();
  else if(action==='exit-demo'){demo=false;dirty=false;state=emptyState();errorText='';go('overview');}
  else if(action==='load-more'){limit+=60;render();}
  else if(action==='install')install();
});
document.addEventListener('input',ev=>{if(ev.target.id==='search'){search=ev.target.value;limit=60;render(true);}});
document.addEventListener('change',ev=>{if(ev.target.id==='category-filter'){category=ev.target.value;limit=60;render();}else if(ev.target.id==='sort-select'){sort=ev.target.value;render();}});
document.addEventListener('submit',async ev=>{
  if(ev.target.id==='connection-form'){ev.preventDefault();await connect(ev.target);}
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
