// Display fields only, from the same official header selectors used by the
// working procurement Android app. Never reads login inputs, cookies or storage.
export function readQnhDisplayIdentity(expectedTenant,doc=globalThis.document){
 const empty={username:'',tenantName:''};
 try{const url=new URL(location.href);if(url.origin!=='https://qnh.meituan.com'||!['/','/home.html'].includes(url.pathname)||!/^\d{1,20}$/u.test(expectedTenant))return empty;
  const visible=e=>{if(!e?.getClientRects().length||e.closest?.('[contenteditable],input,textarea'))return false;for(let n=e;n?.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(n.hidden||n.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false;}return true;};
  const bars=Array.from(doc.querySelectorAll('.top-nav-base')).filter(visible);if(bars.length!==1)return empty;const bar=bars[0],values=selector=>[...new Set(Array.from(bar.querySelectorAll(selector)).filter(visible).map(e=>e.innerText.normalize('NFKC').trim()).filter(Boolean))];
  const ids=values('span[class*="SearchLeftTenantId--"]');if(ids.length!==1||/^\(租户ID:\s*([1-9][0-9]{0,19})\)$/u.exec(ids[0])?.[1]!==expectedTenant)return empty;
  const safe=value=>value.length<=100&&!/[\x00-\x1f\x7f]/u.test(value),users=values('a[class*="TopNavSearchRightTenant--"] > span'),names=values('[class*="SearchLeftName--"]');
  const username=users.length===1&&safe(users[0])&&!/登录|注册|退出/u.test(users[0])?users[0]:'';
  let tenantName='';if(names.length===1){const full=/^(.*?)\s*\(租户ID:\s*(\d+)\)$/u.exec(names[0]);if(full?.[2]===expectedTenant)tenantName=full[1].trim();else if(!full&&!/租户ID/u.test(names[0]))tenantName=names[0];}if(!safe(tenantName))tenantName='';
  return {username,tenantName};
 }catch{return empty;}
}
