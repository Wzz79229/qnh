import test from 'node:test';
import assert from 'node:assert/strict';
import { INVENTORY_URL, LEGACY_INVENTORY_URL } from '../inventory-query.mjs';
import { normalizeInventoryFilters, inventoryFilterReceipt, flowSkuReceipt, inventoryLinkSku, legacyLocationCodes, readSearchRows, createInventorySearch } from '../inventory-search.mjs';

const SKU='0001234567890123456';
const row={name:'合成测试商品',spec:'500ml/瓶',loc:'C55-3-13',store:'合成测试仓(12345)'};
const filters=normalizeInventoryFilters({name:'合成',loc:'C55-3-13'});
function receipt(f=filters,stamp='2',page=1,base=INVENTORY_URL){const q=new URLSearchParams({_t:stamp,current:String(page),tab:base===LEGACY_INVENTORY_URL?'list':'goodsBatch'});for(const [k,v] of Object.entries({skuNameKeyword:f.name,skuIdListStr:f.sku,upcKeyword:f.barcode,externalGoodsCodeKeyword:f.external}))if(v)q.append(k,v);if(f.loc){const parts=f.loc.split('-');while(parts.length<4)parts.push('');for(const part of parts)q.append('locationCodeSegmentList',part);}return base.split('?')[0]+'?'+q;}
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
function harness(t,base=INVENTORY_URL){
 const saved=['location','HTMLInputElement','window'].map(k=>Object.getOwnPropertyDescriptor(globalThis,k));t.after(()=>['location','HTMLInputElement','window'].forEach((k,i)=>saved[i]?Object.defineProperty(globalThis,k,saved[i]):delete globalThis[k]));
 class Input{get value(){return this.current||'';}set value(value){this.current=value;}dispatchEvent(){}}
 globalThis.HTMLInputElement=Input;globalThis.location={href:base};
 const state={tenant:'777',loggedIn:true,rows:[row],card:null,updated:true,requiresLogin:false},waiters=[];
 globalThis.window={open(url){state.originalOpens=(state.originalOpens||0)+1;location.href=new URL(url,location.href).href;}};
 const inputs=Object.fromEntries(['name','sku','barcode','external'].map(k=>[k,new Input()])),locations=Array.from({length:4},()=>new Input());
 const control={inputs,locations,root:{querySelector:()=>null},button:{click(){if(state.updated)location.href=receipt(normalizeInventoryFilters({...Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.value])),loc:locations.map(v=>v.value).join('-').replace(/-+$/u,'')}),'2',1,base);}}};
 const runtime=createInventorySearch({shell:()=>state.loggedIn,tenant:()=>state.tenant,requiresLogin:()=>state.requiresLogin,controls:()=>control,observe:()=>{let resolve;const promise=new Promise(r=>resolve=r);const watcher={promise,resolve,cancel:()=>resolve(false)};waiters.push(watcher);return watcher;},readRows:()=>state.rows.map((data,index)=>({data,link:{getAttribute:()=>state.linkMode==='href'?state.linkHref||flow(state.skus?.[index]||SKU):null,click(){state.clicks=(state.clicks||0)+1;const url=state.linkHref||flow(state.skus?.[index]||SKU);if(state.linkMode==='open')window.open(url);else location.href=url;state.afterClick?.();}}})),readCard:()=>{state.cardReads=(state.cardReads||0)+1;return state.card;}});
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

