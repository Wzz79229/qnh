package com.xianqi.phonevalidation;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.CRC32;

/** Port of the user's 80 x 60 mm printer template: name/spec/SKU row/large location. */
final class LocationLabelRenderer {
    static final int DPI=300, WIDTH=945, HEIGHT=709;
    private final float resolution; private final int targetWidth,targetHeight;
    private LocationLabelRenderer(float resolution,int width,int height){this.resolution=resolution;targetWidth=width;targetHeight=height;}
    private float mm(float value) { return value*resolution/25.4f; }
    private float pt(float value) { return value*resolution/72f; }
    private Paint paint(float points, boolean heavy) {
        Paint p=new Paint(Paint.ANTI_ALIAS_FLAG); p.setColor(Color.BLACK); p.setTextSize(pt(points));
        p.setTypeface(Typeface.create(heavy?"sans-serif-black":"sans-serif",Typeface.BOLD)); return p;
    }
    private static List<String> wrap(String value, Paint p,float width) {
        List<String> lines=new ArrayList<>();
        for(String paragraph:value.split("\n",-1)) { if(paragraph.isEmpty()) { lines.add(""); continue; }
            while(!paragraph.isEmpty()) { int n=p.breakText(paragraph,true,width,null); if(n<1) throw new IllegalArgumentException("商品名称无法排入标签。");
                if(n<paragraph.length() && Character.isHighSurrogate(paragraph.charAt(n-1))) n--; if(n<1) throw new IllegalArgumentException("商品名称无法排入标签。");
                lines.add(paragraph.substring(0,n)); paragraph=paragraph.substring(n); }
        } return lines;
    }
    private static void center(Canvas c,String text,float x,float y,float width,float height,Paint p,boolean shrink) {
        float scale=shrink?Math.min(1,width/Math.max(1,p.measureText(text))):1;
        Paint.FontMetrics f=p.getFontMetrics(); float baseline=y+(height-f.descent-f.ascent)/2;
        c.save(); c.translate(x+(width-p.measureText(text)*scale)/2,baseline); c.scale(scale,1); c.drawText(text,0,0,p); c.restore();
    }
    static Bitmap render(LabelContent data) {return new LocationLabelRenderer(DPI,WIDTH,HEIGHT).draw(data);}
    static final class Layout {
        float left,width,gap,barcodeWidth,barcodeHeight,nameLine,specLine,skuLine,locSize,padding,top,totalHeight;
        List<String> names,specs;Paint namePaint,specPaint,skuPaint,locPaint;LabelCaptionLayout.Plan caption;
    }
    static Layout layout(LabelContent data){return new LocationLabelRenderer(DPI,WIDTH,HEIGHT).measure(data);}
    private Layout measure(LabelContent data){
        Layout p=new Layout();p.left=mm(2.5f);p.width=targetWidth-p.left*2;p.gap=mm(1);p.barcodeWidth=mm(52);p.barcodeHeight=mm(8);
        p.namePaint=paint(11,false);p.specPaint=paint(15,false);p.skuPaint=paint(18,false);p.skuPaint.setTypeface(LabelFonts.sku());
        p.names=wrap(data.name,p.namePaint,p.width);
        // Specification preserves explicit line breaks; long lines squeeze horizontally.
        p.specs=new ArrayList<>();if(!data.spec.isEmpty())java.util.Collections.addAll(p.specs,("规格："+data.spec).split("\\n",-1));
        p.nameLine=pt(11)+mm(2);p.specLine=pt(15)+mm(2);p.skuLine=pt(19.8f);p.padding=mm(4);p.locSize=54;
        float fixed=p.names.size()*p.nameLine+p.specs.size()*p.specLine+p.barcodeHeight+p.gap*(p.specs.isEmpty()?2:3);
        if(fixed+pt(p.locSize)+p.padding*2>targetHeight)p.padding=mm(2.5f);
        p.locPaint=paint(p.locSize,true);
        while(p.locSize>16&&(p.locPaint.measureText(data.location)>p.width||fixed+pt(p.locSize)+p.padding*2>targetHeight)){p.locSize-=.5f;p.locPaint.setTextSize(pt(p.locSize));}
        if(p.locPaint.measureText(data.location)>p.width||fixed+pt(p.locSize)+p.padding*2>targetHeight)throw new IllegalArgumentException("商品资料超过标签可容纳范围，请在牵牛花维护资料后重新查询。");
        p.caption=LabelCaptionLayout.fit(data.skuCaption(),p.width-p.barcodeWidth-p.gap,p.barcodeHeight,new LabelCaptionLayout.Metrics(){
            public float width(String text,float points){return p.skuPaint.measureText(text);}
            public float height(float points){android.graphics.Rect bounds=new android.graphics.Rect();p.skuPaint.getTextBounds(data.skuCaption(),0,data.skuCaption().length(),bounds);return bounds.height();}
        });
        p.totalHeight=fixed+pt(p.locSize);p.top=(targetHeight-p.totalHeight)/2;return p;
    }
    private static void justified(Canvas c,String text,float x,float y,float width,float height,Paint p){
        int count=text.codePointCount(0,text.length());if(count<2){center(c,text,x,y,width,height,p,false);return;}
        Paint.FontMetrics f=p.getFontMetrics();float baseline=y+(height-f.descent-f.ascent)/2,extra=(width-p.measureText(text))/(count-1);
        for(int offset=0;offset<text.length();){int end=offset+Character.charCount(text.codePointAt(offset));String character=text.substring(offset,end);c.drawText(character,x,baseline,p);x+=p.measureText(character)+extra;offset=end;}
    }
    private Bitmap draw(LabelContent data) {
        Layout p=measure(data);Bitmap bitmap=Bitmap.createBitmap(targetWidth,targetHeight,Bitmap.Config.RGB_565);bitmap.setDensity(Math.round(resolution));Canvas c=new Canvas(bitmap);c.drawColor(Color.WHITE);float y=p.top;
        for(int i=0;i<p.names.size();i++){String line=p.names.get(i);if(i+1==p.names.size())center(c,line,p.left,y,p.width,p.nameLine,p.namePaint,false);else justified(c,line,p.left,y,p.width,p.nameLine,p.namePaint);y+=p.nameLine;}y+=p.gap;
        if(!p.specs.isEmpty()){for(String line:p.specs){center(c,line,p.left,y,p.width,p.specLine,p.specPaint,true);y+=p.specLine;}y+=p.gap;}
        // Caption and barcode stay in one group, centered vertically. Only the text
        // is horizontally compressed; its font size and the barcode width stay fixed.
        android.graphics.Rect ink=new android.graphics.Rect();p.skuPaint.getTextBounds(data.skuCaption(),0,data.skuCaption().length(),ink);float textWidth=p.skuPaint.measureText(data.skuCaption())*p.caption.scale,groupWidth=textWidth+p.gap+p.barcodeWidth;
        float captionLeft=p.left+(p.width-groupWidth)/2,baseline=y+(p.barcodeHeight-ink.height())/2-ink.top;
        c.save();c.translate(captionLeft,baseline);c.scale(p.caption.scale,1);c.drawText(data.skuCaption(),0,0,p.skuPaint);c.restore();
        boolean[] bits=data.barcode();float module=p.barcodeWidth/(bits.length+20);if(module<3)throw new IllegalArgumentException("当前打印分辨率无法清晰显示该SKU条码。");
        float barcodeLeft=captionLeft+textWidth+p.gap+(p.barcodeWidth-bits.length*module)/2;Paint bars=new Paint();bars.setColor(Color.BLACK);int top=Math.round(y),bottom=Math.round(y+p.barcodeHeight);
        for(int index=0;index<bits.length;index++)if(bits[index])c.drawRect(Math.round(barcodeLeft+index*module),top,Math.round(barcodeLeft+(index+1)*module),bottom,bars);
        y+=p.barcodeHeight+p.gap;center(c,data.location,p.left,y,p.width,pt(p.locSize),p.locPaint,false);
        // Process small strips: the same monochrome pixels with far fewer JNI
        // calls, while keeping scratch memory at about 120 KB per label.
        int[] pixels=new int[targetWidth*32];for(int row=0;row<targetHeight;row+=32){int height=Math.min(32,targetHeight-row),length=targetWidth*height;bitmap.getPixels(pixels,0,targetWidth,0,row,targetWidth,height);for(int i=0;i<length;i++)pixels[i]=Color.red(pixels[i])<128?Color.BLACK:Color.WHITE;bitmap.setPixels(pixels,0,targetWidth,0,row,targetWidth,height);}return bitmap;
    }
    static byte[] png(Bitmap bitmap) throws Exception {
        ByteArrayOutputStream raw=new ByteArrayOutputStream(); if(!bitmap.compress(Bitmap.CompressFormat.PNG,100,raw)) throw new Exception();
        byte[] input=raw.toByteArray(),density=ByteBuffer.allocate(9).putInt(11811).putInt(11811).put((byte)1).array();
        ByteArrayOutputStream result=new ByteArrayOutputStream(); result.write(input,0,8);
        for(int offset=8;offset+12<=input.length;) {
            int size=ByteBuffer.wrap(input,offset,4).getInt(); if(size<0 || offset+12L+size>input.length) throw new Exception();
            String type=new String(input,offset+4,4,StandardCharsets.US_ASCII);
            if(!"pHYs".equals(type)) result.write(input,offset,size+12);
            if("IHDR".equals(type)) { byte[] tag="pHYs".getBytes(StandardCharsets.US_ASCII); CRC32 crc=new CRC32(); crc.update(tag); crc.update(density);
                result.write(ByteBuffer.allocate(4).putInt(9).array()); result.write(tag); result.write(density); result.write(ByteBuffer.allocate(4).putInt((int)crc.getValue()).array()); }
            offset+=size+12;
        } return result.toByteArray();
    }
}
