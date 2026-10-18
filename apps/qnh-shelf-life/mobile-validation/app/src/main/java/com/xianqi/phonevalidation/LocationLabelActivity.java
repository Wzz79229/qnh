package com.xianqi.phonevalidation;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
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
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/** Creates one image per label; no automatic upload or implicit printing. */
public final class LocationLabelActivity extends QnhProtectedActivity {
    private EditText name,spec,sku,location;
    private TextView status;
    private ImageView preview;
    private Button save,share,print;
    private Bitmap bitmap;
    private byte[] png;
    private LabelContent rendered;
    private int revision=0, sharedRevision=-1;
    private File sharedFile;
    private byte[] savingBytes;
    private int dp(int value) { return Math.round(value*getResources().getDisplayMetrics().density); }
    private TextView text(String value,int size) { TextView t=new TextView(this); t.setText(value); t.setTextSize(size); t.setTextColor(Color.rgb(24,51,76)); t.setPadding(0,dp(8),0,dp(6)); return t; }
    private Button button(String value,android.view.View.OnClickListener action) { Button b=new Button(this); b.setText(value); b.setAllCaps(false); b.setOnClickListener(action); return b; }
    private EditText field(LinearLayout root,String title,String hint,boolean multiline) {
        root.addView(text(title,14)); EditText e=new EditText(this); e.setHint(hint); e.setTextSize(16); e.setSingleLine(!multiline);
        e.setInputType(InputType.TYPE_CLASS_TEXT|(multiline?InputType.TYPE_TEXT_FLAG_MULTI_LINE:InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)); e.setAutofillHints((String[])null); root.addView(e); return e;
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state); ScrollView scroll=new ScrollView(this); LinearLayout root=new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(243,246,250));
        root.setOnApplyWindowInsetsListener((view,insets)->{ view.setPadding(dp(20),insets.getSystemWindowInsetTop()+dp(12),dp(20),insets.getSystemWindowInsetBottom()+dp(24)); return insets; });
        root.addView(button("‹ 返回库管",v->finish())); root.addView(text("库位标签",26)); root.addView(text("80 × 60 毫米 · PNG 图片 · 300 DPI",14));
        root.addView(button("从牵牛花库存查询（新）填入",v->startActivityForResult(new Intent(this,InventoryLookupActivity.class),40)));
        name=field(root,"商品名称","输入商品名称",true); spec=field(root,"规格（选填，可换行）","例如 500ml/瓶",true);
        sku=field(root,"完整 SKU","保留全部数字，包括开头的 0",false); location=field(root,"库位","例如 C56-2-2",false);
        root.addView(text("文字显示 SKU 后六位，条形码包含完整 SKU。每张图片对应一个库位。",13));
        root.addView(button("生成标签图片",v->generate())); root.addView(button("填入示例查看样式",v->{ name.setText("示例商品 饮用水 500ml/瓶"); spec.setText("500ml/瓶"); sku.setText("2110000000000123456"); location.setText("C56-2-2"); generate(); status.setText("这是示例标签，请替换为真实商品和库位后使用。"); }));
        status=text("填写信息，或从牵牛花库存查询选取一条记录。",14); root.addView(status);
        preview=new ImageView(this); preview.setAdjustViewBounds(true); preview.setScaleType(ImageView.ScaleType.FIT_CENTER); preview.setContentDescription("库位标签图片预览"); root.addView(preview,new LinearLayout.LayoutParams(-1,-2));
        save=button("保存 PNG 图片",v->saveImage()); share=button("分享图片 / 发送到打印软件",v->shareImage()); print=button("系统打印（80 × 60 毫米）",v->printImage());
        root.addView(save); root.addView(share); root.addView(print); scroll.addView(root); setContentView(scroll); setActions(false);
        if(state!=null) { name.setText(state.getString("name","")); spec.setText(state.getString("spec","")); sku.setText(state.getString("sku","")); location.setText(state.getString("location","")); }
        TextWatcher changes=new TextWatcher(){ public void beforeTextChanged(CharSequence s,int start,int count,int after){} public void onTextChanged(CharSequence s,int start,int before,int count){ invalidateImage(); } public void afterTextChanged(Editable e){} };
        for(EditText e:new EditText[]{name,spec,sku,location}) e.addTextChangedListener(changes);
    }
    private void setActions(boolean enabled) { save.setEnabled(enabled); share.setEnabled(enabled); print.setEnabled(enabled); }
    private void invalidateImage() { revision++; png=null; rendered=null; preview.setImageDrawable(null); if(bitmap!=null) { bitmap.recycle(); bitmap=null; } setActions(false); status.setText("内容已修改，请重新生成标签图片。"); }
    private void generate() {
        if(!requireQnhAccess())return;
        invalidateImage();
        try { LabelContent value=LabelContent.create(name.getText().toString(),spec.getText().toString(),sku.getText().toString(),location.getText().toString());
            Bitmap next=LocationLabelRenderer.render(value); byte[] encoded;
            try { encoded=LocationLabelRenderer.png(next); } catch(Exception error) { next.recycle(); throw error; }
            bitmap=next; png=encoded; rendered=value; preview.setImageBitmap(bitmap); setActions(true);
            status.setText("图片已生成：945 × 709 像素，80 × 60 毫米。请核对文字和库位，再保存或打印。");
        } catch(IllegalArgumentException error) { status.setText(error.getMessage()); } catch(Exception error) { status.setText("图片生成未完成，请核对内容后重试。"); }
    }
    private void saveImage() {
        if(!requireQnhAccess())return;
        if(png==null || rendered==null) return; savingBytes=png.clone(); Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT); intent.addCategory(Intent.CATEGORY_OPENABLE); intent.setType("image/png"); intent.putExtra(Intent.EXTRA_TITLE,rendered.fileName());
        try { startActivityForResult(intent,41); } catch(Exception error) { savingBytes=null; status.setText("未找到文件保存程序，可使用分享图片。"); }
    }
    private void shareImage() {
        if(!requireQnhAccess())return;
        if(png==null || rendered==null) return;
        try { File folder=new File(getCacheDir(),"labels"); if(!folder.exists() && !folder.mkdirs()) throw new Exception();
            // Each shared image is immutable, so another share cannot change the recipient's pending file.
            if(sharedFile==null || sharedRevision!=revision){ sharedFile=new File(folder,java.util.UUID.randomUUID()+".png"); try(OutputStream output=new FileOutputStream(sharedFile)){ output.write(png); } sharedRevision=revision; }
            File file=sharedFile;
            Uri uri=FileProvider.getUriForFile(this,getPackageName()+".labels",file); Intent send=new Intent(Intent.ACTION_SEND); send.setType("image/png"); send.putExtra(Intent.EXTRA_STREAM,uri); send.setClipData(ClipData.newRawUri("库位标签",uri)); send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION); startActivity(Intent.createChooser(send,"分享库位标签图片"));
        } catch(Exception error) { status.setText("图片分享未完成，请使用保存 PNG 图片。"); }
    }
    private void printImage() {
        if(!requireQnhAccess())return;
        if(bitmap==null || rendered==null) return; final Bitmap printing=bitmap.copy(Bitmap.Config.ARGB_8888,false); final String title=rendered.location;
        PrintManager manager=(PrintManager)getSystemService(PRINT_SERVICE); if(manager==null) { printing.recycle(); status.setText("当前手机没有系统打印服务，请保存图片后用打印软件打开。"); return; }
        manager.print("库位标签 "+title,new PrintDocumentAdapter(){
            private PrintAttributes attributes;
            @Override public void onLayout(PrintAttributes oldValue,PrintAttributes next,CancellationSignal cancellation,LayoutResultCallback callback,Bundle extras){ attributes=next; if(cancellation.isCanceled()) callback.onLayoutCancelled(); else callback.onLayoutFinished(new PrintDocumentInfo.Builder("库位标签.pdf").setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT).setPageCount(1).build(),true); }
            @Override public void onWrite(PageRange[] pages,ParcelFileDescriptor output,CancellationSignal cancellation,WriteResultCallback callback){
                boolean requested=false; for(PageRange p:pages) if(p.getStart()<=0 && p.getEnd()>=0) requested=true; if(!requested){ callback.onWriteFinished(new PageRange[0]); return; }
                PrintedPdfDocument document=new PrintedPdfDocument(LocationLabelActivity.this,attributes);
                try(FileOutputStream stream=new FileOutputStream(output.getFileDescriptor())){
                    if(cancellation.isCanceled()){ callback.onWriteCancelled(); return; } PdfDocument.Page page=document.startPage(0);
                    android.graphics.Rect area=page.getInfo().getContentRect(); float width=80*72/25.4f,height=60*72/25.4f;
                    if(area.width()+1<width || area.height()+1<height){ document.finishPage(page); callback.onWriteFailed("请在打印设置选择 80×60 毫米、无边距。"); return; }
                    float left=area.left+(area.width()-width)/2,top=area.top+(area.height()-height)/2;
                    page.getCanvas().drawBitmap(printing,null,new android.graphics.RectF(left,top,left+width,top+height),null); document.finishPage(page); document.writeTo(stream);
                    if(cancellation.isCanceled()) callback.onWriteCancelled(); else callback.onWriteFinished(new PageRange[]{new PageRange(0,0)});
                }catch(Exception error){ callback.onWriteFailed("打印文件生成未完成，请重试。"); }finally{ document.close(); }
            }
            @Override public void onFinish(){ printing.recycle(); }
        },new PrintAttributes.Builder().setMediaSize(new PrintAttributes.MediaSize("KUGUAN_80_60","80 × 60 毫米",3150,2362)).setResolution(new PrintAttributes.Resolution("label300","300 DPI",300,300)).setMinMargins(PrintAttributes.Margins.NO_MARGINS).setColorMode(PrintAttributes.COLOR_MODE_MONOCHROME).build());
    }
    @Override public void onActivityResult(int request,int result,Intent data){ super.onActivityResult(request,result,data);
        if(request==41){ byte[] bytes=savingBytes; savingBytes=null; if(result==RESULT_OK && data!=null && data.getData()!=null && bytes!=null) try(OutputStream output=getContentResolver().openOutputStream(data.getData())){ if(output==null) throw new Exception(); output.write(bytes); status.setText("PNG 图片已保存到你选择的位置。"); }catch(Exception error){ status.setText("保存未完成，可重新保存或分享。"); } return; }
        if(request==40 && result==RESULT_OK && data!=null){ name.setText(data.getStringExtra("name")); spec.setText(data.getStringExtra("spec")); sku.setText(data.getStringExtra("sku")); location.setText(data.getStringExtra("loc")); status.setText("已填入本次库存查询结果，请核对库位后生成图片。"); }
    }
    @Override protected void onSaveInstanceState(Bundle out){ out.putString("name",name.getText().toString()); out.putString("spec",spec.getText().toString()); out.putString("sku",sku.getText().toString()); out.putString("location",location.getText().toString()); super.onSaveInstanceState(out); }
    @Override protected void onTenantChanged(){name.setText("");spec.setText("");sku.setText("");location.setText("");invalidateImage();status.setText("牵牛花租户已切换，请重新选择商品和库位。");}
    @Override public void onDestroy(){ preview.setImageDrawable(null); if(bitmap!=null) bitmap.recycle(); png=null; savingBytes=null; super.onDestroy(); }
}
