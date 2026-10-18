package com.xianqi.phonevalidation;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.drawable.BitmapDrawable;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import java.io.ByteArrayInputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

/** Real native activity, hidden WebView and bundled JS exercised against a local synthetic page. */
final class InventoryFlowCheck {
    interface Condition{boolean ready()throws Exception;}
    private final Instrumentation test;
    InventoryFlowCheck(Instrumentation test){this.test=test;}
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static Object field(Object owner,String name)throws Exception{Field f=owner.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(owner);}
    private void main(Runnable action)throws Exception{AtomicReference<Throwable> error=new AtomicReference<>();test.runOnMainSync(()->{try{action.run();}catch(Throwable e){error.set(e);}});if(error.get()!=null)throw new AssertionError(error.get());}
    private void until(Condition condition,String message)throws Exception{for(int i=0;i<150;i++){AtomicReference<Boolean> ready=new AtomicReference<>(false);AtomicReference<Throwable> error=new AtomicReference<>();test.runOnMainSync(()->{try{ready.set(condition.ready());}catch(Throwable e){error.set(e);}});if(error.get()!=null)throw new AssertionError(error.get());if(ready.get())return;Thread.sleep(100);}throw new AssertionError(message);}
    private static Button button(View view,String text){if(view instanceof Button&&((Button)view).getText().toString().contains(text))return (Button)view;if(view instanceof ViewGroup){ViewGroup group=(ViewGroup)view;for(int i=0;i<group.getChildCount();i++){Button found=button(group.getChildAt(i),text);if(found!=null)return found;}}return null;}
    void run()throws Exception{
        byte[] html;try(java.io.InputStream input=test.getContext().getAssets().open("inventory-fixture.html")){html=input.readAllBytes();}
        java.util.concurrent.atomic.AtomicBoolean loginForm=new java.util.concurrent.atomic.AtomicBoolean(false);
        byte[] form="<html><body style='background:#ff00ff'><h1>受控登录页面</h1><input type='password'></body></html>".getBytes(StandardCharsets.UTF_8);
        main(()->{try{QnhConnection qnh=QnhConnection.get(test.getTargetContext());java.lang.reflect.Method method=QnhConnection.class.getDeclaredMethod("ensureBrowser");method.setAccessible(true);method.invoke(qnh);WebView web=(WebView)field(qnh,"web");WebViewClient client=web.getWebViewClient();web.setWebViewClient(new WebViewClient(){
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){boolean login=loginForm.get()||!"qnh.meituan.com".equals(request.getUrl().getHost());return new WebResourceResponse("text/html","UTF-8",new ByteArrayInputStream(login?form:html));}
            @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap icon){client.onPageStarted(view,url,icon);}
            @Override public void onPageFinished(WebView view,String url){client.onPageFinished(view,url);}
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){return client.shouldOverrideUrlLoading(view,request);}
        });}catch(Exception error){throw new AssertionError(error);}});
        Instrumentation.ActivityMonitor logins=test.addMonitor(QnhLoginActivity.class.getName(),null,false),homeMonitor=test.addMonitor(WarehouseActivity.class.getName(),null,false);
        Intent login=new Intent(test.getTargetContext(),QnhLoginActivity.class);login.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);test.startActivitySync(login);
        Activity home=test.waitForMonitorWithTimeout(homeMonitor,15000);check(home!=null,"Synthetic official login did not open warehouse");test.removeMonitor(homeMonitor);
        Instrumentation.ActivityMonitor labels=test.addMonitor(LocationLabelActivity.class.getName(),null,false);main(()->{Button start=button(home.findViewById(android.R.id.content),"开始查询");check(start!=null,"Entry button missing");start.performClick();});
        Activity activity=test.waitForMonitorWithTimeout(labels,10000);check(activity instanceof LocationLabelActivity,"Label workspace not opened");test.removeMonitor(labels);
        LabelWorkspace ui=(LabelWorkspace)field(activity,"ui");EditText input=ui.findViewWithTag("smart-query-input");Button submit=ui.findViewWithTag("smart-query-submit");check(input!=null&&submit!=null,"Single-box query controls missing");
        until(()->QnhConnection.get(activity).verified(),"Label session not verified");
        query(input,submit,"2110000000000123456");until(()->ui.preview.getDrawable() instanceof BitmapDrawable&&ui.save.isEnabled(),"SKU lookup did not auto-generate preview");check(logins.getHits()==1,"Query unexpectedly opened official login activity");
        LabelContent content=((LabelRenderState)field(activity,"selection")).content();check(content!=null&&content.sku.equals("2110000000000123456"),"Generated label lost full SKU");
        query(input,submit,"合成测试");until(()->button(ui.search,"A65-1-2")!=null,"Name query choices missing");main(()->button(ui.search,"A65-1-2").performClick());until(()->ui.preview.getDrawable() instanceof BitmapDrawable&&ui.save.isEnabled(),"Selected name result did not generate preview");content=((LabelRenderState)field(activity,"selection")).content();check(content!=null&&content.location.equals("A65-1-2"),"Selection preview did not use selected location");
        query(input,submit,"A64-6-4");until(()->ui.preview.getDrawable() instanceof BitmapDrawable&&ui.save.isEnabled(),"Location query did not generate preview");content=((LabelRenderState)field(activity,"selection")).content();check(content!=null&&content.location.equals("A64-6-4"),"Location classifier queried the wrong field");check(logins.getHits()==1,"Official login reopened during a route transition");
        WebView web=(WebView)field(QnhConnection.get(activity),"web");main(()->{check(web.getVisibility()==View.VISIBLE,"Hidden browser stopped rendering SPA");check(web.getAlpha()==0f,"Business browser must be completely transparent");web.bringToFront();check(((ViewGroup)web.getParent()).indexOfChild(web)==0,"Hidden page must not move above native workspace");web.setTranslationZ(1000f);});noWebPixels();main(()->web.setTranslationZ(0f));
        // A real full-document SSO transition must never create a foreground login Activity.
        main(()->web.loadUrl("https://passport.meituan.com/fixture-login"));until(()->QnhConnection.get(activity).requiresLogin(),"SSO navigation was not observed");Thread.sleep(500);check(logins.getHits()==1,"SSO redirect automatically opened the official login Activity");noWebPixels();
        main(()->{check(web.getAlpha()==0f,"SSO page became visible");check(!((LocationLabelActivity)activity).allowSearch(),"An unverified session allowed a query");web.loadUrl(QnhConnection.INVENTORY);});until(()->((LocationLabelActivity)activity).active(),"Session did not recover inside the native screen");
        query(input,submit,"2110000000000123456");until(()->ui.preview.getDrawable() instanceof BitmapDrawable&&ui.save.isEnabled(),"Query did not recover after SSO");check(logins.getHits()==1,"Recovery reopened the official Activity");
        // The explicit button still opens a visible login page and returns safely afterwards.
        main(()->web.loadUrl("https://passport.meituan.com/fixture-login"));until(()->QnhConnection.get(activity).requiresLogin(),"Second SSO transition missing");loginForm.set(true);Instrumentation.ActivityMonitor explicit=test.addMonitor(QnhLoginActivity.class.getName(),null,false);
        main(()->{Button relogin=button(activity.findViewById(android.R.id.content),"重新登录牵牛花");check(relogin!=null,"Explicit login action missing");relogin.performClick();});Activity loginActivity=test.waitForMonitorWithTimeout(explicit,10000);check(loginActivity!=null,"Explicit login did not open");test.removeMonitor(explicit);
        main(()->{check(web.getAlpha()==1f,"Explicit login must remain usable");loginForm.set(false);QnhConnection.get(activity).freshLogin();});until(()->((LocationLabelActivity)activity).active()&&web.getAlpha()==0f,"Explicit login did not return to hidden mode");check(logins.getHits()==2,"Unexpected login window count");noWebPixels();
        query(input,submit,"A64-6-4");until(()->ui.preview.getDrawable() instanceof BitmapDrawable&&ui.save.isEnabled(),"Label preview missing after explicit relogin");main(()->{activity.finish();home.finish();});test.removeMonitor(logins);
    }
    private void noWebPixels()throws Exception{android.graphics.Bitmap shot=test.getUiAutomation().takeScreenshot();check(shot!=null,"Privacy screenshot unavailable");try{int[] row=new int[shot.getWidth()];for(int y=0;y<shot.getHeight();y+=4){shot.getPixels(row,0,row.length,0,y,row.length,1);for(int x=0;x<row.length;x+=4){int c=row[x];check(!(((c>>16)&255)>190&&(c&255)>190&&((c>>8)&255)<90),"Background web pixels leaked into the native screen");}}}finally{shot.recycle();}}
    private void query(EditText input,Button submit,String text)throws Exception{main(()->{input.setText(text);check(submit.isEnabled(),"Query action disabled");submit.performClick();});}
}
