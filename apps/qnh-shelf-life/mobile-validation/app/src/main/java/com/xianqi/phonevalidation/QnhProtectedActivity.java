package com.xianqi.phonevalidation;

import android.app.Activity;
import android.content.Intent;
import android.view.View;
import android.widget.FrameLayout;
import org.json.JSONObject;

/** All feature screens fail closed after process death, logout or background return. */
public abstract class QnhProtectedActivity extends Activity implements QnhConnection.Listener {
    private static final int LOGIN=7001;
    protected QnhConnection qnh;
    private boolean loginPending=false,resumed=false;
    private String tenant="";
    @Override protected void onResume(){super.onResume();resumed=true;qnh=QnhConnection.get(this);qnh.listen(this);qnh.attach(this,(FrameLayout)findViewById(android.R.id.content),false);if(requireQnhAccess())onAuthenticated();}
    protected final boolean requireQnhAccess(){
        if(qnh==null)qnh=QnhConnection.get(this);
        if(!qnh.verified()){
            getWindow().getDecorView().setVisibility(View.INVISIBLE);
            if(resumed&&!loginPending){loginPending=true;startActivityForResult(new Intent(this,QnhLoginActivity.class),LOGIN);}
            return false;
        }
        String next=qnh.tenant();if(!tenant.isEmpty()&&!tenant.equals(next))onTenantChanged();tenant=next;
        getWindow().getDecorView().setVisibility(View.VISIBLE);return true;
    }
    protected void onAuthenticated(){}
    protected void onTenantChanged(){}
    @Override public void onQnhSnapshot(JSONObject value){if(!resumed)return;if(!qnh.verified()){onSessionUnavailable();requireQnhAccess();}else onAuthenticatedSnapshot(value);}
    protected void onAuthenticatedSnapshot(JSONObject value){}
    protected void onSessionUnavailable(){}
    @Override public void onQnhMessage(String message){}
    @Override protected void onPause(){resumed=false;if(qnh!=null)qnh.unlisten(this);super.onPause();}
    @Override protected void onStop(){getWindow().getDecorView().setVisibility(View.INVISIBLE);super.onStop();}
    @Override public void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request==LOGIN){loginPending=false;if(result!=RESULT_OK || !QnhConnection.get(this).verified())finishAffinity();}}
}
