package com.xianqi.phonevalidation;

import android.content.ClipData;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.pdf.PdfDocument;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;
import android.print.pdf.PrintedPdfDocument;
import android.widget.TextView;
import androidx.core.content.FileProvider;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** Query and label generation share one screen. Product fields are never editable. */
public final class LocationLabelActivity extends QnhProtectedActivity implements InventorySearchPanel.Host {
    private LabelWorkspace ui;
    private BluetoothLabelPrinter bluetoothPrinter;
    private final LabelRenderState selection=new LabelRenderState();
    private final ExecutorService renderer=Executors.newSingleThreadExecutor();
    private Future<?> renderJob;
    private Bitmap bitmap;
    private byte[] png,savingBytes;
    private File sharedFile;
    private String store="";
    private boolean destroyed=false;
    private JSONObject restored;
    @Override public void onCreate(Bundle state){super.onCreate(state);
        ui=new LabelWorkspace(this,this,state,new LabelWorkspace.Actions(){
            public void back(){finish();}public void save(){saveImage();}public void share(){shareImage();}public void print(){printImage();}
        });setContentView(ui);bluetoothPrinter=new BluetoothLabelPrinter(this,new BluetoothLabelPrinter.Host(){public boolean allowed(String scope,LabelContent content){return requireQnhAccess()&&qnh.tenant().equals(scope)&&selection.content()==content&&png!=null;}public void message(String text){ui.message(text);}});
        if(state!=null)try{String raw=state.getString("selected-row","");if(!raw.isEmpty()&&raw.length()<3000)restored=new JSONObject(raw);}catch(Exception ignored){}
    }
    @Override public boolean allowSearch(){return requireQnhAccess();}
    @Override public boolean active(){return isQnhScreenActive();}
    @Override public void onQueryChanged(){clearSelection();}
    @Override public void onSelected(JSONObject row){if(requireQnhAccess())renderSelection(row,true);}
    private void clearSelection(){selection.clear();restored=null;if(renderJob!=null)renderJob.cancel(false);png=null;sharedFile=null;ui.clear();releaseBitmap();}
    private void releaseBitmap(){ui.preview.setImageDrawable(null);if(bitmap!=null&&!bitmap.isRecycled())bitmap.recycle();bitmap=null;}
    private void renderSelection(JSONObject row,boolean reveal){
        clearSelection();
        try{String name=row.getString("name"),spec=row.optString("spec"),sku=row.getString("sku"),loc=row.optString("loc");
            if(loc.isEmpty()||loc.contains("\n"))throw new IllegalArgumentException("该记录没有单一库位，请在查询结果中选择一个有效库位。");
            if(!sku.matches("[A-Za-z0-9._-]{1,64}"))throw new IllegalArgumentException("完整 SKU 尚未核实，请重新查询。");
            final String tenant=qnh.tenant();final long ticket=selection.select(tenant,name,spec,sku,loc);final LabelContent content=selection.content();store=row.optString("store");
            ui.showRecord(content,store);ui.rendering();if(reveal)ui.revealResult();
            renderJob=renderer.submit(()->{
                Bitmap next=null;
                try{next=LocationLabelRenderer.render(content);byte[] encoded=LocationLabelRenderer.png(next);final Bitmap image=next;
                    runOnUiThread(()->{if(destroyed||!selection.current(ticket,tenant)){image.recycle();return;}bitmap=image;png=encoded;ui.showImage(image);});
                }catch(Exception error){if(next!=null&&!next.isRecycled())next.recycle();final String message=error instanceof IllegalArgumentException?error.getMessage():"图片生成未完成，请重新查询后重试。";runOnUiThread(()->{if(!destroyed&&selection.current(ticket,tenant))ui.message(message);});}
            });
        }catch(Exception error){ui.message(error instanceof IllegalArgumentException?error.getMessage():"查询返回的商品资料不完整，请重新查询。");}
    }
    @Override protected void onAuthenticated(){
        ui.search.authenticated();
        if(restored!=null){JSONObject row=restored;restored=null;if(qnh.tenant().equals(row.optString("tenant")))renderSelection(row,false);}
        if(bitmap==null&&png!=null){BitmapFactory.Options options=new BitmapFactory.Options();options.inPreferredConfig=Bitmap.Config.RGB_565;options.inScaled=false;bitmap=BitmapFactory.decodeByteArray(png,0,png.length,options);if(bitmap!=null)ui.showImage(bitmap);}
    }
    @Override protected void onAuthenticatedSnapshot(JSONObject value){ui.search.snapshot(value);}
    @Override protected void onSessionUnavailable(){ui.search.suspended();}
    @Override protected void onTenantChanged(){ui.search.clearTenant();clearSelection();}
    @Override public void onQnhMessage(String value){ui.search.message(value);}
    private void saveImage(){if(!requireQnhAccess()||png==null||selection.content()==null)return;savingBytes=png;
        Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType("image/png");intent.putExtra(Intent.EXTRA_TITLE,selection.content().fileName());
        try{startActivityForResult(intent,41);}catch(Exception error){savingBytes=null;ui.message("没有找到文件保存程序，请使用分享。");}
    }
    private void shareImage(){if(!requireQnhAccess()||png==null)return;
        try{File folder=new File(getCacheDir(),"labels");if(!folder.exists()&&!folder.mkdirs())throw new Exception();
            if(sharedFile==null){sharedFile=new File(folder,java.util.UUID.randomUUID()+".png");try(OutputStream out=new FileOutputStream(sharedFile)){out.write(png);}}
            File[] cached=folder.listFiles();if(cached!=null){long cutoff=System.currentTimeMillis()-24*60*60*1000L;for(File file:cached)if(!file.equals(sharedFile)&&file.isFile()&&file.lastModified()<cutoff)file.delete();}
            Uri uri=FileProvider.getUriForFile(this,getPackageName()+".labels",sharedFile);Intent send=new Intent(Intent.ACTION_SEND);send.setType("image/png");send.putExtra(Intent.EXTRA_STREAM,uri);send.setClipData(ClipData.newRawUri("库位标签",uri));send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);startActivity(Intent.createChooser(send,"分享标签图片"));
        }catch(Exception error){ui.message("分享未完成，请保存图片后重试。");}
    }
    private void printImage(){if(!requireQnhAccess()||png==null||selection.content()==null)return;new android.app.AlertDialog.Builder(this).setTitle("打印标签").setItems(new String[]{"得力720W（蓝牙直打）","系统打印"},(dialog,index)->{if(index==0)bluetoothPrinter.print(selection.content(),qnh.tenant());else systemPrintImage();}).setNegativeButton("取消",null).show();}
    private void systemPrintImage(){if(!requireQnhAccess()||png==null||selection.content()==null)return;final byte[] printing=png;final String title=selection.content().location;
        PrintManager manager=(PrintManager)getSystemService(PRINT_SERVICE);if(manager==null){ui.message("手机尚未配置打印服务，可分享给标签打印软件。");return;}
        manager.print("库位标签 "+title,new PrintDocumentAdapter(){
            private PrintAttributes attributes;
            @Override public void onLayout(PrintAttributes oldValue,PrintAttributes next,CancellationSignal cancellation,LayoutResultCallback callback,Bundle extras){attributes=next;if(cancellation.isCanceled())callback.onLayoutCancelled();else callback.onLayoutFinished(new PrintDocumentInfo.Builder("库位标签.pdf").setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT).setPageCount(1).build(),true);}
            @Override public void onWrite(PageRange[] pages,ParcelFileDescriptor output,CancellationSignal cancellation,WriteResultCallback callback){
                boolean requested=false;for(PageRange page:pages)if(page.getStart()<=0&&page.getEnd()>=0)requested=true;if(!requested){callback.onWriteFinished(new PageRange[0]);return;}
                PrintedPdfDocument document=new PrintedPdfDocument(LocationLabelActivity.this,attributes);Bitmap image=null;
                try(FileOutputStream stream=new FileOutputStream(output.getFileDescriptor())){
                    if(cancellation.isCanceled()){callback.onWriteCancelled();return;}
                    BitmapFactory.Options options=new BitmapFactory.Options();options.inPreferredConfig=Bitmap.Config.RGB_565;options.inScaled=false;image=BitmapFactory.decodeByteArray(printing,0,printing.length,options);if(image==null)throw new Exception();
                    PdfDocument.Page page=document.startPage(0);android.graphics.Rect area=page.getInfo().getContentRect();float width=80*72/25.4f,height=60*72/25.4f;
                    if(area.width()+1<width||area.height()+1<height){document.finishPage(page);callback.onWriteFailed("请在打印设置中选择 80×60 毫米、无边距。");return;}
                    float left=area.left+(area.width()-width)/2,top=area.top+(area.height()-height)/2;page.getCanvas().drawBitmap(image,null,new android.graphics.RectF(left,top,left+width,top+height),null);document.finishPage(page);document.writeTo(stream);
                    if(cancellation.isCanceled())callback.onWriteCancelled();else callback.onWriteFinished(new PageRange[]{new PageRange(0,0)});
                }catch(Exception error){callback.onWriteFailed("打印文件生成未完成，请重试。");}finally{if(image!=null)image.recycle();document.close();}
            }
        },new PrintAttributes.Builder().setMediaSize(new PrintAttributes.MediaSize("KUGUAN_80_60","80 × 60 毫米",3150,2362)).setResolution(new PrintAttributes.Resolution("label300","300 DPI",300,300)).setMinMargins(PrintAttributes.Margins.NO_MARGINS).setColorMode(PrintAttributes.COLOR_MODE_MONOCHROME).build());
    }
    @Override public void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(bluetoothPrinter!=null&&bluetoothPrinter.activityResult(request,result))return;if(request!=41)return;byte[] bytes=savingBytes;savingBytes=null;
        if(result==RESULT_OK&&data!=null&&data.getData()!=null&&bytes!=null)try(OutputStream out=getContentResolver().openOutputStream(data.getData())){if(out==null)throw new Exception();out.write(bytes);ui.message("标签图片已保存。");}catch(Exception error){ui.message("保存未完成，请重试或使用分享。");}
    }
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results){super.onRequestPermissionsResult(request,permissions,results);if(bluetoothPrinter!=null)bluetoothPrinter.permissionsResult(request,results);}
    @Override protected void onPause(){ui.search.paused();super.onPause();}
    @Override protected void onSaveInstanceState(Bundle out){ui.search.saveState(out);LabelContent content=selection.content();if(content!=null)try{JSONObject row=new JSONObject();row.put("name",content.name);row.put("spec",content.spec);row.put("sku",content.sku);row.put("loc",content.location);row.put("store",store);row.put("tenant",selection.tenant());out.putString("selected-row",row.toString());}catch(Exception ignored){}super.onSaveInstanceState(out);}
    @Override public void onTrimMemory(int level){super.onTrimMemory(level);if(level>=TRIM_MEMORY_RUNNING_LOW&&png!=null&&!isQnhScreenActive())releaseBitmap();}
    @Override public void onDestroy(){destroyed=true;if(bluetoothPrinter!=null)bluetoothPrinter.destroy();selection.clear();if(renderJob!=null)renderJob.cancel(false);renderer.shutdownNow();ui.search.destroy();releaseBitmap();png=null;savingBytes=null;super.onDestroy();}
}
