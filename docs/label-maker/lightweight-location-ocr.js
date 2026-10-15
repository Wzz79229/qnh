/** Experimental, local-only known-SKU screenshot reader. Never a general OCR. */
const LETTERS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
let templates;
const FONT_FAMILIES = ['Arial', 'Segoe UI', 'Tahoma', 'Verdana', 'system-ui'];
const GRID_W = 20, GRID_H = 28;

function binary(image, rect, threshold=160) {
  const {width,data}=image; const w=rect.width,h=rect.height,out=new Uint8Array(w*h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
    const i=((rect.y+y)*width+rect.x+x)*4;
    out[y*w+x]=(data[i]+data[i+1]+data[i+2])/3<threshold?1:0;
  }
  return {width:w,height:h,data:out};
}
function bounds(image) {
  let x0=image.width,y0=image.height,x1=-1,y1=-1;
  for(let y=0;y<image.height;y++) for(let x=0;x<image.width;x++) if(image.data[y*image.width+x]) {x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}
  return x1<0?null:{x:x0,y:y0,width:x1-x0+1,height:y1-y0+1};
}
function cropped(image,r) {
  const data=new Uint8Array(r.width*r.height);
  for(let y=0;y<r.height;y++)data.set(image.data.subarray((y+r.y)*image.width+r.x,(y+r.y)*image.width+r.x+r.width),y*r.width);
  return {width:r.width,height:r.height,data};
}
function countHoles(image) {
  const {width:w,height:h,data}=image,seen=new Uint8Array(w*h);let holes=0;
  for(let p=0;p<data.length;p++)if(!data[p]&&!seen[p]){
    const stack=[p];seen[p]=1;let edge=false,area=0;
    while(stack.length){const i=stack.pop(),x=i%w,y=Math.floor(i/w);area++;if(x===0||y===0||x===w-1||y===h-1)edge=true;
      for(const j of [x>0?i-1:-1,x<w-1?i+1:-1,y>0?i-w:-1,y<h-1?i+w:-1])if(j>=0&&!seen[j]&&!data[j]){seen[j]=1;stack.push(j);}
    }if(!edge&&area>=Math.max(2,w*h*.005))holes++;
  }return holes;
}
function normalized(image) {
  const data=new Float32Array(GRID_W*GRID_H);
  for(let y=0;y<GRID_H;y++)for(let x=0;x<GRID_W;x++){
    const x0=x*image.width/GRID_W,x1=(x+1)*image.width/GRID_W;
    const y0=y*image.height/GRID_H,y1=(y+1)*image.height/GRID_H;let value=0,area=0;
    for(let yy=Math.floor(y0);yy<Math.ceil(y1);yy++)for(let xx=Math.floor(x0);xx<Math.ceil(x1);xx++){
      const a=(Math.min(x1,xx+1)-Math.max(x0,xx))*(Math.min(y1,yy+1)-Math.max(y0,yy));
      if(xx>=0&&yy>=0&&xx<image.width&&yy<image.height){value+=image.data[yy*image.width+xx]*a;area+=a;}
    } data[y*GRID_W+x]=value/area;
  } return data;
}
function getTemplates() {
  if(templates)return templates;
  const c=document.createElement('canvas');c.width=100;c.height=100;const ctx=c.getContext('2d',{willReadFrequently:true});templates=[];
  for(const font of FONT_FAMILIES)for(const weight of [400,500])for(const size of [28,32,36,40,44,48])for(const letter of LETTERS){
    ctx.fillStyle='#fff';ctx.fillRect(0,0,100,100);ctx.fillStyle='#000';ctx.font=weight+' '+size+'px '+(font==='system-ui'?'system-ui':'"'+font+'", sans-serif');ctx.textBaseline='alphabetic';ctx.fillText(letter,10,70);
    const b=binary(ctx.getImageData(0,0,100,100),{x:0,y:0,width:100,height:100},160),box=bounds(b);if(!box)continue;
    const img=cropped(b,box);templates.push({letter,font,weight,size,aspect:img.width/img.height,data:normalized(img),holes:countHoles(img)});
  }c.width=c.height=1;return templates;
}
function readGlyph(image,alphabet) {
  const data=normalized(image),aspect=image.width/image.height,holes=countHoles(image);
  const scores=new Map();
  for(const t of getTemplates())if(alphabet.includes(t.letter)&&t.holes===holes){
    let error=0;for(let i=0;i<data.length;i++)error+=Math.abs(data[i]-t.data[i]);
    error=error/data.length+0.16*Math.abs(Math.log(aspect/t.aspect));
    if(!scores.has(t.letter)||scores.get(t.letter).error>error)scores.set(t.letter,{error,template:t});
  }
  const best=[...scores].sort((a,b)=>a[1].error-b[1].error);return best.length>=2?{letter:best[0][0],error:best[0][1].error,margin:best[1][1].error-best[0][1].error,holes,font:best[0][1].template.font,size:best[0][1].template.size}:{letter:'?',error:1,margin:0,holes};
}
function projectionGroups(image,axis,minCount=1,gap=0) {
  const size=axis==='x'?image.width:image.height,other=axis==='x'?image.height:image.width,groups=[];
  for(let p=0;p<size;p++){
    let count=0;for(let q=0;q<other;q++)count+=image.data[axis==='x'?q*image.width+p:p*image.width+q];
    if(count<minCount)continue;const prev=groups[groups.length-1];if(!prev||p>prev.end+1+gap)groups.push({start:p,end:p});else prev.end=p;
  }return groups;
}
function readLine(image,alphabet=LETTERS,{maxGlyphs=Infinity,stopAtWideGap=false}={}) {
  const box=bounds(image);if(!box)return null;const line=cropped(image,box),parts=[];
  for(const run of projectionGroups(line,'x')){
    if(parts.length>=maxGlyphs)break;
    const previous=parts[parts.length-1];
    if(stopAtWideGap&&parts.length>=5&&previous&&box.x+run.start-previous.x-previous.width>line.height*.65)break;
    const glyphImage=cropped(line,{x:run.start,y:0,width:run.end-run.start+1,height:line.height});const gb=bounds(glyphImage);if(!gb)continue;
    const glyph=cropped(glyphImage,gb),h=glyph.height/line.height,w=glyph.width/line.height;
    if(h<0.25){parts.push({letter:w>0.22?'-':'.',error:0,margin:1,x:box.x+run.start,y:box.y+gb.y,width:glyph.width,height:glyph.height});continue;}
    const dotRuns=projectionGroups(glyph,'y');
    if(w<0.23&&dotRuns.length===2&&dotRuns.every(r=>r.end-r.start+1<line.height*.25)){
      parts.push({letter:':',error:0,margin:1,x:box.x+run.start,y:box.y+gb.y,width:glyph.width,height:glyph.height});continue;
    }
    parts.push({...readGlyph(glyph,alphabet),x:box.x+run.start,y:box.y+gb.y,width:glyph.width,height:glyph.height});
  }
  return {text:parts.map(p=>p.letter).join(''),parts,height:line.height,box};
}
function badges(image) {
  const w=image.width,h=image.height,x0=Math.round(w*.04),x1=Math.round(w*.12),groups=[];
  for(let y=0;y<h;y++){
    let blue=0;for(let x=x0;x<x1;x++){const i=(y*w+x)*4,r=image.data[i],g=image.data[i+1],b=image.data[i+2];if(r>170&&g>200&&b>215&&b-r>12&&g-r>5)blue++;}
    if(blue<=w*.02)continue;const prev=groups[groups.length-1];if(!prev||y>prev.end+8)groups.push({start:y,end:y});else prev.end=y;
  }return groups.filter(g=>g.end-g.start>w*.015&&g.end-g.start<w*.08);
}
function lineRegions(image,rect) {
  const b=binary(image,rect,160);
  return projectionGroups(b,'y',Math.max(2,Math.round(rect.width*.003)),1)
    .filter(r=>r.end-r.start>image.width*.008)
    .map(r=>({x:rect.x,y:rect.y+r.start,width:rect.width,height:r.end-r.start+1}));
}
function hasIdentifierRun(image) {
  const box=bounds(image);if(!box)return false;const line=cropped(image,box);let count=0,previous;
  for(const run of projectionGroups(line,'x')){
    const glyph=cropped(line,{x:run.start,y:0,width:run.end-run.start+1,height:line.height}),b=bounds(glyph);
    const tall=b&&b.height>=line.height*.68&&b.width/b.height>=.15&&b.width/b.height<=.85;
    const joined=!previous||run.start-previous.end<=line.height*.5;
    count=tall?(joined?count+1:1):0;if(count>=8)return true;previous=run;
  }return false;
}
function hasPossibleNumericRun(read) {
  let count=0,previous;
  for(const p of read?.parts||[]){
    if(previous&&p.x-previous.x-previous.width>read.height*.5)count=0;
    if(['.',':','-'].includes(p.letter))count=0;
    else if(/^\d$/.test(p.letter)||/[OQILSBZG]/.test(p.letter)||!certain([p]))count++;
    else count=0;
    if(count>=8)return true;previous=p;
  }return false;
}
// Tight shape distance plus a distinct runner-up and equal hole topology.
// Borderline glyphs deliberately trigger the full OCR fallback.
function certain(parts,threshold=.20,margin=.03) {return parts.length>0&&parts.every(p=>p.error<=threshold&&p.margin>=margin);}

