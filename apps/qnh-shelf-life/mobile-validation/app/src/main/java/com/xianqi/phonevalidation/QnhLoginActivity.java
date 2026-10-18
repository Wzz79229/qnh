package com.xianqi.phonevalidation;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;

public final class QnhLoginActivity extends Activity implements QnhConnection.Listener {
    private QnhConnection qnh;private TextView status;private FrameLayout browser;private boolean entering=false,first=true;
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    @Override public void onCreate(Bundle state){super.onCreate(state);qnh=QnhConnection.get(this);
        LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(Color.rgb(243,246,250));
        root.setOnApplyWindowInsetsListener((view,insets)->{view.setPadding(dp(14),insets.getSystemWindowInsetTop()+dp(8),dp(14),insets.getSystemWindowInsetBottom());return insets;});
        LinearLayout brand=new LinearLayout(this);brand.setGravity(android.view.Gravity.CENTER_VERTICAL);ImageView icon=new ImageView(this);icon.setImageResource(com.xianqi.phonevalidation.R.mipmap.ic_launcher);icon.setContentDescription("库管应用图标");brand.addView(icon,new LinearLayout.LayoutParams(dp(44),dp(44)));
        TextView title=new TextView(this);title.setText("  库管 · 登录牵牛花");title.setTextSize(22);title.setTextColor(Color.rgb(18,63,73));brand.addView(title);root.addView(brand);
        status=new TextView(this);status.setText("请在下方牵牛花官方页面登录。验证成功后自动进入库管，并隐藏牵牛花页面。");status.setTextSize(14);status.setPadding(0,dp(10),0,dp(10));root.addView(status);
        Button refresh=new Button(this);refresh.setText("重新加载登录页");refresh.setOnClickListener(v->qnh.freshLogin());root.addView(refresh);
        browser=new FrameLayout(this);root.addView(browser,new LinearLayout.LayoutParams(-1,0,1));setContentView(root);
    }
    @Override protected void onResume(){super.onResume();qnh.listen(this);qnh.attach(this,browser,true);if(first){first=false;qnh.freshLogin();}}
    @Override public void onQnhSnapshot(JSONObject snapshot){if(entering||!qnh.verified())return;entering=true;
        qnh.releaseHost(this);
        if(getCallingActivity()!=null){setResult(RESULT_OK);finish();}
        else{startActivity(new Intent(this,WarehouseActivity.class));finish();}
    }
    @Override public void onQnhMessage(String value){status.setText(value);}
    @Override protected void onPause(){qnh.unlisten(this);super.onPause();}
}
