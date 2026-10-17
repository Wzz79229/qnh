package com.xianqi.phonevalidation;

import java.net.URI;

final class QnhUrlPolicy {
    private QnhUrlPolicy() { }
    static boolean allowedTop(String value) {
        try {
            URI uri = new URI(value); String host = uri.getHost();
            return "https".equals(uri.getScheme()) && uri.getRawUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443) && host != null
                && (host.equals("meituan.com") || host.endsWith(".meituan.com") || host.equals("dianping.com") || host.endsWith(".dianping.com")
                || host.equals("sankuai.com") || host.endsWith(".sankuai.com"));
        } catch (Exception ignored) { return false; }
    }
    static boolean qnhOrigin(String value) {
        try { URI uri = new URI(value); return "https".equals(uri.getScheme()) && "qnh.meituan.com".equals(uri.getHost())
            && uri.getRawUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443); }
        catch (Exception ignored) { return false; }
    }
    static boolean safeImage(String value) {
        try { URI uri = new URI(value); return value.length() <= 2048 && "https".equals(uri.getScheme()) && "img.meituan.net".equals(uri.getHost())
            && uri.getPort() == -1 && uri.getRawUserInfo() == null && uri.getRawQuery() == null && uri.getRawFragment() == null; }
        catch (Exception ignored) { return false; }
    }
}
