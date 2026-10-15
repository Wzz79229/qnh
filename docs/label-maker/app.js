import {renderLabel,encodePng,parseProductText,parseScreenshotText,mergeProductSources} from './label.js';
import {saveLabelImage,shareLabelImage,openLabelImage,capabilities,cleanup} from './save-image.js';

const $=id=>document.getElementById(id);
const fieldNames={name:'商品名称',spec:'规格',sku:'完整 SKU',loc:'库位'};
let png=null,filename='',hasPreview=false,generating=false,revision=0;
let imageFile=null,thumbnailUrl=null,controller=null;
function status(text){$('save-status').textContent=text;}
function enableSave(enabled){
  for(const id of ['download','open-image','share-image'])$(id).disabled=!enabled;
  const supported=capabilities().fileShare;
  $('share-image').hidden=!supported;
  document.querySelector('.save-alternatives span').hidden=!supported;
}
function showError(text){$('form-error').textContent=text;$('form-error').hidden=false;}
function markDirty(){
  revision++;controller?.abort();png=null;enableSave(false);
  $('form-error').hidden=true;$('image-fallback').hidden=true;$('recognized-info').hidden=true;
  $('preview-state').textContent=hasPreview?'需要重新生成':'等待生成';
  $('preview-state').classList.remove('ready');$('dirty-overlay').hidden=!hasPreview;
  $('render-warning').hidden=true;status('识别生成后即可保存，用标签打印 App 打印。');
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
  $('attachment').hidden=false;markDirty();
}
$('product-text').addEventListener('input',markDirty);
$('add-image').onclick=()=>$('image-file').click();
$('image-file').onchange=()=>attachImage($('image-file').files[0]);
$('remove-image').onclick=removeImage;
$('clear-input').onclick=()=>{$('product-text').value='';removeImage();$('product-text').focus();};
$('product-text').addEventListener('paste',event=>{
  const file=[...(event.clipboardData?.files||[])].find(item=>item.type.startsWith('image/'));
  if(!file)return;
  event.preventDefault();const text=event.clipboardData.getData('text/plain');
  if(text)$('product-text').setRangeText(text,$('product-text').selectionStart,$('product-text').selectionEnd,'end');
  attachImage(file);
});
for(const type of ['dragenter','dragover'])$('composer').addEventListener(type,event=>{event.preventDefault();$('composer').classList.add('dragging');});
$('composer').addEventListener('dragleave',event=>{if(!$('composer').contains(event.relatedTarget))$('composer').classList.remove('dragging');});
$('composer').addEventListener('drop',event=>{event.preventDefault();$('composer').classList.remove('dragging');const file=[...(event.dataTransfer?.files||[])].find(item=>item.type.startsWith('image/'));if(file)attachImage(file);else{const text=event.dataTransfer?.getData('text/plain');if(text){$('product-text').value+=($('product-text').value?'\n':'')+text;markDirty();}}});
function showSummary(record,ocrText){
  const summary=$('record-summary');summary.replaceChildren();
  for(const key of ['name','spec','sku','loc']){
    const row=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');
    dt.textContent=fieldNames[key];dd.textContent=record[key]||(key==='spec'?'未提供':'待补充');
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
$('cancel-recognition').onclick=()=>controller?.abort();
$('product-form').addEventListener('submit',async event=>{
  event.preventDefault();if(generating)return;
  const text=$('product-text').value.trim(),file=imageFile;
  if(!text&&!file){showError('请在这个输入区粘贴整段商品文字，或添加库存截图。');$('product-text').focus();return;}
  $('form-error').hidden=true;generating=true;controller=new AbortController();
  const signal=controller.signal,expectedRevision=revision;
  png=null;enableSave(false);$('generate').disabled=true;$('generate').querySelector('span').textContent='正在识别…';
  $('recognition-progress').hidden=!file;$('progress-bar').value=0;
  let ocrText='';
  try{
    const textResult=parseProductText(text);
    if(file){
      const {recognizeScreenshot}=await import('./ocr.js');
      const recognized=await recognizeScreenshot(file,{signal,onProgress:info=>{if(expectedRevision!==revision)return;$('progress-text').textContent=info.status||'正在识别截图…';$('progress-bar').value=Math.min(1,Math.max(0,Number(info.progress)||0));}});
      ocrText=recognized.text||'';
    }
    if(signal.aborted||revision!==expectedRevision)return;
    const imageResult=ocrText?parseScreenshotText(ocrText):{};
    const record=mergeProductSources(textResult,imageResult);
    showSummary(record,ocrText);
    const missing=['name','sku','loc'].filter(key=>!record[key]);
    if(missing.length)throw Error('还缺少'+missing.map(key=>fieldNames[key]).join('、')+'。请在上方整段文字中补充后重新生成，例如“SKU：完整编号；库位：C11-1-5”。');
    if(document.fonts?.ready)await document.fonts.ready;
    const result=renderLabel(record),blob=await encodePng(result.canvas);
    if(signal.aborted||revision!==expectedRevision)return;
    $('label-paper').querySelector('canvas')?.remove();
    result.canvas.setAttribute('role','img');result.canvas.setAttribute('aria-label',`库位${record.loc}，SKU末六位${record.sku.slice(-6)}的标签`);
    $('label-paper').prepend(result.canvas);$('empty-preview').hidden=true;$('dirty-overlay').hidden=true;
    png=blob;filename=`库位标签_${record.loc.replace(/[\\/:*?"<>|\s]/g,'_')}_SKU${record.sku.slice(-6).replace(/[\\/:*?"<>|\s]/g,'_')}_80x60mm.png`;
    hasPreview=true;enableSave(true);$('preview-state').textContent='已生成';$('preview-state').classList.add('ready');
    $('render-warning').textContent=result.warnings.join('；');$('render-warning').hidden=!result.warnings.length;
    status('图片已准备好，请核对识别结果后保存。');
    if(window.matchMedia('(max-width:650px)').matches)$('preview-title').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
  }catch(error){
    if(error.name==='AbortError'||signal.aborted){status('识别已取消，可以修改内容后重试。');return;}
    $('preview-state').textContent='请检查内容';$('dirty-overlay').hidden=!hasPreview;
    showError(error.message||'识别或生成失败，请检查文字和截图后重试。');
  }finally{
    generating=false;controller=null;$('generate').disabled=false;
    $('generate').querySelector('span').textContent='识别并生成标签';$('recognition-progress').hidden=true;
  }
});
$('download').onclick=()=>{if(!png)return;const result=saveLabelImage(png,filename);status(result.status==='download-requested'?'已发起图片下载。如未保存，可点“打开原图”长按保存。':result.message);};
$('open-image').onclick=()=>{if(!png)return;const result=openLabelImage(png);if(result.status==='blocked'&&result.url){$('image-fallback').href=result.url;$('image-fallback').hidden=false;status('浏览器阻止了新窗口，请点下方链接打开原图。');}else status(result.status==='opened'?'原图已打开，手机上可长按图片保存。':result.message);};
$('share-image').onclick=()=>{if(!png)return;shareLabelImage(png,filename).then(result=>status(result.status==='shared'?'已完成系统分享操作。':result.status==='cancelled'?'已取消分享，图片仍可下载或打开。':result.message));};
window.addEventListener('pagehide',event=>{if(!event.persisted){cleanup();if(thumbnailUrl)URL.revokeObjectURL(thumbnailUrl);controller?.abort();}});
enableSave(false);
