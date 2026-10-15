// Keep the upstream integer LSTM model, character set, recoder, version,
// punctuation and number DAWGs byte-for-byte. Remove only the English word
// dictionary (TESSDATA_LSTM_SYSTEM_DAWG = 19), irrelevant to warehouse codes.
// Upstream format/type definitions:
// https://github.com/tesseract-ocr/tesseract/blob/main/src/ccutil/tessdatamanager.h
const fs=require('fs'),zlib=require('zlib'),crypto=require('crypto');
const source=process.argv[2]||'docs/label-maker/vendor/tesseract/lang/eng.traineddata.gz';
const destination=process.argv[3]||'docs/label-maker/vendor/tesseract/lang/eng_codes.traineddata.gz';
const compressed=fs.readFileSync(source),raw=zlib.gunzipSync(compressed);
const n=raw.readInt32LE(0);if(n!==24)throw new Error('Unexpected traineddata version');
const offsets=Array.from({length:n},(_,i)=>Number(raw.readBigInt64LE(4+8*i)));
const components=[];for(let i=0;i<n;i++)if(offsets[i]>=0){const end=offsets.slice(i+1).find(v=>v>=0)??raw.length;components[i]=raw.subarray(offsets[i],end);}
for(const required of[17,21,22,23])if(!components[required]?.length)throw new Error('Missing component '+required);
components[19]=undefined;const header=Buffer.alloc(4+8*n);header.writeInt32LE(n,0);
const payload=[header];let pos=header.length;for(let i=0;i<n;i++){header.writeBigInt64LE(components[i]?BigInt(pos):-1n,4+8*i);if(components[i]){payload.push(components[i]);pos+=components[i].length;}}
const repacked=Buffer.concat(payload);const result=zlib.gzipSync(repacked,{level:9,mtime:0});fs.writeFileSync(destination,result);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const report={source,destination,removed:[19],retained:components.flatMap((v,i)=>v?[i]:[]),sourceCompressedBytes:compressed.length,sourceRawBytes:raw.length,outputCompressedBytes:result.length,outputRawBytes:repacked.length,compressedReductionPercent:100*(1-result.length/compressed.length),sourceSHA256:sha(compressed),outputSHA256:sha(result)};
fs.writeFileSync(destination+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
