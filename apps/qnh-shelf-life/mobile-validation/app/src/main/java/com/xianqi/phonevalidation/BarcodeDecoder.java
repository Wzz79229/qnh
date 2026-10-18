package com.xianqi.phonevalidation;
import com.google.zxing.*;
import com.google.zxing.common.HybridBinarizer;
import java.nio.ByteBuffer;
import java.util.*;

/** Uses the existing ZXing core on luminance only; no bitmap, photo file or upload. */
final class BarcodeDecoder {
    private final MultiFormatReader reader=new MultiFormatReader();
    BarcodeDecoder(){Map<DecodeHintType,Object> hints=new EnumMap<>(DecodeHintType.class);hints.put(DecodeHintType.POSSIBLE_FORMATS,Arrays.asList(BarcodeFormat.CODE_128,BarcodeFormat.CODE_39,BarcodeFormat.CODE_93,BarcodeFormat.EAN_13,BarcodeFormat.EAN_8,BarcodeFormat.UPC_A,BarcodeFormat.UPC_E,BarcodeFormat.ITF,BarcodeFormat.CODABAR,BarcodeFormat.QR_CODE));hints.put(DecodeHintType.TRY_HARDER,Boolean.TRUE);reader.setHints(hints);}
    static byte[] luminance(ByteBuffer buffer,int rowStride,int pixelStride,int width,int height){
        if(buffer==null||width<1||height<1||rowStride<1||pixelStride<1||(long)width*height>1920L*1440)throw new IllegalArgumentException("相机画面尺寸无效。");
        long span=(long)(width-1)*pixelStride+1,required=(long)(height-1)*rowStride+span;
        if(span>rowStride||required>buffer.remaining())throw new IllegalArgumentException("相机画面不完整。");
        byte[] output=new byte[width*height];ByteBuffer input=buffer.duplicate();int base=input.position();
        byte[] row=pixelStride==1?null:new byte[(int)span];
        for(int y=0;y<height;y++){input.position(base+y*rowStride);if(pixelStride==1)input.get(output,y*width,width);else{input.get(row);for(int x=0;x<width;x++)output[y*width+x]=row[x*pixelStride];}}
        return output;
    }
    static byte[] rgb(int[] pixels,int width,int height){if(pixels==null||width<1||height<1||(long)width*height>1280L*960||pixels.length<width*height)throw new IllegalArgumentException("扫码画面尺寸无效。");byte[] output=new byte[width*height];for(int i=0;i<output.length;i++){int c=pixels[i];output[i]=(byte)((((c>>>16)&255)*77+((c>>>8)&255)*150+(c&255)*29+128)>>>8);}return output;}
    Result decode(byte[] bytes,int width,int height){Result value=read(bytes,width,height,false);if(value!=null)return value;byte[] rotated=new byte[bytes.length];for(int y=0;y<height;y++)for(int x=0;x<width;x++)rotated[x*height+(height-1-y)]=bytes[y*width+x];value=read(rotated,height,width,false);if(value!=null)return value;value=read(bytes,width,height,true);return value!=null?value:read(rotated,height,width,true);}
    private Result read(byte[] bytes,int width,int height,boolean inverted){try{LuminanceSource source=new PlanarYUVLuminanceSource(bytes,width,height,0,0,width,height,false);if(inverted)source=source.invert();Result result=reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(source)));return SkuPolicy.decode(result.getText())==null?null:result;}catch(ReaderException|IllegalArgumentException ignored){return null;}finally{reader.reset();}}
    static String query(String raw,String format){String value=SkuPolicy.decode(raw);if(value==null)throw new IllegalArgumentException("条形码内容不适用于商品查询，请重新扫码。");if(Arrays.asList("EAN_13","EAN_8","UPC_A","UPC_E").contains(format))return "条码:"+value;if(SmartQuery.parse(value).key.equals("loc"))return "库位:"+value.toUpperCase(Locale.ROOT);return "SKU:"+value;}
}
