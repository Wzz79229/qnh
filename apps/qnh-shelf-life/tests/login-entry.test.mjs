import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as core from '../dist/core.mjs';
import { CloudStore } from '../dist/cloud.mjs';
import { ConflictError } from '../dist/github.mjs';
import { openQnhLoginViewer } from '../dist/qnh-login-viewer.mjs';
import { syncPhotoState } from '../dist/photo-sync.mjs';

// Run the actual app against a minimal document and the real CloudStore protocol.
// No browser profile, production service, credentials, or stored data are used.
const source = (await readFile(new URL('../dist/app.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*?;\r?\n/gm, '');
const entry = new vm.Script(`${source}\nglobalThis.testApp={autoConnect,loginExpired,render,isBusy:()=>busy,recordCount:()=>state.records.length,stageDraft:record=>{state.records.push(record);dirty=true;search='PRIVATE-SEARCH';category='PRIVATE-CATEGORY';pendingPhotos.set('synthetic-pending',{dataUrl:'data:image/jpeg;base64,synthetic'});},snapshot:()=>({tenant:workspaceTenant,lockedTenant:lockedDraft?.tenant??null,path:config.path,sha,dirty,search,category,photos:pendingPhotos.size,names:state.records.map(record=>record.name)})};`);
const data = { schemaVersion: 1, records: [], settings: { urgentDays: 7, warningDays: 30 }, updatedAt: '2026-10-17T00:00:00.000Z' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function element() {
  const classes = new Set();
  return { innerHTML: '', textContent: '', className: '', classList: {
    toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
    contains: name => classes.has(name), remove: name => classes.delete(name),
  } };
}
function harness({ session = { configured: true, authorized: false, loginMethod: 'qnh_pending' }, stateResponse, logoutResponse, search = '', url = 'https://app.example/', realViewer = false } = {}) {
  const selectors = new Map(['#main', '.desktop-nav', '.bottom-nav', '#page-label', '#sync-pill', '#user-avatar', '#toast'].map(key => [key, element()]));
  const body = element(), listeners = new Map(), windowListeners = new Map(), calls = [], redirects=[];
  const pageUrl=new URL(url);if(search)pageUrl.search=search;
  const viewerNodes=[];
  function makeViewerElement(tagName){
    const attributes=new Map(),events=new Map();
    const node={tagName,children:[],textContent:'',value:'',open:false,removed:false,disabled:false,
      setAttribute(name,value){attributes.set(name,String(value));if(name==='id')this.id=String(value);},
      getAttribute:name=>attributes.get(name)??null,
      removeAttribute(name){attributes.delete(name);},
      append(...nodes){this.children.push(...nodes);},
      addEventListener(name,callback){if(!events.has(name))events.set(name,new Set());events.get(name).add(callback);},
      removeEventListener(name,callback){events.get(name)?.delete(callback);},
      emit(name,event={}){for(const callback of events.get(name)||[])callback({preventDefault(){},...event});},
      showModal(){this.open=true;},
      click(){this.clicked=true;},
      close(){this.open=false;this.emit('close');},
      remove(){this.removed=true;},
    };viewerNodes.push(node);return node;
  }
  body.children=[];body.append=(...nodes)=>body.children.push(...nodes);
  const dialogs = new Map();
  const makeDialog = (id, html='', open=false) => {
    const handlers = new Map();
    const dialog = { id, innerHTML: html, open,
      close() { this.open=false; },
      showModal() { this.open=true; },
      addEventListener: (name, listener) => handlers.set(name, listener),
      removeEventListener(name,listener) { if(handlers.get(name)===listener)handlers.delete(name); },
      dispatchEvent(event) { handlers.get(event.type)?.(event); },
      cloneNode() { return makeDialog(id); },
      replaceWith(replacement) { dialogs.set(id,replacement); },
    };
    return dialog;
  };
  for(const id of ['record-dialog','confirm-dialog','import-dialog','conflict-dialog'])dialogs.set(id,makeDialog(id));
  let activeSession = session, skuFlows = 0, photoFlows = 0, lastSkuFlow, viewerOpens = 0, viewerCloses = 0, viewerCallbacks;
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url, 'https://app.example/').pathname;
    calls.push({ path, method: init.method || 'GET', body: init.body });
    if(path === '/connection.json')return json({ apiBase: 'https://api.example' });
    if(path === '/api/session')return json(activeSession);
    if(path === '/api/login'){activeSession = { configured: true, authorized: true, loginMethod: 'legacy' };return json({ authorized: true });}
    if(path === '/api/logout'){
      const result=logoutResponse?await logoutResponse():json({ authorized: false });
      if(result.ok)activeSession={...activeSession,authorized:false};
      return result;
    }
    if(path === '/api/state')return stateResponse ? await stateResponse({session:activeSession,init}) : init.method==='PUT'?json({sha:'saved-sha'}):json({ data, sha: 'test-sha' });
    if(path === '/api/qnh/login/start')return json({authorized:false,loginMethod:'qnh_browser',status:'login',viewport:{width:1280,height:900},expiresAt:Date.now()+180000});
    if(path === '/api/qnh/login/frame')return new Response(new Uint8Array([255,216,255,217]),{headers:{'Content-Type':'image/jpeg'}});
    if(path === '/api/qnh/login/cancel')return json({});
    throw new Error(`Unexpected request ${path}`);
  };
  const document = {
    body, activeElement: null, hidden: false,
    querySelector: selector => selectors.get(selector) || dialogs.get(selector.slice(1)) || null,
    querySelectorAll: selector => selector==='dialog'?[...dialogs.values()]:selector==='dialog[open]'?[...dialogs.values()].filter(dialog=>dialog.open):[],
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener(name,handler){if(listeners.get(name)===handler)listeners.delete(name);},
    createElement:makeViewerElement,
  };
  const context = vm.createContext({ ...core, ConflictError,
    CloudStore: class extends CloudStore { constructor(base) { super(base, fetchImpl); } },
    document, navigator: {}, location: { search:pageUrl.search, href:pageUrl.href, hostname:pageUrl.hostname, origin:pageUrl.origin, pathname:pageUrl.pathname, replace:target=>redirects.push(target) },
    window: { addEventListener: (name, listener) => windowListeners.set(name, listener), scrollTo() {} }, fetch: fetchImpl,
    URL, URLSearchParams, Intl, FormData, Event, Map, console, syncPhotoState,
    setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
    openSkuFlow(options) { skuFlows++;lastSkuFlow=options; },
    openPhotoFlow() { photoFlows++; },
    openQnhLoginViewer(callbacks) {
      viewerOpens++;viewerCallbacks=callbacks;
      if(realViewer)return openQnhLoginViewer(callbacks,{document,fetch:fetchImpl,timers:{setTimeout:()=>0,clearTimeout(){}},URL:{createObjectURL:()=> 'blob:synthetic-frame',revokeObjectURL(){}},AbortController});
      let closed=false;
      return { close() { if(!closed){closed=true;viewerCloses++;} } };
    },
  });
  entry.runInContext(context);
  return {
    body, calls, selectors, dialogs, redirects, main: () => selectors.get('#main').innerHTML,
    recordCount: () => context.testApp.recordCount(),
    snapshot: () => context.testApp.snapshot(),
    setHidden(value) { document.hidden=value; },
    stageDraft: record => context.testApp.stageDraft(record),
    expire() { context.testApp.loginExpired({code:'AUTH_REQUIRED'});context.testApp.render(); },
    acceptOldProduct: product => lastSkuFlow?.onProduct(product),
    photoFlows: () => photoFlows,
    confirm: () => dialogs.get('confirm-dialog').dispatchEvent({type:'click',target:{closest:()=>({dataset:{confirm:'ok'}})}}),
    async settle() {
      for(let turn = 0; turn < 20 && context.testApp.isBusy(); turn++)await new Promise(resolve => setImmediate(resolve));
      assert.equal(context.testApp.isBusy(), false, 'startup should settle');
    },
    login: password => context.testApp.autoConnect(password),
    click: action => listeners.get('click')({ target: { closest: () => ({ dataset: { action } }) } }),
    setSession(value) { activeSession=value; },
    viewerOpens: () => viewerOpens,
    viewerCloses: () => viewerCloses,
    viewerNodes,
    authorizeViewer: () => viewerCallbacks?.onAuthorized(),
    closeViewer: () => viewerCallbacks?.onClose(),
    emitWindow: name => windowListeners.get(name)?.({ type: name }),
    emitDocument: name => listeners.get(name)?.({ type: name }),
    skuFlows: () => skuFlows,
  };
}

test('QNH pending keeps entry locked without opening an external login page', async () => {
  const app = harness();await app.settle();
  assert.equal(app.body.classList.contains('login-required'), true);
  assert.match(app.main(), /牵牛花登录连接尚未接通/);
  assert.match(app.main(), /disabled>登录牵牛花/);
  assert.doesNotMatch(app.main(), /GitHub|GITHUB_|bzq|data-page|team-login-form|<a\b|target="_blank"|data-action="qnh-login"/);
  assert.equal(app.selectors.get('.bottom-nav').innerHTML, '');
  assert.equal(app.calls.some(call => call.path === '/api/state'), false);
  await app.click('add');
  await app.click('qnh-login');
  assert.equal(app.skuFlows(), 0);
  assert.equal(app.viewerOpens(), 0);
  assert.equal(app.calls.length, 2);
});

test('the inline login button waits for an explicit available server integration', async () => {
  const app = harness({session:{configured:true,authorized:false,loginMethod:'qnh_browser',loginAvailable:true}});
  assert.match(app.main(), /disabled>正在检查登录/);
  assert.doesNotMatch(app.main(), /<a\b|data-action="qnh-login"/);
  await app.settle();
  assert.match(app.main(), /data-action="qnh-login">登录牵牛花/);
  assert.match(app.main(), /在鲜期中完成登录/);
  assert.doesNotMatch(app.main(), /<a\b|target="_blank"|新窗口/);
  await app.click('qnh-login');
  assert.equal(app.viewerOpens(),1);
  assert.equal(app.viewerCloses(),0,'opening must not immediately destroy the modal');
  assert.equal(app.calls.some(call=>call.path==='/api/state'),false);
});

test('the actual viewer module stays open through delegated app click, online and visibility events', async () => {
  const app=harness({realViewer:true,session:{configured:true,authorized:false,loginMethod:'qnh_browser',loginAvailable:true}});await app.settle();
  await app.click('qnh-login');
  for(let turn=0;turn<15;turn++)await new Promise(resolve=>setImmediate(resolve));
  const dialog=app.viewerNodes.find(node=>node.id==='qnh-login-viewer');
  assert.ok(dialog,'delegated click must append the real modal');
  assert.equal(dialog.open,true);assert.equal(dialog.removed,false);
  assert.equal(app.calls.filter(call=>call.path==='/api/qnh/login/start').length,1);
  assert.equal(app.calls.filter(call=>call.path==='/api/qnh/login/frame').length,1);
  app.emitWindow('online');app.emitDocument('visibilitychange');
  assert.equal(dialog.open,true);assert.equal(dialog.removed,false);
  assert.equal(app.calls.some(call=>call.path==='/api/qnh/login/cancel'),false);
  await app.click('auto-connect');await app.settle();
  assert.equal(dialog.removed,true);
  assert.equal(app.calls.filter(call=>call.path==='/api/qnh/login/cancel').length,1);
});

test('opening or closing the inline login and returning to the app cannot grant access', async () => {
  const app = harness({session:{configured:true,authorized:false,loginMethod:'qnh_browser',loginAvailable:true}});await app.settle();
  await app.click('qnh-login');
  await app.click('qnh-login');
  assert.equal(app.viewerOpens(),1,'duplicate taps share one viewer');
  app.closeViewer();
  app.emitWindow('focus');app.emitDocument('visibilitychange');
  await app.settle();
  assert.equal(app.calls.length, 2);
  assert.equal(app.body.classList.contains('login-required'), true);
  assert.equal(app.calls.some(call => call.path === '/api/state'), false);
  await app.click('auto-connect');await app.settle();
  assert.equal(app.calls.filter(call => call.path === '/api/session').length, 2);
  assert.equal(app.calls.some(call => call.path === '/api/login' || call.path === '/api/state'), false);
  assert.equal(app.body.classList.contains('login-required'), true);
  assert.match(app.main(), /data-action="qnh-login"/);
});

test('a pending integration cannot authorize access or replace login with an external destination', async () => {
  const app = harness({ session: { configured: true, authorized: true, loginMethod: 'qnh_pending', loginUrl: 'https://untrusted.example/?token=synthetic-secret', message: 'fake login complete' } });
  await app.settle();
  assert.match(app.main(), /disabled>登录牵牛花/);
  assert.doesNotMatch(app.main(), /<a\b|untrusted|token=|synthetic-secret|fake login complete|data-action="qnh-login"/);
  assert.equal(app.calls.some(call => call.path === '/api/state'), false);
  assert.equal(app.body.classList.contains('login-required'), true);
});

test('inline login requires literal boolean availability and a supported method', async () => {
  for(const session of [
    {loginMethod:'qnh_browser',loginAvailable:'true'},
    {loginMethod:'qnh_browser',loginAvailable:1},
    {loginMethod:'qnh_browser',loginAvailable:false},
    {loginMethod:'qnh_pending',loginAvailable:true},
    {loginMethod:'unexpected',loginAvailable:true},
  ]){
    const app=harness({session:{configured:true,authorized:false,...session}});await app.settle();
    await app.click('qnh-login');
    assert.equal(app.viewerOpens(),0);
    assert.doesNotMatch(app.main(),/data-action="qnh-login"/);
  }
});

test('a viewer success callback still requires server authorization before reading state', async () => {
  const app=harness({session:{configured:true,authorized:false,loginMethod:'qnh_browser',loginAvailable:true}});await app.settle();
  await app.click('qnh-login');
  await app.authorizeViewer();await app.settle();
  assert.equal(app.calls.filter(call=>call.path==='/api/session').length,2);
  assert.equal(app.calls.some(call=>call.path==='/api/state'),false);
  assert.equal(app.body.classList.contains('login-required'),true);
  assert.doesNotMatch(app.main(),/保质期总览/);
});

test('verified inline login automatically enters only after successful server data read', async () => {
  let finishRead;
  const read=new Promise(resolve=>{finishRead=resolve;});
  const app=harness({session:{configured:true,authorized:false,loginMethod:'qnh_browser',loginAvailable:true},stateResponse:()=>read});await app.settle();
  await app.click('qnh-login');
  app.setSession({configured:true,authorized:true,loginMethod:'qnh_browser',loginAvailable:true,tenantId:'7654321'});
  const completing=app.authorizeViewer();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.body.classList.contains('login-required'),true);
  assert.doesNotMatch(app.main(),/保质期总览/);
  finishRead(json({data,sha:'authorized-sha'}));await completing;await app.settle();
  assert.equal(app.body.classList.contains('login-required'),false);
  assert.match(app.main(),/保质期总览/);
});

test('rechecking closes the old viewer and ignores its delayed success callback', async () => {
  const app=harness({session:{configured:true,authorized:false,loginMethod:'qnh_browser',loginAvailable:true}});await app.settle();
  await app.click('qnh-login');
  await app.click('auto-connect');await app.settle();
  assert.equal(app.viewerCloses(),1);
  await app.authorizeViewer();await app.settle();
  assert.equal(app.calls.filter(call=>call.path==='/api/session').length,2);
  assert.equal(app.calls.some(call=>call.path==='/api/state'),false);
  assert.equal(app.body.classList.contains('login-required'),true);
});

test('the old Pages entry changes to the fixed same-app origin before starting phone login', async () => {
  const app=harness({url:'https://wzz79229.github.io/qnh/shelf-life/',session:{configured:true,authorized:true,loginMethod:'qnh_browser',loginAvailable:true,loginUrl:'https://untrusted.example/'}});await app.settle();
  assert.deepEqual(app.redirects,['https://qnh-shelf-life-api.w792294944.workers.dev/']);
  assert.equal(app.calls.some(call=>call.path==='/api/state'),false);
  assert.equal(app.body.classList.contains('login-required'),true);
  assert.doesNotMatch(app.main(),/data-action="qnh-login"|untrusted|<a\b/);
  await app.click('qnh-login');
  assert.equal(app.viewerOpens(),0);
});

test('the primary app, local preview, unrelated paths and explicit demo do not redirect', async () => {
  for(const url of [
    'https://qnh-shelf-life-api.w792294944.workers.dev/',
    'http://127.0.0.1:4176/',
    'https://wzz79229.github.io/another-app/',
    'https://untrusted.example/qnh/shelf-life/',
  ]){
    const app=harness({url,session:{configured:true,authorized:false,loginMethod:'qnh_browser',loginAvailable:true}});await app.settle();
    assert.deepEqual(app.redirects,[]);
  }
  const demo=harness({url:'https://wzz79229.github.io/qnh/shelf-life/?demo=1',session:{configured:true,authorized:false,loginMethod:'qnh_browser',loginAvailable:true}});await demo.settle();
  assert.deepEqual(demo.redirects,[]);
  assert.equal(demo.calls.length,0);
});

test('only boolean authorized true can begin reading business data', async () => {
  for(const authorized of [false, null, undefined, 'true', 1]) {
    const app = harness({ session: { configured: true, authorized } });await app.settle();
    assert.equal(app.body.classList.contains('login-required'), true);
    assert.equal(app.calls.some(call => call.path === '/api/state'), false);
    assert.doesNotMatch(app.main(), /team-login-form|保质期总览/);
  }
});

test('authorized session stays on entry until the data request actually succeeds', async () => {
  let finishRead;
  const read = new Promise(resolve => { finishRead = resolve; });
  const app = harness({ session: { configured: true, authorized: true }, stateResponse: () => read });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.body.classList.contains('login-required'), true);
  assert.doesNotMatch(app.main(), /保质期总览/);
  assert.equal(app.selectors.get('.desktop-nav').innerHTML, '');
  finishRead(json({ data, sha: 'test-sha' }));await app.settle();
  assert.equal(app.body.classList.contains('login-required'), false);
  assert.match(app.main(), /保质期总览/);
  assert.match(app.selectors.get('.bottom-nav').innerHTML, /data-page="scan"/);
});

