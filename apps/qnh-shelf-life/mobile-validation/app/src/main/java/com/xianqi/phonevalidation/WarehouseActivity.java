package com.xianqi.phonevalidation;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Feature hub. Paused shelf-life code and on-device data remain available for future updates. */
public final class WarehouseActivity extends Activity {
    private int dp(int value) { return Math.round(value*getResources().getDisplayMetrics().density); }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state); LinearLayout root=new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(243,246,250));
        root.setOnApplyWindowInsetsListener((view,insets)->{ view.setPadding(dp(24),insets.getSystemWindowInsetTop()+dp(28),dp(24),insets.getSystemWindowInsetBottom()+dp(20)); return insets; });
        TextView title=new TextView(this); title.setText("库管"); title.setTextSize(34); title.setTextColor(Color.rgb(24,51,76)); root.addView(title);
        TextView intro=new TextView(this); intro.setText("仓库日常工具"); intro.setTextSize(16); intro.setPadding(0,dp(8),0,dp(30)); root.addView(intro);
        Button labels=new Button(this); labels.setAllCaps(false); labels.setText("库位标签\n生成 80 × 60 毫米标签图片"); labels.setTextSize(18); labels.setPadding(dp(12),dp(18),dp(12),dp(18)); labels.setOnClickListener(v->startActivity(new Intent(this,LocationLabelActivity.class))); root.addView(labels,new LinearLayout.LayoutParams(-1,dp(110)));
        TextView paused=new TextView(this); paused.setText("保质期管理 · 已暂停"); paused.setTextSize(16); paused.setTextColor(Color.GRAY); paused.setPadding(dp(12),dp(32),0,0); root.addView(paused);
        View spacer=new View(this); root.addView(spacer,new LinearLayout.LayoutParams(1,0,1)); TextView version=new TextView(this); version.setText("库管 0.3.0"); version.setTextColor(Color.GRAY); root.addView(version); setContentView(root);
    }
}
