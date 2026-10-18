package com.xianqi.phonevalidation;
import org.junit.Test;
import static org.junit.Assert.*;

public class LabelRenderStateTest {
    @Test public void oldRenderCannotReplaceNewQueryOrTenant(){LabelRenderState state=new LabelRenderState();long first=state.select("12345","商品 A","500ml","000123","A1-1-1");assertTrue(state.current(first,"12345"));state.clear();assertFalse(state.current(first,"12345"));long second=state.select("67890","商品 B","","2110000000000123456","B2-1-1");assertFalse(state.current(first,"12345"));assertFalse(state.current(second,"12345"));assertTrue(state.current(second,"67890"));assertEquals("2110000000000123456",state.content().sku);}
    @Test public void invalidSelectionNeverPublishesLabel(){LabelRenderState state=new LabelRenderState();try{state.select("12345","商品","","000123","");fail();}catch(IllegalArgumentException expected){}assertNull(state.content());try{state.select("","商品","","000123","A1");fail();}catch(IllegalArgumentException expected){}assertNull(state.content());}
    @Test public void idlePollingIsSlowerWithoutRemovingLoginChecks(){assertEquals(350,QnhPolling.interval(true,false,false));assertEquals(350,QnhPolling.interval(false,true,true));assertTrue(QnhPolling.interval(false,true,false)>1000);assertTrue(QnhPolling.interval(false,false,false)>=10000);}
}
