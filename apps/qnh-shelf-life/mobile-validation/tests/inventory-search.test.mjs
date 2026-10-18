import test from 'node:test';
import assert from 'node:assert/strict';
import { INVENTORY_URL } from '../inventory-query.mjs';
import { normalizeInventoryFilters, inventoryFilterReceipt, flowSkuReceipt, createInventorySearch } from '../inventory-search.mjs';

const SKU='0001234567890123456';
const row={name:'合成测试商品',spec:'500ml/瓶',loc:'C55-3-13',store:'合成测试仓(12345)'};
const filters=normalizeInventoryFilters({name:'合成',loc:'C55-3-13'});
function receipt(f=filters,stamp='2',page=1){const q=new URLSearchParams({_t:stamp,current:String(page),tab:'goodsBatch'});for(const [k,v] of Object.entries({skuNameKeyword:f.name,skuIdListStr:f.sku,upcKeyword:f.barcode,externalGoodsCodeKeyword:f.external}))if(v)q.append(k,v);if(f.loc){const parts=f.loc.split('-');while(parts.length<4)parts.push('');for(const part of parts)q.append('locationCodeSegmentList',part);}return INVENTORY_URL.split('?')[0]+'?'+q;}
const flow=(sku=SKU)=>'https://qnh.meituan.com/#/co-wms/non-erp/goods-flow/list?skuIdKeyword='+sku+'&repositoryId=12345&repositoryType=3';