/** Returns null for every unsupported/uncertain case, so callers retain OCR. */
export async function recognizeLocationFast(file,{sku,signal,debug=false}={}){
  if(signal?.aborted)throw new DOMException('识别已取消。','AbortError');
  if(typeof sku!=='string'||!/^\d{12,64}$/.test(sku)||!(file instanceof Blob)||!file.size||file.size>15*1024*1024)return null;
  let bitmap;
  try{
    bitmap=await createImageBitmap(file);
    if(signal?.aborted)throw new DOMException('识别已取消。','AbortError');
    const w=bitmap.width,h=bitmap.height;if(w<600||w>1700||h>w*4||h<w*1.25||w*h>7000000)return null;
    const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(bitmap,0,0);const image=ctx.getImageData(0,0,w,h);c.width=c.height=1;
    const bs=badges(image);if(!bs.length||bs.length>12||bs.some((b,i)=>i&&b.start-bs[i-1].start<w*.38))return null;
    const cards=[];
    // Count SKU headings independently of blue badges, over the entire visible
    // metadata column. A card whose badge was hidden/changed must never vanish
    // from the uniqueness check. A near-SKU heading is uncertain, so it also
    // has to be accounted for by a fully readable card below.
    const fullColumn={x:Math.round(w*.218),y:0,width:Math.round(w*.62),height:h};
    const identifierRows=lineRegions(image,fullColumn).map(rect=>{
      const pixels=binary(image,rect),read=readLine(pixels,LETTERS,{maxGlyphs:4});
      const possibleSku=read?.parts.length===4&&read.parts[3].letter===':'&&read.parts.slice(0,3).filter((part,i)=>part.letter==='SKU'[i]).length>=2;
      // QNH's two-character Chinese metadata headings (规格 / 重量) occupy
      // two full-width square glyphs before the colon. Their measurement
      // differs from the three narrow ASCII glyphs of SKU, even if a spec
      // contains a long series of quantities. Never use guessed Chinese text.
      const chineseHeading=read?.parts[2]?.letter===':'&&read.parts.slice(0,2).every(p=>p.width/p.height>=.85&&p.width/p.height<=1.2&&p.error>.25);
      const fullRead=!chineseHeading&&hasIdentifierRun(pixels)&&!['SKU:','UPC:'].includes(read?.text)?readLine(pixels):null;
      const possibleNumeric=!chineseHeading&&hasIdentifierRun(pixels)&&(['SKU:','UPC:'].includes(read?.text)||hasPossibleNumericRun(fullRead));
      return {rect,read,fullRead:debug?fullRead:undefined,isIdentifier:possibleSku||possibleNumeric};
    }).filter(row=>row.isIdentifier);
    const skuHeadings=identifierRows.filter(row=>row.read?.text==='SKU:');
    for(const b of bs){
      const locRect={x:Math.round(w*.125),y:Math.max(0,b.start-Math.round(w*.015)),width:Math.round(w*.8),height:Math.round(w*.075)};
      if(locRect.y+locRect.height>h)return null;
      const locLines=lineRegions(image,locRect);
      const loc=locLines.length===1?readLine(binary(image,locLines[0]),LETTERS):null;
      const rect={x:Math.round(w*.218),y:b.end+Math.round(w*.015),width:Math.round(w*.62),height:Math.min(Math.round(w*.29),h-b.end-Math.round(w*.015))};
      if(rect.height<w*.22)return null;
      // Read only each row's ASCII heading. Product names/specifications are
      // supplied by the pasted text and need no lightweight Chinese OCR.
      const lines=lineRegions(image,rect).map(r=>({rect:r,read:readLine(binary(image,r),LETTERS,{maxGlyphs:4})}));
      const skuLines=lines.filter(l=>l.read?.text==='SKU:').map(l=>({...l,read:readLine(binary(image,l.rect),LETTERS,{stopAtWideGap:true})}));
      const entry={loc,lines:lines.map(l=>l.read),sku:skuLines.length===1?skuLines[0].read:null,skuRect:skuLines.length===1?skuLines[0].rect:null};
      if(debug)Object.assign(entry,{badge:{...b},locRect});
      cards.push(entry);
    }
    const matches=[];
    // An unreadable card could be another copy of the same SKU at a different
    // location. Require every visible card's SKU to be unambiguous first.
    const completeEvidence=identifierRows.every(({read})=>['SKU:','UPC:'].includes(read?.text)&&certain(read.parts))
      &&skuHeadings.length===cards.length&&skuHeadings.every(({rect,read})=>read.text==='SKU:'&&certain(read.parts)&&cards.filter(card=>Math.abs(card.skuRect?.y-rect.y)<=2).length===1)
      &&cards.every(card=>card.sku&&certain(card.sku.parts.filter(p=>!['.',':'].includes(p.letter)))&&/^SKU:\d{6,}\.{3}\d{6,}$/.test(card.sku.text)
      &&card.loc&&/^[A-Z]{1,4}\d{1,4}(?:-[A-Z0-9]{1,4}){2,4}$/.test(card.loc.text)&&certain(card.loc.parts));
    for(const card of cards){
      if(!completeEvidence||!card.loc||!card.sku)continue;
      if(!/^[A-Z]{1,4}\d{1,4}(?:-[A-Z0-9]{1,4}){2,4}$/.test(card.loc.text)||!certain(card.loc.parts))continue;
      const m=card.sku.text.match(/^SKU:(\d+)(\.{3})(\d+)$/);
      if(!m||m[1].length<6||m[3].length<6||m[1].length+m[3].length>=sku.length||!sku.startsWith(m[1])||!sku.endsWith(m[3]))continue;
      if(!certain(card.sku.parts.filter(p=>!['.',':'].includes(p.letter))))continue;
      matches.push({loc:card.loc.text,visibleSku:m[1]+'...'+m[3]});
    }
    // These characters can share an indistinguishable raster in unfamiliar
    // fonts (e.g. monospace O versus sans-serif 0). Preserve correctness by
    // sending such target locations to the established OCR engine instead.
    const value=matches.length===1&&!/[0OQ1IL]/.test(matches[0].loc)?{loc:matches[0].loc,sku,targetSku:sku,visibleSku:matches[0].visibleSku,text:'库位：'+matches[0].loc+'\nSKU:'+matches[0].visibleSku,matchedBy:'sku',mode:'location',scope:'target',language:'templates'}:null;
    return debug?{value,cards,matches,skuHeadings,identifierRows,width:w,height:h}:value;
  }catch(error){if(error?.name==='AbortError')throw error;return null;}finally{bitmap?.close();}
}
export { recognizeLocationFast as recognizeLightweightLocation };
