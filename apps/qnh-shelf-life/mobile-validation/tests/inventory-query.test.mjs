import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { INVENTORY_URL, LEGACY_INVENTORY_URL, legacyInventoryPage, inventoryPage, exactInventoryReceipt, normalizeInventoryRows, createInventoryRuntime } from '../inventory-query.mjs';
const SKU='2110000000000123456';
const receipt=(sku=SKU,t='2')=>`${INVENTORY_URL}&skuIdListStr=${sku}&_t=${t}&current=1`;
const row={name:'合成测试商品',spec:'500ml/瓶',loc:'C56-2-2',store:'合成测试仓'};
test('only the observed legacy and new product-stock inventory tabs are lookup entries',()=>{
  assert.ok(inventoryPage(INVENTORY_URL));assert.ok(inventoryPage(LEGACY_INVENTORY_URL));assert.ok(legacyInventoryPage(LEGACY_INVENTORY_URL));assert.ok(legacyInventoryPage(LEGACY_INVENTORY_URL.split('?')[0]));assert.equal(inventoryPage(LEGACY_INVENTORY_URL.replace('tab=list','tab=location')),false);
  for(const url of ['https://qnh.meituan.com/#/unifiedGoods/tenant/spu-list',INVENTORY_URL.replace('goodsBatch','goods'),INVENTORY_URL.replace('qnh.meituan.com','attacker.invalid')])assert.equal(inventoryPage(url),false);
});
test('receipt requires a new official query timestamp and one exact full SKU filter',()=>{
  assert.ok(exactInventoryReceipt(receipt(),SKU,'1'));
  for(const url of [receipt(SKU,'1'),receipt('000123'),receipt()+`&skuIdListStr=${SKU}`,receipt().replace('current=1','current=2'),INVENTORY_URL])assert.equal(exactInventoryReceipt(url,SKU,'1'),false);
});
test('inventory records retain separate locations and never synthesize an SPU or use a UPC',()=>{
  const rows=normalizeInventoryRows({rows:[row,row,{...row,loc:'C56-2-3'}],empty:false},'000123');
  assert.equal(rows.length,2);assert.equal(rows[0].sku,'000123');assert.equal(rows[1].loc,'C56-2-3');assert.equal(rows[0].spu,undefined);
  assert.throws(()=>normalizeInventoryRows({rows:[row],empty:true},SKU));
  assert.throws(()=>normalizeInventoryRows({rows:[],empty:false},SKU));
  assert.deepEqual(normalizeInventoryRows({rows:[],empty:true},SKU),[]);
});
function harness(t){
  const keys=['location','HTMLInputElement'],previous=keys.map(k=>Object.getOwnPropertyDescriptor(globalThis,k));t.after(()=>keys.forEach((k,i)=>previous[i]?Object.defineProperty(globalThis,k,previous[i]):delete globalThis[k]));
  class Input{get value(){return this.current||'';}set value(value){this.current=value;}dispatchEvent(){}}
  const state={tenant:'12345',loggedIn:true,freshUrl:true,snapshot:{rows:[row],empty:false},clicks:0},watchers=[],field=new Input();
  globalThis.location={href:INVENTORY_URL};globalThis.HTMLInputElement=Input;
  const runtime=createInventoryRuntime({shell:()=>state.loggedIn,tenant:()=>state.tenant,
    controls:()=>({field,button:{click(){state.clicks++;if(state.freshUrl)location.href=receipt(field.value,String(state.clicks+1));}}}),
    observe:()=>{let resolve;const promise=new Promise(r=>resolve=r);const watcher={promise,resolve,cancel:()=>resolve(false)};watchers.push(watcher);return watcher;},readRows:()=>state.snapshot});
  return{runtime,state,field,watchers,settle:()=>new Promise(r=>setImmediate(r))};
}
test('query remains pending until table refresh and official SKU receipt agree',async t=>{
  const h=harness(t);assert.equal(h.runtime.begin(1,SKU,'12345'),true);assert.equal(h.runtime.inspect().rows,undefined);h.watchers[0].resolve(true);await h.settle();assert.equal(h.runtime.inspect().status,'found');assert.equal(h.runtime.inspect().rows[0].sku,SKU);
});
test('an old result cannot pass without a fresh table or updated official query filter',async t=>{
  const h=harness(t);h.runtime.begin(1,SKU,'12345');h.watchers[0].resolve(false);await h.settle();assert.equal(h.runtime.inspect().status,'error');
  h.state.freshUrl=false;h.runtime.begin(2,'000123','12345');h.watchers[1].resolve(true);await h.settle();assert.equal(h.runtime.inspect().status,'error');assert.equal(h.runtime.inspect().rows,undefined);
});
test('tenant switch, logout, changed input and cancellation discard prior inventory rows',async t=>{
  const h=harness(t);h.runtime.begin(1,SKU,'12345');h.state.tenant='67890';h.watchers[0].resolve(true);await h.settle();assert.equal(h.runtime.inspect().rows,undefined);
  h.state.tenant='12345';h.runtime.begin(2,SKU,'12345');h.state.loggedIn=false;h.watchers[1].resolve(true);await h.settle();assert.equal(h.runtime.inspect().authorized,false);
  h.state.loggedIn=true;h.runtime.begin(3,SKU,'12345');h.field.value='other';h.watchers[2].resolve(true);await h.settle();assert.equal(h.runtime.inspect().status,'error');
  h.runtime.begin(4,SKU,'12345');h.runtime.cancel();h.watchers[3].resolve(true);await h.settle();assert.equal(h.runtime.inspect().status,'idle');
});
test('the active inventory bundle excludes product-master navigation and credential reads',async()=>{
  const output=await build({entryPoints:[fileURLToPath(new URL('../inventory-entry.mjs',import.meta.url))],bundle:true,platform:'browser',format:'iife',target:'chrome80',keepNames:false,write:false});
  const script=output.outputFiles[0].text,context={window:{},location:{origin:'https://qnh.meituan.com',href:INVENTORY_URL},URL,URLSearchParams,document:{readyState:'loading'}};
  vm.runInNewContext(script,context);assert.equal(context.window.__kuguanInventory.inspect().authorized,false);
  assert.doesNotMatch(script,/unifiedGoods\/tenant\/spu-list|document\.cookie|localStorage|__name|binding\.acquire/);
});
