package com.xianqi.phonevalidation;
import org.junit.Test;import static org.junit.Assert.*;
public class ScanConfirmationTest {
 @Test public void unreadableFramesDoNotEraseAClearObservation(){ScanConfirmation c=new ScanConfirmation();assertFalse(c.observe("CODE_128:0012345678901988220",1000));assertFalse(c.observe(null,1200));assertFalse(c.observe(null,1400));assertTrue(c.observe("CODE_128:0012345678901988220",1600));}
 @Test public void differentCodesAndExpiredMatchesDoNotConfirm(){ScanConfirmation c=new ScanConfirmation();assertFalse(c.observe("A",1000));assertFalse(c.observe("B",1100));assertFalse(c.observe("A",1200));assertFalse(c.observe(null,4000));assertFalse(c.observe("A",4100));assertTrue(c.observe("A",4300));c.clear();assertFalse(c.observe("A",4400));}
}
