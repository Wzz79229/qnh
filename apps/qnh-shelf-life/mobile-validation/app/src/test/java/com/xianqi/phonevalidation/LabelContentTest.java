package com.xianqi.phonevalidation;

import com.google.zxing.common.BitArray;
import com.google.zxing.oned.Code128Reader;
import org.junit.Test;
import static org.junit.Assert.*;

public class LabelContentTest {
    private void roundTrip(String sku) throws Exception {
        LabelContent content=LabelContent.create("合成测试商品","500ml/瓶",sku,"C56-2-2"); boolean[] encoded=content.barcode();
        BitArray scan=new BitArray((encoded.length+20)*4);
        for(int i=0;i<encoded.length;i++) if(encoded[i]) for(int p=0;p<4;p++) scan.set((i+10)*4+p);
        assertEquals(sku,new Code128Reader().decodeRow(0,scan,null).getText());
        assertEquals("SKU:"+sku.substring(Math.max(0,sku.length()-6)),content.skuCaption());
    }
    @Test public void fullNineteenDigitSkuIsEncoded() throws Exception { roundTrip("2110000000000123456"); }
    @Test public void leadingZerosSurvivePrinting() throws Exception { roundTrip("0000001234567890123"); roundTrip("000123"); }
    @Test public void alphaNumericSkuIsSupported() throws Exception { roundTrip("SKU-A01-009"); }
    @Test public void specificationMatchesTheReferencedProject() {
        assertEquals("",LabelContent.cleanSpecification("null（5克(g)/套）"));
        assertEquals("600ml*1瓶",LabelContent.cleanSpecification("600ml*1瓶（600g/瓶）"));
        assertEquals("●哑光灰",LabelContent.cleanSpecification("●哑光灰（1g/份）"));
        assertEquals("L码（灰色）",LabelContent.cleanSpecification("L码（灰色）"));
        assertEquals("500ml（500ml*2瓶）",LabelContent.cleanSpecification("500ml（500ml*2瓶）"));
    }
    @Test public void invalidOrOverfullLabelsAreRejected() {
        for(String sku:new String[]{"", "中文123", "12\n34", "123 456", "123456789012345678901234567890123456789012345678901234567890"}){
            try {LabelContent.create("测试","",sku,"C56-2-2"); fail("Rejected invalid SKU expected");} catch(IllegalArgumentException expected) { }
        }
        try {LabelContent.create("测试","","000123","C1\nC2"); fail();} catch(IllegalArgumentException expected) { }
    }
}
