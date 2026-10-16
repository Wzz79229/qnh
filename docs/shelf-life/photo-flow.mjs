import { recognizePhotos } from './ocr.mjs';
import { parsePackagingText } from './photo-parser.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const unitLabel={day:'天',month:'个月',year:'年'};
const optionalBarcodeIssue=issue=>issue.startsWith('识别到多个有效条码');

/** Add a confirmed catalog name without inventing or changing any packaging date. */
export function applyCatalogProduct(parsed,product) {
  if(!parsed)return null;
  if(!product)return {...parsed,issues:[...parsed.issues]};
  const issues=parsed.issues.filter(issue=>!issue.startsWith('未识别到明确标注的商品名称'));
  if(parsed.barcode&&product.barcodes.length&&!product.barcodes.includes(parsed.barcode))issues.push('包装条码与所选商品不一致，请核对图片、规格并重新选择商品，或取消关联后重拍。');
  return {...parsed,name:product.name,issues,complete:Boolean(parsed.expiryDate&&issues.every(optionalBarcodeIssue))};
}

function productHTML(product,compact=false) {
  return `<span class="catalog-thumb">${product.imageUrl?`<img data-catalog-image src="${escape(product.imageUrl)}" alt="${escape(product.name)}" referrerpolicy="no-referrer" decoding="async">`:''}<span class="catalog-image-label">${product.imageUrl?'图片未加载':'暂无图片'}</span></span><div><strong>${escape(product.name)}</strong><span>${escape(product.spec||'未提供规格')}</span>${compact?'':`<small>SKU ${escape(product.sku)}</small>`}</div>`;
}

