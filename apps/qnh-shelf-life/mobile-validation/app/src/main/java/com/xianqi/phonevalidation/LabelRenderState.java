package com.xianqi.phonevalidation;

/** Immutable query selection plus a revision fence for asynchronous image rendering. */
public final class LabelRenderState {
    private long revision=0;
    private String tenant="";
    private LabelContent content;
    public long clear(){revision++;tenant="";content=null;return revision;}
    public long select(String scope,String name,String spec,String sku,String location){
        if(scope==null||!scope.matches("[1-9][0-9]{0,19}"))throw new IllegalArgumentException("请先登录牵牛花。");
        LabelContent next=LabelContent.create(name,spec,sku,location);revision++;tenant=scope;content=next;return revision;
    }
    public boolean current(long ticket,String scope){return content!=null&&ticket==revision&&tenant.equals(scope);}
    public LabelContent content(){return content;}
    public String tenant(){return tenant;}
}