test('data failure keeps entry closed and hides provider configuration details', async () => {
  const app = harness({ session: { configured: true, authorized: true }, stateResponse: () => json({ code: 'GITHUB_APP_AUTH_FAILED', message: 'GITHUB_APP_PRIVATE_KEY GitHub bzq configuration detail' }, 503) });
  await app.settle();
  assert.equal(app.body.classList.contains('login-required'), true);
  assert.match(app.main(), /暂时无法进入保质期管理/);
  assert.doesNotMatch(app.main(), /GITHUB_|GitHub|bzq|保质期总览/);
});

test('legacy password compatibility appears only when the backend explicitly selects it', async () => {
  const app = harness({ session: { configured: true, authorized: false, loginMethod: 'legacy' } });await app.settle();
  assert.match(app.main(), /team-login-form/);
  await app.login('synthetic-test-password');
  assert.equal(app.body.classList.contains('login-required'), false);
  assert.match(app.main(), /保质期总览/);
  assert.equal(app.calls.filter(call => call.path === '/api/login').length, 1);
  const qnh = harness();await qnh.settle();await qnh.login('synthetic-test-password');
  assert.equal(qnh.calls.some(call => call.path === '/api/login'), false);
});

test('explicit demo mode uses sample data without a session or real data request', async () => {
  const app = harness({ search: '?demo=1' });await app.settle();
  assert.equal(app.body.classList.contains('login-required'), false);
  assert.match(app.main(), /当前为示例体验/);
  assert.match(app.main(), /纯牛奶/);
  assert.equal(app.calls.length, 0);
});

