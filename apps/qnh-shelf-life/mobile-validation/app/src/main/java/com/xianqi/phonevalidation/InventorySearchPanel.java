package com.xianqi.phonevalidation;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.widget.ArrayAdapter;
import android.widget.AutoCompleteTextView;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

/** Inline query controls. Product details are returned to the read-only label workspace. */
public final class InventorySearchPanel extends LinearLayout {
    public interface Host {
        boolean allowSearch();
        boolean active();
        void onQueryChanged();
        void onSelected(JSONObject row);
        default void onScan(){}
        default void onBatchSelected(JSONArray rows){if(rows.length()==1)onSelected(rows.optJSONObject(0));}
    }
    private final Activity owner;private final Host host;private final QnhConnection qnh;
    private NameInput name;
    private TextView status,scope,detected;private LinearLayout results,pages;private Button query,previous,next;
    private JSONArray rows=new JSONArray();private String request="",displayed="";
    private int serial=0,storeDepth=0;private boolean changing=false,queued=false,busy=false,queuedStores=false,productReady=false;
    private AlertDialog stores;
    private LinearLayout batchBar;private Button generateBatch,checkAll;
    private final java.util.Set<Integer> checked=new java.util.LinkedHashSet<>();
    private int[] batchIndices;private int batchCursor=0;private JSONArray batchRows;private boolean batchReturning=false;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final Runnable autocomplete=()->search();
    private static final class NameInput extends AutoCompleteTextView {
        NameInput(Context context){super(context);}
        @Override protected void replaceText(CharSequence value){}
    }
    private int dp(int n){return WarehouseUi.dp(owner,n);}
    private boolean requireQnhAccess(){return host.allowSearch();}
    private boolean isQnhScreenActive(){return host.active();}
    private boolean isFinishing(){return owner.isFinishing();}
    private Button button(String value,android.view.View.OnClickListener click){Button b=WarehouseUi.button(owner,value,false,click);b.setGravity(Gravity.START|Gravity.CENTER_VERTICAL);return b;}
    private EditText field(LinearLayout root,String title,String hint){TextView label=WarehouseUi.text(owner,title,12,WarehouseUi.MUTED,false);root.addView(label);WarehouseUi.space(root,6);EditText e=new EditText(owner);WarehouseUi.input(e,hint);root.addView(e);return e;}
    public InventorySearchPanel(Activity owner,Host host,Bundle state){super(owner);this.owner=owner;this.host=host;qnh=QnhConnection.get(owner);setOrientation(VERTICAL);
        LinearLayout heading=new LinearLayout(owner);heading.setGravity(Gravity.CENTER_VERTICAL);TextView title=WarehouseUi.text(owner,"查询商品",18,WarehouseUi.INK,true);heading.addView(title,new LayoutParams(0,-2,1));
        heading.addView(WarehouseUi.button(owner,"清空",false,v->{changing=true;for(EditText e:fields())e.setText("");changing=false;cancel();host.onQueryChanged();detected.setText("自动识别名称、SKU、库位 · 点击更改类型");status.setText("输入查询条件，标签将自动生成。");}));
        addView(heading);WarehouseUi.space(this,12);
        LinearLayout queryRow=new LinearLayout(owner);queryRow.setGravity(Gravity.CENTER_VERTICAL);name=new NameInput(owner);name.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.AllCaps(java.util.Locale.ROOT),new android.text.InputFilter.LengthFilter(100)});name.setThreshold(2);WarehouseUi.input(name,"输入名称 / SKU / 库位");name.setGravity(Gravity.CENTER);name.setIncludeFontPadding(false);name.setMinHeight(dp(52));name.setPadding(dp(12),dp(10),dp(12),dp(10));name.setTag("smart-query-input");queryRow.addView(name,new LayoutParams(0,-2,1));Button scan=WarehouseUi.button(owner,"扫码",false,v->{if(requireQnhAccess())host.onScan();});scan.setTag("query-scan");scan.setContentDescription("扫描条形码查询商品");LayoutParams scanSize=new LayoutParams(dp(56),dp(52));scanSize.setMarginStart(dp(8));queryRow.addView(scan,scanSize);addView(queryRow,new LayoutParams(-1,-2));WarehouseUi.space(this,8);
        detected=WarehouseUi.text(owner,"自动识别名称、SKU、库位 · 点击更改类型",12,WarehouseUi.GREEN,false);detected.setPadding(0,dp(4),0,dp(4));detected.setOnClickListener(v->{String[] types={"自动识别","商品名称","SKU","库位","商品条码","外部编码"};new AlertDialog.Builder(owner).setTitle("查询类型").setItems(types,(dialog,index)->{String raw=name.getText().toString().trim();try{raw=SmartQuery.parse(raw).value;}catch(IllegalArgumentException ignored){}String[] prefixes={"","名称:","SKU:","库位:","条码:","外部编码:"};name.setText(prefixes[index]+raw);name.setSelection(name.length());}).show();});addView(detected);WarehouseUi.space(this,10);
        addView(WarehouseUi.button(owner,"选择门店 / 仓 ▾",false,v->openStores()),new LayoutParams(-1,dp(40)));WarehouseUi.space(this,8);
        scope=WarehouseUi.text(owner,"正在连接库存查询（新）…",12,WarehouseUi.MUTED,false);addView(scope);WarehouseUi.space(this,6);
        status=WarehouseUi.text(owner,"唯一结果自动出图；多条结果请选择商品与库位。",12,WarehouseUi.MUTED,false);addView(status);WarehouseUi.space(this,12);
        query=WarehouseUi.button(owner,"查询并生成标签",true,v->search());query.setTag("smart-query-submit");addView(query,new LayoutParams(-1,dp(46)));
        results=new LinearLayout(owner);results.setOrientation(VERTICAL);addView(results);
        batchBar=new LinearLayout(owner);batchBar.setOrientation(VERTICAL);WarehouseUi.space(batchBar,10);checkAll=WarehouseUi.button(owner,"全选本页（最多50张）",false,v->toggleAll());batchBar.addView(checkAll);WarehouseUi.space(batchBar,8);generateBatch=WarehouseUi.button(owner,"生成所选（0张）",true,v->startBatch());generateBatch.setTag("batch-generate");batchBar.addView(generateBatch);batchBar.setVisibility(GONE);addView(batchBar,indexOfChild(results));
        pages=new LinearLayout(owner);previous=WarehouseUi.button(owner,"上一页",false,v->page(-1));next=WarehouseUi.button(owner,"下一页",false,v->page(1));previous.setEnabled(false);next.setEnabled(false);LayoutParams p=new LayoutParams(0,dp(42),1);p.setMarginEnd(dp(8));pages.addView(previous,p);pages.addView(next,new LayoutParams(0,dp(42),1));pages.setVisibility(GONE);addView(pages);
        if(state!=null)name.setText(state.getString("query-text",""));
        TextWatcher watcher=new TextWatcher(){public void beforeTextChanged(CharSequence v,int start,int count,int after){}public void afterTextChanged(Editable value){}
            public void onTextChanged(CharSequence value,int start,int before,int count){if(changing)return;cancel();host.onQueryChanged();status.setText("查询后自动生成标签。");try{SmartQuery parsed=SmartQuery.parse(value.toString());detected.setText("已识别为："+parsed.label+" · 点击更改类型");if(name.hasFocus()&&parsed.key.equals("name")&&parsed.value.length()>=2)handler.postDelayed(autocomplete,800);}catch(IllegalArgumentException error){detected.setText(value.length()==0?"自动识别名称、SKU、库位 · 点击更改类型":error.getMessage());}}
        };
        name.addTextChangedListener(watcher);name.setOnEditorActionListener((v,action,event)->{if(action==android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH||event!=null&&event.getAction()==android.view.KeyEvent.ACTION_DOWN&&event.getKeyCode()==android.view.KeyEvent.KEYCODE_ENTER){search();return true;}return false;});
        name.setOnItemClickListener((parent,view,index,id)->select(index));
    }
    public void scanned(String raw,String format){try{String text=BarcodeDecoder.query(raw,format);changing=true;android.text.InputFilter[] saved=name.getFilters();name.setFilters(new android.text.InputFilter[0]);name.setText(text);name.setFilters(saved);name.setSelection(name.length());changing=false;search();}catch(IllegalArgumentException error){changing=false;status.setText(error.getMessage());}}
    private EditText[] fields(){return new EditText[]{name};}
    private JSONObject filters(){SmartQuery parsed=SmartQuery.parse(name.getText().toString());detected.setText("已识别为："+parsed.label+" · 点击更改类型");JSONObject f=new JSONObject();try{f.put(parsed.key,parsed.value);}catch(Exception ignored){}return f;}
    private void cancel(){serial++;request="";displayed="";queued=false;queuedStores=false;busy=false;batchIndices=null;batchRows=null;batchReturning=false;checked.clear();if(batchBar!=null)batchBar.setVisibility(GONE);handler.removeCallbacks(autocomplete);if(name!=null){name.dismissDropDown();name.setAdapter(new ArrayAdapter<String>(owner,R.layout.inventory_suggestion,new String[0]));}rows=new JSONArray();if(pages!=null)pages.setVisibility(GONE);if(results!=null)results.removeAllViews();if(query!=null)query.setEnabled(true);if(previous!=null)previous.setEnabled(false);if(next!=null)next.setEnabled(false);if(qnh!=null)qnh.command("window.__kuguanInventory.cancel()",null);}
    private void search(){handler.removeCallbacks(autocomplete);if(!requireQnhAccess())return;try{filters();}catch(IllegalArgumentException error){status.setText(error.getMessage());return;}
        cancel();host.onQueryChanged();queued=true;busy=true;query.setEnabled(false);status.setText("正在按条件查询库存…");qnh.inventory();int waiting=serial;handler.postDelayed(()->{if(queued&&serial==waiting)fail("库存页面未准备好，请检查网络和牵牛花库存查询权限后重试。");},30000);
    }
    private void runQuery(){if(!queued)return;queued=false;request=String.valueOf(++serial);String current=request;
        qnh.command("window.__kuguanInventory.search("+JSONObject.quote(current)+","+filters().toString()+","+JSONObject.quote(qnh.tenant())+")",ok->{if(current.equals(request)&&!Boolean.TRUE.equals(ok))fail("查询条件未被接受。库位最多四段、每段六个字符；SKU 请填写完整编码。");});
        handler.postDelayed(()->{if(current.equals(request)&&busy&&batchIndices==null)fail("查询超时，请检查网络、门店权限和查询条件后重试。");},35000);
    }
    private void fail(String value){cancel();status.setText(value);}
    public void authenticated(){qnh.watchInventory(true);qnh.inventory();}
    public void suspended(){cancel();status.setText("登录恢复后，请重新查询商品。");if(stores!=null){stores.dismiss();stores=null;}}
    public void clearTenant(){changing=true;for(EditText field:fields())field.setText("");changing=false;cancel();}
    public void message(String value){status.setText(value);}
    public void snapshot(JSONObject value){
        productReady=value.optBoolean("productReady");if(queuedStores&&productReady){queuedStores=false;openStores();return;}
        String store=value.optString("store");if(!store.isEmpty())scope.setText("库存查询（新） · "+store);
        if(queued&&value.optBoolean("productReady")){runQuery();return;}
        if(request.isEmpty()||!request.equals(value.optString("requestId")))return;
        if(batchReturning){if(productReady){batchReturning=false;resolve(batchIndices[batchCursor]);}return;}
        String phase=value.optString("status");
        if("selected".equals(phase)){finishSelection(value.optJSONObject("row"));return;}
        if("resolving".equals(phase)){status.setText("正在核对所选商品的完整 SKU…");return;}
        if("error".equals(phase)){fail("查询结果尚未确认，请重新查询。");return;}
        if(!"found".equals(phase)&&!"not_found".equals(phase))return;
        String key=request+":"+phase;if(key.equals(displayed))return;displayed=key;busy=false;query.setEnabled(true);
        JSONObject paging=value.optJSONObject("pagination");previous.setEnabled(paging!=null&&paging.optBoolean("previous"));next.setEnabled(paging!=null&&paging.optBoolean("next"));
        pages.setVisibility(paging!=null&&(paging.optBoolean("previous")||paging.optBoolean("next"))?VISIBLE:GONE);
        rows=value.optJSONArray("rows");if(rows==null)rows=new JSONArray();results.removeAllViews();checked.clear();String[] suggestions=new String[rows.length()];
        for(int i=0;i<rows.length();i++){JSONObject row=rows.optJSONObject(i);if(row==null){fail("库存记录不完整，请重试。");return;}String title=row.optString("name")+"\n"+row.optString("spec")+"\n"+row.optString("store")+" · 库位："+(row.optString("loc").isEmpty()?"未设置":row.optString("loc"));suggestions[i]=title;final int index=i;Button choice=button(title,v->select(index));LinearLayout line=new LinearLayout(owner);line.setGravity(Gravity.CENTER_VERTICAL);CheckBox box=new CheckBox(owner);box.setTag("batch-choice-"+i);box.setContentDescription("多选："+title);box.setButtonTintList(android.content.res.ColorStateList.valueOf(WarehouseUi.GREEN));box.setOnCheckedChangeListener((view,valueChecked)->{if(valueChecked&&checked.size()>=LabelBatch.MAX_ITEMS){view.setChecked(false);status.setText("每批最多50张，请分批选择。");return;}if(valueChecked)checked.add(index);else checked.remove(index);updateBatch();});line.addView(box,new LayoutParams(dp(44),dp(48)));line.addView(choice,new LayoutParams(0,-2,1));LayoutParams choiceSize=new LayoutParams(-1,-2);choiceSize.topMargin=dp(8);results.addView(line,choiceSize);}
        batchBar.setVisibility(rows.length()>1?VISIBLE:GONE);checkAll.setEnabled(true);updateBatch();
        status.setText(rows.length()==0?"没有符合条件的库存记录，请调整名称、库位或门店范围。":"可点选单张，或勾选多个商品后批量生成（本页 "+rows.length()+" 条）。");
        if(rows.length()==1&&paging!=null&&!paging.optBoolean("previous")&&!paging.optBoolean("next")){results.removeAllViews();select(0);return;}
        name.setAdapter(new ArrayAdapter<>(owner,R.layout.inventory_suggestion,suggestions));if(name.hasFocus()&&rows.length()>0&&SmartQuery.parse(name.getText().toString()).key.equals("name"))name.showDropDown();
    }
    private void select(int index){if(!requireQnhAccess()||busy||request.isEmpty()||index<0||index>=rows.length())return;handler.removeCallbacks(autocomplete);name.dismissDropDown();InputMethodManager keyboard=(InputMethodManager)owner.getSystemService(Context.INPUT_METHOD_SERVICE);if(keyboard!=null)keyboard.hideSoftInputFromWindow(name.getWindowToken(),0);busy=true;query.setEnabled(false);generateBatch.setEnabled(false);checkAll.setEnabled(false);String current=request;
        resolve(index);
    }
    private void resolve(int index){String current=request;int step=batchCursor;status.setText(batchIndices==null?"正在核对商品的完整 SKU…":"正在核对所选商品 "+(batchCursor+1)+" / "+batchIndices.length+"…");qnh.command("window.__kuguanInventory.select("+JSONObject.quote(current)+","+index+","+JSONObject.quote(qnh.tenant())+")",ok->{if(current.equals(request)&&!Boolean.TRUE.equals(ok))fail("库存结果已经变化，请重新查询后选择。");});handler.postDelayed(()->{if(current.equals(request)&&busy&&batchCursor==step)fail("商品核对超时，请重新查询后重试。");},25000);}
    private void finishSelection(JSONObject row){try{if(row==null||!row.getString("sku").matches("[A-Za-z0-9._-]{1,64}")||row.getString("name").isEmpty()||row.getString("name").length()>200||row.optString("spec").length()>240||row.optString("loc").length()>300)throw new Exception();
        if(batchIndices!=null){batchRows.put(row);batchCursor++;if(batchCursor<batchIndices.length){batchReturning=true;String current=request;int step=batchCursor;qnh.restoreInventory();handler.postDelayed(()->{if(current.equals(request)&&batchReturning&&batchCursor==step)fail("返回库存列表超时，请重新查询。");},25000);return;}JSONArray done=batchRows;batchIndices=null;batchRows=null;finishControls();status.setText("已核对 "+done.length()+" 个商品，正在批量生成标签。");host.onBatchSelected(done);}else{finishControls();status.setText("已查询并核对商品，标签正在下方生成。");host.onSelected(row);}qnh.restoreInventory();
    }catch(Exception error){fail("商品资料不完整，请重新查询。");}}
    private void finishControls(){request="";busy=false;query.setEnabled(true);results.removeAllViews();pages.setVisibility(GONE);batchBar.setVisibility(GONE);}
    private void updateBatch(){generateBatch.setText("生成所选（"+checked.size()+"张）");generateBatch.setEnabled(!busy&&!checked.isEmpty());}
    private void toggleAll(){if(busy)return;boolean all=checked.size()==Math.min(rows.length(),LabelBatch.MAX_ITEMS);for(int i=0;i<rows.length();i++){CheckBox box=results.findViewWithTag("batch-choice-"+i);if(box!=null)box.setChecked(!all&&i<LabelBatch.MAX_ITEMS);}}
    private void startBatch(){if(!requireQnhAccess()||busy||request.isEmpty()||checked.isEmpty())return;handler.removeCallbacks(autocomplete);name.dismissDropDown();InputMethodManager keyboard=(InputMethodManager)owner.getSystemService(Context.INPUT_METHOD_SERVICE);if(keyboard!=null)keyboard.hideSoftInputFromWindow(name.getWindowToken(),0);host.onQueryChanged();batchIndices=checked.stream().sorted().mapToInt(Integer::intValue).toArray();batchCursor=0;batchRows=new JSONArray();busy=true;query.setEnabled(false);generateBatch.setEnabled(false);checkAll.setEnabled(false);for(int i=0;i<rows.length();i++){CheckBox box=results.findViewWithTag("batch-choice-"+i);if(box!=null)box.setEnabled(false);}resolve(batchIndices[0]);}
    private void page(int direction){if(!requireQnhAccess()||busy||request.isEmpty())return;host.onQueryChanged();name.dismissDropDown();busy=true;query.setEnabled(false);String current=String.valueOf(++serial);request=current;displayed="";
        qnh.command("window.__kuguanInventory.page("+JSONObject.quote(current)+","+direction+","+JSONObject.quote(qnh.tenant())+")",ok->{if(current.equals(request)&&!Boolean.TRUE.equals(ok))fail("翻页结果未确认，请重新查询。");});
        handler.postDelayed(()->{if(current.equals(request)&&busy)fail("翻页超时，请重新查询。");},20000);
    }
    private void openStores(){if(!requireQnhAccess())return;cancel();host.onQueryChanged();storeDepth=0;if(!productReady||!qnh.isInventory()){queuedStores=true;status.setText("正在加载可选门店 / 仓…");qnh.inventory();int waiting=serial;handler.postDelayed(()->{if(queuedStores&&serial==waiting)fail("门店列表加载超时，请检查网络和库存权限。");},20000);return;}qnh.command("window.__kuguanInventory.openStores()",ok->{if(Boolean.TRUE.equals(ok))loadStores(0);else status.setText("门店选项尚未准备好，请稍后重试。");});}
    private void loadStores(int attempt){if(isFinishing()||!isQnhScreenActive())return;int ticket=serial;qnh.command("window.__kuguanInventory.stores()",result->{if(ticket!=serial||!isQnhScreenActive())return;if(!(result instanceof JSONArray)){status.setText("门店列表暂时不可用。");return;}JSONArray columns=(JSONArray)result;
        if(columns.length()<=storeDepth){if(attempt<15){handler.postDelayed(()->loadStores(attempt+1),400);return;}storeDepth=Math.max(0,columns.length()-1);}
        JSONObject column=columns.optJSONObject(storeDepth);JSONArray options=column==null?null:column.optJSONArray("options");if(options==null||options.length()==0){status.setText("暂无可选门店，请确认牵牛花库存权限。");return;}
        String[] labels=new String[options.length()];for(int i=0;i<options.length();i++){JSONObject item=options.optJSONObject(i);labels[i]=item.optString("label")+(item.optBoolean("children")?"  ›":item.optBoolean("checked")?"  ✓":"");}
        if(stores!=null)stores.dismiss();
        AlertDialog.Builder builder=new AlertDialog.Builder(owner).setTitle("选择门店 / 仓").setItems(labels,(dialog,index)->{JSONObject item=options.optJSONObject(index);int depth=storeDepth;if(item.optBoolean("children"))storeDepth++;qnh.command("window.__kuguanInventory.chooseStore("+depth+","+item.optInt("index")+","+JSONObject.quote(item.optString("key"))+","+JSONObject.quote(item.optString("label"))+")",ok->{if(Boolean.TRUE.equals(ok))loadStores(0);else status.setText("门店列表已变化，请重新打开选择。");});})
            .setPositiveButton("完成",(dialog,which)->{qnh.command("window.__kuguanInventory.closeStores()",null);status.setText("门店范围已更新，请重新查询。");});
        if(storeDepth>0)builder.setNegativeButton("上一级",(dialog,which)->{storeDepth--;loadStores(0);});
        builder.setNeutralButton("更多选项",(dialog,which)->qnh.command("window.__kuguanInventory.scrollStores("+storeDepth+",1)",ok->loadStores(0)));
        stores=builder.create();stores.setOnCancelListener(dialog->qnh.command("window.__kuguanInventory.closeStores()",null));stores.show();
    });}
    public void paused(){cancel();name.dismissDropDown();if(stores!=null){stores.dismiss();stores=null;}qnh.watchInventory(false);}
    public void destroy(){handler.removeCallbacksAndMessages(null);if(stores!=null)stores.dismiss();}
    public void saveState(Bundle out){out.putString("query-text",name.getText().toString());}
}
