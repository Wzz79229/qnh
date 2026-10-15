import {renderLabel,encodePng,parseProductText,parseScreenshotText,mergeProductSources} from './label.js?v=20261015-8';
import {prepareLabelImage,saveLabelImage,shareLabelImage,capabilities,cleanup} from './save-image.js?v=20261015-2';
import {ensureAssetCache} from './asset-cache.js?v=20261015-7';

void ensureAssetCache();

const $=id=>document.getElementById(id);
const fieldNames={name:'商品名称',spec:'规格',sku:'完整 SKU',loc:'库位'};
let png=null,preparedImage=null,filename='',hasPreview=false,generating=false,revision=0;
let imageFile=null,thumbnailUrl=null,controller=null;
const recognitionCache=new WeakMap();
let saveFocus=null;
let recognitionRuntime=null,autoTimer=null,autoQueued=false,autoSubmitting=false;
let preloadTask=null;
function loadRecognitionRuntime(){
  if(!recognitionRuntime)recognitionRuntime=import('./ocr.js?v=20261015-8').catch(error=>{recognitionRuntime=null;throw error;});
  return recognitionRuntime;
}
function warmRecognition(){
  try{const known=mergeProductSources(parseProductText($('product-text').value.trim()),{});if(!known.name||!(known.spec||known.specExplicitEmpty)||!/^\d{10,64}$/.test(known.sku)||known.loc)return;}catch{return;}
  // All numeric SKU/location screenshots share the same coding engine, so
  // prepare it while the image picker is open and reuse it across products.
  void loadRecognitionRuntime().then(module=>module.warmupRecognition({mode:'location'})).catch(()=>{});
}
function preloadRecognition(){
  if(preloadTask)return preloadTask;
  $('retry-resources').hidden=true;$('resource-progress').hidden=false;
  $('resource-status').textContent='正在提前准备图片识别资源…';
  preloadTask=loadRecognitionRuntime().then(module=>module.preloadRecognitionResources({onProgress:info=>{
    if($('resource-status').textContent!==info.status)$('resource-status').textContent=info.status;
    $('resource-progress').value=info.progress;
  }})).then(result=>{
    if(result.fullReady){$('resource-status').textContent='图片识别资源和中文字库已准备';$('resource-progress').hidden=true;}
    else{$('resource-status').textContent=result.codesReady?'常用识别已准备，完整字库尚未准备完成。':'识别资源尚未准备完成，可以继续输入或稍后重试。';$('retry-resources').hidden=false;$('resource-progress').hidden=true;}
  }).catch(()=>{
    $('resource-status').textContent='提前加载尚未完成，可稍后重试；生成时也会继续尝试。';
    $('retry-resources').hidden=false;$('resource-progress').hidden=true;
  }).finally(()=>{preloadTask=null;});
  return preloadTask;
}
$('retry-resources').onclick=preloadRecognition;
void preloadRecognition();
function queueAutoGeneration(){
  clearTimeout(autoTimer);autoQueued=false;
  if(!imageFile)return;
  let known;
  try{known=mergeProductSources(parseProductText($('product-text').value.trim()),{});}catch{return;}
  if(!known.name||!(known.spec||known.specExplicitEmpty)||!/^\d{10,64}$/.test(known.sku))return;
  autoQueued=true;
  if(generating)return;
  const expectedRevision=revision;
  autoTimer=setTimeout(()=>{
    if(!autoQueued||generating||!imageFile||revision!==expectedRevision)return;
    autoQueued=false;autoSubmitting=true;
    $('product-form').requestSubmit();autoSubmitting=false;
  },300);
}
function status(text){$('save-status').textContent=text;$('sheet-status').textContent=text;}
function enableSave(enabled){
  for(const id of ['download','open-image','share-image'])$(id).disabled=!enabled;
  const supported=capabilities().fileShare;
  $('share-image').hidden=!supported;
  $('sheet-share').hidden=!supported;
  document.querySelector('.save-alternatives span').hidden=!supported;
}
function closeSaveSheet(){
  if($('save-sheet').hidden)return;
  $('save-sheet').hidden=true;document.body.classList.remove('save-sheet-open');
  document.querySelector('main').inert=false;document.querySelector('.site-header').inert=false;
  saveFocus?.focus();saveFocus=null;
}
function showSaveSheet(){
  if(!png||!preparedImage)return;
  saveFocus=document.activeElement;
  $('save-sheet-image').src=preparedImage.imageUrl;
  $('sheet-download').href=preparedImage.downloadUrl;
  $('sheet-download').download=preparedImage.filename;
  $('sheet-download').hidden=capabilities().saveMode!=='download';
  $('save-sheet-hint').textContent=capabilities().saveMode==='download'?'可下载 PNG 文件，也可右键原图另存为。':'长按下面的原图，选择保存图片。';
  $('save-sheet').hidden=false;document.body.classList.add('save-sheet-open');
  document.querySelector('main').inert=true;document.querySelector('.site-header').inert=true;
  $('close-save-sheet').focus();
}
$('close-save-sheet').onclick=closeSaveSheet;
$('save-sheet').onclick=event=>{if(event.target===$('save-sheet'))closeSaveSheet();};
document.addEventListener('keydown',event=>{
  if($('save-sheet').hidden)return;
  if(event.key==='Escape')closeSaveSheet();
  if(event.key==='Tab'){
    const buttons=[...$('save-sheet').querySelectorAll('button:not([hidden]),a[href]:not([hidden])')];
    const first=buttons[0],last=buttons[buttons.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
});
function showError(text){$('form-error').textContent=text;$('form-error').hidden=false;}
function markDirty(){
  clearTimeout(autoTimer);autoQueued=false;
  revision++;controller?.abort();closeSaveSheet();png=null;preparedImage=null;enableSave(false);
  $('save-sheet-image').removeAttribute('src');$('sheet-download').removeAttribute('href');
  $('form-error').hidden=true;$('image-fallback').hidden=true;$('recognized-info').hidden=true;
  $('preview-state').textContent=hasPreview?'需要重新生成':'等待生成';
  $('preview-state').classList.remove('ready');$('dirty-overlay').hidden=!hasPreview;
  $('render-warning').hidden=true;status('识别生成后即可保存，用标签打印 App 打印。');
  if(imageFile)$('image-readiness').textContent='文字信息齐全后自动识别';
}
function removeImage(){
  if(thumbnailUrl)URL.revokeObjectURL(thumbnailUrl);
  thumbnailUrl=null;imageFile=null;$('image-file').value='';
  $('attachment').hidden=true;$('image-thumb').removeAttribute('src');markDirty();
}
function attachImage(file){
  if(!file)return;
  if(!/^image\/(png|jpe?g|webp)$/i.test(file.type)){showError('请添加 PNG、JPG 或 WebP 格式的截图。');return;}
  if(file.size>15*1024*1024){showError('截图超过 15MB，请压缩或重新截图后添加。');return;}
  if(thumbnailUrl)URL.revokeObjectURL(thumbnailUrl);
  imageFile=file;thumbnailUrl=URL.createObjectURL(file);
  $('image-thumb').src=thumbnailUrl;$('image-name').textContent=file.name||'粘贴的截图';
  $('attachment').hidden=false;markDirty();warmRecognition();queueAutoGeneration();
}
$('product-text').addEventListener('input',()=>{markDirty();if(imageFile)warmRecognition();queueAutoGeneration();});
$('add-image').onclick=()=>{warmRecognition();$('image-file').click();};
$('image-file').onchange=()=>attachImage($('image-file').files[0]);
$('remove-image').onclick=removeImage;
function clearAll(){
  $('product-text').value='';removeImage();cleanup();
  hasPreview=false;filename='';
  $('label-paper').querySelectorAll('canvas').forEach(canvas=>canvas.remove());
  $('empty-preview').hidden=false;$('dirty-overlay').hidden=true;
  $('preview-state').textContent='等待生成';$('preview-state').classList.remove('ready');
  $('record-summary').replaceChildren();$('ocr-text').textContent='';
  $('recognition-note').textContent='';$('image-name').textContent='';
  $('form-error').textContent='';$('render-warning').textContent='';$('image-fallback').removeAttribute('href');
  $('recognition-progress').hidden=true;$('progress-bar').value=0;
  status('已清空文字和截图，可以放入下一件商品。');
  $('product-text').focus();
}
$('clear-input').onclick=clearAll;
$('clear-all').onclick=clearAll;
$('product-text').addEventListener('paste',event=>{
  const file=[...(event.clipboardData?.files||[])].find(item=>item.type.startsWith('image/'));
  if(!file)return;
  event.preventDefault();const text=event.clipboardData.getData('text/plain');
  if(text){
    $('product-text').setRangeText(text,$('product-text').selectionStart,$('product-text').selectionEnd,'end');
    markDirty();
  }
  attachImage(file);
});
for(const type of ['dragenter','dragover'])$('composer').addEventListener(type,event=>{event.preventDefault();$('composer').classList.add('dragging');});
$('composer').addEventListener('dragleave',event=>{if(!$('composer').contains(event.relatedTarget))$('composer').classList.remove('dragging');});
$('composer').addEventListener('drop',event=>{event.preventDefault();$('composer').classList.remove('dragging');const file=[...(event.dataTransfer?.files||[])].find(item=>item.type.startsWith('image/'));if(file)attachImage(file);else{const text=event.dataTransfer?.getData('text/plain');if(text){$('product-text').value+=($('product-text').value?'\n':'')+text;markDirty();queueAutoGeneration();}}});
function showSummary(record,ocrText){
  const summary=$('record-summary');summary.replaceChildren();
  for(const key of ['name','spec','sku','loc']){
    const row=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');
    dt.textContent=fieldNames[key];dd.textContent=record[key]||(key==='spec'&&record.specExplicitEmpty?'无规格':key==='spec'?'未提供':'待补充');
    if(!record[key]&&key!=='spec')dd.classList.add('missing');
    if(record.sources?.[key]){const source=document.createElement('small');source.textContent=record.sources[key]==='text'?'文字':'图片';dt.append(source);}
    row.append(dt,dd);summary.append(row);
  }
  $('recognized-info').hidden=false;
  $('recognition-note').textContent=[...new Set(record.warnings||[])].join('；');
  $('recognition-note').hidden=!(record.warnings||[]).length;
  $('ocr-details').hidden=!ocrText;$('ocr-text').textContent=ocrText||'';
}
$('example').onclick=()=>{
  removeImage();$('product-text').value='商品名称：示例商品 饮用纯净水；规格：500ml/瓶；SKU：0001234567890123456；库位：A01-1-1';
  markDirty();$('product-form').requestSubmit();
};
$('cancel-recognition').onclick=()=>{clearTimeout(autoTimer);autoQueued=false;controller?.abort();};
$('product-form').addEventListener('submit',async event=>{
  event.preventDefault();if(generating)return;
  clearTimeout(autoTimer);autoQueued=false;const automatic=autoSubmitting;
  const text=$('product-text').value.trim(),file=imageFile;
  if(!text&&!file){showError('请在这个输入区粘贴整段商品文字，或添加库存截图。');$('product-text').focus();return;}
  $('form-error').hidden=true;generating=true;controller=new AbortController();
  const signal=controller.signal,expectedRevision=revision;
  png=null;enableSave(false);$('generate').disabled=true;$('generate').querySelector('span').textContent='正在识别…';
  $('recognition-progress').hidden=!file;$('progress-bar').value=0;
  if(file)$('image-readiness').textContent='正在读取截图…';
  let ocrText='',recognitionMessage='';
  try{
    const textResult=parseProductText(text);
    const known=mergeProductSources(textResult,{});
    if(file){
      if(known.name&&known.sku&&(known.spec||known.specExplicitEmpty)&&known.loc){
        recognitionMessage='文字信息已完整，直接生成标签。';
      }else{
        const mode=known.name&&known.sku&&(known.spec||known.specExplicitEmpty)?'location':'full';
        const cacheKey=JSON.stringify([mode,known.sku||known.name,known.sku?'':known.spec]);
        const cache=recognitionCache.get(file);
        let cachedText=cache?.get(cacheKey);
        if(cachedText===undefined&&cache){
          const imageText=mode==='location'
            ? cache.get('image-full')??cache.get('image-cards')
            : cache.get('image-full-language')==='full'?cache.get('image-full'):undefined;
          // A previous English pass may not contain readable evidence for a
          // different product. Retry OCR for that target instead of reusing a
          // failed association; exact-context failures still remain cached.
          if(imageText!==undefined){
            const candidate=mode==='location'&&/^\d{10,64}$/.test(known.sku)
              ? (await loadRecognitionRuntime()).validateKnownSkuText(imageText,known.sku,parseScreenshotText)
              : parseScreenshotText(imageText,{product:known});
            if(candidate&&!candidate.matchError&&(!(known.sku||known.name)||candidate.matchedBy))cachedText=candidate.ocrText||imageText;
          }
        }
        if(cachedText!==undefined){
          ocrText=cachedText;recognitionMessage='已复用这张截图的识别结果，无需再次等待。';
        }else{
          $('progress-text').textContent=mode==='location'?'正在从截图读取库位…':'正在识别截图…';
          const started=performance.now();
          const {recognizeScreenshot}=await loadRecognitionRuntime();
          const recognized=await recognizeScreenshot(file,{mode,product:known,signal,onProgress:info=>{if(expectedRevision!==revision)return;$('progress-text').textContent=info.status||'正在识别截图…';$('progress-bar').value=Math.min(1,Math.max(0,Number(info.progress)||0));}});
          ocrText=recognized.text||'';
          if(!signal.aborted&&revision===expectedRevision){
            const nextCache=cache||new Map();nextCache.set(cacheKey,ocrText);
            if(recognized.scope==='image'){
              nextCache.set('image-full',ocrText);nextCache.set('image-full-language',recognized.language);
            }
            if(recognized.scope==='cards')nextCache.set('image-cards',ocrText);
            recognitionCache.set(file,nextCache);
          }
          recognitionMessage=`图片识别用时 ${((performance.now()-started)/1000).toFixed(1)} 秒。`;
        }
      }
    }
    if(signal.aborted||revision!==expectedRevision)return;
    const imageResult=ocrText?parseScreenshotText(ocrText,{product:known}):{};
    const record=mergeProductSources(textResult,imageResult);
    showSummary(record,ocrText);
    if(imageResult.matchError&&!known.loc)throw Error(imageResult.matchError);
    if(ocrText&&!known.loc&&(known.sku||known.name)&&!imageResult.matchedBy)throw Error('未能在截图中确认与文字对应的商品，未选取库位。请使用包含该商品名称和 SKU 的清晰截图。');
    const missing=['name','sku','loc'].filter(key=>!record[key]);
    if(missing.length)throw Error('还缺少'+missing.map(key=>fieldNames[key]).join('、')+'。请在上方整段文字中补充后重新生成，例如“SKU：完整编号；库位：C11-1-5”。');
    if(document.fonts?.ready)await document.fonts.ready;
    const result=renderLabel(record),blob=await encodePng(result.canvas);
    const nextFilename=`库位标签_${record.loc.replace(/[\\/:*?"<>|\s]/g,'_')}_SKU${record.sku.slice(-6).replace(/[\\/:*?"<>|\s]/g,'_')}_80x60mm.png`;
    const nextImage=await prepareLabelImage(blob,nextFilename);
    if(signal.aborted||revision!==expectedRevision)return;
    $('label-paper').querySelector('canvas')?.remove();
    result.canvas.setAttribute('role','img');result.canvas.setAttribute('aria-label',`库位${record.loc}，SKU末六位${record.sku.slice(-6)}的标签`);
    $('label-paper').prepend(result.canvas);$('empty-preview').hidden=true;$('dirty-overlay').hidden=true;
    png=blob;filename=nextFilename;preparedImage=nextImage;
    hasPreview=true;enableSave(true);$('preview-state').textContent='已生成';$('preview-state').classList.add('ready');
    $('render-warning').textContent=result.warnings.join('；');$('render-warning').hidden=!result.warnings.length;
    status(recognitionMessage+'图片已准备好，请核对识别结果后保存。');
    if(file)$('image-readiness').textContent='已识别，标签可以保存';
    if(window.matchMedia('(max-width:650px)').matches&&(!automatic||document.activeElement!==$('product-text')))$('preview-title').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
  }catch(error){
    if(expectedRevision!==revision)return;
    if(error.name==='AbortError'||signal.aborted){status('识别已取消，可以修改内容后重试。');if(imageFile)$('image-readiness').textContent='等待识别';return;}
    $('preview-state').textContent='请检查内容';$('dirty-overlay').hidden=!hasPreview;
    showError(error.message||'识别或生成失败，请检查文字和截图后重试。');
    if(imageFile)$('image-readiness').textContent='请检查下方识别提示';
  }finally{
    generating=false;controller=null;$('generate').disabled=false;
    $('generate').querySelector('span').textContent='识别并生成标签';$('recognition-progress').hidden=true;
    if(autoQueued)queueAutoGeneration();
  }
});
function shareImage(){if(!png)return;shareLabelImage(png,filename).then(result=>status(result.status==='shared'?'已完成系统分享操作。':result.status==='cancelled'?'已取消分享，仍可长按原图保存。':result.message));}
$('download').onclick=()=>{
  if(!png)return;showSaveSheet();
  if(capabilities().saveMode!=='download'){
    status('请长按面板中的原图保存，或点击“系统保存 / 分享”。');return;
  }
  const result=saveLabelImage(png,filename);
  status(result.status==='download-requested'?'已发起 PNG 下载；如浏览器未保存，请在弹出的面板里长按原图。':result.message);
};
$('open-image').onclick=showSaveSheet;
$('share-image').onclick=shareImage;
$('sheet-share').onclick=shareImage;
window.addEventListener('pagehide',event=>{if(!event.persisted){clearTimeout(autoTimer);autoQueued=false;cleanup();if(thumbnailUrl)URL.revokeObjectURL(thumbnailUrl);controller?.abort();if(recognitionRuntime)void recognitionRuntime.then(module=>module.releaseRecognition()).catch(()=>{});}});
enableSave(false);
