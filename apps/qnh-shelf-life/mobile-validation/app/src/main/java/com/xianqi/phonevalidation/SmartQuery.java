package com.xianqi.phonevalidation;

import java.util.Locale;

/** Deterministic single-box query classification; identifiers always remain strings. */
public final class SmartQuery {
    public final String key,value,label;
    private SmartQuery(String key,String value,String label){this.key=key;this.value=value;this.label=label;}
    public static SmartQuery parse(String raw){
        String value=raw==null?"":raw.trim();
        if(value.isEmpty()||value.length()>100||value.matches("(?s).*[\\x00-\\x1f\\x7f].*"))throw new IllegalArgumentException("请输入名称、完整 SKU 或库位，最多 100 个字符。");
        java.util.regex.Matcher prefix=java.util.regex.Pattern.compile("^(SKU|库位|名称|条码|外部编码)\\s*[:：]\\s*(.+)$",java.util.regex.Pattern.CASE_INSENSITIVE).matcher(value);
        if(prefix.matches()){String kind=prefix.group(1).toUpperCase(Locale.ROOT);value=prefix.group(2).trim();if(value.isEmpty())throw new IllegalArgumentException("查询内容不能为空。");
            if(kind.equals("SKU"))return sku(value);
            if(kind.equals("库位"))return location(value);
            if(kind.equals("条码"))return new SmartQuery("barcode",value,"商品条码");
            if(kind.equals("外部编码"))return new SmartQuery("external",value,"外部编码");
            return new SmartQuery("name",value,"商品名称");
        }
        if(value.matches("[0-9]{1,64}"))return sku(value);
        if(value.matches("(?i)[a-z]{1,3}[0-9]{1,3}")||value.matches("(?i)(?:[a-z]{1,3}[0-9]{1,3}|[0-9]{1,6})(?:-[a-z0-9]{0,6}){1,3}"))return location(value);
        return new SmartQuery("name",value,"商品名称");
    }
    private static SmartQuery sku(String value){if(!value.matches("[A-Za-z0-9._-]{1,64}"))throw new IllegalArgumentException("请填写完整 SKU。");return new SmartQuery("sku",value,"SKU");}
    private static SmartQuery location(String value){String[] parts=value.split("-",-1);if(parts.length>4)throw new IllegalArgumentException("库位最多四段。");for(String part:parts)if(!part.matches("[A-Za-z0-9]{0,6}"))throw new IllegalArgumentException("库位每段最多六个字母或数字。");return new SmartQuery("loc",value,"库位");}
}
