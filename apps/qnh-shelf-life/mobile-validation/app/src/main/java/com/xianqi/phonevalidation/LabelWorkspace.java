package com.xianqi.phonevalidation;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.os.Bundle;
import android.util.LruCache;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.*;
import java.util.*;
import java.util.concurrent.*;

/** One scrolling list, newest labels first. Only visible images are decoded. */
public final class LabelWorkspace extends FrameLayout {
    public interface Actions {void back();void save();void share();default void pdf(){}default void remove(long id){}default void clear(){}}
    public final InventorySearchPanel search;
    public final Button save,share,pdf;
    public final ListView list;
    private final Activity activity;private final Actions actions;private final TextView count,status,empty,account;
    private final Button clear;private final LabelAdapter adapter=new LabelAdapter();
    private final ExecutorService decoder=Executors.newSingleThreadExecutor();
    private final LruCache<Long,Bitmap> cache=new LruCache<Long,Bitmap>(4*1024*1024){@Override protected int sizeOf(Long key,Bitmap image){return image.getAllocationByteCount();}};
    private List<LabelQueue.Item> labels=Collections.emptyList();private volatile boolean disposed=false;private volatile long revision=0;
    private int dp(int n){return WarehouseUi.dp(activity,n);}
    public LabelWorkspace(Activity activity,InventorySearchPanel.Host host,Bundle state,Actions actions){super(activity);this.activity=activity;this.actions=actions;setBackgroundColor(WarehouseUi.BG);
        list=new ListView(activity){@Override protected void onMeasure(int w,int h){super.onMeasure(MeasureSpec.makeMeasureSpec(Math.min(MeasureSpec.getSize(w),dp(720)),MeasureSpec.EXACTLY),h);}};
        list.setTag("label-list");list.setDivider(new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT));list.setDividerHeight(dp(12));list.setCacheColorHint(Color.TRANSPARENT);list.setClipToPadding(false);list.setPadding(dp(16),dp(12),dp(16),dp(20));list.setSelector(new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT));
        FrameLayout.LayoutParams listSize=new FrameLayout.LayoutParams(-1,-1,Gravity.TOP|Gravity.CENTER_HORIZONTAL);listSize.bottomMargin=dp(84);addView(list,listSize);
        LinearLayout header=new LinearLayout(activity);header.setOrientation(LinearLayout.VERTICAL);
        LinearLayout nav=new LinearLayout(activity);nav.setGravity(Gravity.CENTER_VERTICAL);nav.addView(WarehouseUi.button(activity,"‹ 库管",false,v->actions.back()),new LinearLayout.LayoutParams(dp(78),dp(40)));TextView badge=WarehouseUi.text(activity,"● 牵牛花已登录",11,WarehouseUi.GREEN,false);badge.setGravity(Gravity.END);nav.addView(badge,new LinearLayout.LayoutParams(0,-2,1));header.addView(nav);WarehouseUi.space(header,16);
        account=WarehouseUi.text(activity,"牵牛花账号正在确认…",12,WarehouseUi.MUTED,false);account.setTag("qnh-account");header.addView(account);WarehouseUi.space(header,10);header.addView(WarehouseUi.text(activity,"库位标签",25,WarehouseUi.INK,true));WarehouseUi.space(header,14);LinearLayout searchCard=WarehouseUi.card(activity);search=new InventorySearchPanel(activity,host,state);searchCard.addView(search);header.addView(searchCard);WarehouseUi.space(header,16);
        LinearLayout heading=new LinearLayout(activity);heading.setGravity(Gravity.CENTER_VERTICAL);count=WarehouseUi.text(activity,"已生成标签 · 0 张",16,WarehouseUi.INK,true);count.setTag("label-count");heading.addView(count,new LinearLayout.LayoutParams(0,-2,1));share=WarehouseUi.button(activity,"分享",false,v->actions.share());heading.addView(share,new LinearLayout.LayoutParams(dp(58),dp(38)));clear=WarehouseUi.button(activity,"清空",false,v->actions.clear());clear.setTag("labels-clear");heading.addView(clear,new LinearLayout.LayoutParams(dp(58),dp(38)));header.addView(heading);WarehouseUi.space(header,6);
        status=WarehouseUi.text(activity,"新标签显示在最上方，方便立即核实。",12,WarehouseUi.MUTED,false);header.addView(status);WarehouseUi.space(header,10);empty=WarehouseUi.text(activity,"输入名称、SKU 或库位，查询后自动生成标签。",13,WarehouseUi.MUTED,false);empty.setGravity(Gravity.CENTER);empty.setPadding(dp(12),dp(28),dp(12),dp(28));header.addView(empty);list.addHeaderView(header,null,false);list.setAdapter(adapter);
        LinearLayout footer=new LinearLayout(activity){@Override protected void onMeasure(int w,int h){super.onMeasure(MeasureSpec.makeMeasureSpec(Math.min(MeasureSpec.getSize(w),dp(720)),MeasureSpec.EXACTLY),h);}};footer.setGravity(Gravity.CENTER_VERTICAL);footer.setPadding(dp(16),dp(12),dp(16),dp(12));footer.setBackgroundColor(Color.WHITE);
        save=WarehouseUi.button(activity,"保存全部图片",true,v->actions.save());pdf=WarehouseUi.button(activity,"导出 PDF",false,v->actions.pdf());pdf.setTag("save-pdf");LinearLayout.LayoutParams first=new LinearLayout.LayoutParams(0,dp(48),1.6f);first.setMarginEnd(dp(10));footer.addView(save,first);footer.addView(pdf,new LinearLayout.LayoutParams(0,dp(48),1));addView(footer,new FrameLayout.LayoutParams(-1,dp(80),Gravity.BOTTOM|Gravity.CENTER_HORIZONTAL));
        setOnApplyWindowInsetsListener((view,insets)->{setPadding(0,insets.getSystemWindowInsetTop(),0,insets.getSystemWindowInsetBottom());return insets;});setFocusableInTouchMode(true);requestFocus();setActions(false);
    }
    void showLabels(List<LabelQueue.Item> values){revision++;labels=Collections.unmodifiableList(new ArrayList<>(values));cache.evictAll();count.setText("已生成标签 · "+labels.size()+" 张");empty.setVisibility(labels.isEmpty()?VISIBLE:GONE);adapter.notifyDataSetChanged();setActions(!labels.isEmpty());if(labels.isEmpty())message("新标签显示在最上方，方便立即核实。");}
    int labelCount(){return labels.size();}
    long labelId(int index){return labels.get(index).id;}
    public void rendering(int done,int total){setActions(false);message("正在生成 "+done+" / "+total+" 张，已有标签保留。");}
    public void failed(String value){setActions(!labels.isEmpty());message(value);search.message("本次未添加标签，之前生成的标签仍保留。");}
    public void message(String value){status.setText(value);}
    public void account(String username,String tenantName,String tenant){account.setText("牵牛花账号："+(username.isEmpty()?"暂未识别":username)+"\n"+(tenantName.isEmpty()?"当前租户":tenantName)+(tenant.isEmpty()?"":" · "+tenant));}
    public void setActions(boolean enabled){save.setEnabled(enabled);share.setEnabled(enabled);pdf.setEnabled(enabled);clear.setEnabled(!labels.isEmpty());}
    public void revealResult(){list.post(()->{if(!labels.isEmpty())list.smoothScrollToPositionFromTop(list.getHeaderViewsCount(),0);});}
    public void revealQuery(){list.setSelection(0);}
    public void trimPreviews(){cache.evictAll();}
    public void dispose(){disposed=true;revision++;decoder.shutdownNow();list.setAdapter(null);cache.evictAll();labels=Collections.emptyList();}
    private final class Holder {volatile long id=-1;LinearLayout card;TextView title,newest;ImageView image;Button remove;}
    private final class LabelAdapter extends BaseAdapter {
        @Override public int getCount(){return labels.size();}
        @Override public LabelQueue.Item getItem(int index){return labels.get(index);}
        @Override public long getItemId(int index){return getItem(index).id;}
        @Override public boolean hasStableIds(){return true;}
        @Override public boolean isEnabled(int position){return false;}
        @Override public View getView(int position,View recycled,ViewGroup parent){
            Holder holder;if(recycled==null){holder=new Holder();holder.card=WarehouseUi.card(activity);holder.card.setPadding(dp(12),dp(10),dp(12),dp(12));LinearLayout top=new LinearLayout(activity);top.setGravity(Gravity.CENTER_VERTICAL);holder.title=WarehouseUi.text(activity,"",13,WarehouseUi.INK,true);top.addView(holder.title);holder.newest=WarehouseUi.text(activity,"最新",11,Color.WHITE,true);holder.newest.setPadding(dp(7),dp(3),dp(7),dp(3));holder.newest.setBackground(WarehouseUi.shape(activity,WarehouseUi.GREEN,0,5));LinearLayout.LayoutParams tagSize=new LinearLayout.LayoutParams(-2,-2);tagSize.setMarginStart(dp(8));top.addView(holder.newest,tagSize);Space spacer=new Space(activity);top.addView(spacer,new LinearLayout.LayoutParams(0,1,1));holder.remove=WarehouseUi.button(activity,"删除",false,v->{});top.addView(holder.remove,new LinearLayout.LayoutParams(dp(58),dp(36)));holder.card.addView(top);WarehouseUi.space(holder.card,8);
                holder.image=new ImageView(activity){@Override protected void onMeasure(int w,int h){int width=MeasureSpec.getSize(w);super.onMeasure(MeasureSpec.makeMeasureSpec(width,MeasureSpec.EXACTLY),MeasureSpec.makeMeasureSpec(Math.round(width*709f/945f),MeasureSpec.EXACTLY));}};holder.image.setScaleType(ImageView.ScaleType.FIT_CENTER);holder.image.setBackground(WarehouseUi.shape(activity,Color.WHITE,WarehouseUi.LINE,3));holder.card.addView(holder.image,new LinearLayout.LayoutParams(-1,-2));holder.card.setTag(holder);
            }else holder=(Holder)recycled.getTag();
            LabelQueue.Item item=getItem(position);holder.id=item.id;holder.title.setText(String.format(java.util.Locale.ROOT,"标签 %02d",item.id));holder.newest.setVisibility(position==0?VISIBLE:GONE);holder.remove.setTag("label-delete-"+item.id);holder.remove.setContentDescription("删除标签 "+item.id);holder.remove.setOnClickListener(v->actions.remove(item.id));holder.image.setTag("label-image-"+item.id);holder.image.setContentDescription("库位标签 "+item.entry.content.location+"，SKU "+item.entry.content.sku);
            Bitmap cached=cache.get(item.id);holder.image.setImageBitmap(cached);if(cached==null){Holder target=holder;long version=revision;decoder.submit(()->{if(disposed||target.id!=item.id||version!=revision)return;BitmapFactory.Options options=new BitmapFactory.Options();options.inPreferredConfig=Bitmap.Config.RGB_565;options.inScaled=false;byte[] png=item.entry.png;Bitmap image=BitmapFactory.decodeByteArray(png,0,png.length,options);activity.runOnUiThread(()->{if(disposed||version!=revision||target.id!=item.id){if(image!=null)image.recycle();return;}if(image!=null){cache.put(item.id,image);target.image.setImageBitmap(image);}else message("一张标签预览未能加载，保存的原图仍可使用。");});});}
            return holder.card;
        }
    }
}