/** Packaging dates remain OCR-only; an explicitly selected catalog product can supply its name. */
export function openPhotoFlow({onSave,existingRecord=null,canSync=false,selectedProduct=null,resolveProduct}) {
  const dialog=document.querySelector('#record-dialog');
  let files=[],urls=[],rawResult=null,result=null,previews=[],recognizedText='',controller=null,working=false,errorMessage='';
  let selected=selectedProduct,candidates=[],matchingMessage=selected?'已选择商品，请核对规格；生产日期和保质期仍从包装照片识别。':'';
  let live=true;
  const release=()=>{live=false;controller?.abort();for(const url of urls)URL.revokeObjectURL(url);urls=[];};
  const effectiveResult=()=>applyCatalogProduct(rawResult,selected);
  const render=()=>{
    result=effectiveResult();
    dialog.innerHTML=`<div class="dialog-heading"><div><h2>${existingRecord?'补拍并重新识别':'拍照建立商品批次'}</h2><p>${selected?'已选定商品，拍清生产日期和保质期':'拍清商品名称、生产日期和保质期'}，最多 3 张。</p></div><button class="icon-button" id="photo-close" aria-label="关闭">×</button></div><div class="dialog-body">${selected?`<div class="selected-catalog-product">${productHTML(selected)}<button class="text-button" id="photo-unlink" ${working?'disabled':''}>取消关联</button></div>`:''}<div class="photo-guide"><b>${selected?'① 核对已选商品　② 拍日期与保质期':'① 商品名称　② 日期与保质期'}</b><p>${selected?'商品名称和规格来自已选牵牛花快照，包装日期不会由商品库推断。':'可分开拍摄。标签文字尽量占满画面，避开反光。'}</p></div><div class="photo-thumbnails">${urls.map((url,i)=>`<div><img src="${url}" alt="待识别包装照片 ${i+1}"><button data-remove-photo="${i}" aria-label="移除第 ${i+1} 张照片" ${working?'disabled':''}>×</button></div>`).join('')}</div><label class="camera-picker ${working||files.length>=3?'disabled':''}"><span>＋ ${files.length?'补拍一张':'拍商品包装'}</span><small>也可以从手机相册选择清晰照片</small><input id="packaging-photo-input" type="file" accept="image/*" capture="environment" ${working||files.length>=3?'disabled':''}></label><div id="photo-progress" class="photo-progress" role="status" aria-live="polite"></div>${matchingMessage?`<p class="catalog-match-note">${escape(matchingMessage)}</p>`:''}${candidates.length?`<div class="catalog-candidates"><h3>请核对后选择商品</h3>${candidates.map((product,index)=>`<button class="catalog-candidate" data-product-candidate="${index}" ${working?'disabled':''}>${productHTML(product,true)}<span class="catalog-candidate-select">选择此商品</span></button>`).join('')}</div>`:''}<div id="photo-recognition">${result?`<div class="photo-result"><h3>${result.complete?'请核对识别结果':'还需要补拍或选择商品'}</h3><dl><dt>商品名称</dt><dd>${escape(result.name||'尚未识别')}${selected?'<small class="cell-secondary">来自已确认的商品快照</small>':''}</dd>${selected?`<dt>规格</dt><dd>${escape(selected.spec||'未提供规格')}</dd>`:''}<dt>生产日期</dt><dd>${escape(result.productionDate||'未标明')}</dd><dt>保质期</dt><dd>${result.shelfLife?`${result.shelfLife} ${unitLabel[result.shelfUnit]}`:'未标明'}</dd><dt>到期日期</dt><dd>${escape(result.expiryDate||'无法确定')}</dd></dl>${result.issues.length?`<div class="notice warning"><p>${result.issues.map(escape).join('<br>')}</p></div>`:''}<details><summary>查看包装识别文字</summary><pre>${escape(recognizedText)}</pre></details></div>`:''}</div><div id="photo-error" class="form-error" role="alert">${escape(errorMessage)}</div><div class="form-actions"><button class="button" id="photo-cancel">取消</button><button class="button soft" id="photo-recognize" ${!files.length||working?'disabled':''}>${working?'正在处理…':'识别包装信息'}</button><button class="button primary" id="photo-save" ${!result?.complete||working?'disabled':''}>${canSync?'确认并保存':'确认，暂存本页'}</button></div><p class="form-note">每次确认建立一个拍照批次，系统不推断实际库存数量。请核对包装日期和商品规格；不完整时请补拍。</p></div>`;
    const q=s=>dialog.querySelector(s);
    q('#photo-close').onclick=q('#photo-cancel').onclick=()=>dialog.close();
    if(selected)q('#photo-unlink').onclick=()=>{if(working)return;candidates=[selected,...candidates.filter(product=>product.sku!==selected.sku)];selected=null;matchingMessage='已取消关联。可明确选择商品，或在包装信息完整时按包装照片建档。';render();};
    for(const button of dialog.querySelectorAll('[data-product-candidate]'))button.onclick=()=>{if(working)return;const product=candidates[Number(button.dataset.productCandidate)];if(!product)return;selected=product;matchingMessage='已由你确认关联商品，请再次核对规格和包装日期。';render();};
    q('#packaging-photo-input').onchange=event=>{
      if(working)return;const file=event.target.files?.[0];if(!file)return;
      if(!file.type.startsWith('image/')||file.size>10*1024*1024){q('#photo-error').textContent='请选择不超过 10 MB 的商品照片。';return;}
      files.push(file);urls.push(URL.createObjectURL(file));rawResult=null;previews=[];recognizedText='';render();
    };
    for(const button of dialog.querySelectorAll('[data-remove-photo]'))button.onclick=()=>{if(working)return;const i=Number(button.dataset.removePhoto);URL.revokeObjectURL(urls[i]);files.splice(i,1);urls.splice(i,1);rawResult=null;previews=[];recognizedText='';render();};
    q('#photo-recognize').onclick=async()=>{
      if(working||!files.length)return;errorMessage='';working=true;controller=new AbortController();render();
      try{
        const recognized=await recognizePhotos(files,{signal:controller.signal,onProgress:progress=>{if(live&&dialog.open)q('#photo-progress').textContent=`${progress.status||'正在识别'} · ${Math.round((progress.progress||0)*100)}%`;}});
        if(!live||!dialog.open||controller.signal.aborted)return;
        previews=recognized.previews;recognizedText=recognized.text;rawResult=parsePackagingText(recognized.text);
        if(resolveProduct&&(!selected||(rawResult.barcode&&selected.barcodes.length&&!selected.barcodes.includes(rawResult.barcode)))){
          q('#photo-progress').textContent='正在核对牵牛花商品快照…';
          const match=await resolveProduct(rawResult);
          if(!live||!dialog.open||controller.signal.aborted)return;
          candidates=match?.candidates||[];matchingMessage=match?.message||'';
          if(!selected&&match?.product)selected=match.product;
          else if(selected&&match?.product&&match.product.sku!==selected.sku){candidates=[match.product,...candidates.filter(product=>product.sku!==match.product.sku)];matchingMessage='包装条码对应另一个商品，请核对图片和规格后明确选择。';}
        }
        working=false;render();
      }catch(error){if(!live||!dialog.open)return;working=false;errorMessage=error.name==='AbortError'?'识别已取消，请重新拍摄。':error.message;render();}
    };
    q('#photo-save').onclick=async()=>{
      if(!result?.complete||working)return;const savedResult=result;errorMessage='';working=true;render();
      try{const saved=await onSave({parsed:savedResult,previews,existingRecord,selectedProduct:selected});if(live&&dialog.open&&saved!==false)dialog.close();}
      catch(error){if(live&&dialog.open)errorMessage=error.message;}
      finally{working=false;if(live&&dialog.open)render();}
    };
  };
  const finish=()=>{release();dialog.removeEventListener('close',finish);};
  dialog.addEventListener('close',finish);render();dialog.showModal();
}
