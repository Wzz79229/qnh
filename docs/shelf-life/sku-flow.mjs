import { normalizeSku } from './sku-query.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let zxingLoad;
function decoderLibrary() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  if (!zxingLoad) zxingLoad = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = './vendor/zxing/index.min.js';
    const fail=()=>{clearTimeout(timer);script.remove();zxingLoad=null;reject(new Error('扫码组件无法加载，请联网后重试。'));};
    const timer=setTimeout(fail,15000);
    script.onload = () => {clearTimeout(timer);if(window.ZXing)resolve(window.ZXing);else fail();};
    script.onerror = fail;
    document.head.append(script);
  });
  return zxingLoad;
}

export function openSkuFlow({ lookup, onProduct, initialSku = '' }) {
  const dialog = document.querySelector('#record-dialog');
  let live = true, working = false, reader = null, cameraStarting = false, cameraRun = 0, controller = null, found = null;
  const temporaryUrls=new Set();
  dialog.innerHTML = `<div class="dialog-heading"><div><h2>扫描 SKU 查询商品</h2><p>实时查询牵牛花，再拍生产日期和保质期。</p></div><button class="icon-button" id="sku-close" aria-label="关闭">×</button></div><div class="dialog-body"><div class="sku-camera" hidden><video id="sku-video" playsinline muted></video><span>将 SKU 条码放入画面</span></div><div class="action-row"><button class="button primary" id="sku-camera-start">打开相机扫码</button><label class="button soft">拍摄 SKU 码<input id="sku-photo" type="file" accept="image/*" capture="environment" hidden></label></div><label class="field"><span>扫描的 SKU</span><input id="sku-value" type="text" maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false" value="${escape(initialSku)}" placeholder="也支持扫描枪输入或粘贴 SKU"></label><p class="form-note">请扫描牵牛花 SKU 码。普通商品条码不一定是 SKU，不会混用。</p><div id="sku-status" role="status" aria-live="polite"></div><div id="sku-error" class="form-error" role="alert"></div><div id="sku-product"></div><div class="form-actions"><button class="button" id="sku-cancel">取消</button><button class="button primary" id="sku-query">查询牵牛花</button><button class="button primary" id="sku-next" hidden>确认商品，拍日期</button></div><p class="form-note">查询时请保持此手机的牵牛花登录有效，失效后请重新登录。扫描和包装照片都不会上传或保存。</p></div>`;
  const q = s => dialog.querySelector(s);
  const releaseVideo = video => { video?.srcObject?.getTracks().forEach(t=>t.stop());if(video)video.srcObject=null; };
  const stopCamera = () => { cameraRun++;cameraStarting=false;reader?.reset();reader=null;releaseVideo(q('#sku-video'));const box=q('.sku-camera');if(box)box.hidden=true; };
  const close = () => dialog.close();
  const clearResult = () => { found=null; q('#sku-product').textContent=''; q('#sku-next').hidden=true; };
  const acceptScan = value => { if(!live||working)return; try { q('#sku-value').value=normalizeSku(value); clearResult(); stopCamera(); q('#sku-status').textContent='已扫描 SKU，请点击查询。'; q('#sku-error').textContent=''; } catch(error) { q('#sku-error').textContent=error.message; } };
  const setWorking = value => { working=value; for(const id of ['#sku-query','#sku-camera-start','#sku-photo','#sku-value'])q(id).disabled=value; };
  q('#sku-close').onclick=q('#sku-cancel').onclick=close;
  q('#sku-value').oninput=clearResult;
  q('#sku-camera-start').onclick=async()=>{
    if(working||cameraStarting)return;stopCamera();const run=++cameraRun;cameraStarting=true;q('#sku-error').textContent='';let scanReader,video;
    try { const ZXing=await decoderLibrary();if(!live||working||run!==cameraRun)return;scanReader=new ZXing.BrowserMultiFormatReader();reader=scanReader;video=q('#sku-video');q('.sku-camera').hidden=false;await scanReader.decodeFromConstraints({video:{facingMode:{ideal:'environment'}},audio:false},video,result=>{if(result&&run===cameraRun)acceptScan(result.getText());});if(!live||working||run!==cameraRun){scanReader.reset();releaseVideo(video);} }
    catch(error){if(live&&run===cameraRun){stopCamera();q('#sku-error').textContent=error.name==='NotAllowedError'?'相机未获授权，可使用“拍摄 SKU 码”或扫描枪输入。':'相机暂不可用，请使用“拍摄 SKU 码”。';}else{scanReader?.reset();releaseVideo(video);}}
    finally{if(run===cameraRun)cameraStarting=false;}
  };
  q('#sku-photo').onchange=async event=>{
    const file=event.target.files?.[0]; event.target.value=''; if(!file||working)return;
    if(!file.type.startsWith('image/')||file.size>10*1024*1024){q('#sku-error').textContent='请选择不超过 10 MB 的清晰 SKU 照片。';return;}
    stopCamera();const url=URL.createObjectURL(file);temporaryUrls.add(url);setWorking(true);q('#sku-status').textContent='正在本机识别 SKU 码…';
    try{const ZXing=await decoderLibrary();if(!live)return;const imageReader=new ZXing.BrowserMultiFormatReader();try{const result=await imageReader.decodeFromImageUrl(url);if(live){setWorking(false);acceptScan(result.getText());}}finally{imageReader.reset();}}
    catch(error){if(live){q('#sku-error').textContent='未识别到完整 SKU 码，请靠近拍摄，避免反光。';q('#sku-status').textContent='';}}
    finally{URL.revokeObjectURL(url);temporaryUrls.delete(url);if(live)setWorking(false);}
  };
  q('#sku-query').onclick=async()=>{
    if(working)return;clearResult();q('#sku-error').textContent='';let sku;
    try{sku=normalizeSku(q('#sku-value').value);}catch(error){q('#sku-error').textContent=error.message;return;}
    stopCamera();setWorking(true);controller=new AbortController();q('#sku-status').textContent='正在提交 SKU 查询…';
    try{const product=await lookup(sku,{signal:controller.signal,onProgress:message=>{if(live)q('#sku-status').textContent=message;}});if(!live)return;found=product;q('#sku-status').textContent='已从牵牛花查回此 SKU，请核对商品。';q('#sku-product').innerHTML=`<div class="selected-catalog-product"><span class="catalog-thumb">${product.imageUrl?`<img data-catalog-image src="${escape(product.imageUrl)}" alt="${escape(product.name)}" referrerpolicy="no-referrer">`:'<span class="catalog-image-label">牵牛花未提供图片</span>'}</span><div><strong>${escape(product.name)}</strong><span>${escape(product.spec||'未提供规格')}</span><small>SKU ${escape(product.sku)}</small></div></div>`;q('#sku-next').hidden=false;}
    catch(error){if(live&&error.name!=='AbortError'){q('#sku-error').textContent=error.message;q('#sku-status').textContent='';}}
    finally{if(live)setWorking(false);}
  };
  q('#sku-next').onclick=()=>{if(!found||working)return;const product=found;dialog.addEventListener('close',()=>queueMicrotask(()=>onProduct(product)),{once:true});dialog.close();};
  const finish=()=>{live=false;controller?.abort();stopCamera();for(const url of temporaryUrls)URL.revokeObjectURL(url);temporaryUrls.clear();found=null;dialog.innerHTML='';dialog.removeEventListener('close',finish);};
  dialog.addEventListener('close',finish);dialog.showModal();
}
