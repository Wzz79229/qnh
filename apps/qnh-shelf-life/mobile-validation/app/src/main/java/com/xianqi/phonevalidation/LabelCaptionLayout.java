package com.xianqi.phonevalidation;

/** Fit the short human-readable caption using font size, never a horizontal squeeze threshold. */
final class LabelCaptionLayout {
    interface Metrics {float width(String text,float points);float height(float points);}
    static final class Plan {final float points;final String[] lines;Plan(float points,String...lines){this.points=points;this.lines=lines;}}
    static Plan fit(String caption,float width,float height,Metrics metrics){
        for(int half=36;half>=18;half--){float points=half/2f;if(metrics.width(caption,points)<=width&&metrics.height(points)<=height)return new Plan(points,caption);}
        String value=caption.startsWith("SKU:")?caption.substring(4):caption;
        for(int half=24;half>=18;half--){float points=half/2f;if(Math.max(metrics.width("SKU:",points),metrics.width(value,points))<=width&&metrics.height(points)*2<=height)return new Plan(points,"SKU:",value);}
        throw new IllegalArgumentException("当前字体无法排入标签，请重新打开库管后重试。");
    }
}
