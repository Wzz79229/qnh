import { ConflictError, GitHubError } from './github.mjs';

export class CloudStore {
  #base;
  #fetch;
  #tenant=null;
  constructor(apiBase,fetchImpl=globalThis.fetch) {
    if(!apiBase)throw new GitHubError('团队自动连接后台尚未配置，请联系管理员完成一次后台授权。','SETUP_REQUIRED');
    const url=new URL(apiBase,globalThis.location?.href || 'https://localhost/');
    if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new GitHubError('团队服务须使用 HTTPS。','INVALID_CONFIG');
    if(url.username||url.password||url.search||url.hash)throw new GitHubError('团队服务地址无效。','INVALID_CONFIG');
    if(typeof fetchImpl!=='function')throw new GitHubError('当前浏览器不支持网络请求，请使用新版手机浏览器。','INVALID_CONFIG');
    this.#base=url.href.replace(/\/$/,'');this.#fetch=fetchImpl.bind(globalThis);
  }
  async #request(route,method='GET',body) {
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),30000);
    try {
      const headers=body?{'Content-Type':'application/json'}:{};
      if(!['session','login','logout'].includes(route)&&this.#tenant)headers['X-QNH-Tenant']=this.#tenant;
      const response=await this.#fetch(`${this.#base}/api/${route}`,{method,credentials:'include',cache:'no-store',redirect:'error',headers,body:body?JSON.stringify(body):undefined,signal:controller.signal});
      if(route.startsWith('photos/')&&response.ok)return await response.blob();
      const data=await response.json().catch(()=>({}));
      if(!response.ok){if(['TENANT_CHANGED','AUTH_REQUIRED'].includes(data.code))this.#tenant=null;if(response.status===409&&!route.startsWith('catalog')&&!route.startsWith('qnh/'))throw new ConflictError();throw new GitHubError(data.message||'团队连接暂时不可用，草稿仍保留在本页。',data.code||'CLOUD_ERROR',response.status);}
      return data;
    } catch(error){if(error instanceof GitHubError)throw error;throw new GitHubError('无法连接团队服务。请保持页面打开，联网后重试，或先备份照片草稿。','NETWORK_ERROR');}
    finally{clearTimeout(timer);}
  }
  async session(){
    this.#tenant=null;
    const result=await this.#request('session');
    if(result.loginMethod==='qnh_browser'&&result.authorized===true&&typeof result.tenantId==='string'&&/^[1-9][0-9]{0,19}$/.test(result.tenantId))this.#tenant=result.tenantId;
    return result;
  }
  login(password){this.#tenant=null;return this.#request('login','POST',{password});}
  logout(){this.#tenant=null;return this.#request('logout','POST',{});}
  read(){return this.#request('state');}
  createSkuQuery(sku){return this.#request('qnh/queries','POST',{sku});}
  skuQuery(id){return this.#request(`qnh/queries/${encodeURIComponent(id)}`);}
  catalog(){return this.#request('catalog');}
  catalogPage(index){
    if(!Number.isSafeInteger(index)||index<0||index>=100)throw new GitHubError('商品库页码无效。','INVALID_CATALOG_PAGE');
    return this.#request(`catalog/pages/${index}`);
  }
  write(data,expectedSha){return this.#request('state','PUT',{data,expectedSha});}
  uploadPhoto(id,imageDataUrl){return this.#request('photos','POST',{id,imageDataUrl});}
  photo(id){return this.#request(`photos/${encodeURIComponent(id)}`);}
}
