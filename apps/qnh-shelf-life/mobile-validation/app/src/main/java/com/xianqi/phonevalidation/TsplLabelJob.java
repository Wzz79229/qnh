package com.xianqi.phonevalidation;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** TSC TSPL BITMAP: MSB first, 0 is dark, 1 is white. 80×60 mm at 8 dots/mm. */
final class TsplLabelJob {
    static final int WIDTH=640,HEIGHT=480,ROW_BYTES=80;
    interface PixelRows {void read(int y,int[] row);}
    static byte[] encode(int copies,int gap,PixelRows pixels){
        if(copies<1||copies>20||gap<0||gap>5||pixels==null)throw new IllegalArgumentException("打印份数为1–20，标签间隙为0–5毫米。");
        ByteArrayOutputStream out=new ByteArrayOutputStream(39000);
        ascii(out,"SIZE 80 mm,60 mm\r\nGAP "+gap+" mm,0 mm\r\nDIRECTION 1,0\r\nREFERENCE 0,0\r\nOFFSET 0 mm\r\nCLS\r\nBITMAP 0,0,80,480,0,");
        int[] row=new int[WIDTH];byte[] data=new byte[ROW_BYTES];
        for(int y=0;y<HEIGHT;y++){pixels.read(y,row);Arrays.fill(data,(byte)255);for(int x=0;x<WIDTH;x++){int c=row[x];if((77*((c>>16)&255)+150*((c>>8)&255)+29*(c&255))<128*256)data[x/8]&=(byte)~(128>>(x%8));}out.write(data,0,data.length);}
        ascii(out,"\r\nPRINT 1,"+copies+"\r\n");return out.toByteArray();
    }
    private static void ascii(ByteArrayOutputStream out,String value){byte[] bytes=value.getBytes(StandardCharsets.US_ASCII);out.write(bytes,0,bytes.length);}
}
