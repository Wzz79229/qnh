import test from 'node:test';
import assert from 'node:assert/strict';
import {STOCK_PATH,parseStockJson,matchStockRequest,normalizeStockResponse,createStockResponseReader} from '../inventory-response.mjs';
import {createInventorySearch,normalizeInventoryFilters} from '../inventory-search.mjs';

const SCOPE='777',SKU='2087061394030198822';
const href='https://qnh.meituan.com/home.html#/co-wms/non-erp/stock-query?tab=list&pageSize=2&repositoryList=%5B%5B3%2C12345%5D%5D';
const expected=(page=1)=>({href,filters:normalizeInventoryFilters({loc:'A10'}),scope:SCOPE,page});
const body=(page=1)=>({repositoryId:12345,repositoryType:3,repositoryIds:[12345],locationTypeStrategyId:'EMPOWER',page,pageSize:2,locationCodeSegmentList:['A10','','','']});
const record=(sku=SKU,locs=['A10-1-1'])=>({skuId:sku,goodsInfo:{skuName:'合成测试商品',spec:'白色30×30cm',weight:'5',baseUnit:'片',picUrl:'https://example.invalid/not-loaded.png'},repositoryInfo:{repositoryId:12345,repositoryType:3,repositoryName:'合成测试仓'},storeLocationInfoList:locs.map(locationCode=>({locationCode}))});
const payload=(list=[record(),record('0001234567890123456',['A10-2-1'])],total=list.length)=>({code:0,data:{list,total}});
const request=(page=1)=>matchStockRequest(STOCK_PATH,'POST',JSON.stringify(body(page)),expected(page));