test('logout returns to the entry and removes business navigation', async () => {
  const app = harness({ session: { configured: true, authorized: true, loginMethod: 'legacy' } });await app.settle();
  await app.click('disconnect');
  assert.equal(app.body.classList.contains('login-required'), true);
  assert.equal(app.selectors.get('.bottom-nav').innerHTML, '');
  assert.doesNotMatch(app.main(), /保质期总览/);
  assert.match(app.main(), /team-login-form/);
});

test('a rejected session during refresh closes the business UI again', async () => {
  let reads=0;
  const app = harness({ session: { configured: true, authorized: true, loginMethod: 'legacy' },
    stateResponse: () => ++reads===1?json({ data, sha: 'test-sha' }):json({ code: 'AUTH_REQUIRED', message: 'session expired' }, 401),
  });
  await app.settle();assert.equal(app.body.classList.contains('login-required'), false);
  await app.click('refresh');await app.settle();
  assert.equal(app.body.classList.contains('login-required'), true);
  assert.doesNotMatch(app.main(), /保质期总览/);
  assert.match(app.main(), /team-login-form/);
  assert.equal(app.selectors.get('.bottom-nav').innerHTML, '');
});

test('logout locks immediately and erases loaded records while the server request is still pending', async () => {
  let finishLogout;
  const pending = new Promise(resolve => { finishLogout=resolve; });
  const privateData={...data,records:[core.validateRecord({name:'PRIVATE-SYNTHETIC-BATCH',expiryDate:'2026-12-01',quantity:4,unit:'件'}).record]};
  const app=harness({session:{configured:true,authorized:true,loginMethod:'legacy'},stateResponse:()=>json({data:privateData,sha:'private-sha'}),logoutResponse:()=>pending});
  await app.settle();assert.equal(app.recordCount(),1);
  const leaving=app.click('disconnect');
  assert.equal(app.body.classList.contains('login-required'),true);
  assert.equal(app.recordCount(),0);
  assert.match(app.main(),/正在退出登录/);
  assert.doesNotMatch(app.main(),/PRIVATE-SYNTHETIC-BATCH|team-login-form|保质期总览/);
  await app.click('add');await app.click('auto-connect');
  assert.equal(app.skuFlows(),0);
  assert.equal(app.calls.filter(call=>call.path==='/api/session').length,1);
  finishLogout(json({authorized:false}));await leaving;
  assert.equal(app.body.classList.contains('login-required'),true);
  assert.match(app.main(),/team-login-form/);
});

