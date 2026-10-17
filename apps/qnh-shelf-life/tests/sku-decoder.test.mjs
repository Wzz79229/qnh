import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const ZXing=createRequire(import.meta.url)('../dist/vendor/zxing/index.min.js');

// Synthetic Code128-B pixels exercise the actual shipped decoder, not a scan mock.
function pixelsFor(value){
  const codes=[104,...[...value].map(c=>c.charCodeAt(0)-32)];let check=104;
  for(let i=1;i<codes.length;i++)check+=codes[i]*i;codes.push(check%103,106);
  const bars=[];for(const code of codes){let black=true;for(const run of ZXing.Code128Reader.CODE_PATTERNS[code]){for(let i=0;i<run*3;i++)bars.push(black);black=!black;}}
  const width=bars.length+60,height=150,data=new Uint8ClampedArray(width*height).fill(255);
  for(let y=20;y<height-20;y++)for(let x=30;x<width-30;x++)if(bars[x-30])data[y*width+x]=0;
  return {width,height,data};
}
for(const sku of ['0000000000000000001','2110000000000000007','SKU-000001'])test(`vendored Code128 decoder preserves exact synthetic SKU ${sku}`,()=>{
  const {width,height,data}=pixelsFor(sku);const reader=new ZXing.MultiFormatReader();reader.setHints(null);
  const result=reader.decodeWithState(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.RGBLuminanceSource(data,width,height))));
  assert.equal(result.getText(),sku);assert.equal(typeof result.getText(),'string');
});
