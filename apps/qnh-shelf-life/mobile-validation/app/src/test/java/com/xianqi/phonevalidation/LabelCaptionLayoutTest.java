package com.xianqi.phonevalidation;
import org.junit.Test;
import static org.junit.Assert.*;
public class LabelCaptionLayoutTest {
    private LabelCaptionLayout.Metrics metrics(float widthPerPoint,float heightPerPoint){return new LabelCaptionLayout.Metrics(){public float width(String text,float points){return text.length()*points*widthPerPoint;}public float height(float points){return points*heightPerPoint;}};}
    @Test public void keepsEighteenPointsAndOneLineWhileCompressingHorizontally(){LabelCaptionLayout.Plan p=LabelCaptionLayout.fit("SKU:198822",260,94,metrics(2.2f,5));assertEquals(18,p.points,0);assertArrayEquals(new String[]{"SKU:198822"},p.lines);assertEquals(260f/(10*18*2.2f),p.scale,.001f);assertTrue(p.scale>=.6f);}
    @Test public void rejectsAnOverwideFontWithoutShrinkingOrWrapping(){try{LabelCaptionLayout.fit("SKU:198822",260,94,metrics(2.5f,5));fail("Template must reject a scale below 60 percent");}catch(IllegalArgumentException expected){}}
    @Test public void vendorFontLeadingCannotRejectAnOtherwiseFittingCaption(){LabelCaptionLayout.Plan p=LabelCaptionLayout.fit("SKU:198822",260,94,metrics(2.2f,12));assertEquals(18,p.points,0);assertEquals(1,p.lines.length);}
    @Test public void shortCaptionIsNotStretched(){LabelCaptionLayout.Plan p=LabelCaptionLayout.fit("SKU:123",500,94,metrics(2.2f,5));assertEquals(1,p.scale,0);assertEquals(18,p.points,0);}
    @Test public void exportsKeepEquivalentPhysicalCaptionSize(){float ratio=203.2f/300;LabelCaptionLayout.Plan a=LabelCaptionLayout.fit("SKU:198822",260,94,metrics(2.2f,5)),b=LabelCaptionLayout.fit("SKU:198822",260*ratio,94*ratio,metrics(2.2f*ratio,5*ratio));assertEquals(a.points,b.points,0);assertEquals(a.scale,b.scale,.001f);}
}
