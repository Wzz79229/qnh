package com.xianqi.phonevalidation;
import org.junit.Test;
import static org.junit.Assert.*;
public class QnhDocumentTest {
    @Test public void allowsSpaRoutesButRejectsEarlierLoginDocuments(){
        assertTrue(QnhUrlPolicy.sameDocument("https://qnh.meituan.com/#/inventory?a=1","https://qnh.meituan.com/#/flow?sku=001"));
        assertFalse(QnhUrlPolicy.sameDocument("https://passport.meituan.com/login","https://qnh.meituan.com/#/inventory"));
        assertFalse(QnhUrlPolicy.sameDocument("https://qnh.meituan.com/home.html","https://qnh.meituan.com/#/inventory"));
        assertFalse(QnhUrlPolicy.sameDocument("https://qnh.meituan.com/?ticket=old","https://qnh.meituan.com/?ticket=new"));
        assertFalse(QnhUrlPolicy.sameDocument(null,"https://qnh.meituan.com/"));
        assertFalse(QnhUrlPolicy.sameDocument("http://qnh.meituan.com/","http://qnh.meituan.com/"));
        assertFalse(QnhUrlPolicy.sameDocument("https://qnh.meituan.com.attacker.invalid/","https://qnh.meituan.com.attacker.invalid/"));
    }
}
