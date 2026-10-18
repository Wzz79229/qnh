package com.xianqi.phonevalidation;

/** Template caption: 18 pt on one line, horizontal scale 60% to 100%. */
final class LabelCaptionLayout {
    interface Metrics {float width(String text,float points);float height(float points);}
    static final class Plan {final float points=18,scale;final String[] lines;Plan(String caption,float scale){this.scale=scale;lines=new String[]{caption};}}
    static Plan fit(String caption,float width,float height,Metrics metrics){
        float measured=metrics.width(caption,18),scale=Math.min(1,width/Math.max(1,measured));
        if(width<=0||height<=0||scale<.6f)throw new IllegalArgumentException("SKU 文字无法按模板排入标签，请核对编码或字体。");
        return new Plan(caption,scale);
    }
}
