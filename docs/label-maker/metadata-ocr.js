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
  let count=0,longest=0,totalTall=0,previous;
  for(const column of groups(columns,1,0)) {
    let y0=b.height,y1=-1;
    for(let y=0;y<b.height;y++)for(let x=column.start;x<=column.end;x++)if(b.values[y*b.width+x]) {y0=Math.min(y0,y);y1=Math.max(y1,y);}
    const height=y1-y0+1,width=column.end-column.start+1;
    const tall=height>=b.height*.68 && width/height>=.12 && width/height<=.85;
    const joined=!previous||column.start-previous.end<=b.height*.55;
    count=tall?(joined?count+1:1):0;
    if(tall)totalTall++;
    longest=Math.max(longest,count);
    // The parser permits 3+7, 4+6, and 5+5 visible partial-SKU halves. Every
    // accepted length has at least one half of five digits, never six.
    previous=column;
  }
  // Five-digit inventory totals also contain a long digit run. They are not
  // identifier rows: a permitted visible SKU has at least ten numeric glyphs.
  return longest>=5&&totalTall>=10;
}
function removeEdgeRules(image) {
  // A scrollbar can join every text row when the crop reaches the right edge.
  // Remove only long uninterrupted dark strokes there, never ordinary glyphs.
  const w=image.width,h=image.height,minRun=Math.round(w*.12);
  for(let x=Math.round(w*.94);x<w;x++) {
    let start=-1;
    for(let y=0;y<=h;y++) {
      const i=(y*w+x)*4,dark=y<h&&(image.data[i]+image.data[i+1]+image.data[i+2])/3<210;
      if(dark&&start<0)start=y;
      if(!dark&&start>=0) {
        if(y-start>=minRun)for(let row=start;row<y;row++){const p=(row*w+x)*4;image.data[p]=image.data[p+1]=image.data[p+2]=255;}
        start=-1;
      }
    }
  }
}
function trimIdentifierWidth(image,rect) {
  const b=binary(image,rect,210),columns=new Uint16Array(b.width);
  for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++)columns[x]+=b.values[y*b.width+x];
  let tall=0,previous=null;
  for(const column of groups(columns,1,0)) {
    // Keep every identifier glyph. A large whitespace gap after sufficient
    // numeric-sized glyphs separates auxiliary controls such as Copy buttons.
    if(previous&&tall>=10&&column.start-previous.end>b.height*1.5)return {...rect,width:Math.min(rect.width,previous.end+1+Math.ceil(b.height*.10))};
    let top=b.height,bottom=-1;
    for(let y=0;y<b.height;y++)for(let x=column.start;x<=column.end;x++)if(b.values[y*b.width+x]){top=Math.min(top,y);bottom=Math.max(bottom,y);}
    const height=bottom-top+1,width=column.end-column.start+1;
    if(height>=b.height*.68&&width/height>=.12&&width/height<=.85)tall++;
    previous=column;
  }
  return rect;
}
function blueBadges(image) {
  const w=image.width,h=image.height,x0=Math.round(w*.02),x1=Math.round(w*.40),width=x1-x0;
  // The inventory screen can include a category sidebar. Locate the pale-blue
  // badge itself rather than assuming its horizontal position.
  const mask=new Uint8Array(width*h),candidates=[];
  for(let y=0;y<h;y++)for(let x=x0;x<x1;x++) {
    const i=(y*w+x)*4,r=image.data[i],g=image.data[i+1],b=image.data[i+2];
    if(r>170&&g>200&&b>215&&b-r>12&&g-r>5)mask[y*width+x-x0]=1;
  }
  const queue=new Int32Array(mask.length);
  for(let p=0;p<mask.length;p++) {
    if(!mask[p])continue;
    let head=0,tail=1,minX=width,maxX=0,minY=h,maxY=0;queue[0]=p;mask[p]=0;
    while(head<tail) {
      const at=queue[head++],x=at%width,y=Math.floor(at/width);
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      for(const next of [x?at-1:-1,x+1<width?at+1:-1,y?at-width:-1,y+1<h?at+width:-1]) {
        if(next>=0&&mask[next]){mask[next]=0;queue[tail++]=next;}
      }
    }
    const bw=maxX-minX+1,bh=maxY-minY+1;
    if(bw>w*.035&&bw<w*.10&&bh>w*.015&&bh<w*.08&&tail/(bw*bh)>.35) {
      candidates.push({start:minY,end:maxY,x:minX+x0,width:bw});
    }
  }
  if(!candidates.length)return [];
  // Badges in a single list share a column. An unrelated blue photo fragment
  // must not move the text crop or hide an inventory card.
  const columns=candidates.map(c=>candidates.filter(b=>Math.abs(b.x-c.x)<w*.015));
  columns.sort((a,b)=>b.length-a.length);
  const best=columns[0];
  if(columns.some(c=>Math.abs(c[0].x-best[0].x)>=w*.015&&c.length===best.length))return [];
  return best.sort((a,b)=>a.start-b.start);
}
export async function prepareMetadataSheet(blob,{signal,normalizeHeight=40}={}) {
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  const bitmap=await createImageBitmap(blob);
  try {
    const w=bitmap.width,h=bitmap.height;
    if(w<400||w>1700||h<w*1.25||h>w*5||w*h>8000000)return null;
    const source=document.createElement('canvas');source.width=w;source.height=h;
    const ctx=source.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);
    const image=ctx.getImageData(0,0,w,h);removeEdgeRules(image);ctx.putImageData(image,0,0);
    const badges=blueBadges(image);
    if(!badges.length||badges.length>12||badges.some((r,i)=>i&&r.start-badges[i-1].start<w*.38))return null;
    // Global omission detection is more sensitive than output binarization.
    // A faint SKU outside a badge must invalidate the crop, not disappear.
    const badgeX=badges.reduce((sum,b)=>sum+b.x,0)/badges.length;
    const shift=badgeX-w*.055,metadataX=Math.round(w*.218+shift),metadataWidth=w-metadataX;
    const allIdentifiers=lines(image,{x:metadataX,y:0,width:metadataWidth,height:h},210)
      .filter(r=>hasLongAsciiRun(image,r,210)).map(r=>trimIdentifierWidth(image,r));
    const cards=[];
    for(const badge of badges) {
      const locationX=Math.round(w*.125+shift);
      const locationRect={x:locationX,y:Math.max(0,badge.start-Math.round(w*.015)),width:Math.round(w*.925)-locationX,height:Math.round(w*.075)};
      if(locationRect.y+locationRect.height>h)return null;
      const locations=lines(image,locationRect);
      const metadata={x:metadataX,y:badge.end+Math.round(w*.015),width:metadataWidth,height:Math.min(Math.round(w*.38),h-badge.end-Math.round(w*.015))};
      if(metadata.height<w*.20)return null;
      const identifiers=allIdentifiers.filter(r=>r.y>=metadata.y&&r.y+r.height<=metadata.y+metadata.height);
      // At least a UPC and a SKU row are expected. Extra identifier-like rows
      // are kept, never silently dropped. Missing rows force ordinary OCR.
      if(identifiers.length<2||identifiers.length>4)return null;
      // Keep the entire location band when a toast covers another card. The
      // per-card validator may exclude that card using its readable SKU, but
      // it still requires a clear location for the selected product.
      cards.push({location:locations.length===1?locations[0]:locationRect,identifiers,badge});
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
    .replace(/\bSKU\s*[:：]?\s*\n\s*(?=\d)/gi,'SKU: ')
    // Android's centered ellipsis can be read as ::-, -:- or :::. Normalize
    // only that punctuation between two numeric halves of a labelled SKU.
    // Every digit remains exact; short evidence and duplicate matches reject.
    .replace(/(\bSKU\s*[:：]?\s*)(\d[\d \t]*)([.。:：·•\- \t]{2,})(\d[\d \t]*)/gi,(original,heading,prefix,separator,suffix)=>{
      const mark=separator.replace(/[ \t]/g,'');
      return mark.length>=2&&(/[:：]/.test(mark)||[...mark].filter(c=>'.。·•'.includes(c)).length>=2)
        ?heading+prefix.trim()+'...'+suffix.trim():original;
    });
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

/** Bind OCR rows to the independently detected cards before matching identity.
 * A covered location in another card is harmless only when its complete visible
 * SKU evidence excludes the selected product. Unknown or repeated SKUs reject.
 */
export function validateMetadataCardsResult(data,sku,metadata,parseScreenshotText) {
  const cards=metadata?.cards;
  if(!Array.isArray(cards)||cards.length<1||cards.length>12||!/^\d{10,64}$/.test(sku))return null;
  const outputLines=(data?.blocks||[]).flatMap(b=>(b.paragraphs||[]).flatMap(p=>p.lines||[]));
  if(!outputLines.length)return null;
  const rows=cards.flatMap((card,index)=>(card.sheetRows||[]).map(row=>({...row,card:index,chunks:[]})));
  if(rows.length<cards.length*3)return null;
  for(const line of outputLines) {
    const text=String(line.text||'').trim(),box=line.bbox;
    if(!text||!box||![box.x0,box.y0,box.x1,box.y1].every(Number.isFinite))return null;
    const center=(box.y0+box.y1)/2;
    const matches=rows.filter(r=>center>=r.y-2&&center<=r.y+r.height+2);
    if(matches.length!==1||box.y1-box.y0>matches[0].height*1.8)return null;
    matches[0].chunks.push({text,x:box.x0});
  }
  const recognized=cards.map((_,index)=>rows.filter(r=>r.card===index).map(r=>({
    kind:r.kind,text:normalizeCodeText(r.chunks.sort((a,b)=>a.x-b.x).map(c=>c.text).join(' ')),
  })));
  const skuLines=[];
  for(const card of recognized) {
    const skus=card.filter(r=>r.kind==='identifier'&&/\bSKU\b/i.test(r.text));
    if(skus.length!==1||card.some(r=>r.kind==='location'&&/\bSKU\b/i.test(r.text)))return null;
    skuLines.push(skus[0].text);
  }
  if(!skuEvidence(skuLines,sku))return null;
  const selected=skuLines.findIndex(line=>{
    const field=line.match(/\bSKU\s*[:：]?\s*(\d[\d \t]*(?:(?:\.{2,}|…|⋯)\s*\d[\d \t]*)?)/i)?.[1]?.replace(/\s/g,'');
    const partial=field?.match(/^(\d+)(?:\.{2,}|…|⋯)(\d+)$/);
    return partial?sku.startsWith(partial[1])&&sku.endsWith(partial[2]):field===sku;
  });
  if(selected<0)return null;
  const locRows=recognized[selected].filter(r=>r.kind==='location').map(r=>r.text.replace(/\s/g,''));
  if(locRows.length!==1||!CODE.test(locRows[0]))return null;
  const canonical='库位：'+locRows[0]+'\n'+skuLines[selected];
  const parsed=parseScreenshotText(canonical,{product:{sku}});
  return !parsed.matchError&&parsed.matchedBy==='sku'&&parsed.loc?{...parsed,ocrText:canonical}:null;
}

function ocrRows(data) {
  const source=(data?.blocks||[]).flatMap(b=>(b.paragraphs||[]).flatMap(p=>p.lines||[]));
  const rows=[];
  for(const line of source) {
    const text=normalizeCodeText(line.text||'').trim(),bbox=line.bbox;
    if(!text||!bbox||![bbox.x0,bbox.y0,bbox.x1,bbox.y1].every(Number.isFinite)||bbox.x1<=bbox.x0||bbox.y1<=bbox.y0)continue;
    const height=bbox.y1-bbox.y0,cy=(bbox.y0+bbox.y1)/2;
    const same=rows.filter(r=>Math.abs(r.cy-cy)<Math.max(r.height,height)*.45&&Math.max(r.bbox.x0,bbox.x0)-Math.min(r.bbox.x1,bbox.x1)<Math.max(r.height,height)*4);
    const part={text,bbox,words:line.words||[]};
    if(same.length!==1)rows.push({parts:[part],bbox:{...bbox},height,cy});
    else {
      const row=same[0];row.parts.push(part);
      row.bbox={x0:Math.min(row.bbox.x0,bbox.x0),y0:Math.min(row.bbox.y0,bbox.y0),x1:Math.max(row.bbox.x1,bbox.x1),y1:Math.max(row.bbox.y1,bbox.y1)};
      row.height=row.bbox.y1-row.bbox.y0;row.cy=(row.bbox.y0+row.bbox.y1)/2;
    }
  }
  return rows.map(row=>({...row,text:row.parts.sort((a,b)=>a.bbox.x0-b.bbox.x0).map(p=>p.text).join(' '),words:row.parts.flatMap(p=>p.words)}));
}

const GENERAL_CODE=/^[A-Z]+\d+(?:-[A-Z0-9]+)+$/;
function spatialLocations(rows) {
  const locations=[];
  for(const row of rows) {
    const words=(row.words.length?row.words:row.parts.map(p=>({text:p.text,bbox:p.bbox})))
      .filter(w=>w.bbox&&String(w.text||'').trim()).sort((a,b)=>a.bbox.x0-b.bbox.x0);
    const found=[],labelled=/库\s*位|\bLOC(?:ATION)?\b/i.test(row.text);
    if(!labelled&&!/\bSKU\b/i.test(row.text)&&words.length>3)continue;
    for(let i=0;i<words.length;i++)for(let n=1;n<=Math.min(5,words.length-i);n++) {
      const selected=words.slice(i,i+n),text=normalizeCodeText(selected.map(w=>w.text).join('')).toUpperCase()
        .replace(/^(?:库位(?:码|号)?|LOCATION|LOC)[:：]?/,'').replace(/^[\s:：([\]{}]+|[\s:：,;.)\]}]+$/g,'');
      if(n>1&&selected.slice(1).some(w=>!/^[-\d]/.test(String(w.text||'').trim())))break;
      if(text.length>64||!GENERAL_CODE.test(text))continue;
      const bbox={x0:selected[0].bbox.x0,y0:Math.min(...selected.map(w=>w.bbox.y0)),x1:selected.at(-1).bbox.x1,y1:Math.max(...selected.map(w=>w.bbox.y1))};
      // Prefer an exact word to a longer fragment that merely includes it.
      if(!found.some(l=>l.code===text&&l.bbox.x0===bbox.x0))found.push({code:text,bbox,cy:(bbox.y0+bbox.y1)/2,height:bbox.y1-bbox.y0,labelled});
      break;
    }
    if(new Set(found.map(l=>l.code)).size>1)return null;
    locations.push(...found);
  }
  return locations;
}

