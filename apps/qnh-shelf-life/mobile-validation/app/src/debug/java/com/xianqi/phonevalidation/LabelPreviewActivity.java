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
        setContentView(workspace);LabelContent data=LabelContent.create("【规格可选】示例泡沫地垫 厚1cm 儿童爬行垫 加厚拼接地板垫 1片/份","白色30×30cm","2110000000000198822","A10-1-1");((android.widget.EditText)workspace.findViewWithTag("smart-query-input")).setText(data.sku);image=LocationLabelRenderer.render(data);workspace.showRecord(data,"合成测试仓");workspace.showImage(image);
    }
    @Override protected void onResume(){super.onResume();latest=this;}
    @Override protected void onDestroy(){if(latest==this)latest=null;workspace.search.destroy();workspace.preview.setImageDrawable(null);if(image!=null)image.recycle();super.onDestroy();}
}
