import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {officialLoginState} from '../login-presentation.mjs';
const element=(props={})=>({type:'text',autocomplete:'',getClientRects:()=>[{}],getAttribute:()=>'',...props});
function state(inputs=[],buttons=[],frames=[]){return officialLoginState({querySelectorAll:s=>s==='input'?inputs:s==='iframe'?frames:buttons});}
test('official login presentation recognizes password and SMS forms without reading credentials',t=>{const original=globalThis.getComputedStyle;globalThis.getComputedStyle=()=>({visibility:'visible',display:'block'});t.after(()=>original?globalThis.getComputedStyle=original:delete globalThis.getComputedStyle);for(const input of [element({type:'password'}),element({type:'tel'}),element({getAttribute:()=> '验证码'})]){Object.defineProperty(input,'value',{get(){throw Error('Credentials were read');}});assert.equal(state([input]).login,true);}assert.equal(state([element({type:'search'})]).login,false);assert.equal(state([element({type:'password',getClientRects:()=>[]})]).login,false);assert.equal(state([],[element({innerText:'短信登录'})]).login,true);assert.equal(state([],[],[element({getAttribute:()=> 'https://passport.meituan.com/login'})]).login,true);});
test('login layout bundle refuses unrelated sites and contains no session extraction',async()=>{const result=await build({entryPoints:[fileURLToPath(new URL('../login-entry.mjs',import.meta.url))],bundle:true,write:false,format:'iife',target:'chrome80'}),script=result.outputFiles[0].text;vm.runInNewContext(script,{window:{},URL,location:{href:'https://unrelated.invalid/login'}});assert.doesNotMatch(script,/document\.cookie|localStorage|sessionStorage|\.value\b|fetch\(/);});
