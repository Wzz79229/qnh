package com.xianqi.phonevalidation;

import android.Manifest;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import androidx.core.content.FileProvider;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;

/** Read-only product queries, single or multiple PNGs, and gallery export. */
public final class LocationLabelActivity extends QnhProtectedActivity implements InventorySearchPanel.Host {
    private LabelWorkspace ui;
    private final LabelRenderState selection=new LabelRenderState();
    private final ExecutorService renderer=Executors.newSingleThreadExecutor();
    private final AtomicLong outputFence=new AtomicLong();
    private Future<?> renderJob;
    private Bitmap bitmap;
    private LabelBatch batch,sharedBatch;private List<File> sharedFiles;
    private int page=0,pageRequest=0;
    private boolean destroyed=false,exporting=false;
    private JSONArray selectedRows,restored;
    private String restoredTenant="";
    private LabelBatch permissionBatch;
    private long permissionTicket;
    private String scannerTenant="",scanValue,scanFormat;

    @Override public void onCreate(Bundle state){super.onCreate(state);
        ui=new LabelWorkspace(this,this,state,new LabelWorkspace.Actions(){
            public void back(){finish();}public void save(){saveImages();}public void share(){shareImages();}
            public void previous(){showPage(page-1);}public void next(){showPage(page+1);}
        });setContentView(ui);
        if(state!=null)try{scannerTenant=state.getString("scanner-tenant","");String raw=state.getString("selected-rows","");if(!raw.isEmpty()&&raw.length()<200000){restored=new JSONArray(raw);restoredTenant=state.getString("selected-tenant","");}}catch(Exception ignored){}
    }
    @Override public boolean allowSearch(){return requireQnhAccess();}
    @Override public boolean active(){return isQnhScreenActive();}
    @Override public void onQueryChanged(){clearSelection();}
    @Override public void onSelected(JSONObject row){onBatchSelected(new JSONArray().put(row));}
    @Override public void onBatchSelected(JSONArray rows){if(requireQnhAccess())renderRows(rows,true);}
    @Override public void onScan(){if(requireQnhAccess()){scannerTenant=qnh.tenant();startActivityForResult(new Intent(this,BarcodeScanActivity.class),62);}}
    private void consumeScan(){if(scanValue==null)return;String value=scanValue,format=scanFormat;scanValue=null;if(scannerTenant.equals(qnh.tenant()))ui.search.scanned(value,format);else ui.search.message("登录租户已改变，请重新扫码。");}
    private void clearSelection(){outputFence.incrementAndGet();pageRequest++;selection.clear();restored=null;selectedRows=null;batch=null;sharedBatch=null;sharedFiles=null;page=0;permissionBatch=null;exporting=false;if(renderJob!=null)renderJob.cancel(false);ui.clear();releaseBitmap();}
    private void releaseBitmap(){ui.preview.setImageDrawable(null);if(bitmap!=null&&!bitmap.isRecycled())bitmap.recycle();bitmap=null;}
    private boolean current(long ticket,String tenant){return !destroyed&&outputFence.get()==ticket&&batch!=null&&batch.tenant.equals(tenant);}
    private void renderRows(JSONArray rows,boolean reveal){
        clearSelection();
        try{
            if(rows==null||rows.length()<1||rows.length()>LabelBatch.MAX_ITEMS)throw new IllegalArgumentException("每批最多500张，请按更细库位分批查询。");
            List<LabelContent> contents=new ArrayList<>();List<String> stores=new ArrayList<>();JSONArray normalized=new JSONArray();
            for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);String sku=row.getString("sku"),loc=row.optString("loc");
                if(!sku.matches("[A-Za-z0-9._-]{1,64}"))throw new IllegalArgumentException("完整 SKU 尚未核实，请重新查询。");
                if(loc.isEmpty()||loc.contains("\n"))throw new IllegalArgumentException("所选第"+(i+1)+"条记录没有单一库位，请重新选择。");
                LabelContent data=LabelContent.create(row.getString("name"),row.optString("spec"),sku,loc);String store=row.optString("store");if(store.length()>300)throw new IllegalArgumentException("门店资料不完整。");
                contents.add(data);stores.add(store);normalized.put(new JSONObject().put("name",data.name).put("spec",data.spec).put("sku",data.sku).put("loc",data.location).put("store",store));
            }
            String tenant=qnh.tenant();LabelContent first=contents.get(0);selection.select(tenant,first.name,first.spec,first.sku,first.location);selectedRows=normalized;long ticket=outputFence.get();
            ui.showRecord(first,stores.get(0));ui.rendering(0,contents.size());if(reveal)ui.revealResult();
            renderJob=renderer.submit(()->{
                Bitmap firstImage=null;
                try{List<LabelBatch.Entry> entries=new ArrayList<>();long imageBytes=0;
                    for(int i=0;i<contents.size();i++){
                        if(outputFence.get()!=ticket||Thread.currentThread().isInterrupted())throw new java.util.concurrent.CancellationException();
                        Bitmap image=LocationLabelRenderer.render(contents.get(i));
                        try{byte[] encoded=LocationLabelRenderer.png(image);imageBytes+=encoded.length;if(imageBytes>16*1024*1024)throw new IllegalArgumentException("本批图片过大，请按更细库位分批生成。");entries.add(new LabelBatch.Entry(contents.get(i),stores.get(i),encoded));if(i==0){firstImage=image;image=null;}}finally{if(image!=null)image.recycle();}
                        final int done=i+1;runOnUiThread(()->{if(!destroyed&&outputFence.get()==ticket)ui.rendering(done,contents.size());});
                    }
                    LabelBatch result=new LabelBatch(tenant,entries);Bitmap image=firstImage;firstImage=null;
                    runOnUiThread(()->{if(destroyed||outputFence.get()!=ticket){image.recycle();return;}batch=result;page=0;bitmap=image;ui.showPage(image,0,result.size());ui.search.message(result.size()>1?"已生成 "+result.size()+" 张标签，可一键保存全部图片或批量分享。":"标签已生成，可保存或分享。");});
                }catch(Exception error){if(firstImage!=null)firstImage.recycle();String message=error instanceof IllegalArgumentException?error.getMessage():"图片生成未完成，请重新查询后重试。";runOnUiThread(()->{if(!destroyed&&outputFence.get()==ticket)ui.failed(message);});}
            });
        }catch(Exception error){ui.failed(error instanceof IllegalArgumentException?error.getMessage():"查询返回的商品资料不完整，请重新查询。");}
    }
    private void showPage(int index){
        if(!requireQnhAccess()||batch==null||index<0||index>=batch.size()||exporting)return;LabelBatch captured=batch;long ticket=outputFence.get();int request=++pageRequest;ui.setActions(false);
        renderer.submit(()->{BitmapFactory.Options options=new BitmapFactory.Options();options.inPreferredConfig=Bitmap.Config.RGB_565;options.inScaled=false;byte[] png=captured.get(index).png;Bitmap image=BitmapFactory.decodeByteArray(png,0,png.length,options);
            runOnUiThread(()->{if(!current(ticket,captured.tenant)||request!=pageRequest){if(image!=null)image.recycle();return;}if(image==null){ui.setActions(true);ui.message("预览未能加载，请重试。");return;}releaseBitmap();bitmap=image;page=index;ui.showRecord(captured.get(index).content,captured.get(index).store);ui.showPage(image,index,captured.size());});
        });
    }
    @Override protected void onAuthenticated(){ui.search.authenticated();if(scanValue!=null){restored=null;consumeScan();}else if(restored!=null){JSONArray rows=restored;restored=null;if(qnh.tenant().equals(restoredTenant))renderRows(rows,false);}else if(batch!=null&&bitmap==null)showPage(page);}
    @Override protected void onAuthenticatedSnapshot(JSONObject value){ui.search.snapshot(value);}
    @Override protected void onSessionUnavailable(){ui.search.suspended();scanValue=null;clearSelection();}
    @Override protected void onTenantChanged(){ui.search.clearTenant();clearSelection();}
    @Override public void onQnhMessage(String value){ui.search.message(value);}
    private boolean canExport(){return requireQnhAccess()&&batch!=null&&!exporting&&batch.tenant.equals(qnh.tenant());}
    private void saveImages(){
        if(!canExport())return;
        if(Build.VERSION.SDK_INT<=28&&checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)!=PackageManager.PERMISSION_GRANTED){permissionBatch=batch;permissionTicket=outputFence.get();requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},51);return;}
        LabelBatch captured=batch;long ticket=outputFence.get();exporting=true;ui.setActions(false);ui.message("正在保存 "+captured.size()+" 张图片到相册…");
        renderer.submit(()->{try{LabelGallery.save(this,captured,()->outputFence.get()==ticket);runOnUiThread(()->{if(!current(ticket,captured.tenant))return;exporting=false;ui.setActions(true);ui.message("已保存 "+captured.size()+" 张图片到相册 · 库管标签");});}
            catch(Exception error){runOnUiThread(()->{if(!current(ticket,captured.tenant))return;exporting=false;ui.setActions(true);ui.message("图片未保存完成，请检查手机剩余空间或使用分享。");});}});
    }
    private void shareImages(){
        if(!canExport())return;LabelBatch captured=batch;long ticket=outputFence.get();List<File> reusable=sharedBatch==captured?sharedFiles:null;exporting=true;ui.setActions(false);ui.message("正在准备 "+captured.size()+" 张图片…");
        renderer.submit(()->{try{File rootFolder=new File(getCacheDir(),"labels");purgeShareCache(rootFolder,reusable==null?null:reusable.get(0).getParentFile());File folder=new File(rootFolder,java.util.UUID.randomUUID().toString());List<File> files=reusable!=null?reusable:captured.writeImages(folder);
            runOnUiThread(()->{if(!current(ticket,captured.tenant))return;exporting=false;ui.setActions(true);if(!requireQnhAccess())return;try{
                sharedBatch=captured;sharedFiles=files;ArrayList<Uri> uris=new ArrayList<>();for(File file:files)uris.add(FileProvider.getUriForFile(this,getPackageName()+".labels",file));
                Intent send=new Intent(uris.size()==1?Intent.ACTION_SEND:Intent.ACTION_SEND_MULTIPLE);send.setType("image/png");if(uris.size()==1)send.putExtra(Intent.EXTRA_STREAM,uris.get(0));else send.putParcelableArrayListExtra(Intent.EXTRA_STREAM,uris);
                ClipData clip=ClipData.newRawUri("库位标签",uris.get(0));for(int i=1;i<uris.size();i++)clip.addItem(new ClipData.Item(uris.get(i)));send.setClipData(clip);send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);startActivity(Intent.createChooser(send,"分享 "+uris.size()+" 张标签图片"));
            }catch(Exception error){ui.message("没有找到可接收图片的应用，请保存到相册。");}});
        }catch(Exception error){runOnUiThread(()->{if(!current(ticket,captured.tenant))return;exporting=false;ui.setActions(true);ui.message("分享准备失败，请保存到相册后重试。");});}});
    }
    private void purgeShareCache(File rootFolder,File preserve){File[] folders=rootFolder.listFiles();if(folders==null)return;long cutoff=System.currentTimeMillis()-24*60*60*1000L;for(File folder:folders)if(folder.isDirectory()&&!folder.equals(preserve)&&folder.getName().matches("[0-9a-f-]{36}")&&folder.lastModified()<cutoff){File[] files=folder.listFiles();if(files!=null)for(File file:files)if(file.isFile()&&file.getName().endsWith(".png"))file.delete();folder.delete();}}
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results){super.onRequestPermissionsResult(request,permissions,results);if(request==51){LabelBatch pending=permissionBatch;permissionBatch=null;if(pending!=null&&pending==batch&&permissionTicket==outputFence.get()&&results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED)saveImages();else ui.message("未获相册保存权限，可使用分享图片。");}}
    @Override protected void onPause(){ui.search.paused();super.onPause();}
    @Override public void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request==62&&result==RESULT_OK&&data!=null){scanValue=data.getStringExtra("value");scanFormat=data.getStringExtra("format");if(active()&&requireQnhAccess())consumeScan();}}
    @Override protected void onSaveInstanceState(Bundle out){ui.search.saveState(out);out.putString("scanner-tenant",scannerTenant);if(selectedRows!=null){String raw=selectedRows.toString();if(raw.length()<200000)out.putString("selected-rows",raw);out.putString("selected-tenant",selection.tenant());}super.onSaveInstanceState(out);}
    @Override public void onTrimMemory(int level){super.onTrimMemory(level);if(level>=TRIM_MEMORY_RUNNING_LOW&&batch!=null&&!isQnhScreenActive())releaseBitmap();}
    @Override public void onDestroy(){destroyed=true;outputFence.incrementAndGet();pageRequest++;selection.clear();if(renderJob!=null)renderJob.cancel(false);renderer.shutdownNow();ui.search.destroy();releaseBitmap();batch=null;super.onDestroy();}
}
