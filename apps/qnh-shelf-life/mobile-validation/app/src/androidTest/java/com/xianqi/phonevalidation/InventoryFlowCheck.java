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
        main(()->{try{QnhConnection qnh=QnhConnection.get(test.getTargetContext());java.lang.reflect.Method method=QnhConnection.class.getDeclaredMethod("ensureBrowser");method.setAccessible(true);method.invoke(qnh);WebView web=(WebView)field(qnh,"web");WebViewClient client=web.getWebViewClient();web.setWebViewClient(new WebViewClient(){
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){return new WebResourceResponse("text/html","UTF-8",new ByteArrayInputStream(html));}
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
        WebView web=(WebView)field(QnhConnection.get(activity),"web");main(()->{check(web.getVisibility()==View.VISIBLE,"Hidden browser stopped rendering SPA");check(((ViewGroup)web.getParent()).indexOfChild(web)==0,"Browser must remain behind native workspace");activity.finish();home.finish();});test.removeMonitor(logins);
    }
    private void query(EditText input,Button submit,String text)throws Exception{main(()->{input.setText(text);check(submit.isEnabled(),"Query action disabled");submit.performClick();});}
}
