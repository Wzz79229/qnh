package com.xianqi.phonevalidation;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.provider.MediaStore;
import com.google.zxing.common.BitArray;
import com.google.zxing.oned.Code128Reader;
import java.io.File;
import java.io.FileOutputStream;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/** Actual MediaStore writes via one click, exact-byte/barcode verification and cancellation rollback. */
final class GalleryCheck {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static Map<Uri,String> images(Context context){Map<Uri,String> result=new LinkedHashMap<>();try(Cursor c=context.getContentResolver().query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,new String[]{"_id","_display_name"},null,null,"_id ASC")){if(c!=null)while(c.moveToNext())result.put(ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,c.getLong(0)),c.getString(1));}return result;}
    static void run(Instrumentation test,Activity activity,LabelWorkspace ui,LabelBatch batch)throws Exception{
        Context context=test.getTargetContext();Map<Uri,String> before=images(context);test.runOnMainSync(()->ui.save.performClick());
        boolean complete=false;for(int attempt=0;attempt<150;attempt++){AtomicBoolean ready=new AtomicBoolean();test.runOnMainSync(()->{try{java.lang.reflect.Field f=LocationLabelActivity.class.getDeclaredField("exporting");f.setAccessible(true);java.lang.reflect.Field status=LabelWorkspace.class.getDeclaredField("status");status.setAccessible(true);ready.set(!f.getBoolean(activity)&&((android.widget.TextView)status.get(ui)).getText().toString().contains("已保存 2 张"));}catch(Exception e){throw new AssertionError(e);}});if(ready.get()){complete=true;break;}Thread.sleep(100);}check(complete,"One-click gallery save did not complete");
        Map<Uri,String> added=images(context);added.keySet().removeAll(before.keySet());check(added.size()==2,"One click must create two separate gallery images");
        Set<String> decoded=new HashSet<>();try{int index=0;for(Map.Entry<Uri,String> item:added.entrySet()){
            byte[] bytes;try(java.io.InputStream in=context.getContentResolver().openInputStream(item.getKey())){check(in!=null,"Saved gallery image missing");bytes=in.readAllBytes();}
            check(Arrays.equals(bytes,batch.get(index).png),"Gallery save changed the PNG bytes/order");check(item.getValue().endsWith(batch.imageName(index)),"Gallery filename lost full SKU or unique index");
            Bitmap image=BitmapFactory.decodeByteArray(bytes,0,bytes.length);check(image!=null&&image.getWidth()==945&&image.getHeight()==709,"Gallery image dimensions changed");try{int[] pixels=new int[945];boolean found=false;for(int y=0;y<709&&!found;y++){image.getPixels(pixels,0,945,0,y,945,1);BitArray line=new BitArray(945);for(int x=0;x<945;x++)if((pixels[x]&255)<128)line.set(x);try{String sku=new Code128Reader().decodeRow(y,line,null).getText();check(batch.get(index).content.sku.equals(sku),"Saved full SKU changed");decoded.add(sku);found=true;}catch(com.google.zxing.ReaderException ignored){}}check(found,"Saved PNG barcode failed");}finally{image.recycle();}
            try(FileOutputStream out=new FileOutputStream(new File(context.getFilesDir(),String.format(Locale.ROOT,"batch-%03d.png",index+1)))){out.write(bytes);}index++;
        }
            check(decoded.size()==2,"Batch repeated one product instead of saving each selected SKU");Set<Uri> successful=new HashSet<>(images(context).keySet());AtomicInteger calls=new AtomicInteger();boolean canceled=false;try{LabelGallery.save(context,batch,()->calls.incrementAndGet()<3);}catch(Exception expected){canceled=true;}check(canceled,"Cancellation was ignored");check(successful.equals(images(context).keySet()),"Canceled save left partial gallery images");
            try(FileOutputStream out=new FileOutputStream(new File(context.getFilesDir(),"gallery-check.json"))){out.write(("{\"savedImages\":2,\"width\":945,\"height\":709,\"byteExact\":true,\"distinctSkus\":2,\"cancellationRollback\":true,\"zip\":false}\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));}
        }finally{for(Uri uri:added.keySet())context.getContentResolver().delete(uri,null,null);}
    }
}
