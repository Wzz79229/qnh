import { recognizePhotos } from './ocr.mjs';
import { parsePackagingText } from './photo-parser.mjs';
import { calculateExpiry, parseDate, todayISO } from './core.mjs';

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

/** Quantity is an employee count, never an OCR value or packaging net content. */
export function validateBatchQuantity(value) {
  const text=typeof value==='string'?value.trim():value;
  const quantity=typeof text==='string'&&/^\d+$/.test(text)?Number(text):typeof text==='number'?text:NaN;
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>1_000_000)throw new TypeError('请填写清点件数，须为 1 至 1000000 的整数。');
  return quantity;
}

/** Require both packaging inputs and recalculate expiry independently of OCR's expiry. */
export function dateBatchResult(parsed,product,{today=todayISO()}={}) {
  if(!parsed)return null;
  const {quantity:_ignoredQuantity,barcode:_ignoredBarcode,name:_ignoredName,...packaging}=parsed;
  const issues=(Array.isArray(parsed.issues)?parsed.issues:[]).filter(issue=>typeof issue==='string'
    &&!issue.startsWith('未识别到明确标注的商品名称')&&!issue.startsWith('识别到多个不同的商品名称')&&!issue.includes('条码'));
  const add=message=>{if(!issues.includes(message))issues.push(message);};
  const selected=product&&typeof product.sku==='string'&&product.sku.trim()
    &&typeof product.name==='string'&&product.name.trim();
  if(!selected)add('请先扫描 SKU 并查询牵牛花商品，再拍摄生产日期和保质期。');
  const productionDate=typeof parsed.productionDate==='string'?parseDate(parsed.productionDate):null;
  const current=parseDate(today);
  if(!current)throw new TypeError('今天的日期无效');
  if(!productionDate)add('未识别到完整生产日期，请连同“生产日期”标签补拍。');
  else if(productionDate>current)add('识别到的生产日期晚于今天，请核对包装并重新拍照。');
  const hasShelf=Number.isSafeInteger(parsed.shelfLife)&&parsed.shelfLife>0;
  const hasUnit=['day','month','year'].includes(parsed.shelfUnit);
  if(!hasShelf||!hasUnit)add('未识别到完整保质期，请补拍正整数保质期数值及天、月或年单位。');
  let expiryDate='';
  if(productionDate&&hasShelf&&hasUnit){
    try{expiryDate=calculateExpiry(productionDate,parsed.shelfLife,parsed.shelfUnit);}
    catch{add('生产日期与保质期计算的到期日期超出支持范围，请重新拍照。');}
  }
  const explicitExpiryDate=typeof parsed.expiryDate==='string'&&parsed.expiryDate?parseDate(parsed.expiryDate):null;
  if(parsed.expiryDate&&!explicitExpiryDate)add('识别到的到期日期无效，请补拍完整日期。');
  if(expiryDate&&explicitExpiryDate&&explicitExpiryDate!==expiryDate){
    add(`包装到期日期 ${explicitExpiryDate} 与生产日期加保质期计算的 ${expiryDate} 不一致，请补拍核对；当前不能保存。`);
  }
  return {...packaging,name:selected?product.name:'',barcode:'',productionDate:productionDate||'',expiryDate,
    explicitExpiryDate:Array.isArray(parsed.evidence?.expiryDate)&&parsed.evidence.expiryDate.length?explicitExpiryDate||'':'',
    issues,complete:Boolean(selected&&expiryDate&&issues.every(optionalBarcodeIssue))};
}

function productHTML(product,compact=false) {
  return `<span class="catalog-thumb">${product.imageUrl?`<img data-catalog-image src="${escape(product.imageUrl)}" alt="${escape(product.name)}" referrerpolicy="no-referrer" decoding="async">`:''}<span class="catalog-image-label">${product.imageUrl?'图片未加载':'暂无图片'}</span></span><div><strong>${escape(product.name)}</strong><span>${escape(product.spec||'未提供规格')}</span>${compact?'':`<small>SKU ${escape(product.sku)}</small>`}</div>`;
}

