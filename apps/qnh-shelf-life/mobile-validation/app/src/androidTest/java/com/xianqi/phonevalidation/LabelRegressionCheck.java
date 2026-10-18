package com.xianqi.phonevalidation;

import android.app.Instrumentation;
import android.graphics.Bitmap;
import android.graphics.Paint;
import android.graphics.Typeface;
import com.google.zxing.common.BitArray;
import com.google.zxing.oned.Code128Reader;
import java.io.File;
import java.io.FileOutputStream;

/** Synthetic long-name/19-digit-SKU regression; contains no account or store data. */
final class LabelRegressionCheck {
    static final String SKU="2110000000000198822";
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static void run(Instrumentation test)throws Exception{
        Paint paint=new Paint();paint.setTypeface(LabelFonts.sku());paint.setTextSize(18*300/72f);
        float width=22*300/25.4f,height=8*300/25.4f;
        LabelCaptionLayout.Metrics metrics=new LabelCaptionLayout.Metrics(){public float width(String text,float points){paint.setTextSize(points*300/72f);return paint.measureText(text);}public float height(float points){paint.setTextSize(points*300/72f);Paint.FontMetrics fm=paint.getFontMetrics();return fm.descent-fm.ascent;}};
        LabelCaptionLayout.Plan plan=LabelCaptionLayout.fit("SKU:198822",width,height,metrics);check(plan.points==18&&plan.lines.length==1&&plan.scale>=.6f,"SKU caption must remain 18pt on one line");
        LabelContent example=LabelContent.create("农夫山泉 饮用天然水 550ml×24瓶","550ml×24瓶",SKU,"C56-2-2");LocationLabelRenderer.Layout layout=LocationLabelRenderer.layout(example);
        check(Math.abs(layout.barcodeWidth-52*300/25.4f)<.01f&&Math.abs(layout.barcodeHeight-8*300/25.4f)<.01f,"Barcode must remain 52 x 8 mm");
        check(Math.abs(layout.gap-300/25.4f)<.01f&&Math.abs(layout.left-2.5f*300/25.4f)<.01f,"Template gap or horizontal margin changed");
        check(Math.abs(layout.nameLine-(11*300/72f+2*300/25.4f))<.01f&&Math.abs(layout.specLine-(15*300/72f+2*300/25.4f))<.01f,"Template internal line heights changed");
        check(layout.skuPaint.getTypeface()==LabelFonts.sku(),"SKU must use the bundled face, not the phone system font");check(layout.locSize==54&&layout.caption.points==18&&layout.caption.lines.length==1,"Template font sizes changed");check(Math.abs(layout.top-(709-layout.totalHeight)/2)<.01f&&layout.top>=layout.padding,"Complete content must be vertically centered inside margins");
        String longSpec="白色30×30cm 超长规格文字用于检验必须横向压缩不能自动换成多行 超长规格文字用于检验";LocationLabelRenderer.Layout single=LocationLabelRenderer.layout(LabelContent.create("示例商品",longSpec,SKU,"A10-1-1"));check(single.specs.size()==1&&single.specs.get(0).equals("规格："+longSpec),"Specification was automatically wrapped or lost its prefix");
        LocationLabelRenderer.Layout manual=LocationLabelRenderer.layout(LabelContent.create("示例商品","第一行\n第二行",SKU,"A10-1-1")),blank=LocationLabelRenderer.layout(LabelContent.create("示例商品","",SKU,"A10-1-1"));check(manual.specs.size()==2&&manual.specs.get(1).equals("第二行")&&blank.specs.isEmpty(),"Manual specification breaks or empty specification changed");
        LocationLabelRenderer.Layout small=LocationLabelRenderer.layout(LabelContent.create("示例商品","",SKU,"A10-1-123456"));check(small.locSize<54&&small.locSize>=16&&small.locSize*2==(int)(small.locSize*2),"Location must shrink in half-point steps");
        verify(test,LocationLabelRenderer.render(example),"label-template.png");
        LabelContent value=LabelContent.create("【规格可选】示例泡沫地垫 厚1cm 儿童爬行垫 加厚拼接地板垫 1片/份","白色30×30cm",SKU,"A10-1-1");
        verify(test,LocationLabelRenderer.render(value),"label-regression.png");
    }
    private static void verify(Instrumentation test,Bitmap image,String file)throws Exception{try{
        boolean decoded=false;int[] pixels=new int[image.getWidth()];
        for(int y=0;y<image.getHeight()&&!decoded;y++){image.getPixels(pixels,0,pixels.length,0,y,pixels.length,1);BitArray row=new BitArray(pixels.length);for(int x=0;x<pixels.length;x++)if((pixels[x]&255)<128)row.set(x);try{decoded=SKU.equals(new Code128Reader().decodeRow(y,row,null).getText());}catch(com.google.zxing.ReaderException ignored){}}
        check(decoded,"Long product full SKU did not decode: "+file);try(FileOutputStream out=new FileOutputStream(new File(test.getTargetContext().getFilesDir(),file))){image.compress(Bitmap.CompressFormat.PNG,100,out);}
    }finally{image.recycle();}}
}
