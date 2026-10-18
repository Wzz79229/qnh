package com.xianqi.phonevalidation;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** The only product lookup entry for the active warehouse-label feature. */
public final class InventoryLookupActivity extends Activity {
    private static final String INVENTORY="https://qnh.meituan.com/#/co-wms/inventory-query-integration/list?tab=goodsBatch";
    private static final String HASH="#/co-wms/inventory-query-integration/list";
    private WebView web; private EditText sku; private TextView status; private Button query;
    private String runtime="",tenant="",candidate="",pending="",expectedTenant=""; private int confirmations=0,page=0,operation=0;
    private boolean active=false,ready=false,probing=false,launched=false; private long deadline=0;
    private AlertDialog selection;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final Runnable tick=new Runnable(){public void run(){ if(!active || web==null)return; if(!pending.isEmpty() && android.os.SystemClock.elapsedRealtime()>deadline) fail("查询超时，请在库存查询（新）确认门店/仓后重试。"); probe(); handler.postDelayed(this,1200); }};
    private int dp(int value){ return Math.round(value*getResources().getDisplayMetrics().density); }
    @Override public void onCreate(Bundle state){ super.onCreate(state);
        try(InputStream input=getAssets().open("inventory.js")){ ByteArrayOutputStream output=new ByteArrayOutputStream(); byte[] bytes=new byte[8192]; int count; while((count=input.read(bytes))!=-1){if(output.size()+count>300000)throw new Exception();output.write(bytes,0,count);} runtime=output.toString(StandardCharsets.UTF_8.name()); }
        catch(Exception error){ TextView failure=new TextView(this); failure.setText("缺少库存查询组件，请重新安装库管。"); setContentView(failure); return; }
        LinearLayout root=new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(Color.rgb(243,246,250));
        root.setOnApplyWindowInsetsListener((view,insets)->{view.setPadding(dp(12),insets.getSystemWindowInsetTop(),dp(12),insets.getSystemWindowInsetBottom());return insets;});
        Button back=new Button(this);back.setText("‹ 返回标签编辑");back.setOnClickListener(v->finish());root.addView(back);
        status=new TextView(this);status.setTextSize(14);status.setPadding(0,dp(8),0,dp(8));status.setText("在牵牛花官方页面登录，选择库存查询（新）的门店/仓，再输入完整 SKU 查询。");root.addView(status);
        sku=new EditText(this);sku.setHint("完整 SKU 编码");sku.setSingleLine(true);sku.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);sku.setAutofillHints((String[])null);root.addView(sku);
        LinearLayout actions=new LinearLayout(this);query=new Button(this);query.setText("查询 SKU");query.setOnClickListener(v->begin());actions.addView(query,new LinearLayout.LayoutParams(0,dp(48),1));
        Button inventory=new Button(this);inventory.setText("选择门店/仓");inventory.setOnClickListener(v->{fail("");web.loadUrl(INVENTORY);});actions.addView(inventory,new LinearLayout.LayoutParams(0,dp(48),1));root.addView(actions);
        web=new WebView(this);root.addView(web,new LinearLayout.LayoutParams(-1,0,1));setContentView(root);configure();
        sku.addTextChangedListener(new TextWatcher(){
            public void beforeTextChanged(CharSequence value,int start,int count,int after){}
            public void afterTextChanged(Editable value){}
            public void onTextChanged(CharSequence value,int start,int before,int count){
                boolean hadResult=!pending.isEmpty() || selection!=null;
                fail("");if(selection!=null){selection.dismiss();selection=null;}
                if(ready && QnhUrlPolicy.qnhOrigin(web.getUrl()))web.evaluateJavascript("window.__kuguanInventory && window.__kuguanInventory.cancel();",null);
                if(hadResult)status.setText("SKU 已修改，请重新查询。");
            }
        });
        web.loadUrl(INVENTORY);
    }
    @SuppressLint("SetJavaScriptEnabled") private void configure(){
        WebView.setWebContentsDebuggingEnabled(false);WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);settings.setSaveFormData(false);
        settings.setSupportZoom(true);settings.setBuiltInZoomControls(true);settings.setDisplayZoomControls(false);settings.setUseWideViewPort(true);settings.setLoadWithOverviewMode(true);
        java.util.regex.Matcher version=java.util.regex.Pattern.compile("Chrome/([0-9.]+)").matcher(settings.getUserAgentString());String chrome=version.find()?version.group(1):"120.0.0.0";
        settings.setUserAgentString("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"+chrome+" Safari/537.36");
        CookieManager.getInstance().setAcceptCookie(true);CookieManager.getInstance().setAcceptThirdPartyCookies(web,true);
        web.setWebChromeClient(new WebChromeClient(){@Override public void onPermissionRequest(PermissionRequest request){request.deny();}});
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){ if(!request.isForMainFrame())return false;boolean allowed=QnhUrlPolicy.allowedTop(request.getUrl().toString());if(!allowed)status.setText("已停止打开牵牛花官方登录站点以外的地址。");return !allowed; }
            @Override public void onPageStarted(WebView view,String url,Bitmap icon){page++;ready=false;probing=false;if(!QnhUrlPolicy.qnhOrigin(url)){lock();} }
            @Override public void onPageFinished(WebView view,String url){ready=true;probing=false;probe();}
            @Override public void onReceivedSslError(WebView view,SslErrorHandler ssl,SslError error){ssl.cancel();lock();status.setText("网站证书校验失败，请检查手机时间和网络。");}
            @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error){if(request.isForMainFrame()){ready=false;lock();status.setText("牵牛花页面加载失败，请返回后重试。");}}
        });
    }
    private void lock(){tenant="";candidate="";confirmations=0;fail("");if(selection!=null){selection.dismiss();selection=null;}}
    private void fail(String message){operation++;pending="";expectedTenant="";launched=false;if(query!=null)query.setEnabled(true);if(!message.isEmpty())status.setText(message);}
    private void begin(){String value=sku.getText().toString().trim();
        if(tenant.isEmpty() || confirmations<2){status.setText("请先在下方登录牵牛花。");return;}
        if(!value.matches("[A-Za-z0-9._-]{1,64}")){sku.setError("请输入完整 SKU，不要输入商品条码或多个编码");return;}
        if(selection!=null){selection.dismiss();selection=null;}operation++;pending=value;expectedTenant=tenant;launched=false;deadline=android.os.SystemClock.elapsedRealtime()+35000;query.setEnabled(false);status.setText("正在库存查询（新）按 SKU 查询…");
        if(!isInventory(web.getUrl()))web.loadUrl(INVENTORY);else probe();
    }
    private static boolean isInventory(String value){try{Uri uri=Uri.parse(value);String fragment=uri.getFragment();return QnhUrlPolicy.qnhOrigin(value)&&fragment!=null&&fragment.startsWith(HASH.substring(1)+"?")&&fragment.matches(".*(?:\\?|&)tab=goodsBatch(?:&.*)?$");}catch(Exception error){return false;}}
    private void probe(){if(!active || !ready || probing || web==null || !QnhUrlPolicy.qnhOrigin(web.getUrl()))return;probing=true;final int navigation=page;
        web.evaluateJavascript(runtime+";JSON.stringify(window.__kuguanInventory.inspect());",raw->{if(!active || navigation!=page)return;probing=false;
            try{if(raw==null || raw.length()>80000)throw new Exception();Object decoded=new JSONTokener(raw).nextValue();if(!(decoded instanceof String))throw new Exception();handle(new JSONObject((String)decoded));}
            catch(Exception error){status.setText("正在等待牵牛花页面完成加载。");}
        });
    }
    private void handle(JSONObject value)throws Exception{
        String observed=value.optString("tenantId");if(!value.optBoolean("authorized") || !observed.matches("[1-9][0-9]{0,19}")){lock();return;}
        if(!tenant.isEmpty()&&!tenant.equals(observed))lock();if(!candidate.equals(observed)){candidate=observed;confirmations=1;}else confirmations++;if(confirmations<2)return;tenant=observed;
        if(pending.isEmpty())return;if(!expectedTenant.equals(tenant)){fail("租户已切换，请重新查询。");return;}final int current=operation;
        if(!launched&&value.optBoolean("productReady")){launched=true;web.evaluateJavascript("window.__kuguanInventory.begin("+JSONObject.quote(String.valueOf(current))+","+JSONObject.quote(pending)+","+JSONObject.quote(tenant)+");",ok->{if(current==operation&&!"true".equals(ok))fail("未能操作 SKU 查询框，请在库存查询（新）确认门店/仓后重试。");});}
        else if(launched&&String.valueOf(current).equals(value.optString("requestId"))){String phase=value.optString("status");
            if("found".equals(phase)){if(!pending.equals(value.optString("sku")))throw new Exception();choose(value.getJSONArray("rows"),pending,tenant,current);}
            else if(!"pending".equals(phase))fail("not_found".equals(phase)?"当前库存范围没有此 SKU，请确认门店/仓和筛选条件。":"查询结果尚未确认，请在库存查询（新）核对后重试。");
        }
    }
    private void choose(JSONArray rows,String requested,String scope,int request)throws Exception{
        if(rows.length()<1||rows.length()>100)throw new Exception();String[] titles=new String[rows.length()];for(int index=0;index<rows.length();index++){JSONObject row=rows.getJSONObject(index);
            if(!requested.equals(row.getString("sku"))||row.getString("name").isEmpty()||row.getString("name").length()>200||row.optString("spec").length()>240||row.optString("loc").length()>300)throw new Exception();
            titles[index]=row.getString("name")+"\n"+row.optString("spec")+"\n"+row.getString("store")+" · 库位："+(row.optString("loc").isEmpty()?"未设置":row.optString("loc"));}
        pending="";expectedTenant="";launched=false;query.setEnabled(true);status.setText("已查回库存记录，请选择需要打印的一条。");
        selection=new AlertDialog.Builder(this).setTitle("选择库存记录 / 库位").setItems(titles,(dialog,index)->{
            if(!active||request!=operation||confirmations<2||!scope.equals(tenant)){status.setText("登录或租户已变化，请重新查询。");return;}
            try{JSONObject row=rows.getJSONObject(index);Intent result=new Intent();for(String key:new String[]{"name","spec","sku","loc"})result.putExtra(key,row.getString(key));setResult(RESULT_OK,result);finish();}catch(Exception error){status.setText("库存记录不完整，请重新查询。");}
        }).setNegativeButton("取消",null).create();selection.show();
    }
    @Override public void onResume(){super.onResume();active=true;probing=false;candidate="";confirmations=0;if(web!=null){web.onResume();handler.post(tick);}}
    @Override public void onPause(){active=false;confirmations=0;handler.removeCallbacks(tick);if(web!=null)web.onPause();super.onPause();}
    @Override public void onDestroy(){active=false;handler.removeCallbacksAndMessages(null);if(selection!=null)selection.dismiss();if(web!=null){web.stopLoading();web.destroy();web=null;}super.onDestroy();}
}
