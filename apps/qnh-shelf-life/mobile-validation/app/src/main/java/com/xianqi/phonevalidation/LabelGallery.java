package com.xianqi.phonevalidation;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Save separate PNGs; roll back only this operation's own inserted URIs on failure/cancellation. */
final class LabelGallery {
    interface Allowed{boolean valid();}
    static List<Uri> save(Context context,LabelBatch batch,Allowed allowed)throws Exception{
        ContentResolver resolver=context.getContentResolver();List<Uri> created=new ArrayList<>();String prefix="库管_"+UUID.randomUUID().toString().substring(0,8)+"_";
        try{for(int i=0;i<batch.size();i++){
            require(allowed);ContentValues values=new ContentValues();String name=prefix+batch.imageName(i);values.put(MediaStore.Images.Media.DISPLAY_NAME,name);values.put(MediaStore.Images.Media.MIME_TYPE,"image/png");
            if(Build.VERSION.SDK_INT>=29){values.put(MediaStore.Images.Media.RELATIVE_PATH,Environment.DIRECTORY_PICTURES+"/库管标签");values.put(MediaStore.Images.Media.IS_PENDING,1);}
            else{File folder=new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES),"库管标签");if(!folder.mkdirs()&&!folder.isDirectory())throw new IOException("相册目录创建失败。");values.put(MediaStore.Images.Media.DATA,new File(folder,name).getAbsolutePath());}
            Uri uri=resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,values);if(uri==null)throw new IOException("相册图片创建失败。");created.add(uri);
            try(OutputStream out=resolver.openOutputStream(uri)){if(out==null)throw new IOException("相册写入失败。");out.write(batch.get(i).png);}
        }
            require(allowed);if(Build.VERSION.SDK_INT>=29)for(Uri uri:created){require(allowed);ContentValues ready=new ContentValues();ready.put(MediaStore.Images.Media.IS_PENDING,0);if(resolver.update(uri,ready,null,null)!=1)throw new IOException("相册图片发布失败。");}require(allowed);return created;
        }catch(Exception error){for(Uri uri:created)try{resolver.delete(uri,null,null);}catch(Exception ignored){}throw error;}
    }
    private static void require(Allowed allowed)throws IOException{if(Thread.currentThread().isInterrupted()||!allowed.valid())throw new IOException("已取消保存，请重新查询后操作。");}
}