test('multiple selections recheck each returned inventory row and resolve distinct full SKUs',async t=>{
 const h=harness(t),other={...row,spec:'1L/瓶',loc:'C55-3-14'};h.state.rows=[row,other];h.state.skus=[SKU,'0001234567890123457'];
 h.runtime.search('1',{name:'合成'},'777');h.waiters[0].resolve(true);await h.settle();const returned=location.href;
 assert.equal(h.runtime.select('1',0,'777'),true);h.state.card={name:row.name,sku:SKU};assert.equal(h.runtime.inspect().row.sku,SKU);
 location.href=returned;assert.equal(h.runtime.select('1',1,'777'),true);assert.equal(h.runtime.inspect().row,undefined);h.state.card={name:other.name,sku:h.state.skus[1]};assert.equal(h.runtime.inspect().row.sku,h.state.skus[1]);assert.equal(h.runtime.inspect().row.loc,'C55-3-14');
});
test('a changed batch table, cancellation or a different tenant prevents another selection',async t=>{
 const h=harness(t),other={...row,loc:'C55-3-14'};h.state.rows=[row,other];h.runtime.search('1',{name:'合成'},'777');h.waiters[0].resolve(true);await h.settle();const returned=location.href;
 h.runtime.select('1',0,'777');h.state.card={name:row.name,sku:SKU};h.runtime.inspect();location.href=returned;
 h.state.rows=[{...row,spec:'changed'},other];assert.equal(h.runtime.select('1',1,'777'),false);
 h.state.rows=[row,other];h.state.tenant='888';assert.equal(h.runtime.select('1',1,'777'),false);h.state.tenant='777';h.runtime.cancel();assert.equal(h.runtime.select('1',1,'777'),false);
});

test('region batches may page after selection only with a fresh matching page receipt',async t=>{
 const h=harness(t,LEGACY_INVENTORY_URL),f=normalizeInventoryFilters({loc:'C55'});h.runtime.search('1',f,'777');h.waiters[0].resolve(true);await h.settle();const returned=location.href;h.runtime.select('1',0,'777');h.state.card={name:row.name,sku:SKU};h.runtime.inspect();location.href=returned;
 h.control.root.querySelector=selector=>selector.includes('pagination-next')?{disabled:false,click(){location.href=receipt(f,'2',2,LEGACY_INVENTORY_URL);}}:null;
 assert.equal(h.runtime.page('2',1,'999'),false);assert.equal(h.runtime.page('2',1,'777'),true);h.waiters[1].resolve(true);await h.settle();assert.equal(h.runtime.inspect().status,'found');assert.equal(h.runtime.inspect().requestId,'2');
});

test('a recreated inventory runtime resumes only the exact observed query, scope and rows',async t=>{
 const h=harness(t);h.runtime.search('1',filters,'777');h.waiters[0].resolve(true);await h.settle();const expected=location.href;h.runtime.select('1',0,'777');h.state.card={name:row.name,sku:SKU};h.runtime.inspect();location.href=expected;h.runtime.cancel();
 assert.equal(h.runtime.resume('1',filters,'888',1,expected,[row]),false);
 assert.equal(h.runtime.resume('1',filters,'777',1,expected.replace('_t=2','_t=99'),[row]),false);
 assert.equal(h.runtime.resume('1',filters,'777',1,expected,[{...row,loc:'C55-3-99'}]),false);
 assert.equal(h.runtime.resume('1',filters,'777',1,expected,[{store:row.store,loc:row.loc,spec:row.spec,name:row.name}]),true);assert.equal(h.runtime.select('1',0,'777'),true);
});

test('each product resolution carries its own selection receipt across a resumed batch',async t=>{
 const h=harness(t),f=normalizeInventoryFilters({name:'合成'}),other={...row,loc:'C55-3-14'};
 h.state.rows=[row,other];h.state.skus=[SKU,'0001234567890123457'];h.runtime.search('1',f,'777');h.waiters[0].resolve(true);await h.settle();const returned=location.href;
 assert.equal(h.runtime.select('1',0,'777','11'),true);h.state.card={name:row.name,sku:SKU};const first=h.runtime.inspect();assert.equal(first.selectionId,'11');assert.equal(first.status,'selected');
 location.href=returned;assert.equal(h.runtime.resume('1',f,'777',1,returned,[row,other]),true);assert.equal(h.runtime.inspect().selectionId,undefined);
 assert.equal(h.runtime.select('1',1,'777','12'),true);assert.equal(h.runtime.inspect().selectionId,'12');h.state.card={name:other.name,sku:h.state.skus[1]};const second=h.runtime.inspect();assert.equal(second.selectionId,'12');assert.equal(second.row.sku,h.state.skus[1]);assert.notEqual(first.selectionId,second.selectionId);
 h.runtime.cancel();assert.equal(h.runtime.inspect().selectionId,undefined);
});


