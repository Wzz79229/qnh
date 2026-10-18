package com.xianqi.phonevalidation;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.view.Gravity;
import org.json.JSONObject;

/** All feature screens fail closed after process death, logout or background return. */
public abstract class QnhProtectedActivity extends Activity implements QnhConnection.Listener {
    private static final int LOGIN=7001;
    protected QnhConnection qnh;
    private boolean loginPending=false,resumed=false,sessionReady=false,loginNotified=false;
    private FrameLayout verifying;
    private TextView verificationTitle,verificationText;
    private String tenant="";
    @Override protected void onCreate(Bundle state){super.onCreate(state);if(state!=null){String value=state.getString("qnh-bound-tenant","");if(value.matches("[1-9][0-9]{0,19}"))tenant=value;}}
    @Override protected void onResume(){super.onResume();resumed=true;qnh=QnhConnection.get(this);qnh.listen(this);qnh.attach(this,(FrameLayout)findViewById(android.R.id.content),false);if(requireQnhAccess()){sessionReady=true;onAuthenticated();}}
    private void verificationCover(boolean show){
        if(verifying==null&&show){verifying=new FrameLayout(this);verifying.setBackgroundColor(WarehouseUi.BG);verifying.setClickable(true);verifying.setFocusable(true);
            LinearLayout box=WarehouseUi.card(this);box.setGravity(Gravity.CENTER);verificationTitle=WarehouseUi.text(this,"正在确认牵牛花登录",20,WarehouseUi.INK,true);box.addView(verificationTitle);WarehouseUi.space(box,12);verificationText=WarehouseUi.text(this,"页面加载中，请稍候。验证完成后自动继续。",14,WarehouseUi.MUTED,false);box.addView(verificationText);WarehouseUi.space(box,18);
            box.addView(WarehouseUi.button(this,"重试验证",true,v->qnh.retryVerification()));WarehouseUi.space(box,10);box.addView(WarehouseUi.button(this,"重新登录牵牛花",false,v->openLogin()));
            FrameLayout.LayoutParams card=new FrameLayout.LayoutParams(-1,-2,Gravity.CENTER);int p=WarehouseUi.dp(this,24);card.setMargins(p,p,p,p);verifying.addView(box,card);((FrameLayout)findViewById(android.R.id.content)).addView(verifying,new FrameLayout.LayoutParams(-1,-1));}
        if(verifying!=null){boolean required=qnh!=null&&qnh.requiresLogin();verificationTitle.setText(required?"需要重新确认牵牛花登录":"正在确认牵牛花登录");verificationText.setText(required?"请点击下方按钮重新登录。库管不会自动打开牵牛花页面。":"页面加载中，请稍候。验证完成后自动继续。");verifying.setVisibility(show?View.VISIBLE:View.GONE);if(show)verifying.bringToFront();FrameLayout content=findViewById(android.R.id.content);for(int i=0;i<content.getChildCount();i++){View child=content.getChildAt(i);if(child!=verifying&&!(child instanceof android.webkit.WebView))child.setImportantForAccessibility(show?View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS:View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);}}
    }
    private void openLogin(){if(resumed&&!loginPending){loginPending=true;sessionReady=false;onSessionUnavailable();startActivityForResult(new Intent(this,QnhLoginActivity.class),LOGIN);}}
    protected final boolean requireQnhAccess(){
        if(qnh==null)qnh=QnhConnection.get(this);
        if(!qnh.verified()){
            verificationCover(true);
            // Business actions can never launch the official browser. Only the explicit login button may do so.
            if(qnh.requiresLogin()&&!loginNotified){loginNotified=true;sessionReady=false;onSessionUnavailable();}
            return false;
        }
        String next=qnh.tenant();if(!tenant.isEmpty()&&!tenant.equals(next))onTenantChanged();tenant=next;
        loginNotified=false;getWindow().getDecorView().setVisibility(View.VISIBLE);verificationCover(false);return true;
    }
    protected void onAuthenticated(){}
    protected final boolean isQnhScreenActive(){return resumed&&!loginPending&&qnh!=null&&qnh.verified();}
    protected void onTenantChanged(){}
    @Override public void onQnhSnapshot(JSONObject value){if(!resumed||!requireQnhAccess())return;if(!sessionReady){sessionReady=true;onAuthenticated();}onAuthenticatedSnapshot(value);}
    protected void onAuthenticatedSnapshot(JSONObject value){}
    protected void onSessionUnavailable(){}
    @Override public void onQnhMessage(String message){}
    @Override protected void onPause(){resumed=false;sessionReady=false;if(qnh!=null)qnh.unlisten(this);super.onPause();}
    @Override protected void onStop(){verificationCover(true);super.onStop();}
    @Override protected void onSaveInstanceState(Bundle state){state.putString("qnh-bound-tenant",tenant);super.onSaveInstanceState(state);}
    @Override public void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request==LOGIN){loginPending=false;if(result!=RESULT_OK || !QnhConnection.get(this).verified())finishAffinity();}}
}