/** Packaging dates remain OCR-only; an explicitly selected catalog product can supply its name. */
export function openPhotoFlow({onSave,existingRecord=null,canSync=false,selectedProduct=null,resolveProduct,dateOnly=true,requireProduct=true,recognize=recognizePhotos}) {
  const dialog=document.querySelector('#record-dialog');
  let files=[],urls=[],rawResult=null,result=null,previews=[],recognizedText='',controller=null,working=false,errorMessage='';
  let selected=selectedProduct,candidates=[],matchingMessage=selected?'已选择商品，请核对规格；生产日期和保质期仍从包装照片识别。':'';
  let quantityText='';
  if(existingRecord){try{quantityText=String(validateBatchQuantity(existingRecord.quantity));}catch{}}
  let live=true;
  const clearPhotographs=()=>{for(const url of urls)URL.revokeObjectURL(url);urls=[];files=[];previews=[];};
  const clearRecognition=()=>{rawResult=null;result=null;previews=[];recognizedText='';errorMessage='';};
  const release=()=>{live=false;controller?.abort();clearPhotographs();clearRecognition();quantityText='';dialog.innerHTML='';};
  const effectiveResult=()=>dateOnly?dateBatchResult(rawResult,selected):applyCatalogProduct(rawResult,selected);
  const validQuantity=()=>{try{return validateBatchQuantity(quantityText);}catch{return null;}};
  const render=()=>{
    result=effectiveResult();
    const needsProduct=(dateOnly||requireProduct)&&!selected;
    const cameraDisabled=working||files.length>=3||needsProduct;
    dialog.innerHTML=`<div class="dialog-heading"><div><h2>${existingRecord?'补拍并重新识别':'拍照建立商品批次'}</h2><p>${dateOnly?'拍清生产日期和保质期，最多 3 张。':'拍清商品名称、生产日期和保质期，最多 3 张。'}</p></div><button class="icon-button" id="photo-close" aria-label="关闭">×</button></div>
      <div class="dialog-body">${selected?`<div class="selected-catalog-product">${productHTML(selected)}${!dateOnly&&!requireProduct?`<button class="text-button" id="photo-unlink" ${working?'disabled':''}>取消关联</button>`:''}</div>`:''}
      <div class="photo-guide"><b>${selected?'① 核对 SKU、图片和规格　② 拍日期与保质期　③ 清点件数':'请先扫描 SKU 并查询牵牛花商品'}</b><p>${selected?'商品信息来自本次牵牛花查询。照片只用于本机识别，不会上传或保存。':'查询并确认商品后才能建立批次。'}</p></div>
      <div class="photo-thumbnails">${urls.map((url,i)=>`<div><img src="${url}" alt="临时日期照片 ${i+1}"><button data-remove-photo="${i}" aria-label="移除第 ${i+1} 张照片" ${working?'disabled':''}>×</button></div>`).join('')}</div>
      <label class="camera-picker ${cameraDisabled?'disabled':''}"><span>＋ ${files.length?'补拍一张':'拍生产日期和保质期'}</span><small>也可以从手机相册选择清晰照片</small><input id="packaging-photo-input" type="file" accept="image/*" capture="environment" ${cameraDisabled?'disabled':''}></label>
      <div id="photo-progress" class="photo-progress" role="status" aria-live="polite"></div>${matchingMessage?`<p class="catalog-match-note">${escape(matchingMessage)}</p>`:''}
      ${!dateOnly&&candidates.length?`<div class="catalog-candidates"><h3>请核对后选择商品</h3>${candidates.map((product,index)=>`<button class="catalog-candidate" data-product-candidate="${index}" ${working?'disabled':''}>${productHTML(product,true)}<span class="catalog-candidate-select">选择此商品</span></button>`).join('')}</div>`:''}
      <div id="photo-recognition">${result?`<div class="photo-result"><h3>${result.complete?'请核对日期并填写清点件数':'信息不完整，请补拍核对'}</h3><dl><dt>商品名称</dt><dd>${escape(result.name||'尚未识别')}</dd>${selected?`<dt>规格</dt><dd>${escape(selected.spec||'未提供规格')}</dd>`:''}<dt>生产日期</dt><dd>${escape(result.productionDate||'未标明')}</dd><dt>保质期</dt><dd>${result.shelfLife?`${escape(result.shelfLife)} ${unitLabel[result.shelfUnit]||'单位缺失'}`:'未标明'}</dd><dt>${dateOnly?'计算到期日期':'到期日期'}</dt><dd>${escape(result.expiryDate||'无法确定')}</dd></dl>${result.issues.length?`<div class="notice warning"><p>${result.issues.map(escape).join('<br>')}</p></div>`:''}<details><summary>查看本次识别文字</summary><pre>${escape(recognizedText)}</pre></details></div>`:''}</div>
      <label class="field"><span>该生产日期的清点件数（必填）</span><input id="batch-quantity" type="number" inputmode="numeric" min="1" max="1000000" step="1" value="${escape(quantityText)}" placeholder="请输入员工实际清点件数" required ${working?'disabled':''}></label><p class="form-note">件数必须由员工清点填写，不从净含量或照片推断。</p>
      <div id="photo-error" class="form-error" role="alert">${escape(errorMessage)}</div><div class="form-actions"><button class="button" id="photo-cancel">取消</button><button class="button soft" id="photo-recognize" ${!files.length||working||needsProduct?'disabled':''}>${working?'正在处理…':'识别日期和保质期'}</button><button class="button primary" id="photo-save" ${!result?.complete||working||!validQuantity()||needsProduct?'disabled':''}>${canSync?'确认并保存':'确认，暂存本页'}</button></div><p class="form-note">日期结果只能核对，缺失或冲突时请补拍。确认后只保存商品、日期、保质期和清点件数，临时照片随即清除。</p></div>`;
    const q=s=>dialog.querySelector(s);
    q('#photo-close').onclick=q('#photo-cancel').onclick=()=>dialog.close();
    if(q('#photo-unlink'))q('#photo-unlink').onclick=()=>{if(working)return;candidates=[selected,...candidates.filter(product=>product.sku!==selected.sku)];selected=null;matchingMessage='已取消关联。请重新确认商品。';render();};
    q('#batch-quantity').oninput=event=>{quantityText=event.target.value;errorMessage='';q('#photo-error').textContent='';q('#photo-save').disabled=!result?.complete||working||!validQuantity()||needsProduct;};
    q('#batch-quantity').onblur=()=>{if(quantityText&&!validQuantity())q('#photo-error').textContent='清点件数须为 1 至 1000000 的整数。';};
    for(const button of dialog.querySelectorAll('[data-product-candidate]'))button.onclick=()=>{if(working)return;const product=candidates[Number(button.dataset.productCandidate)];if(!product)return;selected=product;matchingMessage='已由你确认关联商品，请再次核对规格和包装日期。';render();};
    q('#packaging-photo-input').onchange=event=>{
      if(working||needsProduct||files.length>=3)return;const file=event.target.files?.[0];if(!file)return;
      if(!file.type.startsWith('image/')||file.size>10*1024*1024){q('#photo-error').textContent='请选择不超过 10 MB 的商品照片。';return;}
      clearRecognition();files.push(file);urls.push(URL.createObjectURL(file));render();
    };
    for(const button of dialog.querySelectorAll('[data-remove-photo]'))button.onclick=()=>{if(working)return;const i=Number(button.dataset.removePhoto);URL.revokeObjectURL(urls[i]);files.splice(i,1);urls.splice(i,1);clearRecognition();render();};
    q('#photo-recognize').onclick=async()=>{
      if(working||!files.length||needsProduct)return;clearRecognition();working=true;controller=new AbortController();render();
      try{
        const recognized=await recognize(files,{signal:controller.signal,onProgress:progress=>{if(live&&dialog.open)q('#photo-progress').textContent=`${progress.status||'正在识别'} · ${Math.round((progress.progress||0)*100)}%`;}});
        if(!live||!dialog.open||controller.signal.aborted)return;
        previews=[];recognizedText=recognized.text;rawResult=parsePackagingText(recognized.text);
        if(Array.isArray(recognized.previews))recognized.previews.length=0;
        if(!dateOnly&&resolveProduct&&(!selected||(rawResult.barcode&&selected.barcodes.length&&!selected.barcodes.includes(rawResult.barcode)))){
          q('#photo-progress').textContent='正在核对牵牛花商品…';
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
      if(!result?.complete||working||needsProduct)return;let quantity;try{quantity=validateBatchQuantity(quantityText);}catch(error){errorMessage=error.message;render();return;}const savedResult=result;errorMessage='';working=true;clearPhotographs();render();
      try{const saved=await onSave({parsed:savedResult,previews:[],quantity,existingRecord,selectedProduct:selected});if(live&&dialog.open&&saved!==false)dialog.close();}
      catch(error){if(live&&dialog.open)errorMessage=error.message;}
      finally{working=false;if(live&&dialog.open)render();}
    };
  };
  const finish=()=>{release();dialog.removeEventListener('close',finish);};
  dialog.addEventListener('close',finish);render();dialog.showModal();
}
