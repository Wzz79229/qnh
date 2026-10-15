/** Research prototype: local known-SKU metadata OCR, no product OCR or upload. */
const CODE = /^[A-Z]{1,4}\d{1,4}(?:-[A-Z0-9]{1,4}){2,4}$/;
const THRESHOLD = 170;
function groups(values, min, gap = 1) {
  const out = [];
  for (let p = 0; p < values.length; p++) {
    if (values[p] < min) continue;
    const last = out[out.length - 1];
    if (!last || p > last.end + gap + 1) out.push({start:p,end:p});
    else last.end = p;
  }
  return out;
}
function binary(image, rect, threshold=THRESHOLD) {
  const values = new Uint8Array(rect.width * rect.height);
  for (let y=0;y<rect.height;y++) for (let x=0;x<rect.width;x++) {
    const i=((rect.y+y)*image.width+rect.x+x)*4;
    values[y*rect.width+x] = (image.data[i]+image.data[i+1]+image.data[i+2])/3 < threshold ? 1 : 0;
  }
  return {values, width:rect.width, height:rect.height};
}
function lines(image, rect, threshold=THRESHOLD) {
  const b = binary(image,rect,threshold), rows = new Uint16Array(rect.height);
  for (let y=0;y<b.height;y++) for (let x=0;x<b.width;x++) rows[y]+=b.values[y*b.width+x];
  return groups(rows,Math.max(2,Math.round(rect.width*.003)),1)
    .filter(r=>r.end-r.start>image.width*.008)
    .map(r=>({x:rect.x,y:rect.y+r.start,width:rect.width,height:r.end-r.start+1}));
}
function hasLongAsciiRun(image,rect,threshold=THRESHOLD) {
  const b=binary(image,rect,threshold),columns=new Uint16Array(b.width);
  for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++)columns[x]+=b.values[y*b.width+x];
  let count=0,previous;
  for(const column of groups(columns,1,0)) {
    let y0=b.height,y1=-1;
    for(let y=0;y<b.height;y++)for(let x=column.start;x<=column.end;x++)if(b.values[y*b.width+x]) {y0=Math.min(y0,y);y1=Math.max(y1,y);}
    const height=y1-y0+1,width=column.end-column.start+1;
    const tall=height>=b.height*.68 && width/height>=.12 && width/height<=.85;
    const joined=!previous||column.start-previous.end<=b.height*.55;
    count=tall?(joined?count+1:1):0;
    // The parser permits 3+7, 4+6, and 5+5 visible partial-SKU halves. Every
    // accepted length has at least one half of five digits, never six.
    if(count>=5)return true;
    previous=column;
  }
  return false;
}
function blueBadges(image) {
  const w=image.width,h=image.height,rows=new Uint16Array(h);
  for(let y=0;y<h;y++)for(let x=Math.round(w*.04);x<Math.round(w*.12);x++) {
    const i=(y*w+x)*4,r=image.data[i],g=image.data[i+1],b=image.data[i+2];
    if(r>170&&g>200&&b>215&&b-r>12&&g-r>5)rows[y]++;
  }
  return groups(rows,w*.02,8).filter(r=>r.end-r.start>w*.015&&r.end-r.start<w*.08);
}
export async function prepareMetadataSheet(blob,{signal,normalizeHeight=40}={}) {
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  const bitmap=await createImageBitmap(blob);
  try {
    const w=bitmap.width,h=bitmap.height;
    if(w<400||w>1700||h<w*1.25||h>w*5||w*h>8000000)return null;
    const source=document.createElement('canvas');source.width=w;source.height=h;
    const ctx=source.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);
    const image=ctx.getImageData(0,0,w,h),badges=blueBadges(image);
    if(!badges.length||badges.length>12||badges.some((r,i)=>i&&r.start-badges[i-1].start<w*.38))return null;
    // Global omission detection is more sensitive than output binarization.
    // A faint SKU outside a badge must invalidate the crop, not disappear.
    const allIdentifiers=lines(image,{x:Math.round(w*.218),y:0,width:Math.round(w*.62),height:h},210)
      .filter(r=>hasLongAsciiRun(image,r,210));
    const cards=[];
    for(const badge of badges) {
      const locationRect={x:Math.round(w*.125),y:Math.max(0,badge.start-Math.round(w*.015)),width:Math.round(w*.8),height:Math.round(w*.075)};
      if(locationRect.y+locationRect.height>h)return null;
      const locations=lines(image,locationRect);
      const metadata={x:Math.round(w*.218),y:badge.end+Math.round(w*.015),width:Math.round(w*.62),height:Math.min(Math.round(w*.38),h-badge.end-Math.round(w*.015))};
      if(metadata.height<w*.20||locations.length!==1)return null;
      const identifiers=allIdentifiers.filter(r=>r.y>=metadata.y&&r.y+r.height<=metadata.y+metadata.height);
      // At least a UPC and a SKU row are expected. Extra identifier-like rows
      // are kept, never silently dropped. Missing rows force ordinary OCR.
      if(identifiers.length<2||identifiers.length>4)return null;
      cards.push({location:locations[0],identifiers,badge});
    }
    if(allIdentifiers.some(r=>cards.filter(c=>c.identifiers.includes(r)).length!==1))return null;
    // Keep native glyph size. Only whitespace and non-identifier rows removed.
    const rowHeight=r=>normalizeHeight||r.height;
    const rowWidth=r=>Math.round(r.width*rowHeight(r)/r.height);
    const sheet=document.createElement('canvas');sheet.width=Math.max(...cards.flatMap(c=>[c.location,...c.identifiers]).map(rowWidth))+48;
    sheet.height=cards.reduce((sum,c)=>sum+[c.location,...c.identifiers].reduce((n,r)=>n+rowHeight(r)+24,0)+48,24);
    const out=sheet.getContext('2d',{willReadFrequently:true});out.fillStyle='#fff';out.fillRect(0,0,sheet.width,sheet.height);
    let y=24;
    for(const card of cards) {
      card.sheetRows=[];
      for(const r of[card.location,...card.identifiers]) {
        out.drawImage(source,r.x,r.y,r.width,r.height,24,y,rowWidth(r),rowHeight(r));
        card.sheetRows.push({y,height:rowHeight(r),kind:r===card.location?'location':'identifier'});
        y+=rowHeight(r)+24;
      }
      y+=48;
    }
    const pixels=out.getImageData(0,0,sheet.width,sheet.height);
    for(let i=0;i<pixels.data.length;i+=4) {
      const v=(pixels.data[i]+pixels.data[i+1]+pixels.data[i+2])/3<THRESHOLD?0:255;
      pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=v;
    }
    out.putImageData(pixels,0,0);
    const output=await new Promise(resolve=>sheet.toBlob(resolve,'image/png'));
    const shape={width:sheet.width,height:sheet.height};source.width=source.height=sheet.width=sheet.height=1;
    return output?{blob:output,cards,shape,original:{width:w,height:h},rows:allIdentifiers.length}:null;
  } finally { bitmap.close(); }
}
function normalizeCodeText(text) {
  return String(text).replace(/[‐‑‒–—−﹣－]/g,'-')
    .replace(/\bS[ \t]*K[ \t]*U\b/gi,'SKU')
    .replace(/\bSKU\s*[:：]?\s*\n\s*(?=\d)/gi,'SKU: ');
}
function skuEvidence(skuLines,sku) {
  const skuPattern=/\bSKU\s*[:：]?\s*(\d[\d \t]*(?:(?:\.{2,}|…|⋯)\s*\d[\d \t]*)?)/i;
  let compatibleCards=0;
  for(const line of skuLines) {
    if([...line.matchAll(/\bSKU\b/gi)].length!==1)return false;
    const field=line.match(skuPattern)?.[1]?.replace(/\s/g,'');
    if(!field)return false;
    const partial=field.match(/^(\d+)(?:\.{2,}|…|⋯)(\d+)$/);
    if(partial) {
      // A short or damaged non-selected card might be another copy of this
      // target. Its presence must not be discarded to create uniqueness.
      if(partial[1].length<3||partial[2].length<3||partial[1].length+partial[2].length<10)return false;
      if(sku.startsWith(partial[1])&&sku.endsWith(partial[2])) {
        if(partial[1].length+partial[2].length>=sku.length)return false;
        compatibleCards++;
      }
    } else {
      if(!/^\d{10,64}$/.test(field))return false;
      if(field===sku)compatibleCards++;
      // OCR can lose the end of a full numeric line without leaving an
      // ellipsis. A proper substring of the target is incomplete evidence.
      else if((field.length<sku.length&&sku.includes(field))||(field.length>sku.length&&field.includes(sku)))return false;
    }
  }
  return compatibleCards===1;
}
export function validateMetadataResult(text,sku,cardCount,parseScreenshotText) {
  // A recognition loss can hide a second copy of the SKU. Every detected card
  // must retain a readable SKU identifier and a location before uniqueness.
  if(cardCount===undefined)return validateKnownSkuText(text,sku,parseScreenshotText);
  if(!Number.isInteger(cardCount)||cardCount<1||cardCount>12||!/^\d{10,64}$/.test(sku))return null;
  const normalized=normalizeCodeText(text);
  const skuLines=normalized.split(/\r?\n/).filter(l=>/\bSKU\s*[:：]?/i.test(l));
  const locLines=normalized.split(/\r?\n/).map(l=>l.trim().replace(/\s/g,''));
  const codeCount=locLines.filter(l=>CODE.test(l)).length;
  if(skuLines.length!==cardCount||codeCount!==cardCount||!skuEvidence(skuLines,sku))return null;
  const parsed=parseScreenshotText(normalized,{product:{sku}});
  return !parsed.matchError&&parsed.matchedBy==='sku'&&parsed.loc?{...parsed,ocrText:normalized}:null;
}

