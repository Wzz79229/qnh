package com.xianqi.phonevalidation;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.os.Bundle;

/** One responsive screen: query, immutable product details and automatically rendered label. */
public final class LabelWorkspace extends FrameLayout {
    public interface Actions {void back();void save();void share();void print();}
    public final InventorySearchPanel search;
    public final LinearLayout productCard;
    public final ImageView preview;
    public final Button save,share,print;
    private final Activity activity;
    private final LinearLayout body,previewCard,placeholder;
    private final TextView productName,spec,sku,location,store,status;
    private final ScrollView scroll;
    private boolean wide=false;
    private int dp(int n){return WarehouseUi.dp(activity,n);}
    public LabelWorkspace(Activity activity,InventorySearchPanel.Host host,Bundle state,Actions actions){super(activity);this.activity=activity;setBackgroundColor(WarehouseUi.BG);
        scroll=new ScrollView(activity);scroll.setFillViewport(true);scroll.setClipToPadding(false);addView(scroll,new FrameLayout.LayoutParams(-1,-1));
        FrameLayout wrap=new FrameLayout(activity);LinearLayout root=new LinearLayout(activity){@Override protected void onMeasure(int width,int height){super.onMeasure(MeasureSpec.makeMeasureSpec(Math.min(MeasureSpec.getSize(width),dp(960)),MeasureSpec.EXACTLY),height);}};root.setOrientation(LinearLayout.VERTICAL);root.setPadding(dp(16),dp(12),dp(16),dp(24));wrap.addView(root,new FrameLayout.LayoutParams(-1,-2,Gravity.TOP|Gravity.CENTER_HORIZONTAL));scroll.addView(wrap);
        LinearLayout nav=new LinearLayout(activity);nav.setGravity(Gravity.CENTER_VERTICAL);nav.addView(WarehouseUi.button(activity,"‹ 库管",false,v->actions.back()),new LinearLayout.LayoutParams(dp(78),dp(40)));
        TextView badge=WarehouseUi.text(activity,"库存查询（新）",11,WarehouseUi.GREEN,true);badge.setGravity(Gravity.END);nav.addView(badge,new LinearLayout.LayoutParams(0,-2,1));root.addView(nav);WarehouseUi.space(root,18);
        root.addView(WarehouseUi.text(activity,"库位标签",28,WarehouseUi.INK,true));WarehouseUi.space(root,6);root.addView(WarehouseUi.text(activity,"查询、选定、自动出图",13,WarehouseUi.MUTED,false));WarehouseUi.space(root,18);
        LinearLayout searchCard=WarehouseUi.card(activity);search=new InventorySearchPanel(activity,host,state);searchCard.addView(search);root.addView(searchCard);WarehouseUi.space(root,14);
        body=new LinearLayout(activity);body.setOrientation(LinearLayout.VERTICAL);root.addView(body);
        productCard=WarehouseUi.card(activity);productCard.addView(WarehouseUi.text(activity,"查询结果 · 只读",11,WarehouseUi.MUTED,true));WarehouseUi.space(productCard,12);
        productName=WarehouseUi.text(activity,"",18,WarehouseUi.INK,true);productName.setTextIsSelectable(true);productCard.addView(productName);WarehouseUi.space(productCard,12);
        spec=WarehouseUi.text(activity,"",14,WarehouseUi.MUTED,false);spec.setTextIsSelectable(true);productCard.addView(spec);WarehouseUi.space(productCard,9);
        sku=WarehouseUi.text(activity,"",13,WarehouseUi.INK,false);sku.setTypeface(Typeface.MONOSPACE);sku.setTextIsSelectable(true);productCard.addView(sku);WarehouseUi.space(productCard,14);
        location=WarehouseUi.text(activity,"",20,WarehouseUi.GREEN,true);location.setPadding(dp(12),dp(10),dp(12),dp(10));location.setBackground(WarehouseUi.shape(activity,WarehouseUi.SOFT,0,10));location.setTextIsSelectable(true);productCard.addView(location);WarehouseUi.space(productCard,10);
        store=WarehouseUi.text(activity,"",12,WarehouseUi.MUTED,false);productCard.addView(store);productCard.setVisibility(GONE);
        previewCard=WarehouseUi.card(activity);LinearLayout top=new LinearLayout(activity);top.setGravity(Gravity.CENTER_VERTICAL);top.addView(WarehouseUi.text(activity,"标签预览",18,WarehouseUi.INK,true),new LinearLayout.LayoutParams(0,-2,1));top.addView(WarehouseUi.text(activity,"80 × 60 mm",12,WarehouseUi.MUTED,false));previewCard.addView(top);WarehouseUi.space(previewCard,12);
        placeholder=new LinearLayout(activity);placeholder.setOrientation(LinearLayout.VERTICAL);placeholder.setGravity(Gravity.CENTER);placeholder.setPadding(dp(16),dp(28),dp(16),dp(28));placeholder.setBackground(WarehouseUi.shape(activity,WarehouseUi.BG,WarehouseUi.LINE,12));
        ImageView icon=new ImageView(activity);icon.setImageResource(R.mipmap.ic_launcher);icon.setAlpha(.65f);placeholder.addView(icon,new LinearLayout.LayoutParams(dp(46),dp(46)));WarehouseUi.space(placeholder,12);
        placeholder.addView(WarehouseUi.text(activity,"查询商品后自动生成",15,WarehouseUi.INK,true));WarehouseUi.space(placeholder,6);placeholder.addView(WarehouseUi.text(activity,"无需填写商品资料或点击生成",12,WarehouseUi.MUTED,false));previewCard.addView(placeholder);
        preview=new ImageView(activity);preview.setAdjustViewBounds(true);preview.setScaleType(ImageView.ScaleType.FIT_CENTER);preview.setContentDescription("80×60毫米库位标签预览");preview.setVisibility(GONE);previewCard.addView(preview,new LinearLayout.LayoutParams(-1,-2));WarehouseUi.space(previewCard,12);
        status=WarehouseUi.text(activity,"300 DPI PNG · 完整 SKU 条码",12,WarehouseUi.MUTED,false);previewCard.addView(status);WarehouseUi.space(previewCard,14);
        LinearLayout exports=new LinearLayout(activity);save=WarehouseUi.button(activity,"保存图片",true,v->actions.save());share=WarehouseUi.button(activity,"分享",false,v->actions.share());print=WarehouseUi.button(activity,"打印",false,v->actions.print());
        LinearLayout.LayoutParams first=new LinearLayout.LayoutParams(0,dp(46),1.3f);first.setMarginEnd(dp(8));exports.addView(save,first);LinearLayout.LayoutParams second=new LinearLayout.LayoutParams(0,dp(46),1);second.setMarginEnd(dp(8));exports.addView(share,second);exports.addView(print,new LinearLayout.LayoutParams(0,dp(46),1));previewCard.addView(exports);arrange(false);setActions(false);
        setOnApplyWindowInsetsListener((view,insets)->{setPadding(0,insets.getSystemWindowInsetTop(),0,insets.getSystemWindowInsetBottom());return insets;});setFocusableInTouchMode(true);requestFocus();
    }
    private void arrange(boolean next){wide=next;body.removeAllViews();body.setOrientation(next?LinearLayout.HORIZONTAL:LinearLayout.VERTICAL);
        LinearLayout.LayoutParams details=new LinearLayout.LayoutParams(next?0:-1,-2,next?1:0);if(next)details.setMarginEnd(dp(14));else details.bottomMargin=dp(14);body.addView(productCard,details);
        body.addView(previewCard,new LinearLayout.LayoutParams(next?0:-1,-2,next?1.25f:0));
    }
    @Override protected void onSizeChanged(int w,int h,int oldw,int oldh){super.onSizeChanged(w,h,oldw,oldh);boolean next=w>=dp(720);if(next!=wide&&body!=null)post(()->arrange(next));}
    public void showRecord(LabelContent data,String source){productName.setText(data.name);spec.setText("规格  "+(data.spec.isEmpty()?"未设置":data.spec));sku.setText("SKU  "+data.sku);location.setText("库位  "+data.location);store.setText(source);productCard.setVisibility(VISIBLE);}
    public void clear(){productCard.setVisibility(GONE);preview.setImageDrawable(null);preview.setVisibility(GONE);placeholder.setVisibility(VISIBLE);setActions(false);status.setText("300 DPI PNG · 完整 SKU 条码");}
    public void rendering(){preview.setImageDrawable(null);preview.setVisibility(GONE);placeholder.setVisibility(VISIBLE);setActions(false);status.setText("正在本机生成标签…");}
    public void showImage(Bitmap image){preview.setImageBitmap(image);preview.setVisibility(VISIBLE);placeholder.setVisibility(GONE);setActions(true);status.setText("已自动生成 · 945 × 709 px · 300 DPI");}
    public void message(String value){status.setText(value);}
    public void setActions(boolean enabled){save.setEnabled(enabled);share.setEnabled(enabled);print.setEnabled(enabled);}
    public void revealResult(){post(()->scroll.smoothScrollTo(0,Math.max(0,body.getTop()-dp(12))));}
}
