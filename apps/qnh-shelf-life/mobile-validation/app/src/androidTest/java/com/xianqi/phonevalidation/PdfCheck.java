package com.xianqi.phonevalidation;
import android.app.*;
import android.content.*;
import android.graphics.*;
import android.graphics.pdf.PdfRenderer;
import android.os.ParcelFileDescriptor;
import androidx.core.content.FileProvider;
import com.google.zxing.common.BitArray;
import com.google.zxing.oned.Code128Reader;
import java.io.*;
import java.nio.file.Files;

/** Actual PDF button -> document result -> output bytes -> native PDF rendering and barcode decode. */
final class PdfCheck {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static void run(Instrumentation test,Activity activity,LabelWorkspace ui,LabelBatch batch)throws Exception{
        File folder=new File(activity.getCacheDir(),"labels");check(folder.mkdirs()||folder.isDirectory(),"PDF output directory missing");File target=new File(folder,"pdf-export-test.pdf");android.net.Uri uri=FileProvider.getUriForFile(activity,activity.getPackageName()+".labels",target);
        IntentFilter filter=new IntentFilter(Intent.ACTION_CREATE_DOCUMENT);filter.addCategory(Intent.CATEGORY_OPENABLE);filter.addDataType("application/pdf");Instrumentation.ActivityMonitor monitor=test.addMonitor(filter,new Instrumentation.ActivityResult(Activity.RESULT_OK,new Intent().setData(uri)),true);
        try{test.runOnMainSync(()->ui.pdf.performClick());boolean saved=false;for(int i=0;i<200;i++){java.util.concurrent.atomic.AtomicBoolean ready=new java.util.concurrent.atomic.AtomicBoolean();test.runOnMainSync(()->{try{java.lang.reflect.Field f=LocationLabelActivity.class.getDeclaredField("exporting");f.setAccessible(true);ready.set(!f.getBoolean(activity)&&target.length()>0);}catch(Exception e){throw new AssertionError(e);}});if(ready.get()){saved=true;break;}Thread.sleep(100);}check(saved&&monitor.getHits()==1,"PDF save action did not write the selected document");}finally{test.removeMonitor(monitor);}
        File pdf=new File(activity.getFilesDir(),"labels-batch.pdf");Files.copy(target.toPath(),pdf.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        try(ParcelFileDescriptor fd=ParcelFileDescriptor.open(pdf,ParcelFileDescriptor.MODE_READ_ONLY);PdfRenderer renderer=new PdfRenderer(fd)){check(renderer.getPageCount()==batch.size(),"PDF page count does not match label count");for(int index=0;index<renderer.getPageCount();index++)try(PdfRenderer.Page page=renderer.openPage(index)){check(Math.abs(page.getWidth()-227)<=1&&Math.abs(page.getHeight()-170)<=1,"PDF physical page size changed");Bitmap image=Bitmap.createBitmap(945,709,Bitmap.Config.ARGB_8888);image.eraseColor(Color.WHITE);page.render(image,null,null,PdfRenderer.Page.RENDER_MODE_FOR_PRINT);try{int[] pixels=new int[945];boolean found=false;for(int y=0;y<709&&!found;y++){image.getPixels(pixels,0,945,0,y,945,1);BitArray row=new BitArray(945);for(int x=0;x<945;x++)if((pixels[x]&255)<128)row.set(x);try{String sku=new Code128Reader().decodeRow(y,row,null).getText();check(batch.get(index).content.sku.equals(sku),"PDF page contains a different SKU");found=true;}catch(com.google.zxing.ReaderException ignored){}}check(found,"PDF-rendered barcode failed");try(FileOutputStream out=new FileOutputStream(new File(activity.getFilesDir(),"pdf-page-"+(index+1)+".png"))){image.compress(Bitmap.CompressFormat.PNG,100,out);}}finally{image.recycle();}}}
        try(FileOutputStream out=new FileOutputStream(new File(activity.getFilesDir(),"pdf-check.json"))){out.write(("{\"pages\":"+batch.size()+",\"widthMm\":80,\"heightMm\":60,\"nativeRenderBarcodeDecode\":true}\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));}target.delete();
    }
}
