package com.xianqi.phonevalidation;
import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.*;
import org.json.JSONObject;

/** Compact phone wrapper around the unchanged official login page. */
public final class QnhLoginActivity extends Activity implements QnhConnection.Listener {
    private QnhConnection qnh;private TextView status;private FrameLayout browser;private ProgressBar progress;private boolean entering=false;
    private int dp(int value){return WarehouseUi.dp(this,value);}
    @Override public void onCreate(Bundle state){super.onCreate(state);qnh=QnhConnection.get(this);
        LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(WarehouseUi.BG);root.setOnApplyWindowInsetsListener((v,i)->{v.setPadding(0,i.getSystemWindowInsetTop(),0,i.getSystemWindowInsetBottom());return i;});
        LinearLayout brand=new LinearLayout(this);brand.setGravity(Gravity.CENTER_VERTICAL);brand.setPadding(dp(14),dp(10),dp(14),dp(10));
        ImageView icon=new ImageView(this);icon.setImageResource(R.mipmap.ic_launcher);icon.setContentDescription("库管图标");brand.addView(icon,new LinearLayout.LayoutParams(dp(38),dp(38)));
        LinearLayout titles=new LinearLayout(this);titles.setOrientation(LinearLayout.VERTICAL);titles.setPadding(dp(10),0,dp(8),0);titles.addView(WarehouseUi.text(this,"登录牵牛花",19,WarehouseUi.INK,true));WarehouseUi.space(titles,3);titles.addView(WarehouseUi.text(this,"库管 · 官方页面安全登录",11,WarehouseUi.MUTED,false));brand.addView(titles,new LinearLayout.LayoutParams(0,-2,1));
        Button refresh=WarehouseUi.button(this,"刷新",false,v->{entering=false;status.setText("正在重新加载官方登录页…");progress.setVisibility(android.view.View.VISIBLE);qnh.freshLogin();});refresh.setContentDescription("重新加载牵牛花登录页");brand.addView(refresh,new LinearLayout.LayoutParams(dp(62),dp(40)));root.addView(brand);
        progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);progress.setMax(100);progress.setProgressTintList(android.content.res.ColorStateList.valueOf(WarehouseUi.GREEN));root.addView(progress,new LinearLayout.LayoutParams(-1,dp(3)));
        browser=new FrameLayout(this);browser.setBackgroundColor(android.graphics.Color.WHITE);root.addView(browser,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout bottom=new LinearLayout(this);bottom.setGravity(Gravity.CENTER_VERTICAL);bottom.setPadding(dp(12),dp(8),dp(12),dp(8));status=WarehouseUi.text(this,"正在加载官方登录页…",12,WarehouseUi.MUTED,false);status.setMaxLines(3);bottom.addView(status,new LinearLayout.LayoutParams(0,-2,1));
        Button smaller=WarehouseUi.button(this,"－",false,v->qnh.loginZoom(false));smaller.setContentDescription("缩小登录页面");bottom.addView(smaller,new LinearLayout.LayoutParams(dp(44),dp(42)));Button larger=WarehouseUi.button(this,"＋",false,v->qnh.loginZoom(true));larger.setContentDescription("放大登录页面");LinearLayout.LayoutParams zoom=new LinearLayout.LayoutParams(dp(44),dp(42));zoom.setMarginStart(dp(6));bottom.addView(larger,zoom);root.addView(bottom);setContentView(root);
    }
    @Override protected void onResume(){super.onResume();qnh.listen(this);qnh.attach(this,browser,true);qnh.loginPage();}
    @Override public void onQnhPageProgress(int value){progress.setProgress(value);progress.setVisibility(value<100?android.view.View.VISIBLE:android.view.View.GONE);if(value==100)status.setText("请完成官方登录，成功后自动进入库管。");}
    @Override public void onQnhSnapshot(JSONObject snapshot){if(entering)return;if(!qnh.verified()){if(snapshot.optBoolean("authorized"))status.setText("登录成功，正在确认并进入库管…");return;}entering=true;status.setText("已登录，正在进入库管…");qnh.releaseHost(this);if(getCallingActivity()!=null){setResult(RESULT_OK);finish();}else{startActivity(new Intent(this,WarehouseActivity.class));finish();}}
    @Override public void onQnhMessage(String value){progress.setVisibility(android.view.View.GONE);status.setText(value);}
    @Override protected void onPause(){qnh.unlisten(this);super.onPause();}
}