test('failed logout cannot reenter using the old cookie and must complete logout before another session check', async () => {
  let fail=true;
  const app=harness({session:{configured:true,authorized:true,loginMethod:'legacy'},logoutResponse:()=>{if(fail)throw new Error('synthetic network failure');return json({authorized:false});}});
  await app.settle();await app.click('disconnect');
  assert.equal(app.body.classList.contains('login-required'),true);
  assert.equal(app.recordCount(),0);
  assert.doesNotMatch(app.main(),/team-login-form|保质期总览/);
  assert.match(app.main(),/账号退出尚未完成/);
  await app.click('auto-connect');await app.settle();
  assert.equal(app.calls.filter(call=>call.path==='/api/logout').length,2);
  assert.equal(app.calls.filter(call=>call.path==='/api/session').length,1);
  assert.equal(app.calls.filter(call=>call.path==='/api/state').length,1);
  assert.equal(app.body.classList.contains('login-required'),true);
  fail=false;await app.click('auto-connect');await app.settle();
  assert.equal(app.calls.filter(call=>call.path==='/api/logout').length,3);
  assert.equal(app.calls.filter(call=>call.path==='/api/session').length,2);
  assert.equal(app.calls.filter(call=>call.path==='/api/state').length,1);
  assert.equal(app.body.classList.contains('login-required'),true);
  assert.match(app.main(),/team-login-form/);
});

