import { readLoggedInQnhShell, readObservedQnhTenantId } from '../backend/qnh-browser-session.mjs';
import { inventoryPage, legacyInventoryPage, observeInventory } from './inventory-query.mjs';
import { readQnhDisplayIdentity } from './qnh-display-identity.mjs';
import { createStockResponseReader } from './inventory-response.mjs';

const visible = e => Boolean(e && e.getClientRects().length && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden');
const ID = /^[A-Za-z0-9._-]{1,64}$/u;
const fields = {name:'skuNameKeyword',sku:'skuIdListStr',barcode:'upcKeyword',external:'externalGoodsCodeKeyword'};
export function normalizeInventoryFilters(raw) {
  if(!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k=>![...Object.keys(fields),'loc'].includes(k)))throw Error('FILTER');
  const output={};
  for(const key of [...Object.keys(fields),'loc']){
    const value=raw[key]??'';if(typeof value!=='string'||value.length>100||/[\x00-\x1f\x7f]/u.test(value))throw Error('FILTER');output[key]=value.trim();
  }
  if(output.sku&&!ID.test(output.sku))throw Error('SKU');
  const location=output.loc?output.loc.split('-'):[];if(location.length>4||location.some(v=>v.length>6))throw Error('LOCATION');
  if(!Object.values(output).some(Boolean))throw Error('EMPTY');return output;
}
function queryOf(href){return new URLSearchParams(new URL(href).hash.split('?')[1]||'');}
export function inventoryFilterReceipt(href,filters,page,previousStamp,requireNewStamp=true){
  if(!inventoryPage(href))return false;const q=queryOf(href),stamp=q.get('_t');
  if(!/^\d+$/u.test(stamp||'')||requireNewStamp&&stamp===previousStamp||q.get('current')!==String(page))return false;
  for(const [key,field] of Object.entries(fields)){const values=q.getAll(field);if(values.length>1||(values[0]||'')!==filters[key])return false;}
  const actual=q.getAll('locationCodeSegmentList'),expected=filters.loc?filters.loc.split('-'):[];while(expected.length<4)expected.push('');
  return actual.length===0?expected.every(v=>!v):actual.length<=4&&[...actual,...Array(4-actual.length).fill('')].every((v,i)=>v===expected[i]);
}
export function searchControls(){
  const panels=Array.from(document.querySelectorAll(legacyInventoryPage(location.href)?'[id$="-panel-list"]':'[id$="-panel-goodsBatch"]')).filter(visible);if(panels.length!==1)return null;const root=panels[0];
  const inputs={};for(const [key,id] of Object.entries(fields)){const found=Array.from(root.querySelectorAll('input#'+id)).filter(visible);if(found.length!==1)return null;inputs[key]=found[0];}
  const locations=Array.from(root.querySelectorAll('.wms-wand-storage-location-input-select input')).filter(visible);if(locations.length!==4)return null;
  const buttons=Array.from(root.querySelectorAll('button')).filter(e=>visible(e)&&e.innerText.replace(/\s+/gu,'')==='查询');if(buttons.length!==1)return null;
  const headers=Array.from(root.querySelectorAll('thead th')).filter(visible).map(e=>e.innerText.trim());if(!['商品信息','门店/仓','库位'].every(v=>headers.includes(v)))return null;
  return {root,inputs,locations,headers,button:buttons[0]};
}
export function legacyLocationCodes(element,prefix){
  const full=/^[A-Za-z]{1,3}[0-9]{1,3}(?:-[A-Za-z0-9]{1,6}){1,3}$/u;
  const leaves=Array.from(element.querySelectorAll('span')).filter(e=>!e.querySelector('span')).map(e=>e.innerText.trim()).filter(t=>full.test(t));
  const values=leaves.length?leaves:element.innerText.trim().split(/[\s,，、;；]+/u).filter(t=>full.test(t));
  const codes=[...new Set(values)].filter(t=>t.split('-')[0].toUpperCase()===prefix.toUpperCase());if(!codes.length)throw Error('LOCATION');return codes;
}
export function readSearchRows(control){
  const rows=[];for(const element of control.root.querySelectorAll('tbody tr')){
    if(!visible(element)||element.getBoundingClientRect().height<1)continue;const cells=Array.from(element.children).filter(e=>e.tagName==='TD');
    const product=cells[0]?.querySelector('.wms-wand-goods-info-goods-name-text'),store=cells[control.headers.indexOf('门店/仓')],loc=cells[control.headers.indexOf('库位')];
    if(!visible(product)||!store||!loc)continue;
    const row={name:product.innerText.trim(),spec:/(?:^|\n)\s*规格[：:]\s*([^\n]*)/u.exec(cells[0].innerText)?.[1]?.trim()||'',store:store.innerText.trim(),loc:loc.innerText.trim()};
    if(!row.name||!row.store||Object.values(row).some(v=>v.length>300||/[\x00-\x08\x0b-\x1f\x7f]/u.test(v)))throw Error('ROW');
    const links=Array.from(element.querySelectorAll('a')).filter(e=>visible(e)&&e.innerText.trim()==='查询流水');if(links.length!==1)throw Error('LINK');
    const region=legacyInventoryPage(location.href)?control.locations[0].value.trim():'';
    if(region&&/^[A-Za-z]{1,3}[0-9]{1,3}$/u.test(region)){for(const value of legacyLocationCodes(loc,region))rows.push({data:{...row,loc:value},element,link:links[0]});}
    else rows.push({data:row,element,link:links[0]});
  }
  const empty=Array.from(control.root.querySelectorAll('.wms-ant-empty, .wms-ant-table-placeholder')).some(e=>visible(e)&&/暂无数据|暂无内容/u.test(e.innerText));
  if(rows.length>500||!rows.length&&!empty||rows.length&&empty)throw Error('ROWS');return rows;
}
function sameInputs(control,filters){return Object.keys(fields).every(k=>control.inputs[k].value===filters[k])&&control.locations.every((e,i)=>e.value===(filters.loc.split('-')[i]||''));}
function pagination(control){const button=key=>control.root.querySelector('.wms-ant-pagination-'+key+' button');const prev=button('prev'),next=button('next');return {current:Number(queryOf(location.href).get('current')||'1'),previous:Boolean(prev&&!prev.disabled),next:Boolean(next&&!next.disabled)};}
export function flowSkuReceipt(href,card,selected,expectedSku=''){
  try{const url=new URL(href),[path,query]=url.hash.split('?'),q=new URLSearchParams(query);
    if(url.origin!=='https://qnh.meituan.com'||!['/','/home.html'].includes(url.pathname)||path!=='#/co-wms/non-erp/goods-flow/list'||q.getAll('skuIdKeyword').length!==1)return '';
    const sku=q.get('skuIdKeyword');if(!ID.test(sku||'')||expectedSku&&sku!==expectedSku||!card||card.name!==selected.name||card.sku!==sku)return '';
    const storeId=/[（(](\d+)[)）]\s*$/u.exec(selected.store)?.[1];if(storeId&&q.get('repositoryId')!==storeId)return '';return sku;
  }catch{return '';}
}
// A fresh inventory row's own official flow link already contains its full SKU.
// Require its displayed store ID too; ambiguous links keep the full-page fallback.
export function inventoryLinkSku(href,selected,expectedSku='',base=globalThis.location?.href){
  try{const url=new URL(href,base),[path,query]=url.hash.split('?'),q=new URLSearchParams(query),storeId=/[（(](\d+)[)）]\s*$/u.exec(selected.store)?.[1];
    if(url.origin!=='https://qnh.meituan.com'||!['/','/home.html'].includes(url.pathname)||path!=='#/co-wms/non-erp/goods-flow/list'||!storeId)return '';
    if(['skuIdKeyword','repositoryId','repositoryType'].some(key=>q.getAll(key).length!==1))return '';
    const sku=q.get('skuIdKeyword');return ID.test(sku||'')&&(!expectedSku||sku===expectedSku)&&q.get('repositoryId')===storeId&&/^[1-9][0-9]*$/u.test(q.get('repositoryType')||'')?sku:'';
  }catch{return '';}
}
function captureInventoryLink(row,expectedSku){
  const direct=row.link.getAttribute?.('href'),sku=direct&&inventoryLinkSku(direct,row.data,expectedSku);if(sku)return {sku};
  const browser=globalThis.window,original=browser?.open,urls=[];
  // The observed official handler uses synchronous window.open. Capture only its
  // flow URL during this one read-only click, then immediately restore the API.
  const capture=function(url,...args){try{const target=new URL(String(url),location.href);if(target.origin==='https://qnh.meituan.com'&&target.hash.split('?')[0]==='#/co-wms/non-erp/goods-flow/list'){urls.push(target.href);return null;}}catch{}return original.apply(this,[url,...args]);};
  let hooked=false;try{if(typeof original==='function'){try{browser.open=capture;hooked=browser.open===capture;}catch{}}row.link.click();}finally{if(hooked&&browser.open===capture)browser.open=original;}
  if(!urls.length)return null;const captured=urls.length===1&&inventoryLinkSku(urls[0],row.data,expectedSku);if(!captured)throw Error('LINK');return {sku:captured};
}
function readFlowCard(){
  const cards=Array.from(document.querySelectorAll('.wms-wand-goods-info')).filter(visible).map(card=>{
    const name=card.querySelector('.wms-wand-goods-info-goods-name-text')?.innerText.trim();
    const ids=Array.from(card.querySelectorAll('.wms-wand-goods-info-rest-info-non-tooltip')).map(e=>/^SKU[：:]\s*([A-Za-z0-9._-]{1,64})\s*$/u.exec(e.innerText.trim())?.[1]).filter(Boolean);
    return name&&ids.length===1?{name,sku:ids[0]}:null;
  }).filter(Boolean);return cards.length===1?cards[0]:null;
}
export function loginRequired(){
  try{const u=new URL(location.href);return u.origin!=='https://qnh.meituan.com'||!['/','/home.html'].includes(u.pathname)||/^#\/(?:login|logout)(?:\/|\?|$)/iu.test(u.hash)||Array.from(document.querySelectorAll('input[type="password"]')).some(visible);}catch{return true;}
}
function setInput(input,value){if(input.value===value)return;input.focus?.();const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;if(!setter)throw Error('INPUT');setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));input.blur?.();}
function storeToggle(){return searchControls()?.root.querySelector('.wms-roo-wand-storepicker-bizqnh-multi-cascader-picker .wms-roo-multi-cascader-toggle');}
function storeColumns(){return Array.from(document.querySelectorAll('.wms-roo-wand-storepicker-bizqnh-multi-cascader-picker-dropdown .wms-roo-picker-cascader-menu-column')).filter(visible);}
export function createInventorySearch({shell=readLoggedInQnhShell,tenant=readObservedQnhTenantId,controls=searchControls,observe=observeInventory,readRows=readSearchRows,readCard=readFlowCard,readDisplayIdentity=readQnhDisplayIdentity,requiresLogin=loginRequired,now=()=>Date.now(),responses=null}={}){
  let state={status:'idle'},generation=0,watcher=null,receipt='',selected=null,responseTicket=null;
  const identity=()=>{try{const u=new URL(location.href),id=tenant();return u.origin==='https://qnh.meituan.com'&&['/','/home.html'].includes(u.pathname)&&shell()&&typeof id==='string'&&/^[1-9][0-9]{0,19}$/u.test(id)?id:'';}catch{return '';}};
  const responseReader=responses||createStockResponseReader({identity,now});
  const cancel=()=>{generation++;watcher?.cancel();watcher=null;responseReader.cancel();responseTicket=null;state={status:'idle'};receipt='';selected=null;};
  const matches=scope=>Boolean(identity()&&identity()===scope);
  function publish(requestId,filters,scope,control){
    const rows=readRows(control).map(row=>row.data);receipt=location.href;
    state={status:rows.length?'found':'not_found',requestId:String(requestId),tenantId:scope,filters,rows,pageRows:rows,receipt,pagination:pagination(control)};
  }
  function execute(requestId,filters,scope,page,click,newStamp){
    const control=controls();if(!matches(scope)||!inventoryPage(location.href)||!control||!/^\d{1,15}$/u.test(String(requestId)))return false;
    cancel();const current=generation,stamp=queryOf(location.href).get('_t');state={status:'pending',requestId:String(requestId),tenantId:scope,filters};
    (async()=>{try{
      if(page===1&&newStamp){for(const key of Object.keys(fields))setInput(control.inputs[key],filters[key]);for(let i=0;i<4;i++)setInput(control.locations[i],filters.loc.split('-')[i]||'');}
      if(!sameInputs(control,filters))throw Error('INPUT');watcher=observe(control);const active=watcher;
      const ticket=legacyInventoryPage(location.href)?responseReader.begin({href:location.href,filters,scope,page}):null;
      const dom=active.promise.then(fresh=>({fresh,result:null}));
      click(control);
      const outcome=await (ticket?Promise.race([dom,ticket.promise.then(result=>result?{fresh:true,result}:dom)]):dom);
      const fresh=outcome.fresh;if(current!==generation)return;watcher=null;
      for(let attempt=0;fresh&&!identity()&&!requiresLogin()&&current===generation&&attempt<20;attempt++)await new Promise(resolve=>setTimeout(resolve,150));
      if(current!==generation)return;const currentControl=controls();
      if(!fresh||!matches(scope)||!currentControl||!sameInputs(currentControl,filters)||!inventoryFilterReceipt(location.href,filters,page,stamp,newStamp))throw Error('STALE');
      if(outcome.result&&responseReader.current(ticket)){
        active.cancel();receipt=location.href;responseTicket=ticket;
        state={status:outcome.result.rows.length?'found':'not_found',requestId:String(requestId),tenantId:scope,filters,rows:outcome.result.rows,receipt,pagination:outcome.result.pagination,dataSource:'response',responseMs:outcome.result.elapsedMs};
      }else{responseReader.cancel();publish(requestId,filters,scope,currentControl);}
    }catch{if(current===generation){watcher?.cancel();watcher=null;responseReader.cancel();responseTicket=null;state={status:'error',requestId:String(requestId),tenantId:scope};}}})();return true;
  }
  return Object.freeze({version:2,cancel,
    inspect(details=true){const id=identity();if(!id){const required=requiresLogin();if(required)cancel();return {authorized:false,authState:required?'login_required':'checking',tenantId:'',productReady:false,status:'checking'};}
      if(state.tenantId&&state.tenantId!==id)cancel();
      if(state.status==='resolving'&&selected){const sku=flowSkuReceipt(location.href,readCard(),selected.data,state.filters.sku);if(sku)state={...state,status:'selected',row:{...selected.data,sku}};else if(now()>selected.deadline)state={...state,status:'error'};}
      const control=details&&id&&inventoryPage(location.href)?controls():null,account=readDisplayIdentity(id);
      const {pageRows:internalRows,...report}=state;
      return {...report,authorized:true,authState:'authenticated',tenantId:id,username:account.username,tenantName:account.tenantName,productReady:Boolean(control),source:legacyInventoryPage(location.href)?'legacy':'new',store:control?.root.querySelector('.wms-roo-picker-value-list')?.innerText.trim()||''};
    },
    search(requestId,raw,scope){let filters;try{filters=normalizeInventoryFilters(raw);}catch{return false;}if(/^[A-Za-z]{1,3}[0-9]{1,3}$/u.test(filters.loc)&&!legacyInventoryPage(location.href))return false;return execute(requestId,filters,scope,1,c=>c.button.click(),true);},
    resume(requestId,raw,scope,page,expectedReceipt,expectedRows){try{const filters=normalizeInventoryFilters(raw),control=controls();if(!/^\d{1,15}$/u.test(String(requestId))||!matches(scope)||!inventoryPage(location.href)||location.href!==expectedReceipt||!control||!sameInputs(control,filters)||!inventoryFilterReceipt(location.href,filters,page,null,false)||!Array.isArray(expectedRows)||expectedRows.length>500)return false;const rows=readRows(control).map(row=>row.data);if(!rows.length||JSON.stringify(rows.map(row=>[row.name,row.spec,row.store,row.loc]))!==JSON.stringify(expectedRows.map(row=>[row.name,row.spec,row.store,row.loc])))return false;cancel();publish(requestId,filters,scope,control);return true;}catch{return false;}},
    page(requestId,direction,scope){if(!['found','not_found','selected'].includes(state.status)||![-1,1].includes(direction)||!matches(scope)||location.href!==receipt)return false;
      const control=controls(),button=control?.root.querySelector('.wms-ant-pagination-'+(direction===1?'next':'prev')+' button');if(!button||button.disabled)return false;
      return execute(requestId,state.filters,scope,Number(queryOf(location.href).get('current'))+direction,()=>button.click(),false);
    },
    select(requestId,index,scope,selectionId=''){if(!['found','selected'].includes(state.status)||String(requestId)!==state.requestId||!matches(scope)||location.href!==receipt||!Number.isInteger(index)||index<0||index>=state.rows.length||!/^\d{0,15}$/u.test(selectionId))return false;
      if(state.dataSource==='response'){const rows=takeResponseRows(requestId,[index],scope);if(!rows)return false;state={...state,status:'selected',selectionId,row:rows[0],inventoryRetained:true};return true;}
      try{const control=controls();if(!control||!sameInputs(control,state.filters))return false;const rows=readRows(control),row=rows[index];if(JSON.stringify(rows.map(item=>item.data))!==JSON.stringify(state.pageRows))return false;if(!row||JSON.stringify(row.data)!==JSON.stringify(state.rows[index]))return false;
        
        selected={data:row.data,deadline:now()+20000};const {row:previousRow,inventoryRetained:previousRetained,...remaining}=state;state={...remaining,status:'resolving',selectionId};
        const linked=captureInventoryLink(row,state.filters.sku);
        if(linked){const fresh=controls();if(!matches(scope)||location.href!==receipt||!fresh||!sameInputs(fresh,state.filters)||JSON.stringify(readRows(fresh).map(item=>item.data))!==JSON.stringify(state.pageRows))throw Error('STALE');state={...state,status:'selected',row:{...row.data,sku:linked.sku},inventoryRetained:true};}
        return true;
      }catch{return false;}
    },
    takeResponseRows,
    openStores(){if(!identity()||!inventoryPage(location.href))return false;cancel();if(!storeColumns().length)storeToggle()?.click();return true;},
    stores(){if(!identity())return [];return storeColumns().map((column,depth)=>({depth,options:Array.from(column.querySelectorAll('li[role="menuitem"]')).filter(visible).map((e,index)=>({index,key:e.querySelector('input[type="checkbox"]')?.value||'',label:e.innerText.trim(),children:e.classList.contains('wms-roo-picker-cascader-menu-has-children'),checked:Boolean(e.querySelector('input[type="checkbox"]')?.checked)}))}));},
    chooseStore(depth,index,key,label){if(!identity()||!Number.isInteger(depth)||!Number.isInteger(index))return false;const column=storeColumns()[depth],row=column&&Array.from(column.querySelectorAll('li[role="menuitem"]')).filter(visible)[index];
      if(!row||row.innerText.trim()!==label||row.querySelector('input[type="checkbox"]')?.value!==key)return false;cancel();if(row.classList.contains('wms-roo-picker-cascader-menu-has-children'))row.querySelector('i.roo-icon-chevron-right-new')?.click();else row.querySelector('input[type="checkbox"]')?.click();return true;
    },
    scrollStores(depth,direction){if(!identity()||!Number.isInteger(depth)||![-1,1].includes(direction))return false;const holder=storeColumns()[depth]?.querySelector('.rc-virtual-list-holder');if(!holder)return false;holder.scrollBy(0,direction*holder.clientHeight*.8);return true;},
    closeStores(){if(identity())controls()?.inputs.name.click();}
  });
  function takeResponseRows(requestId,indices,scope){
    if(state.dataSource!=='response'||!['found','selected'].includes(state.status)||String(requestId)!==state.requestId||!matches(scope)||location.href!==receipt||!responseReader.current(responseTicket)||!Array.isArray(indices)||!indices.length||indices.length>500||new Set(indices).size!==indices.length)return null;
    const control=controls();if(!control||!sameInputs(control,state.filters)||indices.some(index=>!Number.isInteger(index)||index<0||index>=state.rows.length))return null;
    return indices.map(index=>({...state.rows[index]}));
  }
}
