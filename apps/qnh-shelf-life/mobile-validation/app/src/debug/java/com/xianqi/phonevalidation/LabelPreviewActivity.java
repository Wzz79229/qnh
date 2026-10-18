package com.xianqi.phonevalidation;
import android.app.Activity;
import android.os.Bundle;
import org.json.JSONObject;

/** Test-only synthetic UI fixture. Not compiled into the release APK. */
public final class LabelPreviewActivity extends Activity {
    public static LabelPreviewActivity latest;
    public LabelWorkspace workspace;
    private android.graphics.Bitmap image;
    @Override public void onCreate(Bundle state){super.onCreate(state);
        if(getIntent().getBooleanExtra("wide",false))setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
        workspace=new LabelWorkspace(this,new InventorySearchPanel.Host(){public boolean allowSearch(){return false;}public boolean active(){return false;}public void onQueryChanged(){}public void onSelected(JSONObject row){}},null,new LabelWorkspace.Actions(){public void back(){}public void save(){}public void share(){}public void print(){}});
        setContentView(workspace);LabelContent data=LabelContent.create("示例商品 饮用水 500ml/瓶","500ml/瓶","2110000000000123456","A64-6-4");image=LocationLabelRenderer.render(data);workspace.showRecord(data,"合成测试仓");workspace.showImage(image);
    }
    @Override protected void onResume(){super.onResume();latest=this;}
    @Override protected void onDestroy(){if(latest==this)latest=null;workspace.search.destroy();workspace.preview.setImageDrawable(null);if(image!=null)image.recycle();super.onDestroy();}
}