test('the login gate clears open and already closed business dialogs and runs their close cleanup', async () => {
  const app=harness({session:{configured:true,authorized:true,loginMethod:'legacy'}});await app.settle();
  let cleanup=0;
  for(const [index,dialog] of [...app.dialogs.values()].entries()){
    dialog.innerHTML='PRIVATE-CLOSED-DIALOG-PRODUCT-DATA';dialog.open=index===0;
    dialog.addEventListener('close',()=>{cleanup++;});
  }
  await app.click('disconnect');
  assert.equal(cleanup,4);
  for(const dialog of app.dialogs.values()){
    assert.equal(dialog.innerHTML,'');assert.equal(dialog.open,false);
  }
  assert.equal(app.body.classList.contains('login-required'),true);
});

test('an authorized first tenant read opens an empty workspace without creating a file', async () => {
  const app=harness({session:{configured:true,authorized:true,loginMethod:'qnh_browser',loginAvailable:true,tenantId:'7654321'},
    stateResponse:()=>json({data:null,sha:null})});
  await app.settle();
  assert.equal(app.body.classList.contains('login-required'),false);
  assert.equal(app.recordCount(),0);
  assert.match(app.main(),/保质期总览/);
  assert.equal(app.calls.some(call=>call.method==='PUT'),false);
});