test('raw inventory data supplies complete SKU, exact official specification, store and separate locations',()=>{
 const value=normalizeStockResponse(payload([record(SKU,['A10-2-1','A10-1-1','A100-1-1','A10-1-1'])]),request(),expected());
 assert.deepEqual(value.rows,[{sku:SKU,name:'合成测试商品',spec:'白色30×30cm(5g/片)',store:'合成测试仓(12345)',loc:'A10-2-1'},{sku:SKU,name:'合成测试商品',spec:'白色30×30cm(5g/片)',store:'合成测试仓(12345)',loc:'A10-1-1'}]);
 assert.deepEqual(value.pagination,{current:1,pageSize:2,total:1,previous:false,next:false});
});
test('long numeric tokens and leading-zero string SKUs survive without JavaScript rounding',()=>{
 const source=JSON.stringify(payload([record('REPLACE'),record('0001234567890123456')])).replace('"REPLACE"',SKU);
 assert.equal(parseStockJson(source).data.list[0].skuId,SKU);
 const result=normalizeStockResponse(source,request(),expected());assert.equal(result.rows[0].sku,SKU);assert.equal(result.rows[1].sku,'0001234567890123456');
 const values=parseStockJson('{"literal":"12345678901234567 and \\"quote\\"", "n":12345678901234567,"small":42,"decimal":1.25,"exp":1e2}');
 assert.equal(values.n,'12345678901234567');assert.equal(values.small,42);assert.equal(values.decimal,1.25);assert.equal(values.exp,100);
 assert.throws(()=>normalizeStockResponse(payload([record(Number(SKU))]),request(),expected()),/ID/);
 assert.throws(()=>parseStockJson('{"n":0012345678901234567}'));
});
test('request correlation requires official POST, exact filters, store set, page and location boundary',()=>{
 assert.ok(request());
 for(const patch of [{page:2},{pageSize:0},{pageSize:501},{repositoryIds:[12345,9]},{repositoryId:9},{repositoryType:2},{skuNameKeyword:'其他'},{skuIdListStr:SKU},{locationCodeSegmentList:['A100']},{locationTypeStrategyId:'OTHER'}])assert.equal(matchStockRequest(STOCK_PATH,'POST',JSON.stringify({...body(),...patch}),expected()),null);
 for(const url of ['https://attacker.invalid'+STOCK_PATH,STOCK_PATH+'?other=1',STOCK_PATH+'/other'])assert.equal(matchStockRequest(url,'POST',JSON.stringify(body()),expected()),null);
 assert.equal(matchStockRequest(STOCK_PATH,'GET',JSON.stringify(body()),expected()),null);
 assert.equal(matchStockRequest(STOCK_PATH,'POST',JSON.stringify(body()),{...expected(),href:href.replace('12345','99999')}),null);
});
test('pagination uses product total before expanding locations, with no missing last page',()=>{
 const first=normalizeStockResponse(payload([record(SKU,['A10-1-1','A10-1-2']),record('OTHER')],3),request(),expected());
 const last=normalizeStockResponse(payload([record('LAST',['A10-10-1'])],3),request(2),expected(2));
 assert.equal(first.rows.length,3);assert.equal(first.pagination.next,true);assert.equal(last.pagination.previous,true);assert.equal(last.pagination.next,false);
 assert.throws(()=>normalizeStockResponse(payload([record()],3),request(),expected()),/TOTAL/);
 assert.throws(()=>normalizeStockResponse({...payload(),data:{...payload().data,page:2}},request(),expected()),/PAGE/);
});
test('failed, foreign-tenant, foreign-store, missing-SKU and oversized response data cannot become labels',()=>{
 for(const value of [{...payload(),code:401},{...payload(),success:false},{...payload(),data:{...payload().data,tenantId:'888'}},payload([{...record(),tenantId:'888'}]),payload([{...record(),repositoryInfo:{...record().repositoryInfo,repositoryId:9}}]),payload([{...record(),skuId:undefined}]),payload([{...record(),storeLocationInfoList:null}]),payload([{...record(),goodsInfo:{skuName:''}}])])assert.throws(()=>normalizeStockResponse(value,request(),expected()));
 assert.throws(()=>parseStockJson(' '.repeat(4*1024*1024+1)),/SIZE/);
 const many=record(SKU,Array.from({length:501},(_,i)=>`A10-${i}-1`));assert.throws(()=>normalizeStockResponse(payload([many]),request(),expected()));
 assert.deepEqual(normalizeStockResponse(payload([],0),request(),expected()).rows,[]);
});
function browserHarness(){
 let tenant=SCOPE;
 class Xhr extends EventTarget {
  open(method,url){this.method=method;this.url=url;return 'opened';}
  send(body){this.body=body;this.sends=(this.sends||0)+1;return 'sent';}
  complete(value,status=200,type=''){this.status=status;this.responseType=type;this.responseText=typeof value==='string'?value:JSON.stringify(value);this.response=type==='json'?value:null;this.dispatchEvent(new Event('loadend'));}
 }
 const browser={XMLHttpRequest:Xhr},reader=createStockResponseReader({browser,identity:()=>tenant});
 function send(value=body()){const xhr=new browser.XMLHttpRequest();xhr.open('POST','https://qnh.meituan.com'+STOCK_PATH);assert.equal(xhr.send(JSON.stringify(value)),'sent');return xhr;}
 return {browser,reader,send,tenant:value=>tenant=value};
}
test('XHR observer consumes only the current official response, leaves original response intact and never replays',async()=>{
 const h=browserHarness(),ticket=h.reader.begin(expected()),xhr=h.send();let pageRead='';xhr.addEventListener('loadend',()=>pageRead=xhr.responseText);
 const raw=JSON.stringify(payload());xhr.complete(raw);const result=await ticket.promise;
 assert.equal(pageRead,raw);assert.equal(xhr.sends,1);assert.equal(result.rows[0].sku,SKU);assert.equal(h.reader.current(ticket),true);
 h.send({...body(),locationCodeSegmentList:['B20']});assert.equal(h.reader.current(ticket),false);
});
test('canceled or superseded requests and tenant switches discard late responses',async()=>{
 const h=browserHarness(),first=h.reader.begin(expected()),old=h.send();h.reader.cancel();old.complete(payload());assert.equal(await first.promise,null);assert.equal(h.reader.current(first),false);
 const second=h.reader.begin(expected()),xhr=h.send();h.tenant('888');xhr.complete(payload());assert.equal(await second.promise,null);assert.equal(h.reader.current(second),false);
 h.tenant(SCOPE);const third=h.reader.begin(expected()),a=h.send();const fourth=h.reader.begin(expected()),b=h.send();a.complete(payload());b.complete(payload());assert.equal(await third.promise,null);assert.ok(await fourth.promise);assert.equal(h.reader.current(fourth),true);
});
test('unsupported business envelopes and unsafe pre-parsed identifiers resolve unavailable',async()=>{
 for(const [value,status,type] of [[payload(),403,''],[{code:0,data:{list:[]}},200,''],[payload([record(Number(SKU))]),200,'json']]){
  const h=browserHarness(),ticket=h.reader.begin(expected());h.send().complete(value,status,type);assert.equal(await ticket.promise,null);assert.equal(h.reader.current(ticket),false);
 }
});
test('temporary hidden tenant header does not authorize data until the same original tenant is visible again',async()=>{
 const h=browserHarness(),ticket=h.reader.begin(expected());h.tenant('');const xhr=h.send();xhr.complete(payload());assert.ok(await ticket.promise);assert.equal(h.reader.current(ticket),false);h.tenant(SCOPE);assert.equal(h.reader.current(ticket),true);
 h.reader.cancel();h.tenant('');const unverified=h.reader.begin(expected());assert.equal(await unverified.promise,null);h.tenant(SCOPE);assert.equal(h.reader.current(unverified),false);
});
test('fetch observes a bounded cloned response without consuming or replacing the page response',async()=>{
 const original=new Response(JSON.stringify(payload()),{status:200}),browser={fetch:()=>Promise.resolve(original)};
 const reader=createStockResponseReader({browser,identity:()=>SCOPE}),ticket=reader.begin(expected());
 const received=await browser.fetch('https://qnh.meituan.com'+STOCK_PATH,{method:'POST',body:JSON.stringify(body())});
 assert.equal(received,original);assert.equal((await ticket.promise).rows[0].sku,SKU);assert.equal(JSON.parse(await original.text()).data.list[0].skuId,SKU);
});
function runtimeHarness(t){
 const keys=['location','HTMLInputElement','window'],saved=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));t.after(()=>keys.forEach((key,i)=>saved[i]?Object.defineProperty(globalThis,key,saved[i]):delete globalThis[key]));
 class Input{get value(){return this.current||'';}set value(value){this.current=value;}dispatchEvent(){}}
 globalThis.HTMLInputElement=Input;globalThis.location={href};
 const h=browserHarness();globalThis.window=h.browser;
 const inputs=Object.fromEntries(['name','sku','barcode','external'].map(key=>[key,new Input()])),locations=Array.from({length:4},()=>new Input());
 let page=1;let pending;const state={next:false,domReads:0};
 const fire=()=>{const q=new URLSearchParams(href.split('?')[1]);q.set('_t',String(page+9));q.set('current',String(page));for(const value of ['A10','','',''])q.append('locationCodeSegmentList',value);location.href=href.split('?')[0]+'?'+q;pending=h.send(body(page));};
 const control={inputs,locations,button:{click:fire},root:{querySelector:selector=>selector.includes('pagination-next')?{disabled:!state.next,click(){page++;fire();}}:null}};
 const runtime=createInventorySearch({shell:()=>true,tenant:()=>SCOPE,requiresLogin:()=>false,controls:()=>control,readDisplayIdentity:()=>({}),responses:h.reader,observe:()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,cancel:()=>resolve(false)};},readRows:()=>{state.domReads++;throw Error('DOM table must not be read');},readCard:()=>{throw Error('Flow card must not be read');}});
 return {...h,runtime,control,state,complete:(list,total)=>pending.complete(payload(list,total)),settle:()=>new Promise(done=>setImmediate(done))};
}
test('A10 raw responses publish all full SKUs before DOM rendering and cross the bridge once per selected page',async t=>{
 const h=runtimeHarness(t);assert.equal(h.runtime.search('1',{loc:'A10'},SCOPE),true);h.complete([record(SKU,['A10-2-1','A10-1-1']),record('SECOND')],3);await h.settle();
 const snapshot=h.runtime.inspect();assert.equal(snapshot.dataSource,'response');assert.equal(snapshot.rows.length,3);assert.equal(snapshot.pagination.next,true);assert.equal(h.state.domReads,0);
 assert.equal(h.runtime.takeResponseRows('1',[0,1,2],SCOPE).length,3);assert.equal(h.runtime.takeResponseRows('1',[0,0],SCOPE),null);assert.equal(h.runtime.takeResponseRows('1',[0],'888'),null);
 assert.equal(h.runtime.select('1',1,SCOPE,'22'),true);assert.equal(h.runtime.inspect().row.loc,'A10-1-1');assert.equal(h.runtime.inspect().inventoryRetained,true);
 h.state.next=true;assert.equal(h.runtime.page('2',1,SCOPE),true);h.complete([record('THIRD',['A10-10-1'])],3);await h.settle();
 assert.equal(h.runtime.inspect().pagination.current,2);assert.equal(h.runtime.inspect().pagination.next,false);assert.equal(h.runtime.takeResponseRows('2',[0],SCOPE)[0].sku,'THIRD');assert.equal(h.state.domReads,0);
});
test('response selections are invalidated by changed filter, changed URL, later query or cancellation',async t=>{
 const h=runtimeHarness(t);h.runtime.search('1',{loc:'A10'},SCOPE);h.complete([record()],1);await h.settle();const before=location.href;
 h.control.locations[0].value='B20';assert.equal(h.runtime.takeResponseRows('1',[0],SCOPE),null);h.control.locations[0].value='A10';
 location.href+='&other=1';assert.equal(h.runtime.takeResponseRows('1',[0],SCOPE),null);location.href=before;
 h.send({...body(),locationCodeSegmentList:['B20']});assert.equal(h.runtime.takeResponseRows('1',[0],SCOPE),null);h.runtime.cancel();assert.equal(h.runtime.inspect().status,'idle');
});
