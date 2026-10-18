import test from 'node:test';
import assert from 'node:assert/strict';
import {readQnhDisplayIdentity} from '../qnh-display-identity.mjs';
function fixture(t){
 const keys=['location','getComputedStyle'],saved=keys.map(k=>Object.getOwnPropertyDescriptor(globalThis,k));t.after(()=>keys.forEach((k,i)=>saved[i]?Object.defineProperty(globalThis,k,saved[i]):delete globalThis[k]));
 globalThis.location={href:'https://qnh.meituan.com/home.html#/co-wms/non-erp/stock-query'};globalThis.getComputedStyle=e=>({display:'block',visibility:'visible',opacity:'1',...e.style});
 const node=text=>({innerText:text,nodeType:1,parentElement:null,getClientRects:()=>[{}],getAttribute:()=>'',closest:()=>null});
 const state={id:[node('（租户ID:777）')],names:[node('合成企业（租户ID:777）')],users:[node('合成操作员')]};
 const bar={...node(''),querySelectorAll:s=>s.startsWith('span[')?state.id:s.startsWith('a[')?state.users:state.names};
 const doc={querySelectorAll:s=>s==='.top-nav-base'?[bar]:[]};return {doc,state,node};
}
test('display identity reads only the matching official top bar without credentials',t=>{const h=fixture(t);for(const n of [...h.state.id,...h.state.names,...h.state.users])Object.defineProperty(n,'value',{get(){throw Error('Credential field accessed');}});assert.deepEqual(readQnhDisplayIdentity('777',h.doc),{username:'合成操作员',tenantName:'合成企业'});assert.deepEqual(readQnhDisplayIdentity('888',h.doc),{username:'',tenantName:''});});
test('missing, conflicting, editable and hidden account nodes are never reused',t=>{const h=fixture(t);h.state.users.push(h.node('另一个账号'));assert.equal(readQnhDisplayIdentity('777',h.doc).username,'');h.state.users=[h.node('退出登录')];assert.equal(readQnhDisplayIdentity('777',h.doc).username,'');h.state.users=[h.node('旧账号')];h.state.users[0].style={display:'none'};assert.equal(readQnhDisplayIdentity('777',h.doc).username,'');h.state.users[0].style={};h.state.users[0].closest=()=>({});assert.equal(readQnhDisplayIdentity('777',h.doc).username,'');});
test('account changes and tenant switches are reflected from the current page without a cache',t=>{const h=fixture(t);assert.equal(readQnhDisplayIdentity('777',h.doc).username,'合成操作员');h.state.users=[h.node('新操作员')];assert.equal(readQnhDisplayIdentity('777',h.doc).username,'新操作员');h.state.id=[h.node('（租户ID:888）')];assert.deepEqual(readQnhDisplayIdentity('777',h.doc),{username:'',tenantName:''});globalThis.location.href='https://attacker.invalid/';assert.deepEqual(readQnhDisplayIdentity('888',h.doc),{username:'',tenantName:''});});
