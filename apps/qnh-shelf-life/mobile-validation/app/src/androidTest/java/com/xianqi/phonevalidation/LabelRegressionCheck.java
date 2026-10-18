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
        Paint paint=new Paint();paint.setTypeface(Typeface.create(Typeface.MONOSPACE,Typeface.BOLD));paint.setTextSize(18*300/72f);
        float width=22*300/25.4f,height=8*300/25.4f;
        check(width/paint.measureText("SKU:198822")<.6f,"Regression font must reproduce the old rejection");
        LabelCaptionLayout.Metrics metrics=new LabelCaptionLayout.Metrics(){public float width(String text,float points){paint.setTextSize(points*300/72f);return paint.measureText(text);}public float height(float points){paint.setTextSize(points*300/72f);Paint.FontMetrics fm=paint.getFontMetrics();return fm.descent-fm.ascent;}};
        LabelCaptionLayout.Plan plan=LabelCaptionLayout.fit("SKU:198822",width,height,metrics);check(plan.points>=9,"Caption became too small");for(String line:plan.lines)check(metrics.width(line,plan.points)<=width,"Caption overflow");
        LabelContent value=LabelContent.create("【规格可选】示例泡沫地垫 厚1cm 儿童爬行垫 加厚拼接地板垫 1片/份","白色30×30cm",SKU,"A10-1-1");
        verify(test,LocationLabelRenderer.render(value),"label-regression.png");verify(test,LocationLabelRenderer.renderFor720W(value),"label-regression-720w.png");
    }
    private static void verify(Instrumentation test,Bitmap image,String file)throws Exception{try{
        boolean decoded=false;int[] pixels=new int[image.getWidth()];
        for(int y=0;y<image.getHeight()&&!decoded;y++){image.getPixels(pixels,0,pixels.length,0,y,pixels.length,1);BitArray row=new BitArray(pixels.length);for(int x=0;x<pixels.length;x++)if((pixels[x]&255)<128)row.set(x);try{decoded=SKU.equals(new Code128Reader().decodeRow(y,row,null).getText());}catch(com.google.zxing.ReaderException ignored){}}
        check(decoded,"Long product full SKU did not decode: "+file);try(FileOutputStream out=new FileOutputStream(new File(test.getTargetContext().getFilesDir(),file))){image.compress(Bitmap.CompressFormat.PNG,100,out);}
    }finally{image.recycle();}}
}