test('name, SKU, barcode, location and external filters stay strings and combine',()=>{
 assert.deepEqual(normalizeInventoryFilters({name:' 合成商品 ',sku:'000123',barcode:'000456',loc:'C55--13',external:'EXT-01'}),{name:'合成商品',sku:'000123',barcode:'000456',loc:'C55--13',external:'EXT-01'});
 for(const bad of [{},{sku:123},{name:'x\n'},{loc:'1234567'},{loc:'A-B-C-D-E'},{name:'合成',tenant:'12345'}])assert.throws(()=>normalizeInventoryFilters(bad));
});
test('official receipt must match all filters, repeated location segments, new timestamp and page',()=>{
 assert.ok(inventoryFilterReceipt(receipt(),filters,1,'1'));
 for(const url of [receipt(filters,'1'),receipt({...filters,name:'别的商品'}),receipt()+`&skuIdListStr=${SKU}`,receipt().replace('locationCodeSegmentList=13','locationCodeSegmentList=14'),receipt(filters,'2',2)])assert.equal(inventoryFilterReceipt(url,filters,1,'1'),false);
 assert.ok(inventoryFilterReceipt(receipt(filters,'2',2),filters,2,'2',false));
});
test('SKU comes from the selected inventory flow card and URL, never from UPC',()=>{
 assert.equal(flowSkuReceipt(flow(),{name:row.name,sku:SKU},row),SKU);
 for(const [url,card,selection,expected] of [[flow(),{name:row.name,sku:'123'},row,''],[flow(),{name:'另一个商品',sku:SKU},row,''],[flow().replace('repositoryId=12345','repositoryId=99999'),{name:row.name,sku:SKU},row,''],[flow()+'&skuIdKeyword=123',{name:row.name,sku:SKU},row,''],[flow().replace('qnh.meituan.com','attacker.invalid'),{name:row.name,sku:SKU},row,''],[flow(),{name:row.name,sku:SKU},row,'OTHER-SKU']])assert.equal(flowSkuReceipt(url,card,selection,expected),'');
});
function harness(t){
 const saved=['location','HTMLInputElement'].map(k=>Object.getOwnPropertyDescriptor(globalThis,k));t.after(()=>['location','HTMLInputElement'].forEach((k,i)=>saved[i]?Object.defineProperty(globalThis,k,saved[i]):delete globalThis[k]));
 class Input{get value(){return this.current||'';}set value(value){this.current=value;}dispatchEvent(){}}
 globalThis.HTMLInputElement=Input;globalThis.location={href:INVENTORY_URL};
 const state={tenant:'777',loggedIn:true,rows:[row],card:null,updated:true,requiresLogin:false},waiters=[];
 const inputs=Object.fromEntries(['name','sku','barcode','external'].map(k=>[k,new Input()])),locations=Array.from({length:4},()=>new Input());
 const control={inputs,locations,root:{querySelector:()=>null},button:{click(){if(state.updated)location.href=receipt(normalizeInventoryFilters({...Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.value])),loc:locations.map(v=>v.value).join('-').replace(/-+$/u,'')}));}}};
 const runtime=createInventorySearch({shell:()=>state.loggedIn,tenant:()=>state.tenant,requiresLogin:()=>state.requiresLogin,controls:()=>control,observe:()=>{let resolve;const promise=new Promise(r=>resolve=r);const watcher={promise,resolve,cancel:()=>resolve(false)};waiters.push(watcher);return watcher;},readRows:()=>state.rows.map(data=>({data,link:{click(){location.href=flow();}}})),readCard:()=>state.card});
 return {runtime,state,control,waiters,settle:()=>new Promise(r=>setImmediate(r))};
}
test('name/location search returns choices and resolves the selected full SKU before returning data',async t=>{
 const h=harness(t);assert.equal(h.runtime.search('1',filters,'777'),true);h.waiters[0].resolve(true);await h.settle();assert.equal(h.runtime.inspect().status,'found');assert.equal(h.runtime.inspect().rows[0].sku,undefined);
 assert.equal(h.runtime.select('1',0,'777'),true);assert.equal(h.runtime.inspect().status,'resolving');h.state.card={name:row.name,sku:SKU};assert.equal(h.runtime.inspect().status,'selected');assert.equal(h.runtime.inspect().row.sku,SKU);
});
test('changed table, changed input, logout and tenant switch cannot reuse selected results',async t=>{
 const h=harness(t);h.runtime.search('1',filters,'777');h.waiters[0].resolve(true);await h.settle();h.state.rows=[{...row,loc:'DIFFERENT'}];assert.equal(h.runtime.select('1',0,'777'),false);
 h.state.rows=[row];h.control.inputs.name.value='Changed';assert.equal(h.runtime.select('1',0,'777'),false);
 h.control.inputs.name.value=filters.name;h.state.tenant='888';assert.equal(h.runtime.select('1',0,'777'),false);assert.equal(h.runtime.inspect().rows,undefined);
 h.state.loggedIn=false;assert.equal(h.runtime.inspect().authorized,false);
});
test('a canceled request or stale query URL cannot publish results',async t=>{
 const h=harness(t);h.runtime.search('1',filters,'777');h.runtime.cancel();h.waiters[0].resolve(true);await h.settle();assert.equal(h.runtime.inspect().status,'idle');
 h.state.updated=false;location.href=INVENTORY_URL;h.runtime.search('2',filters,'777');h.waiters[1].resolve(true);await h.settle();assert.equal(h.runtime.inspect().status,'error');
});
test('lightweight idle checks still detect logout without reading inventory controls',t=>{
 const h=harness(t);h.control.root.querySelector=()=>{throw Error('Heavy inventory read');};
 assert.equal(h.runtime.inspect(false).authorized,true);assert.equal(h.runtime.inspect(false).productReady,false);
 h.state.loggedIn=false;assert.equal(h.runtime.inspect(false).authorized,false);assert.equal(h.runtime.inspect(false).tenantId,'');
});
test('a temporary shell gap while opening flow does not lose the selected row or expose unverified data',async t=>{
 const h=harness(t);h.runtime.search('1',filters,'777');h.waiters[0].resolve(true);await h.settle();h.runtime.select('1',0,'777');
 h.state.loggedIn=false;const checking=h.runtime.inspect();assert.equal(checking.authorized,false);assert.equal(checking.authState,'checking');assert.equal(checking.row,undefined);assert.equal(checking.rows,undefined);
 h.state.loggedIn=true;h.state.card={name:row.name,sku:SKU};assert.equal(h.runtime.inspect().status,'selected');assert.equal(h.runtime.inspect().row.sku,SKU);
});
test('an explicit login page discards the selected row rather than restoring it after login',async t=>{
 const h=harness(t);h.runtime.search('1',filters,'777');h.waiters[0].resolve(true);await h.settle();h.runtime.select('1',0,'777');h.state.loggedIn=false;h.state.requiresLogin=true;assert.equal(h.runtime.inspect().authState,'login_required');
 h.state.loggedIn=true;h.state.card={name:row.name,sku:SKU};assert.equal(h.runtime.inspect().status,'idle');assert.equal(h.runtime.inspect().row,undefined);
});
