package com.xianqi.phonevalidation;
import org.junit.Test;
import static org.junit.Assert.*;
public class SmartQueryTest {
    @Test public void detectsNormalWarehouseInputsWithoutLosingSkuDigits(){assertEquals("name",SmartQuery.parse("农夫山泉 500ml").key);assertEquals("name",SmartQuery.parse("可乐500ml").key);assertEquals("name",SmartQuery.parse("iPhone 16").key);assertEquals("sku",SmartQuery.parse("0001234567890123456").key);assertEquals("0001234567890123456",SmartQuery.parse("0001234567890123456").value);for(String loc:new String[]{"A64-6-4","C55--13","A64","12-3-4"})assertEquals("loc",SmartQuery.parse(loc).key);}
    @Test public void ambiguousInputsHaveSingleBoxOverrides(){assertEquals("name",SmartQuery.parse("名称:12345").key);assertEquals("sku",SmartQuery.parse("sku：ABC-01").key);assertEquals("barcode",SmartQuery.parse("条码:6901234567890").key);assertEquals("external",SmartQuery.parse("外部编码:EXT-01").key);}
    @Test public void rejectsMalformedOrEmptyQueries(){for(String raw:new String[]{"","  ","x\ny","库位:A1234567-1","SKU:123 45"})try{SmartQuery.parse(raw);fail(raw);}catch(IllegalArgumentException expected){}}
}
