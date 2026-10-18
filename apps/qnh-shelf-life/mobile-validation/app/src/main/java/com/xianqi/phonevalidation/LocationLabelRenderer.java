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
    private static float mm(float value) { return value*DPI/25.4f; }
    private static float pt(float value) { return value*DPI/72f; }
    private static Paint paint(float points, boolean heavy) {
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
    static Bitmap render(LabelContent data) {
        float left=mm(2.5f), width=WIDTH-left*2, gap=mm(1), barcodeWidth=mm(52), barcodeHeight=mm(8);
        Paint namePaint=paint(11,false), specPaint=paint(15,false), skuPaint=paint(18,false);
        List<String> names=wrap(data.name,namePaint,width), specs=new ArrayList<>();
        String[] parts=("规格："+data.spec).split("\n",-1); java.util.Collections.addAll(specs,parts);
        for(String line:specs) if(width/Math.max(1,specPaint.measureText(line))<.6f) throw new IllegalArgumentException("规格过长，请在规格中添加换行后重新生成。");
        float nameLine=pt(11)+mm(2), specLine=pt(15)+mm(2), padding=mm(4), locSize=54;
        float fixed=names.size()*nameLine+specs.size()*specLine+barcodeHeight+gap*(specs.isEmpty()?2:3);
        if(fixed+pt(locSize)+padding*2>HEIGHT) padding=mm(2.5f);
        Paint locPaint=paint(locSize,true);
        while(locSize>16 && (locPaint.measureText(data.location)>width || fixed+pt(locSize)+padding*2>HEIGHT)) { locSize-=.5f; locPaint.setTextSize(pt(locSize)); }
        if(locPaint.measureText(data.location)>width || fixed+pt(locSize)+padding*2>HEIGHT) throw new IllegalArgumentException("标签内容超过 80×60 毫米，请精简商品名称、规格或库位后重新生成。");
        float skuWidth=width-barcodeWidth-gap, skuScale=Math.min(1,skuWidth/skuPaint.measureText(data.skuCaption()));
        if(skuScale<.6f) throw new IllegalArgumentException("SKU 文字无法清晰排入标签，请核对编码。");
        Bitmap bitmap=Bitmap.createBitmap(WIDTH,HEIGHT,Bitmap.Config.ARGB_8888); bitmap.setDensity(DPI); Canvas c=new Canvas(bitmap); c.drawColor(Color.WHITE);
        float y=(HEIGHT-fixed-pt(locSize))/2;
        for(int i=0;i<names.size();i++) { String line=names.get(i);
            center(c,line,left,y,width,nameLine,namePaint,false); y+=nameLine;
        } y+=gap;
        if(!specs.isEmpty()) { for(String line:specs) { center(c,line,left,y,width,specLine,specPaint,true); y+=specLine; } y+=gap; }
        Paint.FontMetrics skuMetrics=skuPaint.getFontMetrics();
        c.save(); c.translate(left,y+(barcodeHeight-skuMetrics.descent-skuMetrics.ascent)/2); c.scale(skuScale,1); c.drawText(data.skuCaption(),0,0,skuPaint); c.restore();
        boolean[] bits=data.barcode(); float module=barcodeWidth/(bits.length+20);
        float barcodeLeft=left+width-barcodeWidth+10*module;
        Paint bars=new Paint(); bars.setColor(Color.BLACK); int top=Math.round(y),bottom=Math.round(y+barcodeHeight);
        for(int index=0;index<bits.length;index++) if(bits[index]) c.drawRect(Math.round(barcodeLeft+index*module),top,Math.round(barcodeLeft+(index+1)*module),bottom,bars);
        y+=barcodeHeight+gap; center(c,data.location,left,y,width,pt(locSize),locPaint,false);
        int[] pixels=new int[WIDTH*HEIGHT]; bitmap.getPixels(pixels,0,WIDTH,0,0,WIDTH,HEIGHT);
        for(int i=0;i<pixels.length;i++) pixels[i]=Color.red(pixels[i])<128?Color.BLACK:Color.WHITE;
        bitmap.setPixels(pixels,0,WIDTH,0,0,WIDTH,HEIGHT); return bitmap;
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
