package com.xianqi.phonevalidation;
import android.app.Activity;
import android.os.Bundle;
import android.graphics.Bitmap;
import java.util.*;
import org.json.JSONObject;
/** Synthetic scroll-list fixture; excluded from release APK. */
public final class LabelPreviewActivity extends Activity {
    public static LabelPreviewActivity latest;public LabelWorkspace workspace;
    @Override public void onCreate(Bundle state){super.onCreate(state);if(getIntent().getBooleanExtra("wide",false))setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
        workspace=new LabelWorkspace(this,new InventorySearchPanel.Host(){public boolean allowSearch(){return false;}public boolean active(){return false;}public void onQueryChanged(){}public void onSelected(JSONObject row){}},null,new LabelWorkspace.Actions(){public void back(){}public void save(){}public void share(){}});setContentView(workspace);
        LabelQueue feed=new LabelQueue();String[] names={"合成测试饮用水","合成测试饮用水","区域测试商品"},specs={"500ml/瓶","1L/瓶","1份"},skus={"2110000000000123456","2110000000000123457","2110000000000123458"},locations={"A10-1-1","A10-1-2","A10-2-1"};
        for(int i=0;i<3;i++){LabelContent data=LabelContent.create(names[i],specs[i],skus[i],locations[i]);Bitmap image=LocationLabelRenderer.render(data);try{feed.prepend(new LabelBatch("777",Collections.singletonList(new LabelBatch.Entry(data,"合成测试仓",LocationLabelRenderer.png(image)))));}catch(Exception error){throw new AssertionError(error);}finally{image.recycle();}}
        ((android.widget.EditText)workspace.findViewWithTag("smart-query-input")).setText("A10");workspace.showLabels(feed.items());workspace.message("最新生成的标签显示在最上方。");
    }
    @Override protected void onResume(){super.onResume();latest=this;}
    @Override protected void onDestroy(){if(latest==this)latest=null;workspace.search.destroy();workspace.dispose();super.onDestroy();}
}
