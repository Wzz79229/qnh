package com.xianqi.phonevalidation;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.zip.DeflaterOutputStream;

/** Lossless one-bit images, exact 80x60 mm PDF pages, no print service or external PDF SDK. */
final class LabelPdf {
    static final String WIDTH="226.7716535433",HEIGHT="170.0787401575";
    private static final class Sink extends OutputStream{final OutputStream out;long count=0;Sink(OutputStream out){this.out=out;}@Override public void write(int b)throws IOException{out.write(b);count++;}@Override public void write(byte[] b,int off,int len)throws IOException{out.write(b,off,len);count+=len;}void text(String value)throws IOException{write(value.getBytes(StandardCharsets.US_ASCII));}void flushToOutput()throws IOException{out.flush();}}
    private static void allowed(LabelGallery.Allowed allowed)throws IOException{if(Thread.currentThread().isInterrupted()||!allowed.valid())throw new IOException("PDF保存已取消。");}
    static void write(LabelBatch batch,OutputStream target,LabelGallery.Allowed allowed)throws Exception{
        allowed(allowed);Sink out=new Sink(target);int count=2+batch.size()*3;long[] offsets=new long[count+1];out.text("%PDF-1.4\n%");out.write(new byte[]{(byte)0xe2,(byte)0xe3,(byte)0xcf,(byte)0xd3});out.text("\n");
        offsets[1]=out.count;out.text("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");offsets[2]=out.count;out.text("2 0 obj\n<< /Type /Pages /Count "+batch.size()+" /Kids [");for(int i=0;i<batch.size();i++)out.text((3+i*3)+" 0 R ");out.text("] >>\nendobj\n");
        for(int i=0;i<batch.size();i++){
            allowed(allowed);int page=3+i*3,content=page+1,image=page+2;offsets[page]=out.count;out.text(page+" 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 "+WIDTH+" "+HEIGHT+"] /Resources << /XObject << /Label "+image+" 0 R >> >> /Contents "+content+" 0 R >>\nendobj\n");
            byte[] commands=("q\n"+WIDTH+" 0 0 "+HEIGHT+" 0 0 cm\n/Label Do\nQ\n").getBytes(StandardCharsets.US_ASCII);offsets[content]=out.count;out.text(content+" 0 obj\n<< /Length "+commands.length+" >>\nstream\n");out.write(commands);out.text("endstream\nendobj\n");
            BitmapFactory.Options options=new BitmapFactory.Options();options.inScaled=false;options.inPreferredConfig=Bitmap.Config.RGB_565;byte[] png=batch.get(i).png;Bitmap bitmap=BitmapFactory.decodeByteArray(png,0,png.length,options);if(bitmap==null)throw new IOException("标签图片读取失败。");byte[] data;int width=bitmap.getWidth(),height=bitmap.getHeight();
            try{ByteArrayOutputStream compressed=new ByteArrayOutputStream();try(DeflaterOutputStream zip=new DeflaterOutputStream(compressed)){int[] pixels=new int[width];byte[] row=new byte[(width+7)/8];for(int y=0;y<height;y++){allowed(allowed);bitmap.getPixels(pixels,0,width,0,y,width,1);java.util.Arrays.fill(row,(byte)255);for(int x=0;x<width;x++)if((pixels[x]&255)<128)row[x/8]&=(byte)~(128>>(x%8));zip.write(row);}}data=compressed.toByteArray();}finally{bitmap.recycle();}
            offsets[image]=out.count;out.text(image+" 0 obj\n<< /Type /XObject /Subtype /Image /Width "+width+" /Height "+height+" /ColorSpace /DeviceGray /BitsPerComponent 1 /Interpolate false /Filter /FlateDecode /Length "+data.length+" >>\nstream\n");out.write(data);out.text("\nendstream\nendobj\n");
        }
        allowed(allowed);long xref=out.count;out.text("xref\n0 "+(count+1)+"\n0000000000 65535 f \n");for(int i=1;i<=count;i++)out.text(String.format(Locale.ROOT,"%010d 00000 n \n",offsets[i]));out.text("trailer\n<< /Size "+(count+1)+" /Root 1 0 R >>\nstartxref\n"+xref+"\n%%EOF\n");out.flushToOutput();
    }
}
