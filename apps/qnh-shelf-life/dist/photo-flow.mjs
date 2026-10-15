import { recognizePhotos } from './ocr.mjs';
import { parsePackagingText } from './photo-parser.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const unitLabel={day:'天',month:'个月',year:'年'};

/** Packaging data is read-only: uncertain values can only be replaced by another photograph. */
export function openPhotoFlow({onSave,existingRecord=null,canSync=false}) {
  const dialog=document.querySelector('#record-dialog');
  let files=[],urls=[],result=null,previews=[],controller=null,working=false;
  const release=()=>{controller?.abort();for(const url of urls)URL.revokeObjectURL(url);urls=[];};
  const render=()=>{
    dialog.innerHTML=`<div class="dialog-heading"><div><h2>${existingRecord?'补拍并重新识别':'拍照建立商品批次'}</h2><p>拍清商品名称、生产日期和保质期，最多 3 张。</p></div><button class="icon-button" id="photo-close" aria-label="关闭">×</button></div><div class="dialog-body"><div class="photo-guide"><b>① 商品名称　② 日期与保质期</b><p>可分开拍摄。标签文字尽量占满画面，避开反光。</p></div><div class="photo-thumbnails">${urls.map((url,i)=>`<div><img src="${url}" alt="待识别包装照片 ${i+1}"><button data-remove-photo="${i}" aria-label="移除第 ${i+1} 张照片" ${working?'disabled':''}>×</button></div>`).join('')}</div><label class="camera-picker ${working||files.length>=3?'disabled':''}"><span>＋ ${files.length?'补拍一张':'拍商品包装'}</span><small>也可以从手机相册选择清晰照片</small><input id="packaging-photo-input" type="file" accept="image/*" capture="environment" ${working||files.length>=3?'disabled':''}></label><div id="photo-progress" class="photo-progress" role="status" aria-live="polite"></div><div id="photo-recognition"></div><div id="photo-error" class="form-error" role="alert"></div><div class="form-actions"><button class="button" id="photo-cancel">取消</button><button class="button soft" id="photo-recognize" ${!files.length||working?'disabled':''}>${working?'正在识别…':'识别包装信息'}</button><button class="button primary" id="photo-save" ${!result?.complete||working?'disabled':''}>确认并保存</button></div><p class="form-note">每次确认建立一个拍照批次，系统不推断实际库存数量。识别结果须与包装核对；不完整时请补拍。</p></div>`;
    const q=s=>dialog.querySelector(s);
    q('#photo-close').onclick=q('#photo-cancel').onclick=()=>dialog.close();
    q('#packaging-photo-input').onchange=event=>{
      const file=event.target.files?.[0];if(!file)return;
      if(!file.type.startsWith('image/')||file.size>10*1024*1024){q('#photo-error').textContent='请选择不超过 10 MB 的商品照片。';return;}
      files.push(file);urls.push(URL.createObjectURL(file));result=null;previews=[];render();
    };
    for(const button of dialog.querySelectorAll('[data-remove-photo]'))button.onclick=()=>{const i=Number(button.dataset.removePhoto);URL.revokeObjectURL(urls[i]);files.splice(i,1);urls.splice(i,1);result=null;previews=[];render();};
    q('#photo-recognize').onclick=async()=>{
      if(working||!files.length)return;working=true;controller=new AbortController();render();
      try{
        const recognized=await recognizePhotos(files,{signal:controller.signal,onProgress:progress=>{if(dialog.open)q('#photo-progress').textContent=`${progress.status||'正在识别'} · ${Math.round((progress.progress||0)*100)}%`;}});
        if(!dialog.open||controller.signal.aborted)return;
        previews=recognized.previews;result=parsePackagingText(recognized.text);working=false;render();
        q('#photo-recognition').innerHTML=`<div class="photo-result"><h3>${result.complete?'请核对识别结果':'还需要补拍'}</h3><dl><dt>商品名称</dt><dd>${escape(result.name||'尚未识别')}</dd><dt>生产日期</dt><dd>${escape(result.productionDate||'未标明')}</dd><dt>保质期</dt><dd>${result.shelfLife?`${result.shelfLife} ${unitLabel[result.shelfUnit]}`:'未标明'}</dd><dt>到期日期</dt><dd>${escape(result.expiryDate||'无法确定')}</dd></dl>${result.issues.length?`<div class="notice warning"><p>${result.issues.map(escape).join('<br>')}</p></div>`:''}<details><summary>查看识别文字</summary><pre>${escape(recognized.text)}</pre></details></div>`;
      }catch(error){if(!dialog.open)return;working=false;render();q('#photo-error').textContent=error.name==='AbortError'?'识别已取消，请重新拍摄。':error.message;}
    };
    q('#photo-save').textContent=canSync?'确认并保存':'确认，暂存本页';
    q('#photo-save').onclick=async()=>{
      if(!result?.complete||working)return;working=true;q('#photo-save').disabled=true;
      try{const saved=await onSave({parsed:result,previews,existingRecord});if(saved!==false)dialog.close();}
      catch(error){q('#photo-error').textContent=error.message;}
      finally{working=false;if(dialog.open)q('#photo-save').disabled=!result?.complete;}
    };
  };
  const finish=()=>{release();dialog.removeEventListener('close',finish);};
  dialog.addEventListener('close',finish);render();dialog.showModal();
}