const tenantSession=tenantId=>({configured:true,authorized:true,loginMethod:'qnh_browser',loginAvailable:true,tenantId});
const tenantRecord=name=>core.validateRecord({name,productionDate:'2026-10-01',expiryDate:'2026-12-01',quantity:3,unit:'件'}).record;

test('an expired A draft is erased before B read and is never merged or written into B', async () => {
  let finishB;
  const waitB=new Promise(resolve=>{finishB=resolve;});
  const app=harness({session:tenantSession('111'),stateResponse:({session})=>session.tenantId==='111'?json({data,sha:'a-sha'}):waitB});await app.settle();
  app.stageDraft(tenantRecord('PRIVATE-TENANT-A-DRAFT'));await app.click('add');
  app.expire();
  assert.equal(app.recordCount(),0);assert.equal(app.snapshot().sha,null);
  assert.equal(app.snapshot().photos,0);assert.equal(app.snapshot().search,'');
  assert.equal(app.snapshot().lockedTenant,'111');
  assert.equal(app.snapshot().path,'');
  assert.doesNotMatch(app.main(),/PRIVATE-TENANT-A/);
  app.setSession(tenantSession('222'));
  const switching=app.login();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.recordCount(),0);assert.equal(app.snapshot().lockedTenant,null);
  assert.equal(app.body.classList.contains('login-required'),true);
  app.acceptOldProduct({sku:'old-a-product',name:'PRIVATE-TENANT-A-PRODUCT'});
  assert.equal(app.photoFlows(),0,'an old SKU callback must not open a product editor in B');
  const bData={...data,records:[tenantRecord('TENANT-B-RECORD')]};
  finishB(json({data:bData,sha:'b-sha'}));await switching;await app.settle();
  assert.equal(app.snapshot().tenant,'222');assert.equal(app.snapshot().dirty,false);
  assert.equal(app.snapshot().path,'data/tenants/222/shelf-life.json');
  assert.deepEqual(Array.from(app.snapshot().names),['TENANT-B-RECORD']);
  assert.doesNotMatch(app.main(),/PRIVATE-TENANT-A/);
  assert.equal(app.calls.some(call=>call.method==='PUT'),false);
  await app.click('team');
  assert.match(app.main(),/data\/tenants\/222\/shelf-life\.json/);
  assert.doesNotMatch(app.main(),/data\/tenants\/111\//);
});

