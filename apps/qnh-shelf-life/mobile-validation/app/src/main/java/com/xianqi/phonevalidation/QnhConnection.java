package com.xianqi.phonevalidation;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.MutableContextWrapper;
import android.graphics.Bitmap;
import android.net.http.SslError;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** One on-device official browser. Login is visible; authenticated lookup is hidden. */
public final class QnhConnection {
    public static final String INVENTORY="https://qnh.meituan.com/#/co-wms/inventory-query-integration/list?tab=goodsBatch";
    public interface Listener { void onQnhSnapshot(JSONObject snapshot); void onQnhMessage(String message); }
    public interface Result { void accept(Object result); }
    private static QnhConnection instance;
    public static synchronized QnhConnection get(Context context){if(instance==null)instance=new QnhConnection(context.getApplicationContext());return instance;}
    private final Context app;
    private final MutableContextWrapper context;
    private final WebView web;
    private final QnhGate gate=new QnhGate();
    private final Handler handler=new Handler(Looper.getMainLooper());
    private String runtime="";
    private Listener listener;
    private Activity owner;
    private int navigation=0;
    private boolean active=false,ready=false,probing=false,loaded=false;
    private final Runnable tick=new Runnable(){public void run(){if(!active)return;probe();handler.postDelayed(this,900);}};
    @SuppressLint("SetJavaScriptEnabled") private QnhConnection(Context application){
        app=application;context=new MutableContextWrapper(app);web=new WebView(context);
        try(InputStream input=app.getAssets().open("inventory.js")){ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buffer=new byte[8192];int n;while((n=input.read(buffer))!=-1){if(out.size()+n>350000)throw new Exception();out.write(buffer,0,n);}runtime=out.toString(StandardCharsets.UTF_8.name());}catch(Exception error){runtime="";}
        WebView.setWebContentsDebuggingEnabled(false);WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);settings.setSaveFormData(false);settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setSupportZoom(true);settings.setBuiltInZoomControls(true);settings.setDisplayZoomControls(false);settings.setUseWideViewPort(true);settings.setLoadWithOverviewMode(true);
        java.util.regex.Matcher version=java.util.regex.Pattern.compile("Chrome/([0-9.]+)").matcher(settings.getUserAgentString());String chrome=version.find()?version.group(1):"120.0.0.0";
        settings.setUserAgentString("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"+chrome+" Safari/537.36");
        CookieManager.getInstance().setAcceptCookie(true);CookieManager.getInstance().setAcceptThirdPartyCookies(web,true);
        web.setWebChromeClient(new WebChromeClient(){@Override public void onPermissionRequest(PermissionRequest request){request.deny();}});
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){if(!request.isForMainFrame())return false;boolean allowed=QnhUrlPolicy.allowedTop(request.getUrl().toString());if(!allowed)message("已停止打开牵牛花官方登录站点以外的地址。");return !allowed;}
            @Override public void onPageStarted(WebView view,String url,Bitmap icon){navigation++;ready=false;probing=false;if(!QnhUrlPolicy.qnhOrigin(url)){gate.clear();notifyLocked();}}
            @Override public void onPageFinished(WebView view,String url){ready=true;probing=false;probe();}
            @Override public void onReceivedSslError(WebView view,SslErrorHandler ssl,SslError error){ssl.cancel();gate.clear();ready=false;notifyLocked();message("网站证书校验失败，请检查手机时间和网络。");}
            @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error){if(request.isForMainFrame()){gate.clear();ready=false;notifyLocked();message("牵牛花页面加载失败，请检查网络后重新加载。");}}
        });
    }
    public boolean verified(){return gate.verified();}
    public String tenant(){return gate.tenant();}
    public void listen(Listener value){listener=value;}
    public void unlisten(Listener value){if(listener==value)listener=null;}
    public void attach(Activity activity,FrameLayout host,boolean visible){
        if(web.getParent() instanceof ViewGroup)((ViewGroup)web.getParent()).removeView(web);
        owner=activity;context.setBaseContext(activity);web.setVisibility(visible?View.VISIBLE:View.INVISIBLE);
        host.addView(web,0,new FrameLayout.LayoutParams(-1,-1));web.onResume();
    }
    public void releaseHost(Activity activity){if(owner==activity){if(web.getParent() instanceof ViewGroup)((ViewGroup)web.getParent()).removeView(web);owner=null;context.setBaseContext(app);}}
    public void foreground(boolean value){active=value;handler.removeCallbacks(tick);if(value){web.onResume();handler.post(tick);}else{gate.clear();navigation++;probing=false;web.onPause();}}
    public void freshLogin(){gate.clear();ready=false;probing=false;loaded=true;web.loadUrl(INVENTORY);}
    public void signOut(Runnable done){gate.clear();ready=false;navigation++;probing=false;web.stopLoading();CookieManager.getInstance().removeAllCookies(ignored->{CookieManager.getInstance().flush();android.webkit.WebStorage.getInstance().deleteAllData();done.run();});}
    public void inventory(){if(!loaded || !isInventory()){loaded=true;web.loadUrl(INVENTORY);}else probe();}
    public boolean isInventory(){try{android.net.Uri uri=android.net.Uri.parse(web.getUrl());String fragment=uri.getFragment();return QnhUrlPolicy.qnhOrigin(web.getUrl())&&fragment!=null&&fragment.startsWith("/co-wms/inventory-query-integration/list?")&&("&"+fragment.substring(fragment.indexOf('?')+1)+"&").contains("&tab=goodsBatch&");}catch(Exception ignored){return false;}}
    public void command(String expression,Result callback){
        if(!verified() || !ready || !QnhUrlPolicy.qnhOrigin(web.getUrl())){if(callback!=null)callback.accept(null);return;}
        int page=navigation;web.evaluateJavascript(runtime+";JSON.stringify("+expression+");",raw->{if(page!=navigation||!active){if(callback!=null)callback.accept(null);return;}Object decoded=decode(raw);if(callback!=null)callback.accept(decoded);});
    }
    private static Object decode(String raw){try{if(raw==null||raw.length()>180000)return null;Object outer=new org.json.JSONTokener(raw).nextValue();return outer instanceof String?new org.json.JSONTokener((String)outer).nextValue():null;}catch(Exception error){return null;}}
    private void probe(){
        if(!active||!ready||probing||!QnhUrlPolicy.qnhOrigin(web.getUrl())||runtime.isEmpty())return;
        probing=true;int page=navigation;
        web.evaluateJavascript(runtime+";JSON.stringify(window.__kuguanInventory.inspect());",raw->{if(page!=navigation||!active)return;probing=false;Object value=decode(raw);
            if(!(value instanceof JSONObject)){gate.clear();notifyLocked();return;}JSONObject snapshot=(JSONObject)value;
            gate.observe(snapshot.optBoolean("authorized"),snapshot.optString("tenantId"));if(listener!=null)listener.onQnhSnapshot(snapshot);
        });
    }
    private void notifyLocked(){if(listener!=null)listener.onQnhSnapshot(new JSONObject());}
    private void message(String value){if(listener!=null)listener.onQnhMessage(value);}
}
