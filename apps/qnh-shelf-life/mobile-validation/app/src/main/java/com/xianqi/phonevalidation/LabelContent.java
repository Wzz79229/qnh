package com.xianqi.phonevalidation;

import com.google.zxing.oned.Code128Writer;

/** Label data is kept as text, including every leading zero of the full SKU. */
public final class LabelContent {
    public final String name, spec, sku, location;
    private LabelContent(String name, String spec, String sku, String location) { this.name=name; this.spec=spec; this.sku=sku; this.location=location; }
    public static LabelContent create(String name, String spec, String sku, String location) {
        name=clean(name,200,"商品名称"); spec=cleanSpecification(clean(spec,240,"规格")); sku=clean(sku,80,"SKU"); location=clean(location,48,"库位");
        if(name.isEmpty() || sku.isEmpty() || location.isEmpty()) throw new IllegalArgumentException("请填写商品名称、完整 SKU 和库位。");
        if(!sku.matches("[\\x21-\\x7e]{1,80}") || sku.contains("..")) throw new IllegalArgumentException("SKU 请使用完整英文、数字或英文符号，不要含空格、中文或省略号。");
        if(location.contains("\n")) throw new IllegalArgumentException("每张标签只填写一个库位。");
        LabelContent data=new LabelContent(name,spec,sku,location); data.barcode(); return data;
    }
    private static String clean(String value,int max,String field) {
        if(value==null) value=""; value=value.replace("\r\n","\n").trim();
        if(value.length()>max || value.matches("(?s).*[\\x00-\\x08\\x0b-\\x1f\\x7f].*")) throw new IllegalArgumentException(field+"内容过长或含不支持的字符。"); return value;
    }
    public String skuCaption() { return "SKU:"+sku.substring(Math.max(0,sku.length()-6)); }
    public static String cleanSpecification(String value) {
        String text=value.trim();
        while(text.endsWith(")") || text.endsWith("）")) {
            java.util.ArrayDeque<Character> stack=new java.util.ArrayDeque<>(); int start=-1; boolean invalid=false;
            for(int i=text.length()-1;i>=0;i--) { char c=text.charAt(i);
                if(c==')'||c=='）')stack.push(c);
                else if(c=='('||c=='（') { if(stack.isEmpty() || stack.pop()!=(c=='('?')':'）')) {invalid=true;break;} if(stack.isEmpty()){start=i;break;} }
            }
            if(invalid || start<1) break;
            String metadata=java.text.Normalizer.normalize(text.substring(start+1,text.length()-1),java.text.Normalizer.Form.NFKC).replaceAll("\\s+","").toLowerCase(java.util.Locale.ROOT);
            if(!metadata.matches("(?:(?:净重|重量|净含量)[:：]?)?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:(?:千克|公斤)\\(kg\\)|毫克\\(mg\\)|克\\(g\\)|毫升\\(ml\\)|升\\(l\\)|kg|mg|g|千克|公斤|毫克|克|ml|l|毫升|升)/(?:\\d+)?(?:份|瓶|袋|包|盒|罐|桶|箱|杯|支|个|件|套|组|粒|片|条|卷|张|双|只|颗|块|提)")) break;
            String primary=text.substring(0,start).trim(); if(primary.isEmpty()) break; text=primary;
        }
        return java.text.Normalizer.normalize(text,java.text.Normalizer.Form.NFKC).matches("(?i)null|空")?"":text;
    }
    public boolean[] barcode() {
        boolean[] bits=new Code128Writer().encode(sku);
        // 52 mm at 300 dpi, at least 3 pixels per module, 10-module quiet zone each side.
        if(bits.length+20>204) throw new IllegalArgumentException("SKU 过长，无法在当前标签内保持清晰条码，请核对编码。"); return bits;
    }
    public String fileName() { return "kuguan_"+location.replaceAll("[^A-Za-z0-9._-]","_")+"_"+sku.replaceAll("[^A-Za-z0-9._-]","_")+".png"; }
}
