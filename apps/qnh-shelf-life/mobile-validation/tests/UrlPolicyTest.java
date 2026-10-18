package com.xianqi.phonevalidation;

public final class UrlPolicyTest {
    static void check(boolean value) { if (!value) throw new AssertionError("URL policy failed"); }
    public static void main(String[] ignored) {
        check(QnhUrlPolicy.allowedTop("https://qnh.meituan.com/"));
        check(QnhUrlPolicy.allowedTop("https://passport.meituan.com/login"));
        check(!QnhUrlPolicy.allowedTop("https://meituan.com.attacker.invalid/"));
        check(!QnhUrlPolicy.allowedTop("https://qnh.meituan.com@attacker.invalid/"));
        check(!QnhUrlPolicy.allowedTop("http://qnh.meituan.com/"));
        check(!QnhUrlPolicy.allowedTop("https://qnh.meituan.com:8443/"));
        check(!QnhUrlPolicy.allowedTop("intent://qnh.meituan.com/"));
        check(!QnhUrlPolicy.allowedTop("file:///data/local/tmp/test"));
        check(!QnhUrlPolicy.allowedTop("javascript:alert(1)"));
        check(!QnhUrlPolicy.allowedTop(null));
        check(QnhUrlPolicy.qnhOrigin("https://qnh.meituan.com/#/home"));
        check(!QnhUrlPolicy.qnhOrigin("https://passport.meituan.com/"));
        check(!QnhUrlPolicy.qnhOrigin("https://qnh.meituan.com.attacker.invalid/"));
        check(!QnhUrlPolicy.qnhOrigin("https://u:p@qnh.meituan.com/"));
        check(QnhUrlPolicy.safeImage("https://img.meituan.net/test/image.jpg"));
        check(!QnhUrlPolicy.safeImage("https://img.meituan.net.attacker.invalid/image.jpg"));
        check(!QnhUrlPolicy.safeImage("https://img.meituan.net/image.jpg?cookie=secret"));
        check(!QnhUrlPolicy.safeImage("https://img.meituan.net/image.jpg#value"));
        check(!QnhUrlPolicy.safeImage("https://u:p@img.meituan.net/image.jpg"));
        check(!QnhUrlPolicy.safeImage("http://img.meituan.net/image.jpg"));
        check("2110000000000000001".equals(SkuPolicy.decode("SKU：2110000000000000001")));
        check("000123".equals(SkuPolicy.decode("000123")));
        check(SkuPolicy.decode("https://attacker.invalid/?sku=123") == null);
        check(SkuPolicy.decode("javascript:alert(1)") == null);
        check(SkuPolicy.decode("123 456") == null);
        check(SkuPolicy.decode(null) == null);
        System.out.println("URL policy checks passed");
    }
}
