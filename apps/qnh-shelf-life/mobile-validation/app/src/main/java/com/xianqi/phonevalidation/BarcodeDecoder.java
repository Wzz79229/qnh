package com.xianqi.phonevalidation;
import com.google.zxing.*;
import com.google.zxing.common.HybridBinarizer;
import java.nio.ByteBuffer;
import java.util.*;

/** Uses the existing ZXing core on luminance only; no bitmap, photo file or upload. */
final class BarcodeDecoder {
    private final MultiFormatReader reader=new MultiFormatReader();
    BarcodeDecoder(){Map<DecodeHintType,Object> hints=new EnumMap<>(DecodeHintType.class);hints.put(DecodeHintType.POSSIBLE_FORMATS,Arrays.asList(BarcodeFormat.CODE_128,BarcodeFormat.CODE_39,BarcodeFormat.CODE_93,BarcodeFormat.EAN_13,BarcodeFormat.EAN_8,BarcodeFormat.UPC_A,BarcodeFormat.UPC_E,BarcodeFormat.ITF,BarcodeFormat.CODABAR,BarcodeFormat.QR_CODE));hints.put(DecodeHintType.TRY_HARDER,Boolean.TRUE);reader.setHints(hints);}
    static byte[] luminance(ByteBuffer buffer,int rowStride,int pixelStride,int width,int height){byte[] output=new byte[width*height];int base=buffer.position();for(int y=0;y<height;y++)for(int x=0;x<width;x++)output[y*width+x]=buffer.get(base+y*rowStride+x*pixelStride);return output;}
    Result decode(byte[] bytes,int width,int height){Result value=read(bytes,width,height);if(value!=null)return value;byte[] rotated=new byte[bytes.length];for(int y=0;y<height;y++)for(int x=0;x<width;x++)rotated[x*height+(height-1-y)]=bytes[y*width+x];return read(rotated,height,width);}
    private Result read(byte[] bytes,int width,int height){try{int x=width/20,y=height/10;LuminanceSource source=new PlanarYUVLuminanceSource(bytes,width,height,x,y,width-x*2,height-y*2,false);Result result=reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(source)));return SkuPolicy.decode(result.getText())==null?null:result;}catch(ReaderException|IllegalArgumentException ignored){return null;}finally{reader.reset();}}
    static String query(String raw,String format){String value=SkuPolicy.decode(raw);if(value==null)throw new IllegalArgumentException("条形码内容不适用于商品查询，请重新扫码。");if(Arrays.asList("EAN_13","EAN_8","UPC_A","UPC_E").contains(format))return "条码:"+value;if(SmartQuery.parse(value).key.equals("loc"))return "库位:"+value.toUpperCase(Locale.ROOT);return "SKU:"+value;}
}
