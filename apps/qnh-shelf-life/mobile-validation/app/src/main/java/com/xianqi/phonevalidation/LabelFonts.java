package com.xianqi.phonevalidation;
import android.content.res.AssetManager;
import android.graphics.Typeface;
/** A bundled Latin face makes physical SKU typography independent of vendor fonts. */
final class LabelFonts {
    private static Typeface sku;
    static synchronized void initialize(AssetManager assets){if(sku==null)sku=Typeface.createFromAsset(assets,"fonts/Roboto-Bold-Latin.ttf");}
    static synchronized Typeface sku(){if(sku==null)throw new IllegalStateException("标签字体尚未加载，请重新打开库管。");return sku;}
}
