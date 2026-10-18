package com.xianqi.phonevalidation;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Small native style helpers; no extra UI runtime or remote fonts. */
public final class WarehouseUi {
    public static final int BG=0xfff3f6f5,INK=0xff173d38,MUTED=0xff6e8179,GREEN=0xff176b56,SOFT=0xffe9f3ed,LINE=0xffdfe8e2;
    public static int dp(Context c,float value){return Math.round(value*c.getResources().getDisplayMetrics().density);}
    public static GradientDrawable shape(Context c,int color,int border,float radius){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(c,radius));if(border!=0)d.setStroke(dp(c,1),border);return d;}
    public static TextView text(Context c,String value,int size,int color,boolean bold){TextView t=new TextView(c);t.setText(value);t.setTextSize(size);t.setTextColor(color);t.setIncludeFontPadding(false);t.setLineSpacing(dp(c,3),1);if(bold)t.setTypeface(Typeface.DEFAULT,Typeface.BOLD);return t;}
    public static LinearLayout card(Context c){LinearLayout layout=new LinearLayout(c);layout.setOrientation(LinearLayout.VERTICAL);int p=dp(c,18);layout.setPadding(p,p,p,p);layout.setBackground(shape(c,Color.WHITE,LINE,18));return layout;}
    public static void space(LinearLayout parent,int height){parent.addView(new View(parent.getContext()),new LinearLayout.LayoutParams(1,dp(parent.getContext(),height)));}
    public static void input(EditText e,String hint){Context c=e.getContext();e.setTextSize(15);e.setTextColor(INK);e.setHintTextColor(MUTED);e.setHint(hint);e.setSingleLine(true);e.setAutofillHints((String[])null);e.setPadding(dp(c,12),dp(c,11),dp(c,12),dp(c,11));e.setMinimumHeight(dp(c,46));e.setImeOptions(EditorInfo.IME_ACTION_SEARCH);StateListDrawable bg=new StateListDrawable();bg.addState(new int[]{android.R.attr.state_focused},shape(c,Color.WHITE,GREEN,10));bg.addState(new int[]{},shape(c,BG,LINE,10));e.setBackground(bg);}
    public static Button button(Context c,String value,boolean primary,View.OnClickListener click){Button b=new Button(c){@Override public void setEnabled(boolean enabled){super.setEnabled(enabled);setAlpha(enabled?1:.4f);}};b.setText(value);b.setTextSize(14);b.setAllCaps(false);b.setTypeface(Typeface.DEFAULT,Typeface.BOLD);b.setTextColor(primary?Color.WHITE:GREEN);b.setMinHeight(0);b.setMinimumHeight(dp(c,44));b.setPadding(dp(c,12),dp(c,8),dp(c,12),dp(c,8));b.setStateListAnimator(null);b.setBackground(new RippleDrawable(ColorStateList.valueOf(0x20176b56),shape(c,primary?GREEN:SOFT,0,11),null));b.setOnClickListener(click);return b;}
}
