package com.xianqi.phonevalidation;

import com.google.zxing.common.BitArray;
import com.google.zxing.oned.Code128Reader;

/** Desktop JVM check of the actual delivered PNG, separate from Android's API stubs. */
public final class LabelPngTest {
    public static void main(String[] args) throws Exception {
        java.nio.file.Path path=java.nio.file.Path.of(args[0]);
        java.awt.image.BufferedImage image=javax.imageio.ImageIO.read(path.toFile());
        if(image.getWidth()!=945 || image.getHeight()!=709) throw new AssertionError("Label dimensions");
        BitArray scan=new BitArray(614); for(int x=0;x<614;x++) if((image.getRGB(301+x,330)&255)<128) scan.set(x);
        String actual=new Code128Reader().decodeRow(330,scan,null).getText();
        if(!"2110000000000123456".equals(actual)) throw new AssertionError("Full SKU barcode mismatch");
        for(int y=0;y<image.getHeight();y++)for(int x=0;x<image.getWidth();x++){int rgb=image.getRGB(x,y)&0xffffff;if(rgb!=0 && rgb!=0xffffff)throw new AssertionError("Expected pure black/white");}
        byte[] png=java.nio.file.Files.readAllBytes(path); boolean density=false;
        for(int offset=8;offset+12<=png.length;){int size=java.nio.ByteBuffer.wrap(png,offset,4).getInt();String type=new String(png,offset+4,4,java.nio.charset.StandardCharsets.US_ASCII);
            if(size<0 || offset+12L+size>png.length) throw new AssertionError("PNG chunk length");
            if("pHYs".equals(type)){density=size==9 && java.nio.ByteBuffer.wrap(png,offset+8,4).getInt()==11811 && java.nio.ByteBuffer.wrap(png,offset+12,4).getInt()==11811 && png[offset+16]==1;}
            offset+=size+12;
        }
        if(!density)throw new AssertionError("Expected 300 DPI metadata");
        System.out.println("Label PNG verified: 945x709, 300 DPI, black/white, full SKU decoded.");
    }
}
