package com.xianqi.phonevalidation;

import android.Manifest;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
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

/** Query results automatically prepend to a tenant-scoped vertical label list. */
public final class LocationLabelActivity extends QnhProtectedActivity implements InventorySearchPanel.Host {
    private LabelWorkspace ui;private final LabelRenderState selection=new LabelRenderState();
    private final ExecutorService renderer=Executors.newSingleThreadExecutor();private final AtomicLong outputFence=new AtomicLong();private Future<?> renderJob;
    private LabelQueue queue=new LabelQueue();private LabelBatch batch,sharedBatch;private List<File> sharedFiles;
    private boolean destroyed=false,exporting=false;private JSONArray restored;private String restoredTenant="";
    private LabelBatch permissionBatch;private long permissionTicket;
    private String scannerTenant="",scanValue,scanFormat;
    private LabelBatch pdfBatch;private long pdfTicket;private Uri pdfTarget;
    @Override public void onCreate(Bundle state){super.onCreate(state);
        ui=new LabelWorkspace(this,this,state,new LabelWorkspace.Actions(){public void back(){finish();}public void save(){saveImages();}public void share(){shareImages();}public void pdf(){savePdf();}public void remove(long id){removeLabel(id);}public void clear(){clearLabels();}});setContentView(ui);
        Object retained=getLastNonConfigurationInstance();if(retained instanceof LabelQueue)queue=(LabelQueue)retained;
        if(state!=null)try{scannerTenant=state.getString("scanner-tenant","");String raw=state.getString("generated-rows","");if(!raw.isEmpty()&&raw.length()<200000){restored=new JSONArray(raw);restoredTenant=state.getString("generated-tenant","");}}catch(Exception ignored){}
    }
    @Override public boolean allowSearch(){return requireQnhAccess();}
    @Override public boolean active(){return isQnhScreenActive();}
    @Override public void onQueryChanged(){cancelPending();}
    @Override public void onSelected(JSONObject row){onBatchSelected(new JSONArray().put(row));}
    @Override public void onBatchSelected(JSONArray rows){if(requireQnhAccess())renderRows(rows,true,false);}
    @Override public void onLocationBatchSelected(JSONArray rows){if(requireQnhAccess())renderRows(rows,true,true);}
    @Override public void onScan(){if(requireQnhAccess()){scannerTenant=qnh.tenant();startActivityForResult(new Intent(this,BarcodeScanActivity.class),62);}}
    private void consumeScan(){if(scanValue==null)return;String value=scanValue,format=scanFormat;scanValue=null;if(scannerTenant.equals(qnh.tenant()))ui.search.scanned(value,format);else ui.search.message("登录租户已改变，请重新扫码。");}
    @Override public Object onRetainNonConfigurationInstance(){return queue;}
    private void cancelPending(){outputFence.incrementAndGet();restored=null;sharedBatch=null;sharedFiles=null;permissionBatch=null;pdfBatch=null;pdfTarget=null;exporting=false;if(renderJob!=null)renderJob.cancel(false);ui.setActions(batch!=null);}
    private void refreshLabels(){batch=queue.size()==0?null:queue.snapshot(qnh.tenant());selection.clear();if(batch!=null){LabelContent first=batch.get(0).content;selection.select(batch.tenant,first.name,first.spec,first.sku,first.location);}ui.showLabels(queue.items());ui.setActions(batch!=null&&!exporting);}
    private void clearLabels(){if(!requireQnhAccess())return;ui.search.cancelQuery();cancelPending();queue.clear();refreshLabels();}
    private void removeLabel(long id){if(!requireQnhAccess()||queue.size()==0||!queue.tenant().equals(qnh.tenant()))return;cancelPending();if(queue.remove(id,qnh.tenant())){refreshLabels();ui.message(queue.size()==0?"标签已清空。":"已删除该标签，剩余 "+queue.size()+" 张。");}}
    private void resetLabels(){cancelPending();queue.clear();batch=null;selection.clear();ui.showLabels(queue.items());}
    private boolean current(long ticket,String tenant){return !destroyed&&outputFence.get()==ticket&&batch!=null&&batch.tenant.equals(tenant);}
    private boolean pending(long ticket,String tenant){return !destroyed&&outputFence.get()==ticket;}
    private void renderRows(JSONArray rows,boolean reveal,boolean sortLocations){cancelPending();
        try{
            if(rows==null||rows.length()<1||rows.length()>LabelBatch.MAX_ITEMS||queue.size()+rows.length()>LabelBatch.MAX_ITEMS)throw new IllegalArgumentException("最多保留500张标签，请保存后清空部分标签。");
            List<LabelContent> contents=new ArrayList<>();List<String> stores=new ArrayList<>();
            for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);String sku=row.getString("sku"),loc=row.optString("loc");if(!sku.matches("[A-Za-z0-9._-]{1,64}"))throw new IllegalArgumentException("完整 SKU 尚未核实，请重新查询。");if(loc.isEmpty()||loc.contains("\n"))throw new IllegalArgumentException("所选第"+(i+1)+"条记录没有单一库位，请重新选择。");LabelContent data=LabelContent.create(row.getString("name"),row.optString("spec"),sku,loc);String store=row.optString("store");if(store.length()>300)throw new IllegalArgumentException("门店资料不完整。");contents.add(data);stores.add(store);}
            String tenant=qnh.tenant();long ticket=outputFence.get();ui.rendering(0,contents.size());
            renderJob=renderer.submit(()->{try{List<LabelBatch.Entry> entries=new ArrayList<>();long bytes=0;for(int i=0;i<contents.size();i++){if(outputFence.get()!=ticket||Thread.currentThread().isInterrupted())return;Bitmap image=LocationLabelRenderer.render(contents.get(i));try{byte[] png=LocationLabelRenderer.png(image);bytes+=png.length;if(bytes>16*1024*1024)throw new IllegalArgumentException("本批图片过大，请减少所选商品。");entries.add(new LabelBatch.Entry(contents.get(i),stores.get(i),png));}finally{image.recycle();}final int done=i+1;runOnUiThread(()->{if(pending(ticket,tenant))ui.rendering(done,contents.size());});}
                if(sortLocations)entries.sort((a,b)->LocationOrder.compare(a.content.location,b.content.location));LabelBatch generated=new LabelBatch(tenant,entries);runOnUiThread(()->commitGenerated(ticket,tenant,generated,reveal,0));
            }catch(Exception error){String message=error instanceof IllegalArgumentException?error.getMessage():"本次标签未生成，请重试。";runOnUiThread(()->{if(pending(ticket,tenant))ui.failed(message);});}});
        }catch(Exception error){ui.failed(error instanceof IllegalArgumentException?error.getMessage():"查询返回的商品资料不完整，请重新查询。");}
    }
    private void commitGenerated(long ticket,String tenant,LabelBatch generated,boolean reveal,int attempts){if(!pending(ticket,tenant))return;if(!qnh.verified()){if(attempts<100)ui.postDelayed(()->commitGenerated(ticket,tenant,generated,reveal,attempts+1),250);else ui.failed("登录验证尚未恢复，本次标签未添加，请重新查询。");return;}if(!tenant.equals(qnh.tenant()))return;try{queue.prepend(generated);refreshLabels();ui.message("新增 "+generated.size()+" 张 · 共 "+queue.size()+" 张，最新标签已置顶。");ui.search.message(ui.search.lookupNote()+"，标签已生成并置顶。");if(reveal)ui.revealResult();}catch(IllegalArgumentException error){ui.failed(error.getMessage());}}
    @Override protected void onAuthenticated(){if(!queue.tenant().isEmpty()&&!queue.tenant().equals(qnh.tenant()))resetLabels();ui.search.authenticated();if(queue.size()>0&&batch==null)refreshLabels();if(scanValue!=null){restored=null;consumeScan();}else if(restored!=null){JSONArray rows=restored;restored=null;if(queue.size()==0&&qnh.tenant().equals(restoredTenant))renderRows(rows,false,false);}if(pdfTarget!=null)consumePdf();}
    @Override protected void onAuthenticatedSnapshot(JSONObject value){ui.account(value.optString("username"),value.optString("tenantName"),value.optString("tenantId"));ui.search.snapshot(value);}
    @Override protected void onSessionUnavailable(){resetLabels();ui.account("","","");ui.search.suspended();scanValue=null;}
    @Override protected void onTenantChanged(){resetLabels();ui.search.clearTenant();}
    @Override public void onQnhMessage(String value){ui.search.message(value);}
    private boolean canExport(){return requireQnhAccess()&&batch!=null&&!exporting&&batch.tenant.equals(qnh.tenant());}
    private void savePdf(){if(!canExport())return;pdfBatch=batch;pdfTicket=outputFence.get();exporting=true;ui.setActions(false);Intent create=new Intent(Intent.ACTION_CREATE_DOCUMENT);create.addCategory(Intent.CATEGORY_OPENABLE);create.setType("application/pdf");create.putExtra(Intent.EXTRA_TITLE,"库管标签_"+batch.size()+"张_"+System.currentTimeMillis()+".pdf");try{startActivityForResult(create,63);}catch(Exception error){pdfBatch=null;exporting=false;ui.setActions(true);ui.message("未找到文件保存程序，请使用图片保存或分享。");}}
    private void consumePdf(){LabelBatch captured=pdfBatch;Uri target=pdfTarget;long ticket=pdfTicket;pdfTarget=null;pdfBatch=null;if(captured==null||captured!=batch||ticket!=outputFence.get()||!captured.tenant.equals(qnh.tenant())){exporting=false;if(batch!=null)ui.setActions(true);return;}ui.message("正在保存 PDF · "+captured.size()+"页…");renderer.submit(()->{File temp=null;try{temp=File.createTempFile("kuguan-labels-",".pdf",getCacheDir());try(java.io.OutputStream out=new java.io.FileOutputStream(temp)){LabelPdf.write(captured,out,()->outputFence.get()==ticket);}if(outputFence.get()!=ticket)throw new java.io.IOException("已取消保存。");try(java.io.InputStream in=new java.io.FileInputStream(temp);java.io.OutputStream out=getContentResolver().openOutputStream(target,"w")){if(out==null)throw new java.io.IOException("文件无法写入。");byte[] bytes=new byte[8192];int n;while((n=in.read(bytes))!=-1){if(outputFence.get()!=ticket)throw new java.io.IOException("已取消保存。");out.write(bytes,0,n);}}runOnUiThread(()->{if(!current(ticket,captured.tenant))return;exporting=false;ui.setActions(true);ui.message("PDF 已保存 · "+captured.size()+"页，每页80×60毫米");});}catch(Exception error){runOnUiThread(()->{if(!current(ticket,captured.tenant))return;exporting=false;ui.setActions(true);ui.message("PDF 未保存完成，请检查剩余空间后重试。");});}finally{if(temp!=null)temp.delete();}});}
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
    @Override public void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request==62&&result==RESULT_OK&&data!=null){scanValue=data.getStringExtra("value");scanFormat=data.getStringExtra("format");if(active()&&requireQnhAccess())consumeScan();}if(request==63){if(result==RESULT_OK&&data!=null&&data.getData()!=null){pdfTarget=data.getData();if(active()&&requireQnhAccess())consumePdf();}else{pdfBatch=null;pdfTarget=null;exporting=false;if(batch!=null)ui.setActions(true);}}}
    @Override protected void onSaveInstanceState(Bundle out){ui.search.saveState(out);out.putString("scanner-tenant",scannerTenant);if(queue.size()>0){JSONArray rows=new JSONArray();List<LabelQueue.Item> values=queue.items();for(int i=0;i<values.size();i++){LabelBatch.Entry e=values.get(i).entry;try{rows.put(new JSONObject().put("name",e.content.name).put("spec",e.content.spec).put("sku",e.content.sku).put("loc",e.content.location).put("store",e.store));}catch(Exception ignored){}}String raw=rows.toString();if(raw.length()<200000){out.putString("generated-rows",raw);out.putString("generated-tenant",queue.tenant());}}super.onSaveInstanceState(out);}
    @Override public void onTrimMemory(int level){super.onTrimMemory(level);if(level>=TRIM_MEMORY_RUNNING_LOW)ui.trimPreviews();}
    @Override public void onDestroy(){destroyed=true;outputFence.incrementAndGet();selection.clear();if(renderJob!=null)renderJob.cancel(false);renderer.shutdownNow();ui.search.destroy();ui.dispose();batch=null;super.onDestroy();}
}
