package com.xianqi.phonevalidation;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.MutableContextWrapper;
import android.content.ComponentCallbacks2;
import android.graphics.Bitmap;
import android.net.http.SslError;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
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

/** One lazy on-device browser, cached static assets and one runtime injection per document. */
public final class QnhConnection {
    public static final String INVENTORY="https://qnh.meituan.com/#/co-wms/inventory-query-integration/list?tab=goodsBatch";
    public static final String LEGACY_INVENTORY="https://qnh.meituan.com/home.html#/co-wms/non-erp/stock-query?tab=list&pageSize=50";
    public interface Listener {void onQnhSnapshot(JSONObject value);void onQnhMessage(String message);default void onQnhPageProgress(int progress){}default void onQnhLoginStage(String stage){}}
    public interface Result {void accept(Object value);}
    private static QnhConnection instance;
    public static synchronized QnhConnection get(Context context){if(instance==null)instance=new QnhConnection(context.getApplicationContext());return instance;}
    private final Context app;
    private final MutableContextWrapper context;
    private final QnhGate gate=new QnhGate();
    private final Handler handler=new Handler(Looper.getMainLooper());
    private WebView web;
    private Listener listener;
    private Activity owner;
    private String runtime="",loginRuntime="",lastInventory=INVENTORY,lastNewInventory=INVENTORY,lastLegacyInventory=LEGACY_INVENTORY;private boolean loginProbing=false;
    private int navigation=0;
    private int restoreTicket=0;private boolean restoring=false;
    private boolean active=false,ready=false,probing=false,loaded=false,injected=false,loginVisible=false,inventoryInterest=false,pending=false,loginRequired=false;
    private long burstUntil=0;
    private final Runnable release=()->releaseBrowser();
    private final Runnable tick=new Runnable(){public void run(){if(!active)return;probe();handler.postDelayed(this,QnhPolling.interval(loginVisible||!gate.verified(),inventoryInterest,pending||SystemClock.elapsedRealtime()<burstUntil));}};
    private QnhConnection(Context application){app=application;context=new MutableContextWrapper(app);
        try(InputStream input=app.getAssets().open("inventory.js")){ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buffer=new byte[8192];int n;while((n=input.read(buffer))!=-1){if(out.size()+n>350000)throw new Exception();out.write(buffer,0,n);}runtime=out.toString(StandardCharsets.UTF_8.name());}catch(Exception ignored){}
        try(InputStream input=app.getAssets().open("login.js")){ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buffer=new byte[4096];int n;while((n=input.read(buffer))!=-1){if(out.size()+n>50000)throw new Exception();out.write(buffer,0,n);}loginRuntime=out.toString(StandardCharsets.UTF_8.name());}catch(Exception ignored){}
    }
    @SuppressLint("SetJavaScriptEnabled") private void ensureBrowser(){if(web!=null)return;
        web=new WebView(context){
            @Override public boolean dispatchTouchEvent(android.view.MotionEvent event){return loginVisible&&super.dispatchTouchEvent(event);}
            @Override public boolean requestFocus(int direction,android.graphics.Rect previous){return loginVisible&&super.requestFocus(direction,previous);}
            @Override public void bringToFront(){if(loginVisible)super.bringToFront();}
        };web.setAlpha(0f);WebView.setWebContentsDebuggingEnabled(false);WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);settings.setSaveFormData(false);settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setSupportZoom(true);settings.setBuiltInZoomControls(true);settings.setDisplayZoomControls(false);settings.setUseWideViewPort(true);settings.setLoadWithOverviewMode(true);settings.setMediaPlaybackRequiresUserGesture(true);
        // Match the working procurement app: preserve the normal Android WebView
        // user agent so official authentication can choose its mobile layout.
        CookieManager.getInstance().setAcceptCookie(true);CookieManager.getInstance().setAcceptThirdPartyCookies(web,true);
        web.setWebChromeClient(new WebChromeClient(){@Override public void onProgressChanged(WebView view,int progress){if(view==web&&loginVisible&&listener!=null)listener.onQnhPageProgress(progress);}@Override public void onPermissionRequest(PermissionRequest request){request.deny();}
            @Override public boolean onCreateWindow(WebView view,boolean dialog,boolean gesture,android.os.Message result){return false;}
            @Override public void onShowCustomView(View view,CustomViewCallback callback){callback.onCustomViewHidden();}
        });
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){if(!request.isForMainFrame())return false;boolean allowed=QnhUrlPolicy.allowedTop(request.getUrl().toString());if(!allowed)message("已停止打开官方登录站点以外的地址。");return !allowed;}
            @Override public void onPageStarted(WebView view,String url,Bitmap icon){if(view!=web)return;navigation++;ready=false;probing=false;injected=false;gate.clear();loginProbing=false;if(loginVisible){web.setAlpha(0f);if(listener!=null)listener.onQnhLoginStage("loading");}loginRequired=!QnhUrlPolicy.qnhOrigin(url);if(loginRequired){restoreTicket++;restoring=false;}notifyLocked();}
            @Override public void onPageFinished(WebView view,String url){if(view!=web||!QnhUrlPolicy.sameDocument(url,view.getUrl()))return;ready=true;probing=false;kick();}
            @Override public void onReceivedSslError(WebView view,SslErrorHandler ssl,SslError error){ssl.cancel();if(view!=web)return;gate.clear();ready=false;notifyLocked();message("网站证书校验失败，请检查手机时间和网络。");}
            @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error){if(view==web&&request.isForMainFrame()){gate.clear();ready=false;notifyLocked();message("牵牛花页面加载失败，请检查网络后重新加载。");}}
        });
    }
    public boolean verified(){return gate.verified();}
    public boolean requiresLogin(){return loginRequired;}
    public void retryVerification(){kick();}
    public String tenant(){return gate.tenant();}
    public void listen(Listener value){listener=value;}
    public void unlisten(Listener value){if(listener==value)listener=null;}
    public void attach(Activity activity,FrameLayout host,boolean visible){context.setBaseContext(activity);ensureBrowser();if(web.getParent() instanceof ViewGroup)((ViewGroup)web.getParent()).removeView(web);
        owner=activity;loginVisible=visible;if(visible)inventoryInterest=false;
        web.getSettings().setLoadsImagesAutomatically(visible);web.getSettings().setBlockNetworkImage(!visible);
        // Keep the SPA rendering: INVISIBLE can suspend its animation-frame updates.
        // Transparency also prevents a frame from flashing through if the browser requests focus or changes Z order.
        web.setVisibility(View.VISIBLE);web.setAlpha(0f);web.getSettings().setUseWideViewPort(true);web.getSettings().setLoadWithOverviewMode(true);web.setFocusable(visible);web.setFocusableInTouchMode(visible);web.setImportantForAccessibility(visible?View.IMPORTANT_FOR_ACCESSIBILITY_AUTO:View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        host.addView(web,0,new FrameLayout.LayoutParams(-1,-1));web.resumeTimers();web.onResume();kick();
    }
    public void releaseHost(Activity activity){if(owner==activity){if(web!=null){web.setAlpha(0f);if(web.getParent() instanceof ViewGroup)((ViewGroup)web.getParent()).removeView(web);}owner=null;context.setBaseContext(app);}}
    public void foreground(boolean value){active=value;handler.removeCallbacks(tick);handler.removeCallbacks(release);
        if(value){if(web!=null){web.resumeTimers();web.onResume();}kick();}
        else{gate.clear();loginRequired=false;navigation++;probing=false;pending=false;if(web!=null){web.onPause();web.pauseTimers();}handler.postDelayed(release,60000);}
    }
    public void trimMemory(int level){if(!active&&(level==ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW||level==ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL||level>=ComponentCallbacks2.TRIM_MEMORY_BACKGROUND))releaseBrowser();}
    private void releaseBrowser(){if(active||web==null)return;WebView old=web;web=null;navigation++;ready=false;loaded=false;injected=false;probing=false;gate.clear();if(old.getParent() instanceof ViewGroup)((ViewGroup)old.getParent()).removeView(old);old.stopLoading();old.destroy();owner=null;context.setBaseContext(app);}
    public void freshLogin(){restoreTicket++;restoring=false;ensureBrowser();gate.clear();ready=false;probing=false;loaded=true;injected=false;lastInventory=INVENTORY;lastNewInventory=INVENTORY;lastLegacyInventory=LEGACY_INVENTORY;web.loadUrl(INVENTORY);kick();}
    public void loginPage(){ensureBrowser();if(!loaded){loaded=true;web.loadUrl(INVENTORY);}kick();}
    public boolean loginZoom(boolean larger){return loginVisible&&web!=null&&(larger?web.zoomIn():web.zoomOut());}
    public void signOut(Runnable done){gate.clear();loginRequired=true;ready=false;navigation++;probing=false;lastInventory=INVENTORY;lastNewInventory=INVENTORY;lastLegacyInventory=LEGACY_INVENTORY;if(web!=null)web.stopLoading();CookieManager.getInstance().removeAllCookies(ignored->{CookieManager.getInstance().flush();android.webkit.WebStorage.getInstance().deleteAllData();done.run();});}
    public void inventory(){inventory(false);}
    public void inventory(boolean legacy){restoreTicket++;restoring=false;ensureBrowser();String target=legacy?lastLegacyInventory:lastNewInventory;
        // Carry only the official selected store scope between the two inventory pages.
        String source=isInventory()?web.getUrl():lastInventory;
        if(isInventoryUrl(source)&&legacyInventoryUrl(source)!=legacy)try{String sourceFragment=android.net.Uri.parse(source).getFragment(),targetFragment=android.net.Uri.parse(target).getFragment();android.net.Uri sourceScope=android.net.Uri.parse("https://qnh.meituan.com/?"+sourceFragment.substring(sourceFragment.indexOf('?')+1)),targetScope=android.net.Uri.parse("https://qnh.meituan.com/?"+targetFragment.substring(targetFragment.indexOf('?')+1));android.net.Uri.Builder params=new android.net.Uri.Builder();for(String key:targetScope.getQueryParameterNames())if(!key.equals("repositoryList")&&!key.equals("queryPoiType"))for(String value:targetScope.getQueryParameters(key))params.appendQueryParameter(key,value);for(String key:new String[]{"repositoryList","queryPoiType"}){String value=sourceScope.getQueryParameter(key);if(value!=null)params.appendQueryParameter(key,value);}target=target.substring(0,target.indexOf('?')+1)+params.build().getEncodedQuery();}catch(Exception ignored){}
        if(!loaded||!isInventory()||isLegacyInventory()!=legacy){loaded=true;web.loadUrl(target);}kick();}
    public boolean isInventory(){return web!=null&&isInventoryUrl(web.getUrl());}
    public boolean isLegacyInventory(){return web!=null&&legacyInventoryUrl(web.getUrl());}
    private static boolean legacyInventoryUrl(String value){try{android.net.Uri uri=android.net.Uri.parse(value);String fragment=uri.getFragment();if(!QnhUrlPolicy.qnhOrigin(value)||fragment==null)return false;String[] parts=fragment.split("\\?",2);if(!parts[0].equals("/co-wms/non-erp/stock-query"))return false;String tab=parts.length==1?null:android.net.Uri.parse("https://qnh.meituan.com/?"+parts[1]).getQueryParameter("tab");return tab==null||tab.equals("list");}catch(Exception ignored){return false;}}
    private static boolean isInventoryUrl(String value){if(legacyInventoryUrl(value))return true;try{android.net.Uri uri=android.net.Uri.parse(value);String fragment=uri.getFragment();return QnhUrlPolicy.qnhOrigin(value)&&fragment!=null&&fragment.startsWith("/co-wms/inventory-query-integration/list?")&&("&"+fragment.substring(fragment.indexOf('?')+1)+"&").contains("&tab=goodsBatch&");}catch(Exception ignored){return false;}}
    public void restoreInventory(){if(!verified()||web==null)return;restoring=true;int ticket=++restoreTicket;String target=lastInventory;if(!target.equals(web.getUrl()))web.loadUrl(target);kick();handler.postDelayed(()->{if(ticket!=restoreTicket||!restoring||web==null||!active||loginVisible)return;if(target.equals(web.getUrl()))web.reload();else{web.loadUrl(target);handler.postDelayed(()->{if(ticket==restoreTicket&&restoring&&web!=null&&active&&!loginVisible&&target.equals(web.getUrl()))web.reload();},500);}kick();},1500);}
    public void watchInventory(boolean value){inventoryInterest=value;kick();}
    private void kick(){if(!active)return;handler.removeCallbacks(tick);handler.post(tick);}
    private String prefix(){return injected?"":runtime+";";}
    public void command(String expression,Result callback){if(!verified()||!ready||web==null||!QnhUrlPolicy.qnhOrigin(web.getUrl())){if(callback!=null)callback.accept(null);return;}
        int page=navigation;burstUntil=SystemClock.elapsedRealtime()+1800;
        web.evaluateJavascript(prefix()+"JSON.stringify("+expression+");",raw->{if(page!=navigation||!active){if(callback!=null)callback.accept(null);return;}Object decoded=decode(raw);if(decoded!=null)injected=true;if(callback!=null)callback.accept(decoded);kick();});
    }
    private static Object decode(String raw){try{if(raw==null||raw.length()>1500000)return null;Object outer=new org.json.JSONTokener(raw).nextValue();return outer instanceof String?new org.json.JSONTokener((String)outer).nextValue():null;}catch(Exception ignored){return null;}}
    private void loginPresentation(){if(!loginVisible||!ready||web==null||loginProbing||loginRuntime.isEmpty()||!QnhUrlPolicy.allowedTop(web.getUrl()))return;loginProbing=true;int page=navigation;web.evaluateJavascript(loginRuntime+";JSON.stringify(window.__kuguanLoginView?window.__kuguanLoginView.inspect():null);",raw->{loginProbing=false;if(page!=navigation||!loginVisible||web==null)return;Object decoded=decode(raw);if(!(decoded instanceof JSONObject))return;JSONObject value=(JSONObject)decoded;if(!QnhUrlPolicy.sameDocument(value.optString("documentUrl"),web.getUrl()))return;String stage=value.optString("stage");web.setAlpha("login".equals(stage)?1f:0f);if(listener!=null)listener.onQnhLoginStage(stage);});}
    private void probe(){loginPresentation();if(!active||!ready||probing||web==null||!QnhUrlPolicy.qnhOrigin(web.getUrl())||runtime.isEmpty())return;probing=true;int page=navigation;boolean details=inventoryInterest&&!loginVisible;
        web.evaluateJavascript(prefix()+"JSON.stringify({documentUrl:location.href,snapshot:window.__kuguanInventory.inspect("+details+")});",raw->{if(page!=navigation||!active)return;probing=false;Object value=decode(raw);if(!(value instanceof JSONObject)){gate.clear();notifyLocked();return;}
            JSONObject envelope=(JSONObject)value;if(!QnhUrlPolicy.sameDocument(envelope.optString("documentUrl"),web.getUrl()))return;JSONObject snapshot=envelope.optJSONObject("snapshot");if(snapshot==null){gate.clear();notifyLocked();return;}
            injected=true;loginRequired="login_required".equals(snapshot.optString("authState"));gate.observe(snapshot.optBoolean("authorized"),snapshot.optString("tenantId"));String phase=snapshot.optString("status");pending="pending".equals(phase)||"resolving".equals(phase);if(restoring&&snapshot.optBoolean("productReady")){restoring=false;restoreTicket++;}
            if(gate.verified()&&isInventory()){lastInventory=web.getUrl();if(isLegacyInventory())lastLegacyInventory=lastInventory;else lastNewInventory=lastInventory;}if(listener!=null)listener.onQnhSnapshot(snapshot);
        });
    }
    private void notifyLocked(){if(listener!=null)listener.onQnhSnapshot(new JSONObject());}
    private void message(String value){if(listener!=null)listener.onQnhMessage(value);}
}
