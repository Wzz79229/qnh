package com.xianqi.phonevalidation;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import com.google.zxing.common.BitArray;
import com.google.zxing.oned.Code128Reader;
import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.atomic.AtomicReference;

/** Native bitmap, read-only result UI and phone/tablet preview verification, no account needed. */
public final class LabelInstrumentation extends Instrumentation {
    private Bundle arguments;
    @Override public void onCreate(Bundle value){super.onCreate(value);arguments=value;start();}
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static void readOnly(View view){check(!(view instanceof EditText),"Product result must not be editable");if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int i=0;i<group.getChildCount();i++)readOnly(group.getChildAt(i));}}
    @Override public void onStart(){Bundle report=new Bundle();try{
        AtomicReference<Throwable> failure=new AtomicReference<>();
        runOnMainSync(()->{try{
            LabelContent value=LabelContent.create("示例商品 饮用水 500ml/瓶","500ml/瓶","2110000000000123456","A64-6-4");Bitmap image=LocationLabelRenderer.render(value);
            try{check(image.getConfig()==Bitmap.Config.RGB_565,"Expected compact black and white bitmap");check(image.getAllocationByteCount()<=945*709*2+709*4,"Bitmap allocation exceeded compact size");
                BitArray row=new BitArray(614);int[] scan=new int[945];image.getPixels(scan,0,945,0,330,945,1);for(int x=0;x<614;x++)if((scan[301+x]&255)<128)row.set(x);check(value.sku.equals(new Code128Reader().decodeRow(330,row,null).getText()),"Full SKU barcode failed");
                for(int y=0;y<709;y++){image.getPixels(scan,0,945,0,y,945,1);for(int color:scan)check((color&0xffffff)==0||(color&0xffffff)==0xffffff,"Image contains grey pixels");}
                byte[] png=LocationLabelRenderer.png(image);try(FileOutputStream out=new FileOutputStream(new File(getTargetContext().getFilesDir(),"label-native.png"))){out.write(png);}report.putInt("bitmapBytes",image.getAllocationByteCount());
            }finally{image.recycle();}
        }catch(Throwable error){failure.set(error);}});if(failure.get()!=null)throw new AssertionError(failure.get());
        boolean wide=arguments!=null&&"true".equals(arguments.getString("wide"));if(!wide)new InventoryFlowCheck(this).run();Intent intent=new Intent(getTargetContext(),LabelPreviewActivity.class);intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);intent.putExtra("wide",wide);startActivitySync(intent);
        for(int i=0;i<40;i++){waitForIdleSync();LabelPreviewActivity current=LabelPreviewActivity.latest;if(current!=null&&current.workspace.getWidth()>0&&(!wide||current.getResources().getConfiguration().orientation==android.content.res.Configuration.ORIENTATION_LANDSCAPE))break;Thread.sleep(200);}
        waitForIdleSync();LabelPreviewActivity current=LabelPreviewActivity.latest;check(current!=null,"Preview activity missing");
        runOnMainSync(()->{try{readOnly(current.workspace.productCard);check(current.workspace.save.isEnabled(),"Image export actions missing");}catch(Throwable error){failure.set(error);}});if(failure.get()!=null)throw new AssertionError(failure.get());
        saveScreenshot(wide?"workspace-wide.png":"workspace-query.png");
        if(!wide){runOnMainSync(()->current.workspace.revealResult());Thread.sleep(700);waitForIdleSync();saveScreenshot("workspace-label.png");}
        report.putString("stream","CHECKS PASSED: full SKU decoded, compact bitmap, read-only product fields, responsive preview, "+(wide?"wide screen":"actual native login, hidden WebView, SKU/name/location query and automatic preview")+".\n");runOnMainSync(()->current.finish());finish(Activity.RESULT_OK,report);
    }catch(Throwable error){report.putString("stream","CHECKS FAILED: "+error+"\n");finish(Activity.RESULT_CANCELED,report);}}
    private void saveScreenshot(String file)throws Exception{boolean focused=false;String found="none";for(int attempt=0;attempt<30;attempt++){android.view.accessibility.AccessibilityNodeInfo root=getUiAutomation().getRootInActiveWindow();if(root!=null){found=String.valueOf(root.getPackageName());focused=getTargetContext().getPackageName().equals(found);root.recycle();}if(focused)break;Thread.sleep(200);}Bitmap shot=getUiAutomation().takeScreenshot();check(shot!=null,"Screenshot unavailable");try(FileOutputStream out=new FileOutputStream(new File(getTargetContext().getFilesDir(),file))){shot.compress(Bitmap.CompressFormat.PNG,100,out);}finally{shot.recycle();}check(focused,"Screenshot must show app, without a system dialog; active="+found);}
}