test('the same verified tenant can recover and save its own unsynced draft', async () => {
  const app=harness({session:tenantSession('111')});await app.settle();
  app.stageDraft(tenantRecord('TENANT-A-OWN-DRAFT'));app.expire();
  assert.equal(app.recordCount(),0);
  await app.login();await app.settle();
  assert.equal(app.snapshot().tenant,'111');
  assert.equal(app.recordCount(),1);assert.equal(app.snapshot().lockedTenant,null);
  const writes=app.calls.filter(call=>call.method==='PUT');
  assert.equal(writes.length,1);
  assert.equal(JSON.parse(writes[0].body).data.records[0].name,'TENANT-A-OWN-DRAFT');
});

test('a changed tenant cannot recover A even when B state fails to load', async () => {
  const app=harness({session:tenantSession('111'),stateResponse:({session})=>session.tenantId==='111'?json({data,sha:'a-sha'}):json({message:'synthetic read failure'},503)});await app.settle();
  app.stageDraft(tenantRecord('PRIVATE-A-DRAFT'));app.expire();app.setSession(tenantSession('222'));
  await app.login();await app.settle();
  assert.equal(app.body.classList.contains('login-required'),true);
  assert.equal(app.recordCount(),0);assert.equal(app.snapshot().lockedTenant,null);
  assert.equal(app.snapshot().sha,null);assert.equal(app.snapshot().photos,0);
  assert.equal(app.calls.some(call=>call.method==='PUT'),false);
  assert.doesNotMatch(app.main(),/PRIVATE-A/);
});

test('authorized QNH sessions with absent, numeric, zero-prefixed or malformed tenant fail closed', async () => {
  for(const tenantId of [undefined,null,111,'','0','0111','-1','111/222','1'.repeat(21)]){
    const app=harness({session:tenantSession(tenantId)});await app.settle();
    assert.equal(app.body.classList.contains('login-required'),true);
    assert.equal(app.recordCount(),0);assert.equal(app.snapshot().tenant,null);
    assert.equal(app.calls.some(call=>call.path==='/api/state'),false);
  }
});

test('logout permanently erases a tenant draft instead of recovering it on the next login', async () => {
  const app=harness({session:tenantSession('111')});await app.settle();
  app.stageDraft(tenantRecord('DISCARDED-ON-LOGOUT'));
  const leaving=app.click('disconnect');app.confirm();await leaving;
  assert.equal(app.snapshot().lockedTenant,null);assert.equal(app.snapshot().tenant,null);
  assert.equal(app.snapshot().path,'');
  app.setSession(tenantSession('111'));await app.login();await app.settle();
  assert.equal(app.recordCount(),0);
  assert.equal(app.calls.some(call=>call.method==='PUT'),false);
});

test('a cross-tab TENANT_CHANGED response immediately locks and erases the prior visible tenant', async () => {
  let reads=0;
  const app=harness({session:tenantSession('111'),stateResponse:()=>++reads===1?json({data:{...data,records:[tenantRecord('PRIVATE-PRIOR-TENANT')]},sha:'a-sha'}):json({code:'TENANT_CHANGED',message:'tenant changed'},401)});await app.settle();
  await app.click('refresh');await app.settle();
  assert.equal(app.body.classList.contains('login-required'),true);
  assert.equal(app.recordCount(),0);assert.equal(app.snapshot().tenant,null);assert.equal(app.snapshot().path,'');
  assert.doesNotMatch(app.main(),/PRIVATE-PRIOR-TENANT/);
});

