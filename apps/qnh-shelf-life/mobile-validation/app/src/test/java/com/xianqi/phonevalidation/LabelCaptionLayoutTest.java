package com.xianqi.phonevalidation;
import org.junit.Test;
import static org.junit.Assert.*;
public class LabelCaptionLayoutTest {
    private LabelCaptionLayout.Metrics metrics(float widthPerPoint,float heightPerPoint){return new LabelCaptionLayout.Metrics(){public float width(String text,float points){return text.length()*points*widthPerPoint;}public float height(float points){return points*heightPerPoint;}};}
    @Test public void wideNumericFontThatFailedTheOldThresholdStillFits(){LabelCaptionLayout.Metrics m=metrics(2.5f,5);assertTrue(260/m.width("SKU:198822",18)<.6f);LabelCaptionLayout.Plan p=LabelCaptionLayout.fit("SKU:198822",260,94,m);assertEquals(1,p.lines.length);assertTrue(p.points>=9);assertTrue(m.width(p.lines[0],p.points)<=260);assertTrue(m.height(p.points)<=94);}
    @Test public void veryWideFontUsesTwoReadableLinesWithoutLosingDigits(){LabelCaptionLayout.Metrics m=metrics(4.5f,5);LabelCaptionLayout.Plan p=LabelCaptionLayout.fit("SKU:198822",260,94,m);assertArrayEquals(new String[]{"SKU:","198822"},p.lines);assertTrue(p.points>=9);for(String line:p.lines)assertTrue(m.width(line,p.points)<=260);assertTrue(m.height(p.points)*2<=94);}
    @Test public void printerAndExportUseEquivalentPhysicalCaptionSize(){float ratio=203.2f/300;LabelCaptionLayout.Plan export=LabelCaptionLayout.fit("SKU:198822",260,94,metrics(2.5f,5));LabelCaptionLayout.Plan printer=LabelCaptionLayout.fit("SKU:198822",260*ratio,94*ratio,metrics(2.5f*ratio,5*ratio));assertEquals(export.points,printer.points,0.01f);assertArrayEquals(export.lines,printer.lines);}
}
