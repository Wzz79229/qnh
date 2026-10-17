package com.xianqi.phonevalidation;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;

/** Device-only compatibility probe. No Worker browser, GitHub credential or privileged JS bridge. */
public final class MainActivity extends Activity {
    private static final String LOGIN_URL = "https://qnh.meituan.com/";
    private static final String PRODUCT_URL = LOGIN_URL + "#/unifiedGoods/tenant/spu-list";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService images = Executors.newSingleThreadExecutor();
    private WebView web;
    private TextView status, result, tenantLabel, imageStatus, address;
    private EditText skuInput;
    private Button query, returnButton;
    private ImageView image;
    private ScrollView workbench;
    private String runtime = "", tenantId = "", candidate = "", pendingSku = "", pendingTenant = "";
    private int confirmations = 0, navigation = 0, operation = 0;
    private long deadline = 0;
    private boolean active = false, ready = false, probing = false, launched = false, loggedIn = false;
    private final Runnable tick = new Runnable() { public void run() {
        if (!active || web == null) return;
        if (!pendingSku.isEmpty() && android.os.SystemClock.elapsedRealtime() > deadline) failQuery("查询超时，请在牵牛花页面确认是否能打开商品管理后重试。");
        probe(); handler.postDelayed(this, 1200);
    }};

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        try (InputStream input = getAssets().open("qnh-phone.js")) { runtime = new String(readLimited(input, 200_000), StandardCharsets.UTF_8); }
        catch (Exception error) { showFatal("安装包缺少查询组件，请重新安装验证版。"); return; }
        buildUi(); configureBrowser();
        status.setText("请在下方牵牛花官方页面登录，成功后自动进入鲜期。可双指缩放页面。");
        web.loadUrl(LOGIN_URL);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private TextView label(String value, int size) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(Color.rgb(28, 57, 50));
        view.setPadding(0, dp(6), 0, dp(6)); return view;
    }
    private Button button(String title, View.OnClickListener click) {
        Button button = new Button(this); button.setText(title); button.setAllCaps(false); button.setOnClickListener(click); return button;
    }
    private void buildUi() {
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(243, 246, 241));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(dp(12), insets.getSystemWindowInsetTop(), dp(12), insets.getSystemWindowInsetBottom()); return insets;
        });
        root.addView(label("鲜期 · 手机连接验证", 22));
        status = label("正在打开牵牛花…", 13); root.addView(status);
        LinearLayout tools = new LinearLayout(this);
        tools.addView(button("牵牛花页面", v -> showOfficial()), new LinearLayout.LayoutParams(0, dp(44), 1));
        returnButton = button("返回鲜期", v -> { if (loggedIn) showWorkbench(); });
        returnButton.setEnabled(false); tools.addView(returnButton, new LinearLayout.LayoutParams(0, dp(44), 1));
        tools.addView(button("重新加载", v -> { if (web != null) { failQuery(""); web.reload(); } }), new LinearLayout.LayoutParams(0, dp(44), 1));
        root.addView(tools);
        address = label("https://qnh.meituan.com", 11); root.addView(address);
        web = new WebView(this); root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        workbench = new ScrollView(this); workbench.setFillViewport(true);
        LinearLayout content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL); content.setPadding(dp(8), dp(16), dp(8), dp(16));
        tenantLabel = label("", 15); content.addView(tenantLabel);
        content.addView(label("输入一个真实 SKU，验证是否能直接从本机牵牛花查回商品名称、规格和图片。", 15));
        skuInput = new EditText(this); skuInput.setHint("SKU 编码"); skuInput.setSingleLine(true);
        skuInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        skuInput.setAutofillHints((String[]) null); content.addView(skuInput);
        query = button("查询商品", v -> startQuery()); content.addView(query);
        result = label("", 17); content.addView(result);
        image = new ImageView(this); image.setScaleType(ImageView.ScaleType.FIT_CENTER); image.setContentDescription("牵牛花商品主图");
        content.addView(image, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(220))); image.setVisibility(View.GONE);
        imageStatus = label("", 13); content.addView(imageStatus);
        content.addView(label("当前验证版只检查手机登录与商品查询。扫码、拍照识别和 GitHub 批次保存将在连接验证后接入。", 13));
        content.addView(button("清除本机牵牛花登录", v -> clearLogin()));
        workbench.addView(content); root.addView(workbench, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        workbench.setVisibility(View.GONE); setContentView(root);
    }

    @SuppressLint("SetJavaScriptEnabled") private void configureBrowser() {
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSaveFormData(false); settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportZoom(true); settings.setBuiltInZoomControls(true); settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true); settings.setLoadWithOverviewMode(true);
        // QNH is a desktop merchant SPA. Keep it usable with pinch zoom on a phone.
        settings.setUserAgentString("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + chromeVersion(settings.getUserAgentString()) + " Safari/537.36");
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                if (allowedTop(request.getUrl().toString())) return false;
                status.setText("此链接不属于牵牛花登录站点，已停止打开。请使用页面中的网页登录方式。"); return true;
            }
            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
                navigation++; ready = false; probing = false;
                if (launched) failQuery("页面已切换，请重新查询 SKU。");
                try { Uri uri = Uri.parse(url); address.setText("https://" + uri.getHost()); } catch (Exception ignored) { address.setText(""); }
                if (!qnhOrigin(url)) lock();
            }
            @Override public void onPageFinished(WebView view, String url) { ready = true; probing = false; probe(); }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler sslHandler, SslError error) {
                sslHandler.cancel(); lock(); status.setText("网站证书校验失败，请检查手机时间和网络后重试。");
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) { ready = false; lock(); status.setText("牵牛花页面未能加载，请检查手机网络后点击重新加载。"); }
            }
        });
    }

    static String chromeVersion(String ua) {
        java.util.regex.Matcher match = java.util.regex.Pattern.compile("Chrome/([0-9.]+)").matcher(ua);
        return match.find() ? match.group(1) : "120.0.0.0";
    }
    static boolean allowedTop(String value) {
        return QnhUrlPolicy.allowedTop(value);
    }
    static boolean qnhOrigin(String value) {
        return QnhUrlPolicy.qnhOrigin(value);
    }
    private void probe() {
        if (!active || !ready || probing || web == null || !qnhOrigin(web.getUrl())) return;
        probing = true; final int page = navigation;
        web.evaluateJavascript(runtime + ";JSON.stringify(window.__xianqiPhoneValidation.inspect());", raw -> {
            if (page != navigation || !active) return;
            probing = false;
            try {
                if (raw == null || raw.length() > 40_000) throw new Exception();
                Object decoded = new JSONTokener(raw).nextValue();
                if (!(decoded instanceof String)) throw new Exception();
                handleProbe(new JSONObject((String) decoded));
            } catch (Exception ignored) { status.setText("正在等待牵牛花页面加载。若长时间没有变化，请点击重新加载。"); }
        });
    }
    private void handleProbe(JSONObject value) throws Exception {
        String observed = value.optString("tenantId", "");
        if (!value.optBoolean("authorized") || !observed.matches("[1-9][0-9]{0,19}")) { lock(); return; }
        if (loggedIn && !tenantId.equals(observed)) lock();
        if (!observed.equals(candidate)) { candidate = observed; confirmations = 1; }
        else confirmations++;
        if (confirmations < 2) return;
        if (!tenantId.isEmpty() && !tenantId.equals(observed)) { failQuery(""); result.setText(""); image.setImageDrawable(null); image.setVisibility(View.GONE); }
        boolean entering = !loggedIn || !tenantId.equals(observed);
        tenantId = observed; loggedIn = true; returnButton.setEnabled(true); tenantLabel.setText("已登录牵牛花 · 租户 " + tenantId);
        if (entering) { status.setText("手机端牵牛花已登录，可以验证商品查询。"); showWorkbench(); }
        if (pendingSku.isEmpty()) return;
        if (!pendingTenant.equals(tenantId)) { failQuery("牵牛花租户已切换，请重新查询。"); return; }
        final int current = operation, page = navigation;
        if (!launched && value.optBoolean("productReady")) {
            launched = true;
            String call = "window.__xianqiPhoneValidation.begin(" + JSONObject.quote(String.valueOf(current)) + "," + JSONObject.quote(pendingSku) + "," + JSONObject.quote(pendingTenant) + ");";
            web.evaluateJavascript(call, raw -> {
                if (current == operation && page == navigation && !"true".equals(raw)) failQuery("未能操作牵牛花的 SKU 查询框，请打开牵牛花页面核对。");
            });
        } else if (launched && String.valueOf(current).equals(value.optString("requestId"))) {
            String phase = value.optString("status");
            if ("found".equals(phase)) showProduct(value, current);
            else if (!"pending".equals(phase)) failQuery("not_found".equals(phase) ? "牵牛花没有返回此 SKU，请核对编码。" : "未能确认本次查询结果，请在牵牛花页面核对后重试。");
        }
    }
    private void lock() {
        boolean previouslyLoggedIn = loggedIn;
        loggedIn = false; tenantId = ""; candidate = ""; confirmations = 0;
        if (returnButton == null) return;
        returnButton.setEnabled(false); failQuery(""); result.setText(""); image.setImageDrawable(null); image.setVisibility(View.GONE); imageStatus.setText("");
        workbench.setVisibility(View.GONE); web.setVisibility(View.VISIBLE); address.setVisibility(View.VISIBLE);
        if (previouslyLoggedIn) status.setText("牵牛花登录状态已变化，请在官方页面完成登录。");
    }
    private void showOfficial() { web.setVisibility(View.VISIBLE); address.setVisibility(View.VISIBLE); workbench.setVisibility(View.GONE); }
    private void showWorkbench() { web.setVisibility(View.GONE); address.setVisibility(View.GONE); workbench.setVisibility(View.VISIBLE); }
    private void startQuery() {
        String sku = skuInput.getText().toString().trim();
        if (!loggedIn) { showOfficial(); status.setText("请先登录牵牛花。"); return; }
        if (!sku.matches("[A-Za-z0-9._-]{1,64}")) { skuInput.setError("请输入完整 SKU 编码"); return; }
        operation++; pendingSku = sku; pendingTenant = tenantId; launched = false;
        deadline = android.os.SystemClock.elapsedRealtime() + 35_000;
        query.setEnabled(false); result.setText(""); image.setVisibility(View.GONE); image.setImageDrawable(null); imageStatus.setText("");
        status.setText("正在通过手机牵牛花查询 SKU，请稍候…");
        InputMethodManager keyboard = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (keyboard != null) keyboard.hideSoftInputFromWindow(skuInput.getWindowToken(), 0);
        // Keep the real merchant page visible while querying; no remote browser is started.
        showOfficial();
        if (web.getUrl() == null || !web.getUrl().split("\\?")[0].endsWith("#/unifiedGoods/tenant/spu-list")) web.loadUrl(PRODUCT_URL);
        else probe();
    }
    private void failQuery(String message) {
        operation++; pendingSku = ""; pendingTenant = ""; launched = false;
        if (query != null) query.setEnabled(true);
        if (!message.isEmpty() && status != null) { status.setText(message); if (loggedIn) { result.setText(message); showWorkbench(); } }
    }
    private void showProduct(JSONObject state, int current) throws Exception {
        if (!pendingTenant.equals(state.optString("tenantId")) || !pendingSku.equals(state.optString("sku"))) throw new Exception();
        JSONObject product = state.getJSONObject("product");
        String sku = product.getString("sku"), name = product.getString("name"), spec = product.optString("spec", ""), imageUrl = product.getString("imageUrl");
        if (!sku.equals(pendingSku) || name.isEmpty() || name.length() > 200 || spec.length() > 120 || !safeImage(imageUrl)) throw new Exception();
        pendingSku = ""; pendingTenant = ""; launched = false; query.setEnabled(true);
        result.setText(name + (spec.isEmpty() ? "" : "\n" + spec) + "\nSKU：" + sku);
        status.setText("已从本机牵牛花查回商品信息。"); imageStatus.setText("正在加载牵牛花商品主图…"); image.setVisibility(View.VISIBLE); showWorkbench();
        images.submit(() -> {
            Bitmap bitmap = null;
            try { bitmap = loadImage(imageUrl); } catch (Exception ignored) { /* No credential or private diagnostics. */ }
            final Bitmap loaded = bitmap;
            handler.post(() -> {
                if (current != operation || !loggedIn || isFinishing()) return;
                if (loaded == null) { image.setVisibility(View.GONE); imageStatus.setText("商品图片未能加载，可打开牵牛花页面核对。"); }
                else { image.setImageBitmap(loaded); imageStatus.setText("商品主图来自牵牛花"); }
            });
        });
    }
    static boolean safeImage(String value) {
        return QnhUrlPolicy.safeImage(value);
    }
    private static Bitmap loadImage(String value) throws Exception {
        if (!safeImage(value)) throw new Exception();
        HttpsURLConnection connection = (HttpsURLConnection) new java.net.URL(value).openConnection();
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(10_000); connection.setReadTimeout(10_000);
        try {
            if (connection.getResponseCode() != 200 || connection.getContentType() == null || !connection.getContentType().startsWith("image/")) throw new Exception();
            byte[] bytes; try (InputStream input = connection.getInputStream()) { bytes = readLimited(input, 2_000_000); }
            BitmapFactory.Options bounds = new BitmapFactory.Options(); bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth > 20_000 || bounds.outHeight > 20_000) throw new Exception();
            BitmapFactory.Options decode = new BitmapFactory.Options(); decode.inSampleSize = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / decode.inSampleSize > 1024) decode.inSampleSize *= 2;
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, decode);
        } finally { connection.disconnect(); }
    }
    private static byte[] readLimited(InputStream input, int limit) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] block = new byte[8192]; int count;
        while ((count = input.read(block)) != -1) { if (output.size() + count > limit) throw new Exception(); output.write(block, 0, count); }
        return output.toByteArray();
    }
    private void clearLogin() {
        ready = false; probing = false; navigation++;
        failQuery(""); lock(); web.stopLoading(); web.clearHistory(); web.clearCache(true); WebStorage.getInstance().deleteAllData();
        CookieManager.getInstance().removeAllCookies(removed -> { CookieManager.getInstance().flush(); web.loadUrl(LOGIN_URL); });
        status.setText("本机登录已清除，请重新登录牵牛花。");
    }
    private void showFatal(String message) { TextView text = label(message, 18); text.setPadding(dp(20), dp(40), dp(20), dp(20)); setContentView(text); }
    @Override public void onResume() { super.onResume(); active = true; probing = false; if (web != null) { web.onResume(); handler.removeCallbacks(tick); handler.post(tick); } }
    @Override public void onPause() { active = false; handler.removeCallbacks(tick); if (web != null) web.onPause(); super.onPause(); }
    @Override public void onBackPressed() {
        if (web != null && web.getVisibility() == View.VISIBLE && loggedIn) showWorkbench();
        else super.onBackPressed();
    }
    @Override public void onDestroy() {
        active = false; handler.removeCallbacksAndMessages(null); images.shutdownNow();
        if (web != null) { web.stopLoading(); web.destroy(); web = null; } super.onDestroy();
    }
}
