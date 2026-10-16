export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>牵牛花管理员连接</title><link rel="stylesheet" href="/admin.css"><script type="module" src="/admin.mjs"></script></head>
<body><main><p class="eyebrow">鲜期 · 管理员工具</p><h1>连接牵牛花</h1>
<p>先验证远程浏览器能否登录牵牛花。仅管理员可操作，每个 UTC 日一次，最多 5 分钟。此页不会自动创建浏览器。</p>
<p>开始后，在远程窗口自行输入牵牛花账号、密码和验证码。当前测试不保存密码或登录凭据，结束后关闭远程浏览器。</p>
<p>完成登录后，在远程窗口进入“商品 → 商品主档”，再点“检查登录状态”。</p>
<div id="status" role="status">尚未开始。登录状态未验证。</div>
<div class="actions"><button id="start" type="button">开始 5 分钟连接测试</button><button id="open" type="button" disabled>打开远程登录窗口</button><button id="check" type="button">检查登录状态</button><button id="stop" type="button" disabled>结束并关闭浏览器</button></div>
<p class="note">看到“商品页已验证”只说明本次浏览器能读取商品主档；商品和图片同步还需另行完成。免费额度按 UTC 日计算，北京时间每天 08:00 重置。</p>
</main></body></html>`;

export const ADMIN_STYLE = `:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#183a2b;background:#f2f7f2}*{box-sizing:border-box}body{margin:0;padding:24px}main{max-width:620px;margin:36px auto;background:#fff;border:1px solid #d7e6db;border-radius:24px;padding:28px}.eyebrow{font-size:13px;font-weight:700;color:#46775d}h1{margin-top:8px}p{line-height:1.75}.actions{display:grid;gap:12px;margin-top:20px}button{font:inherit;min-height:48px;border:1px solid #c2d7c9;border-radius:12px;background:#edf5ef;color:#183a2b;padding:12px;font-weight:650}button:first-child{background:#1d6546;color:white}button:disabled{opacity:.45}#status{background:#f2f7f2;border-radius:12px;padding:18px;line-height:1.65}.note{font-size:13px;color:#5d7164}@media(max-width:500px){body{padding:12px}main{margin:12px auto;padding:20px}}`;

export const ADMIN_SCRIPT = `const status = document.querySelector('#status');
const start = document.querySelector('#start');
const open = document.querySelector('#open');
const check = document.querySelector('#check');
const stop = document.querySelector('#stop');
let expiresAt = 0;
let busy = false;
let closed = true;
let remoteWindow = null;
const labels = { stopped:'远程浏览器已关闭。', needs_login:'等待你在远程窗口完成登录。', login_unverified:'登录状态未验证。', catalog_ready:'商品页已验证，可看到商品主档和 SPU 行。' };
const errors = { DAILY_TEST_USED:'本次 UTC 日的测试已使用。北京时间下一个 08:00 后可重新测试。', ACCESS_REQUIRED:'管理员登录已失效，请刷新页面重新登录。', SETUP_REQUIRED:'管理员连接服务配置未完成。', STOP_PENDING:'正在重试关闭浏览器，请稍后检查状态。', BROWSER_START_FAILED:'浏览器未能启动，登录状态尚未验证。', BROWSER_CHECK_UNAVAILABLE:'暂时无法检查，登录状态尚未验证。', SESSION_OWNED_BY_OTHER_ADMIN:'另一位管理员正在使用连接测试。' };
function buttons(){start.disabled=busy||!closed;open.disabled=busy||closed;check.disabled=busy;stop.disabled=busy||closed;}
function clear(){closed=true;expiresAt=0;if(remoteWindow&&!remoteWindow.closed){remoteWindow.close();}remoteWindow=null;buttons();}
function show(data){if(data.status==='stopped'){clear();}else if(data.expiresAt){closed=false;expiresAt=Date.parse(data.expiresAt);}
status.textContent=errors[data.code]||labels[data.status]||'连接服务暂时不可用。';if(expiresAt){status.textContent+=' 本次测试结束时间：'+new Date(expiresAt).toLocaleTimeString('zh-CN')+'。';}buttons();}
async function api(path,method){const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'X-Qnh-Connector':'1'}});const data=await response.json();show(data);return data;}
async function run(path,method){if(busy)return;busy=true;buttons();try{return await api(path,method);}catch{status.textContent='连接失败，请刷新页面检查管理员登录。';}finally{busy=false;buttons();}}
start.addEventListener('click',()=>run('/session/start','POST'));
check.addEventListener('click',()=>run('/session/status','GET'));
stop.addEventListener('click',async()=>{const data=await run('/session/stop','POST');if(data?.status==='stopped')clear();});
open.addEventListener('click',async()=>{if(busy||closed)return;const popup=window.open('about:blank','_blank');if(popup){popup.opener=null;}const data=await run('/session/live-view','POST');
try{const url=new URL(data?.liveViewUrl);if(url.origin!=='https://live.browser.run'||url.pathname!=='/ui/view'||url.searchParams.get('mode')!=='tab')throw new Error();if(popup){remoteWindow=popup;popup.location.replace(url.href);}else{status.textContent='浏览器阻止了新窗口，请允许弹出窗口后重试。';}}catch{if(popup)popup.close();}});
setInterval(()=>{if(expiresAt&&Date.now()>=expiresAt){clear();status.textContent='本次测试时间已到，服务器将关闭远程浏览器。';}},1000);
// No automatic start, status polling, credential fields, or saved Live View URL.
buttons();`;