test('location receipts accept omitted trailing empty segments without merging A10 and A100',()=>{
 const f=normalizeInventoryFilters({loc:'A10'}),short=receipt(f).replaceAll('&locationCodeSegmentList=','');
 const u=new URL(receipt(f));const q=new URLSearchParams(u.hash.split('?')[1]);q.delete('locationCodeSegmentList');q.append('locationCodeSegmentList','A10');
 assert.equal(inventoryFilterReceipt(u.href.split('?')[0]+'?'+q,f,1,'1'),true);
 q.set('locationCodeSegmentList','A100');assert.equal(inventoryFilterReceipt(u.href.split('?')[0]+'?'+q,f,1,'1'),false);
});
test('A10 is entered directly in the legacy official location field without scanning unfiltered inventory',async t=>{
 const h=harness(t,LEGACY_INVENTORY_URL),f=normalizeInventoryFilters({loc:'A10'});let focus=0,blur=0,pages=0;
 h.control.locations[0].focus=()=>focus++;h.control.locations[0].blur=()=>blur++;
 h.control.root.querySelector=selector=>selector.includes('pagination-next')?{disabled:false,click(){pages++;location.href=receipt(f,'2',2,LEGACY_INVENTORY_URL);}}:null;
 h.state.rows=[{...row,loc:'A10-1-1'},{...row,loc:'A10-1-2'}];assert.equal(h.runtime.search('9',f,'777'),true);h.waiters[0].resolve(true);await h.settle();
 assert.equal(h.control.locations[0].value,'A10');assert.deepEqual(h.control.locations.slice(1).map(v=>v.value),['','','']);assert.equal(focus,1);assert.equal(blur,1);assert.equal(h.runtime.inspect().filters.loc,'A10');assert.equal(h.runtime.inspect().rows.length,2);assert.equal(pages,0);assert.equal(h.runtime.searchPrefix,undefined);
 assert.equal(h.runtime.page('10',1,'777'),true);h.waiters[1].resolve(true);await h.settle();assert.equal(pages,1);assert.equal(h.runtime.inspect().filters.loc,'A10');assert.equal(new URLSearchParams(location.href.split('?')[1]).get('locationCodeSegmentList'),'A10');
});
test('an empty direct A10 result stays not-found without broadening or automatically paging inventory',async t=>{
 const h=harness(t,LEGACY_INVENTORY_URL);h.state.rows=[];let pages=0;h.control.root.querySelector=selector=>selector.includes('pagination-next')?{disabled:false,click(){pages++;}}:null;
 h.runtime.search('7',{loc:'A10'},'777');h.waiters[0].resolve(true);await h.settle();assert.equal(h.runtime.inspect().status,'not_found');assert.equal(h.runtime.inspect().filters.loc,'A10');assert.equal(pages,0);assert.equal(h.waiters.length,1);
 h.runtime.cancel();assert.equal(h.runtime.inspect().status,'idle');
});

test('region queries reject the new inventory entry instead of returning a misleading empty result',t=>{const h=harness(t);assert.equal(h.runtime.search('12',{loc:'A10'},'777'),false);assert.equal(h.waiters.length,0);});
test('legacy product rows expand individual matching locations and exclude A100',()=>{const span=text=>({innerText:text,querySelector:()=>null}),cell={innerText:'A10-1-1A10-1-2A100-1-1',querySelectorAll:()=>[span('A10-1-1'),span('A10-1-2'),span('A100-1-1'),span('A10-1-2')]};assert.deepEqual(legacyLocationCodes(cell,'A10'),['A10-1-1','A10-1-2']);assert.throws(()=>legacyLocationCodes(cell,'B20'));assert.deepEqual(legacyLocationCodes({innerText:'A10-1-1\nA10-2-1',querySelectorAll:()=>[]},'a10'),['A10-1-1','A10-2-1']);});