test('a backup file body that arrives after switching tenants cannot open confirmation or restore into B', async () => {
  let finishText;
  const text=new Promise(resolve=>{finishText=resolve;});
  const app=harness({session:tenantSession('111')});await app.settle();
  await app.click('restore-backup');
  const input=app.viewerNodes.filter(node=>node.tagName==='input').at(-1);
  input.files=[{size:100,text:()=>text}];const restoring=input.onchange();
  app.expire();app.setSession(tenantSession('222'));await app.login();await app.settle();
  finishText(JSON.stringify({...data,records:[tenantRecord('PRIVATE-A-BACKUP')]}));await restoring;
  assert.equal(app.recordCount(),0);assert.equal(app.snapshot().tenant,'222');assert.equal(app.snapshot().dirty,false);
  assert.equal(app.dialogs.get('confirm-dialog').open,false);
  assert.equal(app.calls.some(call=>call.method==='PUT'),false);
});

test('a backup confirmation left over from A cannot restore after B is verified', async () => {
  const app=harness({session:tenantSession('111')});await app.settle();
  await app.click('restore-backup');
  const input=app.viewerNodes.filter(node=>node.tagName==='input').at(-1);
  input.files=[{size:100,text:async()=>JSON.stringify({...data,records:[tenantRecord('PRIVATE-A-CONFIRMED-BACKUP')]})}];
  const restoring=input.onchange();await new Promise(resolve=>setImmediate(resolve));
  const oldConfirmation=app.dialogs.get('confirm-dialog');assert.equal(oldConfirmation.open,true);
  app.expire();app.setSession(tenantSession('222'));await app.login();await app.settle();
  oldConfirmation.dispatchEvent({type:'click',target:{closest:()=>({dataset:{confirm:'ok'}})}});await restoring;
  assert.equal(app.recordCount(),0);assert.equal(app.snapshot().tenant,'222');assert.equal(app.snapshot().dirty,false);
  assert.equal(app.calls.some(call=>call.method==='PUT'),false);
});

test('returning to a dirty workspace closes its dialog and rechecks tenant before displaying B', async () => {
  let finishB;
  const bRead=new Promise(resolve=>{finishB=resolve;});
  const app=harness({session:tenantSession('111'),stateResponse:({session})=>session.tenantId==='111'?json({data,sha:'a-sha'}):bRead});await app.settle();
  app.stageDraft(tenantRecord('PRIVATE-A-VISIBILITY-DRAFT'));
  const oldDialog=app.dialogs.get('record-dialog');oldDialog.innerHTML='PRIVATE-A-DETAIL';oldDialog.open=true;
  app.setHidden(true);app.emitDocument('visibilitychange');
  app.setSession(tenantSession('222'));app.setHidden(false);
  const rechecking=app.emitDocument('visibilitychange');
  assert.equal(app.body.classList.contains('login-required'),true);
  assert.equal(app.recordCount(),0);assert.equal(oldDialog.open,false);
  assert.equal(app.selectors.get('#toast').textContent,'');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.snapshot().lockedTenant,null);
  finishB(json({data:{...data,records:[tenantRecord('B-VISIBILITY-RECORD')]},sha:'b-sha'}));await rechecking;await app.settle();
  assert.deepEqual(Array.from(app.snapshot().names),['B-VISIBILITY-RECORD']);
  assert.equal(app.calls.some(call=>call.method==='PUT'),false);
});

test('visibility locks immediately during an old refresh and ignores its late A response', async () => {
  let finishOldRead,reads=0;
  const oldRead=new Promise(resolve=>{finishOldRead=resolve;});
  const app=harness({session:tenantSession('111'),stateResponse:({session})=>{
    reads++;
    if(reads===1)return json({data:{...data,records:[tenantRecord('PRIVATE-A-INITIAL')]},sha:'a-sha'});
    if(reads===2)return oldRead;
    return json({data:{...data,records:[tenantRecord('B-AFTER-REFRESH')]},sha:'b-sha'});
  }});await app.settle();
  await app.click('refresh');
  app.setSession(tenantSession('222'));app.emitDocument('visibilitychange');
  assert.equal(app.recordCount(),0);assert.equal(app.body.classList.contains('login-required'),true);
  finishOldRead(json({data:{...data,records:[tenantRecord('PRIVATE-LATE-A')]},sha:'late-a-sha'}));await app.settle();
  assert.deepEqual(Array.from(app.snapshot().names),['B-AFTER-REFRESH']);
  assert.equal(app.snapshot().tenant,'222');
  assert.equal(app.calls.some(call=>call.method==='PUT'),false);
});
