const visible=e=>Boolean(e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none');
export function officialLoginState(doc=document){
 const inputs=Array.from(doc.querySelectorAll('input')).filter(visible);
 const field=inputs.find(e=>e.type==='password'||e.type==='tel'||/账号|手机号|手机号码|验证码/u.test(e.getAttribute('placeholder')||'')||e.autocomplete==='username');
 const methods=Array.from(doc.querySelectorAll('button,a,[role="tab"]')).some(e=>visible(e)&&/^(?:账号|密码|短信|扫码|验证码)登录$/u.test((e.innerText||'').trim()));
 const frame=Array.from(doc.querySelectorAll('iframe')).find(e=>visible(e)&&/login|passport|qrcode/iu.test(e.getAttribute('src')||''));
 return {login:Boolean(field||methods||frame),field,frame};
}
export function installLoginPresentation(){
 const u=new URL(location.href);if(u.protocol!=='https:'||!['meituan.com','dianping.com','sankuai.com'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))return;
 if(window.__kuguanLoginView)return;
 let cover=null,scheduled=false,seen=false,lastCard=null;
 const ensure=()=>{if(!cover){cover=document.createElement('div');cover.id='kuguan-login-transition';cover.setAttribute('role','status');cover.style.cssText='position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;flex-direction:column;background:#f3f6f5;color:#173d38;font:16px sans-serif;padding:24px;box-sizing:border-box;text-align:center;';cover.innerHTML='<div style="font-size:28px;font-weight:700;margin-bottom:18px">库管</div><div data-status>正在连接牵牛花…</div>';document.documentElement.appendChild(cover);}else if(!cover.isConnected)document.documentElement.appendChild(cover);};
 function fit(field,frame){let viewport=document.querySelector('meta[name="viewport"]');if(!viewport){viewport=document.createElement('meta');viewport.name='viewport';(document.head||document.documentElement).appendChild(viewport);}viewport.content='width=device-width, initial-scale=1, user-scalable=yes';
  if(frame){if(frame.style.maxWidth!=='100%')frame.style.maxWidth='100%';if(frame.style.width!=='100%')frame.style.width='100%';}
  if(!field||lastCard?.isConnected&&lastCard.contains(field))return;let card=field.parentElement;for(let p=field.parentElement;p&&p!==document.body;p=p.parentElement){const r=p.getBoundingClientRect();if(r.width>=240&&r.width<=720&&r.height>=120){card=p;if(r.height>=260)break;}}
  if(!card||card===lastCard)return;lastCard=card;
  for(let p=card;p;p=p.parentElement){p.style.minWidth='0';p.style.maxWidth='100%';p.style.boxSizing='border-box';if(p===card||p===document.body||p.getBoundingClientRect().width>innerWidth){p.style.width='100%';p.style.left='auto';p.style.right='auto';p.style.transform='none';p.style.position='relative';p.style.marginLeft='auto';p.style.marginRight='auto';}if(p===document.body)break;}
  card.style.cssText+=';float:none;width:calc(100% - 32px);max-width:440px;min-width:0;left:auto;right:auto;top:auto;margin:20px auto;box-sizing:border-box;';
  for(const e of card.querySelectorAll('input,button,form')){e.style.maxWidth='100%';e.style.boxSizing='border-box';}
  requestAnimationFrame(()=>{if(officialLoginState().login)card.scrollIntoView({block:'start'});});
 }
 function inspect(){ensure();const value=officialLoginState();seen=seen||value.login;const shown=value.login?'none':'flex';if(cover.style.display!==shown)cover.style.display=shown;const title=seen?'登录完成，正在进入库管…':'正在连接牵牛花…';if(cover.querySelector('[data-status]').textContent!==title)cover.querySelector('[data-status]').textContent=title;if(value.login)fit(value.field,value.frame);return {stage:value.login?'login':seen?'transition':'loading',documentUrl:location.href};}
 const observer=new MutationObserver(records=>{if(records.every(r=>cover&&(r.target===cover||cover.contains(r.target))))return;if(!scheduled){scheduled=true;queueMicrotask(()=>{scheduled=false;inspect();});}});
 observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','type']});
 Object.defineProperty(window,'__kuguanLoginView',{value:Object.freeze({inspect}),configurable:true});inspect();
}
