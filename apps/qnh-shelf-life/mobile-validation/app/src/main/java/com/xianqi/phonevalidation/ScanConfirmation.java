package com.xianqi.phonevalidation;
/** Two matching observations; an unreadable frame does not erase a good observation. */
final class ScanConfirmation {
    private String previous="";private long time=0;private int count=0;
    boolean observe(String value,long now){if(value==null||value.isEmpty()){if(now-time>2500)clear();return false;}if(previous.equals(value)&&now-time<=2500)count++;else{previous=value;count=1;}time=now;return count>=2;}
    void clear(){previous="";time=0;count=0;}
}