/** Same identity proof for one ordinary original-image codes confirmation.
 * All observed locations and UPC/SKU headings are accounted for. An optional
 * geometric card count adds a stronger independent completeness check.
 */
export function validateKnownSkuText(text,sku,parseScreenshotText,{expectedCards}={}) {
  if(!/^\d{10,64}$/.test(sku))return null;
  const normalized=normalizeCodeText(text),rows=normalized.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const cards=[];let card=null;
  const skuLines=[];
  let upcCount=0;
  for(const row of rows) {
    const loc=row.replace(/^库[ \t]*位(?:码|号)?[ \t]*[:：]?[ \t]*/,'').replace(/\s/g,'');
    if(CODE.test(loc)) {card={loc,skus:[],upc:0};cards.push(card);continue;}
    if(/\bSKU\b/i.test(row)) {
      if(!card)return null;
      card.skus.push(row);skuLines.push(row);
    }
    const upcs=[...row.matchAll(/\bU[ \t]*P[ \t]*C\b/gi)].length;
    upcCount+=upcs;if(card)card.upc+=upcs;
  }
  // The search input can repeat the first card's location. It is accepted only
  // before every identifier and only when its code agrees with that first card.
  if(cards.length>1&&cards[0].skus.length===0&&cards[0].upc===0&&cards[0].loc===cards[1].loc)cards.shift();
  if(!cards.length||cards.length>12||cards.some(c=>c.skus.length!==1||c.upc>1)||upcCount>skuLines.length)return null;
  if(expectedCards!==undefined&&cards.length!==expectedCards)return null;
  if(skuLines.length!==cards.length||!skuEvidence(skuLines,sku))return null;
  const canonical=cards.map(c=>'库位：'+c.loc+'\n'+c.skus[0]).join('\n');
  const parsed=parseScreenshotText(canonical,{product:{sku}});
  return !parsed.matchError&&parsed.matchedBy==='sku'&&parsed.loc?{...parsed,ocrText:canonical}:null;
}
