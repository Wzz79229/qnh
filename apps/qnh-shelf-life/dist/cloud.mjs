import { ConflictError, GitHubError } from './github.mjs';

export class CloudStore {
  #base;
  #fetch;
  constructor(apiBase,fetchImpl=globalThis.fetch) {
    if(!apiBase)throw new GitHubError('团队自动连接后台尚未配置，请联系管理员完成一次后台授权。','SETUP_REQUIRED');
    const url=new URL(apiBase,globalThis.location?.href || 'https://localhost/');
    if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new GitHubError('团队服务须使用 HTTPS。','INVALID_CONFIG');
    if(url.username||url.password||url.search||url.hash)throw new GitHubError('团队服务地址无效。','INVALID_CONFIG');
    this.#base=url.href.replace(/\/$/,'');this.#fetch=fetchImpl;
  }
  async #request(route,method='GET',body) {
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),30000);
    try {
      const response=await this.#fetch(`${this.#base}/api/${route}`,{method,credentials:'include',cache:'no-store',redirect:'error',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:controller.signal});
      if(route.startsWith('photos/')&&response.ok)return await response.blob();
      const data=await response.json().catch(()=>({}));
      if(!response.ok){if(response.status===409)throw new ConflictError();throw new GitHubError(data.message||'团队连接暂时不可用，照片和草稿仍保留在本页。',data.code||'CLOUD_ERROR',response.status);}
      return data;
    } catch(error){if(error instanceof GitHubError)throw error;throw new GitHubError('无法连接团队服务。请保持页面打开，联网后重试，或先备份照片草稿。','NETWORK_ERROR');}
    finally{clearTimeout(timer);}
  }
  session(){return this.#request('session');}
  login(password){return this.#request('login','POST',{password});}
  logout(){return this.#request('logout','POST',{});}
  read(){return this.#request('state');}
  write(data,expectedSha){return this.#request('state','PUT',{data,expectedSha});}
  uploadPhoto(id,imageDataUrl){return this.#request('photos','POST',{id,imageDataUrl});}
  photo(id){return this.#request(`photos/${encodeURIComponent(id)}`);}
}