test('fast official links require one full SKU and a matching visible store ID',()=>{
 assert.equal(inventoryLinkSku(flow(),row),SKU);
 assert.equal(inventoryLinkSku(flow().replace('https://qnh.meituan.com/',''),row,'','https://qnh.meituan.com/home.html'),SKU);
 for(const [url,selected,expected] of [[flow()+'&skuIdKeyword=123',row,''],[flow()+'&repositoryId=12345',row,''],[flow()+'&repositoryType=3',row,''],[flow().replace('repositoryId=12345','repositoryId=999'),row,''],[flow().replace('repositoryType=3','repositoryType=0'),row,''],[flow().replace('qnh.meituan.com','attacker.invalid'),row,''],[flow().replace('/#/','/other#/'),row,''],[flow(),{...row,store:'No store ID'},''],[flow(),row,'OTHER']])assert.equal(inventoryLinkSku(url,selected,expected),'');
});

test('a fresh row href returns its exact full SKU without opening or reading a flow page',async t=>{
 const h=harness(t,LEGACY_INVENTORY_URL);h.state.linkMode='href';h.runtime.search('1',{loc:'C55'},'777');h.waiters[0].resolve(true);await h.settle();const before=location.href;
 assert.equal(h.runtime.select('1',0,'777','9'),true);const result=h.runtime.inspect();assert.equal(result.status,'selected');assert.equal(result.row.sku,SKU);assert.equal(result.selectionId,'9');assert.equal(result.inventoryRetained,true);assert.equal(location.href,before);assert.equal(h.state.clicks,undefined);assert.equal(h.state.cardReads,undefined);
});

test('synchronous official popup links resolve 50 products while retaining the inventory page',async t=>{
 const h=harness(t,LEGACY_INVENTORY_URL);h.state.linkMode='open';h.state.rows=Array.from({length:50},(_,i)=>({...row,loc:'C55-1-'+(i+1)}));h.state.skus=Array.from({length:50},(_,i)=>'0001234567890'+String(i).padStart(6,'0'));
 h.runtime.search('1',{loc:'C55'},'777');h.waiters[0].resolve(true);await h.settle();const before=location.href,original=window.open;
 for(let index=0;index<50;index++){assert.equal(h.runtime.select('1',index,'777',String(index+1)),true);const result=h.runtime.inspect();assert.equal(result.row.sku,h.state.skus[index]);assert.equal(result.row.loc,h.state.rows[index].loc);assert.equal(result.inventoryRetained,true);assert.equal(window.open,original);assert.equal(location.href,before);}
 assert.equal(h.state.clicks,50);assert.equal(h.state.originalOpens,undefined);assert.equal(h.state.cardReads,undefined);
});

test('fast captures cannot survive a changed row, changed tenant or logout during the click',async t=>{
 const h=harness(t,LEGACY_INVENTORY_URL);h.state.linkMode='open';const original=window.open;
 for(const mutate of [()=>h.state.rows=[{...row,spec:'changed'}],()=>h.state.tenant='888',()=>h.state.loggedIn=false]){h.state.rows=[row];h.state.tenant='777';h.state.loggedIn=true;location.href=LEGACY_INVENTORY_URL;h.runtime.search('1',{loc:'C55'},'777');h.waiters.at(-1).resolve(true);await h.settle();h.state.afterClick=mutate;assert.equal(h.runtime.select('1',0,'777','1'),false);assert.equal(window.open,original);assert.equal(h.runtime.inspect().inventoryRetained,undefined);h.runtime.cancel();}
});

