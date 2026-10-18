package com.xianqi.phonevalidation;
import org.junit.Test;
import static org.junit.Assert.*;
import com.google.zxing.*;
import com.google.zxing.common.BitMatrix;
import java.nio.ByteBuffer;
public class BarcodeDecoderTest {
    @Test public void decodesFull19DigitSkuAndRotatedFrames()throws Exception{String sku="0012345678901988220";int w=640,h=480;BitMatrix bars=new com.google.zxing.oned.Code128Writer().encode(sku,BarcodeFormat.CODE_128,w,180);byte[] y=new byte[w*h];java.util.Arrays.fill(y,(byte)255);for(int row=0;row<180;row++)for(int x=0;x<w;x++)if(bars.get(x,row))y[(row+150)*w+x]=0;BarcodeDecoder decoder=new BarcodeDecoder();assertEquals(sku,decoder.decode(y,w,h).getText());byte[] rotated=new byte[y.length];for(int row=0;row<h;row++)for(int x=0;x<w;x++)rotated[x*h+h-1-row]=y[row*w+x];assertEquals(sku,decoder.decode(rotated,h,w).getText());}
    @Test public void handlesCameraRowPaddingAndPixelStride(){assertArrayEquals(new byte[]{1,2,3,4,5,6},BarcodeDecoder.luminance(ByteBuffer.wrap(new byte[]{1,2,3,9,9,4,5,6}),5,1,3,2));assertArrayEquals(new byte[]{1,2,3,4},BarcodeDecoder.luminance(ByteBuffer.wrap(new byte[]{1,9,2,9,4,3,9,4}),5,2,2,2));}
    @Test public void scanQueryPreservesIdentifiersAndUsesActualBarcodeType(){assertEquals("SKU:0012345678901988220",BarcodeDecoder.query("0012345678901988220","CODE_128"));assertEquals("条码:0123456789012",BarcodeDecoder.query("0123456789012","EAN_13"));assertEquals("库位:A10-1-1",BarcodeDecoder.query("a10-1-1","CODE_128"));assertEquals("SKU:abc_DEF",BarcodeDecoder.query("abc_DEF","CODE_128"));try{BarcodeDecoder.query("https://example.com","QR_CODE");fail();}catch(IllegalArgumentException expected){}}
}
