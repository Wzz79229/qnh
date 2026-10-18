package com.xianqi.phonevalidation;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;

/** Small feature hub sharing the native label workspace's visual style. */
public final class WarehouseActivity extends QnhProtectedActivity {
    private int dp(int value){return WarehouseUi.dp(this,value);}
    @Override public void onCreate(Bundle state){super.onCreate(state);
        FrameLayout container=new FrameLayout(this);container.setBackgroundColor(WarehouseUi.BG);ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);container.addView(scroll);
        FrameLayout wrap=new FrameLayout(this);LinearLayout root=new LinearLayout(this){@Override protected void onMeasure(int w,int h){super.onMeasure(MeasureSpec.makeMeasureSpec(Math.min(MeasureSpec.getSize(w),dp(680)),MeasureSpec.EXACTLY),h);}};root.setOrientation(LinearLayout.VERTICAL);root.setPadding(dp(22),dp(26),dp(22),dp(24));wrap.addView(root,new FrameLayout.LayoutParams(-1,-2,Gravity.CENTER_HORIZONTAL));scroll.addView(wrap);
        LinearLayout brand=new LinearLayout(this);brand.setGravity(Gravity.CENTER_VERTICAL);ImageView icon=new ImageView(this);icon.setImageResource(R.mipmap.ic_launcher);icon.setContentDescription("库管图标");brand.addView(icon,new LinearLayout.LayoutParams(dp(56),dp(56)));LinearLayout titles=new LinearLayout(this);titles.setPadding(dp(14),0,0,0);titles.setOrientation(LinearLayout.VERTICAL);titles.addView(WarehouseUi.text(this,"库管",29,WarehouseUi.INK,true));WarehouseUi.space(titles,5);titles.addView(WarehouseUi.text(this,"仓库日常工具",13,WarehouseUi.MUTED,false));brand.addView(titles);root.addView(brand);WarehouseUi.space(root,30);
        LinearLayout label=WarehouseUi.card(this);label.addView(WarehouseUi.text(this,"库位标签",22,WarehouseUi.INK,true));WarehouseUi.space(label,9);label.addView(WarehouseUi.text(this,"查询商品，自动生成可打印的库位标签。",14,WarehouseUi.MUTED,false));WarehouseUi.space(label,18);label.addView(WarehouseUi.button(this,"开始查询  →",true,v->{if(requireQnhAccess())startActivity(new Intent(this,LocationLabelActivity.class));}));root.addView(label);WarehouseUi.space(root,14);
        LinearLayout paused=WarehouseUi.card(this);paused.addView(WarehouseUi.text(this,"保质期管理",17,WarehouseUi.MUTED,true));WarehouseUi.space(paused,8);paused.addView(WarehouseUi.text(this,"已暂停",12,WarehouseUi.MUTED,false));root.addView(paused);WarehouseUi.space(root,24);
        Button account=WarehouseUi.button(this,"退出登录 / 切换牵牛花账号",false,null);account.setOnClickListener(v->{account.setEnabled(false);QnhConnection.get(this).signOut(()->{account.setEnabled(true);requireQnhAccess();});});root.addView(account);WarehouseUi.space(root,18);root.addView(WarehouseUi.text(this,"库管 0.5.1",12,WarehouseUi.MUTED,false));
        container.setOnApplyWindowInsetsListener((view,insets)->{container.setPadding(0,insets.getSystemWindowInsetTop(),0,insets.getSystemWindowInsetBottom());return insets;});setContentView(container);
    }
}
