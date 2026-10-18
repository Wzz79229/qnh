package com.xianqi.phonevalidation;

/** Process-only access state. No saved flag or Intent extra can grant access. */
public final class QnhGate {
    private String tenant="",candidate="";
    private int confirmations=0;
    private boolean verified=false;
    public boolean observe(boolean authorized,String value) {
        if(!authorized || value==null || !value.matches("[1-9][0-9]{0,19}")){clear();return false;}
        if(!candidate.equals(value)){candidate=value;confirmations=1;verified=false;}else confirmations++;
        if(confirmations>=2){tenant=value;verified=true;}
        return verified;
    }
    public boolean verified(){return verified;}
    public String tenant(){return verified?tenant:"";}
    public void clear(){tenant="";candidate="";confirmations=0;verified=false;}
}
