import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as core from '../dist/core.mjs';
import { CloudStore } from '../dist/cloud.mjs';
import { ConflictError } from '../dist/github.mjs';

// Run the actual app against a minimal document and the real CloudStore protocol.
// No browser profile, production service, credentials, or stored data are used.
const source = (await readFile(new URL('../dist/app.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*?;\r?\n/gm, '');
const entry = new vm.Script(`${source}\nglobalThis.testApp={autoConnect,isBusy:()=>busy,recordCount:()=>state.records.length};`);
const data = { schemaVersion: 1, records: [], settings: { urgentDays: 7, warningDays: 30 }, updatedAt: '2026-10-17T00:00:00.000Z' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function element() {
  const classes = new Set();
  return { innerHTML: '', textContent: '', className: '', classList: {
    toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
    contains: name => classes.has(name), remove: name => classes.delete(name),
  } };
}
function harness({ session = { configured: true, authorized: false, loginMethod: 'qnh_pending' }, stateResponse, logoutResponse, search = '' } = {}) {
  const selectors = new Map(['#main', '.desktop-nav', '.bottom-nav', '#page-label', '#sync-pill', '#user-avatar', '#toast'].map(key => [key, element()]));
  const body = element(), listeners = new Map(), calls = [];
  const dialogs = new Map();
  const makeDialog = (id, html='', open=false) => {
    const handlers = new Map();
    const dialog = { id, innerHTML: html, open,
      close() { this.open=false; },
      addEventListener: (name, listener) => handlers.set(name, listener),
      dispatchEvent(event) { handlers.get(event.type)?.(event); },
      cloneNode() { return makeDialog(id); },
      replaceWith(replacement) { dialogs.set(id,replacement); },
    };
    return dialog;
  };
  for(const id of ['record-dialog','confirm-dialog','import-dialog','conflict-dialog'])dialogs.set(id,makeDialog(id));
  let activeSession = session, skuFlows = 0;
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
    if(path === '/api/state')return stateResponse ? await stateResponse() : json({ data, sha: 'test-sha' });
    throw new Error(`Unexpected request ${path}`);
  };
  const document = {
    body, activeElement: null, hidden: false,
    querySelector: selector => selectors.get(selector) || dialogs.get(selector.slice(1)) || null,
    querySelectorAll: selector => selector==='dialog'?[...dialogs.values()]:selector==='dialog[open]'?[...dialogs.values()].filter(dialog=>dialog.open):[],
    addEventListener: (name, handler) => listeners.set(name, handler),
  };
  const context = vm.createContext({ ...core, ConflictError,
    CloudStore: class extends CloudStore { constructor(base) { super(base, fetchImpl); } },
    document, navigator: {}, location: { search, href: `https://app.example/${search}`, hostname: 'app.example' },
    window: { addEventListener() {}, scrollTo() {} }, fetch: fetchImpl,
    URL, URLSearchParams, Intl, FormData, Event, console,
    setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
    openSkuFlow() { skuFlows++; },
  });
  entry.runInContext(context);
  return {
    body, calls, selectors, dialogs, main: () => selectors.get('#main').innerHTML,
    recordCount: () => context.testApp.recordCount(),
    async settle() {
      for(let turn = 0; turn < 20 && context.testApp.isBusy(); turn++)await new Promise(resolve => setImmediate(resolve));
      assert.equal(context.testApp.isBusy(), false, 'startup should settle');
    },
    login: password => context.testApp.autoConnect(password),
    click: action => listeners.get('click')({ target: { closest: () => ({ dataset: { action } }) } }),
    skuFlows: () => skuFlows,
  };
}

test('QNH pending shows one disabled login entry without business UI or an outside login loop', async () => {
  const app = harness();await app.settle();
  assert.equal(app.body.classList.contains('login-required'), true);
  assert.match(app.main(), /牵牛花登录连接尚未接通/);
  assert.match(app.main(), /disabled>登录牵牛花/);
  assert.doesNotMatch(app.main(), /GitHub|GITHUB_|bzq|data-page|team-login-form|<a\b|https:\/\/qnh/);
  assert.equal(app.selectors.get('.bottom-nav').innerHTML, '');
  assert.equal(app.calls.some(call => call.path === '/api/state'), false);
  await app.click('add');
  assert.equal(app.skuFlows(), 0);
  assert.equal(app.calls.length, 2);
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