test('ambiguous or wrong-store popup links fail closed and restore window.open',async t=>{
 const h=harness(t,LEGACY_INVENTORY_URL);h.state.linkMode='open';h.state.linkHref=flow().replace('repositoryId=12345','repositoryId=999');h.runtime.search('1',{loc:'C55'},'777');h.waiters[0].resolve(true);await h.settle();const original=window.open;
 assert.equal(h.runtime.select('1',0,'777'),false);assert.equal(window.open,original);assert.equal(h.runtime.inspect().inventoryRetained,undefined);
 h.state.linkHref=flow();h.state.afterClick=()=>window.open(flow('0001234567890123457'));assert.equal(h.runtime.select('1',0,'777'),false);assert.equal(window.open,original);
});

test('router navigation keeps the verified flow-card fallback and fast results are not cached',async t=>{
 const h=harness(t);h.state.linkMode='href';h.runtime.search('1',filters,'777');h.waiters[0].resolve(true);await h.settle();assert.equal(h.runtime.select('1',0,'777'),true);assert.equal(h.runtime.inspect().inventoryRetained,true);
 h.runtime.cancel();h.state.linkMode='router';location.href=INVENTORY_URL;h.runtime.search('2',filters,'777');h.waiters[1].resolve(true);await h.settle();assert.equal(h.runtime.select('2',0,'777'),true);assert.equal(h.runtime.inspect().status,'resolving');assert.equal(h.runtime.inspect().inventoryRetained,undefined);h.state.card={name:row.name,sku:SKU};assert.equal(h.runtime.inspect().status,'selected');assert.equal(h.runtime.inspect().row.sku,SKU);
});

test('fifty official product rows may expand to 150 location labels without truncation',t=>{
 const h=harness(t,LEGACY_INVENTORY_URL),saved=globalThis.getComputedStyle;globalThis.getComputedStyle=()=>({display:'block',visibility:'visible'});t.after(()=>saved?globalThis.getComputedStyle=saved:delete globalThis.getComputedStyle);
 const node=(text='')=>({innerText:text,tagName:'TD',getClientRects:()=>[{}],querySelector:()=>null});
 const control=count=>{const elements=Array.from({length:50},(_,i)=>{const product=node('合成多库位商品'),first={...node('合成多库位商品\n规格：1件'),querySelector:()=>product},store=node('合成测试仓(12345)'),spans=Array.from({length:count},(_,n)=>node(`A10-${i+1}-${n+1}`)),loc={...node(spans.map(e=>e.innerText).join('\n')),querySelectorAll:()=>spans},link=node('查询流水');return {...node(),children:[first,store,loc],getBoundingClientRect:()=>({height:50}),querySelectorAll:()=>[link]};});return {headers:['商品信息','门店/仓','库位'],locations:[{value:'A10'}],root:{querySelectorAll:selector=>selector==='tbody tr'?elements:[]}};};
 const rows=readSearchRows(control(3));assert.equal(rows.length,150);assert.equal(rows[0].data.loc,'A10-1-1');assert.equal(rows.at(-1).data.loc,'A10-50-3');assert.throws(()=>readSearchRows(control(11)),/ROWS/);
});

test('large expanded pages are sent once and resume still compares every location row',async t=>{
 const h=harness(t,LEGACY_INVENTORY_URL);h.state.rows=Array.from({length:150},(_,i)=>({...row,loc:'C55-1-'+(i+1)}));h.state.linkMode='open';h.runtime.search('1',{loc:'C55'},'777');h.waiters[0].resolve(true);await h.settle();const result=h.runtime.inspect(),url=location.href;assert.equal(result.rows.length,150);assert.equal(result.pageRows,undefined);assert.equal(h.runtime.select('1',149,'777','150'),true);assert.equal(h.runtime.inspect().row.loc,'C55-1-150');assert.equal(h.runtime.resume('1',result.filters,'777',1,url,result.rows),true);assert.equal(h.runtime.resume('1',result.filters,'777',1,url,result.rows.map((r,i)=>i===149?{...r,loc:'CHANGED'}:r)),false);
});
