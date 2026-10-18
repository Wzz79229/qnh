package com.xianqi.phonevalidation;

final class SkuPolicy {
    private SkuPolicy() { }
    static String decode(String raw) {
        if (raw == null || raw.length() > 128) return null;
        String value = raw.trim().replaceFirst("^(?i:SKU)\\s*[:：]\\s*", "");
        return value.matches("[A-Za-z0-9._-]{1,64}") ? value : null;
    }
}