/** Layout-independent fallback. Only recognized SKU headings establish identity;
 * OCR coordinates establish the reading column and field order. A location may
 * never cross another SKU or be borrowed from an incompletely identified card.
 */
export function validateSpatialSkuResult(data,sku,parseScreenshotText,{expectedCards}={}) {
  if(!/^\d{10,64}$/.test(sku))return null;
  const rows=ocrRows(data);if(!rows.length)return null;
  const skuRows=rows.filter(r=>/\bSKU\b/i.test(r.text));
  if(!skuRows.length||skuRows.length>12||(expectedCards!==undefined&&skuRows.length!==expectedCards))return null;
  if(!skuEvidence(skuRows.map(r=>r.text),sku))return null;
  const upcs=rows.reduce((n,r)=>n+[...r.text.matchAll(/\bU[ \t]*P[ \t]*C\b/gi)].length,0);
  if(upcs>skuRows.length)return null;
  // A numeric row whose heading was lost can hide a second target SKU.
  if(rows.some(r=>! /\b(?:SKU|U[ \t]*P[ \t]*C)\b/i.test(r.text)&&/\d[\d \t]*(?:(?:\.{2,}|…|⋯)\s*\d[\d \t]*)?/.test(r.text)&&[...r.text.matchAll(/\d[\d \t]*(?:(?:\.{2,}|…|⋯)\s*\d[\d \t]*)?/g)].some(m=>m[0].replace(/\D/g,'').length>=10)))return null;
  const selected=skuRows.find(row=>{
    const field=row.text.match(/\bSKU\s*[:：]?\s*(\d[\d \t]*(?:(?:\.{2,}|…|⋯)\s*\d[\d \t]*)?)/i)?.[1]?.replace(/\s/g,'');
    const partial=field?.match(/^(\d+)(?:\.{2,}|…|⋯)(\d+)$/);
    return partial?sku.startsWith(partial[1])&&sku.endsWith(partial[2]):field===sku;
  });
  if(!selected)return null;
  const locations=spatialLocations(rows);if(!locations?.length)return null;
  const columns=[];
  for(const row of [...skuRows].sort((a,b)=>a.bbox.x0-b.bbox.x0)) {
    const heading=row.words.find(w=>/^SKU[:：]?$/i.test(normalizeCodeText(w.text||'').trim()));
    row.skuX=heading?.bbox?.x0??row.bbox.x0;
    const same=columns.filter(c=>Math.abs(c.x-row.skuX)<=Math.max(c.height,row.height)*3);
    if(same.length>1)return null;
    const column=same[0]||{x:row.skuX,height:row.height,skus:[],locations:[]};
    if(!same.length)columns.push(column);column.skus.push(row);
    column.x=column.skus.reduce((n,r)=>n+r.skuX,0)/column.skus.length;column.height=Math.max(column.height,row.height);
  }
  for(const loc of locations) {
    const distances=columns.map(c=>({column:c,d:Math.abs(loc.bbox.x0-c.x)})).sort((a,b)=>a.d-b.d);
    if(distances.length>1&&distances[1].d-distances[0].d<Math.max(loc.height,distances[0].column.height))return null;
    const column=distances[0].column;
    const maxGap=Math.max(...column.skus.map(r=>r.bbox.x1-r.bbox.x0),column.height*8);
    if(columns.length>1&&distances[0].d>maxGap)return null;column.locations.push(loc);
  }
  const column=columns.find(c=>c.skus.includes(selected));if(!column)return null;
  const ordered=column.skus.sort((a,b)=>a.cy-b.cy);
  // More distinct field values than SKU rows means at least one identifier was
  // omitted. Repeated search text for the same one-card location is harmless.
  if(new Set(column.locations.map(l=>l.code)).size>ordered.length)return null;
  const choice=candidates=>{
    const labelled=candidates.filter(l=>l.labelled),values=labelled.length?labelled:candidates;
    return values.length&&new Set(values.map(l=>l.code)).size===1?values[0]:null;
  };
  const inline=ordered.map(r=>choice(column.locations.filter(l=>Math.abs(l.cy-r.cy)<=Math.max(l.height,r.height)*.65)));
  const before=ordered.map((r,i)=>inline[i]||choice(column.locations.filter(l=>l.cy<r.cy-r.height*.65&&(!i||l.cy>ordered[i-1].cy+ordered[i-1].height*.65))));
  const after=ordered.map((r,i)=>inline[i]||choice(column.locations.filter(l=>l.cy>r.cy+r.height*.65&&(i+1===ordered.length||l.cy<ordered[i+1].cy-ordered[i+1].height*.65))));
  const index=ordered.indexOf(selected),beforeCount=before.filter(Boolean).length,afterCount=after.filter(Boolean).length;
  let location=inline[index];
  if(!location) {
    if(beforeCount>afterCount)location=before[index];
    else if(afterCount>beforeCount)location=after[index];
    else if(before[index]&&after[index]&&before[index].code===after[index].code)location=before[index];
    else if(ordered.length===1&&new Set(column.locations.map(l=>l.code)).size===1)location=column.locations[0];
  }
  if(!location)return null;
  // Reading order is insufficient when the proposed location lies closer to
  // another SKU. A search-field repeat or mixed field order must not let a
  // majority vote override that local ownership conflict.
  const selectedDistance=Math.abs(location.cy-selected.cy);
  if(ordered.some(r=>r!==selected&&Math.abs(location.cy-r.cy)+Math.max(r.height,selected.height)*.65<selectedDistance))return null;
  // With an omitted location, an interior field can belong to either adjacent
  // card. Only an edge field or a direct same-row pair has independent order
  // evidence; otherwise let a clearer OCR pass decide instead of borrowing it.
  if(!inline[index]&&column.locations.length<ordered.length&&location.cy>ordered[0].cy&&location.cy<ordered.at(-1).cy)return null;
  const visibleField=selected.text.match(/\bSKU\s*[:：]?\s*(\d[\d \t]*(?:(?:\.{2,}|…|⋯)\s*\d[\d \t]*)?)/i)?.[1]?.trim();
  if(!visibleField)return null;
  const canonical='库位：'+location.code+'\nSKU: '+visibleField;
  const parsed=parseScreenshotText(canonical,{product:{sku}});
  return !parsed.matchError&&parsed.matchedBy==='sku'&&parsed.loc?{...parsed,ocrText:canonical}:null;
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
