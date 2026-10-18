package com.xianqi.phonevalidation;

import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.widget.ArrayAdapter;
import android.widget.AutoCompleteTextView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native inventory filters and result picker; the official browser stays hidden. */
public final class InventoryLookupActivity extends QnhProtectedActivity {
    private NameInput name;private EditText sku,location,barcode,external;
    private TextView status,scope;private LinearLayout results,extra;private Button query,previous,next;
    private JSONArray rows=new JSONArray();private String request="",displayed="";
    private int serial=0,storeDepth=0;private boolean changing=false,queued=false,busy=false,queuedStores=false,productReady=false;
    private AlertDialog stores;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final Runnable autocomplete=()->search();
    private static final class NameInput extends AutoCompleteTextView {
        NameInput(Context context){super(context);}
        // Keep the typed search term; choosing a suggestion must not launch another query.
        @Override protected void replaceText(CharSequence text){}
    }
    private int dp(int n){return Math.round(n*getResources().getDisplayMetrics().density);}
    private Button button(String text,android.view.View.OnClickListener click){Button b=new Button(this);b.setAllCaps(false);b.setText(text);b.setOnClickListener(click);return b;}
    private TextView text(String value,int size){TextView t=new TextView(this);t.setText(value);t.setTextSize(size);t.setTextColor(Color.rgb(24,51,76));t.setPadding(0,dp(8),0,dp(4));return t;}
    private EditText field(LinearLayout root,String title,String hint){root.addView(text(title,14));EditText e=new EditText(this);e.setSingleLine(true);e.setHint(hint);e.setTextSize(16);e.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);e.setAutofillHints((String[])null);root.addView(e);return e;}
    @Override public void onCreate(Bundle state){super.onCreate(state);
        ScrollView scroll=new ScrollView(this);LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(Color.rgb(243,246,250));
        root.setOnApplyWindowInsetsListener((v,insets)->{v.setPadding(dp(18),insets.getSystemWindowInsetTop()+dp(8),dp(18),insets.getSystemWindowInsetBottom()+dp(20));return insets;});
        root.addView(button("‹ 返回标签编辑",v->finish()));root.addView(text("查询商品与库位",25));
        scope=text("正在连接牵牛花库存查询（新）…",13);root.addView(scope);root.addView(button("选择门店 / 仓",v->openStores()));
        root.addView(text("商品名称",14));name=new NameInput(this);name.setSingleLine(true);name.setTextSize(16);name.setThreshold(2);name.setHint("输入名称，查询后从下拉列表选择");name.setAutofillHints((String[])null);root.addView(name);
        sku=field(root,"SKU 编码","完整 SKU，可与其他条件组合");
        location=field(root,"库位编码","例如 C55、C55-3 或 C55-3-13");
        root.addView(button("更多查询条件：商品条码 / 外部编码",v->extra.setVisibility(extra.getVisibility()==android.view.View.VISIBLE?android.view.View.GONE:android.view.View.VISIBLE)));
        extra=new LinearLayout(this);extra.setOrientation(LinearLayout.VERTICAL);barcode=field(extra,"商品条码","商品包装条码");external=field(extra,"外部编码","牵牛花中的外部编码");extra.setVisibility(android.view.View.GONE);root.addView(extra);
        LinearLayout actions=new LinearLayout(this);query=button("查询",v->search());actions.addView(query,new LinearLayout.LayoutParams(0,dp(52),1));actions.addView(button("重置",v->{changing=true;for(EditText e:fields())e.setText("");changing=false;cancel();status.setText("已清空查询条件。");}),new LinearLayout.LayoutParams(0,dp(52),1));root.addView(actions);
        status=text("可按名称、SKU、库位或更多条件组合查询。",14);root.addView(status);
        results=new LinearLayout(this);results.setOrientation(LinearLayout.VERTICAL);root.addView(results);
        LinearLayout pages=new LinearLayout(this);previous=button("上一页",v->page(-1));next=button("下一页",v->page(1));previous.setEnabled(false);next.setEnabled(false);pages.addView(previous,new LinearLayout.LayoutParams(0,dp(48),1));pages.addView(next,new LinearLayout.LayoutParams(0,dp(48),1));root.addView(pages);
        scroll.addView(root);setContentView(scroll);
        if(state!=null){changing=true;String[] keys={"name","sku","location","barcode","external"};EditText[] fields=fields();for(int i=0;i<keys.length;i++)fields[i].setText(state.getString(keys[i],""));changing=false;}
        TextWatcher watcher=new TextWatcher(){public void beforeTextChanged(CharSequence v,int start,int count,int after){}public void afterTextChanged(Editable e){}
            public void onTextChanged(CharSequence v,int start,int before,int count){if(changing)return;cancel();status.setText("查询条件已修改，请重新查询。");if(name.hasFocus()&&name.getText().toString().trim().length()>=2)handler.postDelayed(autocomplete,700);}
        };
        for(EditText e:fields())e.addTextChangedListener(watcher);
        name.setOnItemClickListener((parent,view,index,id)->select(index));
    }
    private EditText[] fields(){return new EditText[]{name,sku,location,barcode,external};}
    private JSONObject filters(){JSONObject f=new JSONObject();try{f.put("name",name.getText().toString().trim());f.put("sku",sku.getText().toString().trim());f.put("loc",location.getText().toString().trim());f.put("barcode",barcode.getText().toString().trim());f.put("external",external.getText().toString().trim());}catch(Exception ignored){}return f;}
    private void cancel(){serial++;request="";displayed="";queued=false;queuedStores=false;busy=false;handler.removeCallbacks(autocomplete);if(name!=null){name.dismissDropDown();name.setAdapter(new ArrayAdapter<String>(this,R.layout.inventory_suggestion,new String[0]));}rows=new JSONArray();if(results!=null)results.removeAllViews();if(query!=null)query.setEnabled(true);if(previous!=null)previous.setEnabled(false);if(next!=null)next.setEnabled(false);if(qnh!=null)qnh.command("window.__kuguanInventory.cancel()",null);}
    private void search(){handler.removeCallbacks(autocomplete);if(!requireQnhAccess())return;JSONObject f=filters();boolean any=false;for(String k:new String[]{"name","sku","loc","barcode","external"})any|=!f.optString(k).isEmpty();if(!any){status.setText("请填写至少一个查询条件。");return;}
        cancel();queued=true;busy=true;query.setEnabled(false);status.setText("正在按条件查询库存…");qnh.inventory();int waiting=serial;handler.postDelayed(()->{if(queued&&serial==waiting)fail("库存页面未准备好，请检查网络和牵牛花库存查询权限后重试。");},30000);
    }
    private void runQuery(){if(!queued)return;queued=false;request=String.valueOf(++serial);String current=request;
        qnh.command("window.__kuguanInventory.search("+JSONObject.quote(current)+","+filters().toString()+","+JSONObject.quote(qnh.tenant())+")",ok->{if(current.equals(request)&&!Boolean.TRUE.equals(ok))fail("查询条件未被接受。库位最多四段、每段六个字符；SKU 请填写完整编码。");});
        handler.postDelayed(()->{if(current.equals(request)&&busy)fail("查询超时，请检查网络、门店权限和查询条件后重试。");},35000);
    }
    private void fail(String value){cancel();status.setText(value);}
    @Override protected void onAuthenticated(){qnh.inventory();}
    @Override protected void onSessionUnavailable(){cancel();if(stores!=null){stores.dismiss();stores=null;}}
    @Override protected void onTenantChanged(){changing=true;for(EditText field:fields())field.setText("");changing=false;cancel();}
    @Override public void onQnhMessage(String value){status.setText(value);}
    @Override protected void onAuthenticatedSnapshot(JSONObject value){
        productReady=value.optBoolean("productReady");if(queuedStores&&productReady){queuedStores=false;openStores();return;}
        String store=value.optString("store");if(!store.isEmpty())scope.setText("库存查询（新） · "+store);
        if(queued&&value.optBoolean("productReady")){runQuery();return;}
        if(request.isEmpty()||!request.equals(value.optString("requestId")))return;
        String phase=value.optString("status");
        if("selected".equals(phase)){finishSelection(value.optJSONObject("row"));return;}
        if("resolving".equals(phase)){status.setText("正在核对所选商品的完整 SKU…");return;}
        if("error".equals(phase)){fail("查询结果尚未确认，请重新查询。");return;}
        if(!"found".equals(phase)&&!"not_found".equals(phase))return;
        String key=request+":"+phase;if(key.equals(displayed))return;displayed=key;busy=false;query.setEnabled(true);
        JSONObject paging=value.optJSONObject("pagination");previous.setEnabled(paging!=null&&paging.optBoolean("previous"));next.setEnabled(paging!=null&&paging.optBoolean("next"));
        rows=value.optJSONArray("rows");if(rows==null)rows=new JSONArray();results.removeAllViews();String[] suggestions=new String[rows.length()];
        for(int i=0;i<rows.length();i++){JSONObject row=rows.optJSONObject(i);if(row==null){fail("库存记录不完整，请重试。");return;}String title=row.optString("name")+"\n"+row.optString("spec")+"\n"+row.optString("store")+" · 库位："+(row.optString("loc").isEmpty()?"未设置":row.optString("loc"));suggestions[i]=title;final int index=i;results.addView(button(title,v->select(index)));}
        status.setText(rows.length()==0?"没有符合条件的库存记录，请调整名称、库位或门店范围。":"请选择需要打印的商品与库位（本页 "+rows.length()+" 条）。");
        name.setAdapter(new ArrayAdapter<>(this,R.layout.inventory_suggestion,suggestions));if(name.hasFocus()&&rows.length()>0)name.showDropDown();
    }
    private void select(int index){if(!requireQnhAccess()||busy||request.isEmpty()||index<0||index>=rows.length())return;handler.removeCallbacks(autocomplete);name.dismissDropDown();busy=true;query.setEnabled(false);String current=request;
        qnh.command("window.__kuguanInventory.select("+JSONObject.quote(current)+","+index+","+JSONObject.quote(qnh.tenant())+")",ok->{if(current.equals(request)&&!Boolean.TRUE.equals(ok))fail("库存结果已经变化，请重新查询后选择。");});
    }
    private void finishSelection(JSONObject row){try{if(row==null||!row.getString("sku").matches("[A-Za-z0-9._-]{1,64}")||row.getString("name").isEmpty()||row.getString("name").length()>200||row.optString("spec").length()>240||row.optString("loc").length()>300)throw new Exception();Intent data=new Intent();for(String key:new String[]{"name","spec","sku","loc"})data.putExtra(key,row.getString(key));setResult(RESULT_OK,data);request="";finish();}catch(Exception error){fail("商品资料不完整，请重新查询。");}}
    private void page(int direction){if(!requireQnhAccess()||busy||request.isEmpty())return;name.dismissDropDown();busy=true;query.setEnabled(false);String current=String.valueOf(++serial);request=current;displayed="";
        qnh.command("window.__kuguanInventory.page("+JSONObject.quote(current)+","+direction+","+JSONObject.quote(qnh.tenant())+")",ok->{if(current.equals(request)&&!Boolean.TRUE.equals(ok))fail("翻页结果未确认，请重新查询。");});
        handler.postDelayed(()->{if(current.equals(request)&&busy)fail("翻页超时，请重新查询。");},20000);
    }
    private void openStores(){if(!requireQnhAccess())return;cancel();storeDepth=0;if(!productReady||!qnh.isInventory()){queuedStores=true;status.setText("正在加载可选门店 / 仓…");qnh.inventory();int waiting=serial;handler.postDelayed(()->{if(queuedStores&&serial==waiting)fail("门店列表加载超时，请检查网络和库存权限。");},20000);return;}qnh.command("window.__kuguanInventory.openStores()",ok->{if(Boolean.TRUE.equals(ok))loadStores(0);else status.setText("门店选项尚未准备好，请稍后重试。");});}
    private void loadStores(int attempt){if(isFinishing())return;qnh.command("window.__kuguanInventory.stores()",result->{if(!(result instanceof JSONArray)){status.setText("门店列表暂时不可用。");return;}JSONArray columns=(JSONArray)result;
        if(columns.length()<=storeDepth){if(attempt<15){handler.postDelayed(()->loadStores(attempt+1),400);return;}storeDepth=Math.max(0,columns.length()-1);}
        JSONObject column=columns.optJSONObject(storeDepth);JSONArray options=column==null?null:column.optJSONArray("options");if(options==null||options.length()==0){status.setText("暂无可选门店，请确认牵牛花库存权限。");return;}
        String[] labels=new String[options.length()];for(int i=0;i<options.length();i++){JSONObject item=options.optJSONObject(i);labels[i]=item.optString("label")+(item.optBoolean("children")?"  ›":item.optBoolean("checked")?"  ✓":"");}
        if(stores!=null)stores.dismiss();
        AlertDialog.Builder builder=new AlertDialog.Builder(this).setTitle("选择门店 / 仓").setItems(labels,(dialog,index)->{JSONObject item=options.optJSONObject(index);int depth=storeDepth;if(item.optBoolean("children"))storeDepth++;qnh.command("window.__kuguanInventory.chooseStore("+depth+","+item.optInt("index")+","+JSONObject.quote(item.optString("key"))+","+JSONObject.quote(item.optString("label"))+")",ok->{if(Boolean.TRUE.equals(ok))loadStores(0);else status.setText("门店列表已变化，请重新打开选择。");});})
            .setPositiveButton("完成",(dialog,which)->{qnh.command("window.__kuguanInventory.closeStores()",null);status.setText("门店范围已更新，请重新查询。");});
        if(storeDepth>0)builder.setNegativeButton("上一级",(dialog,which)->{storeDepth--;loadStores(0);});
        builder.setNeutralButton("更多选项",(dialog,which)->qnh.command("window.__kuguanInventory.scrollStores("+storeDepth+",1)",ok->loadStores(0)));
        stores=builder.create();stores.setOnCancelListener(dialog->qnh.command("window.__kuguanInventory.closeStores()",null));stores.show();
    });}
    @Override public void onPause(){handler.removeCallbacks(autocomplete);super.onPause();}
    @Override public void onDestroy(){handler.removeCallbacksAndMessages(null);if(stores!=null)stores.dismiss();super.onDestroy();}
    @Override protected void onSaveInstanceState(Bundle out){String[] keys={"name","sku","location","barcode","external"};EditText[] fields=fields();for(int i=0;i<keys.length;i++)out.putString(keys[i],fields[i].getText().toString());super.onSaveInstanceState(out);}
}
