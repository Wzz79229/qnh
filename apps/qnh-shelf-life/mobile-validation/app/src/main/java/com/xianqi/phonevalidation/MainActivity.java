package com.xianqi.phonevalidation;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
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
import org.json.JSONArray;
import org.json.JSONTokener;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;

/** Phone-owned QNH login, camera recognition and tenant-scoped batch management. */
public final class MainActivity extends Activity {
    private static final String LOGIN_URL = "https://qnh.meituan.com/";
    private static final String PRODUCT_URL = LOGIN_URL + "#/unifiedGoods/tenant/spu-list";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService images = Executors.newSingleThreadExecutor();
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final CloudClient cloud = new CloudClient();
    private int cloudGeneration = 0;
    private boolean cloudBusy = false;
    private TextView cloudStatus;
    private Button cloudButton;
    private LinearLayout cloudRows;
    private AlertDialog cloudImageDialog;
    private WebView web, batchEngine;
    private boolean batchReady = false, resumeVerified = false, restoreWorkbench = false;
    private String batchRuntime = "", captureTenant = "", captureSku = "", pendingCapture = "", captureMode = "", productionText = "", shelfText = "";
    private int batchGeneration = 0;
    private JSONObject currentProduct = null, currentDates = null;
    private DraftStore drafts;
    private String draftId = "";
    private LinearLayout batchPanel;
    private TextView dateSummary, draftList;
    private EditText quantityInput;
    private Button draftButton;
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
        try (InputStream input = getAssets().open("batch.js")) { batchRuntime = new String(readLimited(input, 300_000), StandardCharsets.UTF_8); }
        catch (Exception error) { showFatal("安装包缺少日期识别组件，请重新安装。"); return; }
        drafts = new DraftStore(this);
        buildUi(); configureBrowser();
        configureBatchEngine();
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
        root.addView(label("鲜期 · 保质期管理", 22));
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
        content.addView(button("扫描 SKU 码", v -> openCapture("sku")));
        content.addView(label("扫描 SKU 码查询商品，也可以输入完整 SKU。", 15));
        skuInput = new EditText(this); skuInput.setHint("SKU 编码"); skuInput.setSingleLine(true);
        skuInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        skuInput.setAutofillHints((String[]) null); content.addView(skuInput);
        query = button("查询商品", v -> startQuery()); content.addView(query);
        result = label("", 17); content.addView(result);
        image = new ImageView(this); image.setScaleType(ImageView.ScaleType.FIT_CENTER); image.setContentDescription("牵牛花商品主图");
        content.addView(image, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(220))); image.setVisibility(View.GONE);
        imageStatus = label("", 13); content.addView(imageStatus);
        batchPanel = new LinearLayout(this); batchPanel.setOrientation(LinearLayout.VERTICAL); batchPanel.setVisibility(View.GONE);
        batchPanel.addView(label("当前生产批次", 19));
        batchPanel.addView(button("拍生产日期", v -> openCapture("production")));
        batchPanel.addView(button("拍保质期", v -> openCapture("shelf")));
        dateSummary = label("拍清生产日期和保质期，程序自动计算到期日期。", 15); batchPanel.addView(dateSummary);
        quantityInput = new EditText(this); quantityInput.setSingleLine(true); quantityInput.setHint("清点件数"); quantityInput.setInputType(InputType.TYPE_CLASS_NUMBER); batchPanel.addView(quantityInput);
        draftButton = button("保存批次", v -> saveDraft()); batchPanel.addView(draftButton);
        batchPanel.addView(label("包装照片只在手机识别，不保存、不上传。保存时先加密暂存，连接云端后同步商品资料、商品主图和批次。", 13)); content.addView(batchPanel);
        content.addView(label("云端同步", 18)); cloudStatus = label("连接后可同步当前租户的批次。", 13); content.addView(cloudStatus);
        cloudButton = button("连接云端 / 同步批次", v -> requestCloud()); content.addView(cloudButton);
        cloudRows = new LinearLayout(this); cloudRows.setOrientation(LinearLayout.VERTICAL); content.addView(cloudRows);
        content.addView(label("最近本机批次", 18)); draftList = label("", 14); content.addView(draftList);
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
    @SuppressLint("SetJavaScriptEnabled") private void configureBatchEngine() {
        batchEngine = new WebView(this);
        batchEngine.getSettings().setJavaScriptEnabled(true); batchEngine.getSettings().setBlockNetworkLoads(true);
        batchEngine.getSettings().setAllowFileAccess(false); batchEngine.getSettings().setAllowContentAccess(false);
        batchEngine.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        batchEngine.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
            @Override public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript(batchRuntime + ";Boolean(window.__xianqiBatch);", raw -> {
                    batchReady = "true".equals(raw);
                    if (batchReady && (!productionText.isEmpty() || !shelfText.isEmpty())) parseDates();
                });
            }
        });
        batchEngine.loadDataWithBaseURL("https://appassets.androidplatform.net/", "<!doctype html><meta charset=utf-8><title>本机日期计算</title>", "text/html", "UTF-8", null);
    }
    private JSONObject evaluationObject(String raw) throws Exception {
        if (raw == null || raw.length() > 50_000) throw new Exception();
        Object decoded = new JSONTokener(raw).nextValue(); if (!(decoded instanceof String)) throw new Exception();
        return new JSONObject((String) decoded);
    }
    private void clearBatch() {
        batchGeneration++; currentProduct = null; currentDates = null; productionText = ""; shelfText = ""; draftId = "";
        if (batchPanel != null) { batchPanel.setVisibility(View.GONE); dateSummary.setText("拍清生产日期和保质期，程序自动计算到期日期。"); quantityInput.setText(""); draftButton.setEnabled(true); }
    }
    private void openCapture(String mode) {
        if (!loggedIn || !resumeVerified) { status.setText("正在确认牵牛花登录，请稍候。"); return; }
        if (!"sku".equals(mode) && currentProduct == null) { status.setText("请先扫描 SKU 查回商品。"); return; }
        captureTenant = tenantId; captureSku = currentProduct == null ? "" : currentProduct.optString("sku"); captureMode = mode; pendingCapture = "";
        Intent request = new Intent(this, CaptureActivity.class); request.putExtra("mode", "sku".equals(mode) ? "sku" : "date");
        startActivityForResult(request, 62);
    }
    @Override public void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != 62) return;
        if (resultCode != RESULT_OK || data == null) { captureMode = ""; pendingCapture = ""; return; }
        String expectedMode = "sku".equals(captureMode) ? "sku" : "date", text = data.getStringExtra("value");
        if (!expectedMode.equals(data.getStringExtra("mode")) || text == null || text.length() > 12000) { captureMode = ""; pendingCapture = ""; return; }
        pendingCapture = text; resumeVerified = false; candidate = ""; confirmations = 0;
        status.setText("识别完成，正在确认当前牵牛花租户…");
    }
    private void applyCapture() {
        if (pendingCapture.isEmpty() || !resumeVerified) return;
        String text = pendingCapture, mode = captureMode; pendingCapture = ""; captureMode = "";
        if (!tenantId.equals(captureTenant)) { status.setText("租户已切换，本次识别结果已丢弃，请重新扫描。"); return; }
        if ("sku".equals(mode)) {
            String sku = SkuPolicy.decode(text); if (sku == null) { status.setText("未识别到完整 SKU，请重新扫描。"); return; }
            skuInput.setText(sku); startQuery(); return;
        }
        if (currentProduct == null || !captureSku.equals(currentProduct.optString("sku"))) { status.setText("商品已变化，请为当前商品重新拍日期。"); return; }
        if ("production".equals(mode)) productionText = text; else if ("shelf".equals(mode)) shelfText = text; else return;
        batchGeneration++; draftId = ""; currentDates = null; showWorkbench(); parseDates();
    }
    private void parseDates() {
        if (!batchReady || batchEngine == null) { status.setText("本机日期计算正在加载，请稍候。"); return; }
        final int generation = batchGeneration; final String tenant = tenantId;
        String text = productionText + "\n" + shelfText;
        batchEngine.evaluateJavascript("JSON.stringify(window.__xianqiBatch.parse(" + JSONObject.quote(text) + "));", raw -> {
            if (generation != batchGeneration || !tenant.equals(tenantId) || !loggedIn || !resumeVerified) return;
            try {
                currentDates = evaluationObject(raw);
                String production = currentDates.optString("productionDate", ""), expiry = currentDates.optString("expiryDate", "");
                int shelf = currentDates.optInt("shelfLife", 0); String unit = currentDates.optString("shelfUnit", "day");
                String summary = "生产日期：" + (production.isEmpty() ? "未识别" : production) + "\n保质期：" + (shelf < 1 ? "未识别" : shelf + ("month".equals(unit) ? "个月" : "year".equals(unit) ? "年" : "天"))
                    + "\n到期日期：" + (expiry.isEmpty() ? "待计算" : expiry);
                if (!currentDates.optBoolean("complete")) {
                    JSONArray issues = currentDates.optJSONArray("issues");
                    if (issues != null && issues.length() > 0) summary += "\n" + issues.optString(0);
                    status.setText("日期信息尚未完整，请按提示重新拍摄。");
                } else { draftId = java.util.UUID.randomUUID().toString(); status.setText("日期已识别，请核对到期日期并填写清点件数。"); }
                dateSummary.setText(summary); draftButton.setEnabled(currentDates.optBoolean("complete"));
            } catch (Exception ignored) { status.setText("日期计算未完成，请重新拍摄。"); }
        });
    }
    private void saveDraft() {
        if (!loggedIn || !resumeVerified || currentProduct == null || currentDates == null || !currentDates.optBoolean("complete") || !batchReady) {
            status.setText("请先查回商品并识别完整日期。"); return;
        }
        final int generation = batchGeneration; final String tenant = tenantId;
        try {
            JSONObject value = new JSONObject(); value.put("id", draftId); value.put("tenantId", tenant); value.put("product", currentProduct);
            value.put("dates", currentDates); value.put("quantity", quantityInput.getText().toString().trim()); draftButton.setEnabled(false);
            batchEngine.evaluateJavascript("JSON.stringify(window.__xianqiBatch.draft(" + value.toString() + "));", raw -> {
                if (generation != batchGeneration || !tenant.equals(tenantId) || !loggedIn || !resumeVerified) return;
                try {
                    JSONObject response = evaluationObject(raw);
                    if (!response.optBoolean("ok")) { status.setText(response.optString("message", "批次数据未确认，请重新核对。")); draftButton.setEnabled(true); return; }
                    drafts.save(tenant, response.getJSONObject("draft"));
                    batchGeneration++; productionText = ""; shelfText = ""; currentDates = null; draftId = ""; quantityInput.setText("");
                    dateSummary.setText("已暂存当前批次。录入下一生产日期时请重新拍摄。"); draftButton.setEnabled(false);
                    status.setText("批次已加密暂存在本机，尚未同步云端。"); refreshDrafts();
                    if (cloud.connected(tenant)) syncCloud();
                } catch (Exception ignored) { draftButton.setEnabled(true); status.setText("本机批次保存未完成，请保留当前信息后重试。"); }
            });
        } catch (Exception ignored) { status.setText("批次信息不完整，请重新核对。"); }
    }
    private void refreshDrafts() {
        if (!loggedIn || !resumeVerified || drafts == null || draftList == null) return;
        try {
            JSONArray values = drafts.list(tenantId); StringBuilder summary = new StringBuilder();
            for (int index = 0; index < values.length(); index++) {
                JSONObject row = values.getJSONObject(index), product = row.getJSONObject("product");
                if (index > 0) summary.append("\n\n");
                summary.append(product.getString("name")).append("\nSKU：").append(product.getString("sku"))
                    .append("\n生产：").append(row.getString("productionDate")).append(" · 到期：").append(row.getString("expiryDate"))
                    .append("\n").append(row.getInt("quantity")).append(" 件 · ").append("cloud".equals(row.optString("syncStatus")) ? "已同步云端" : "本机待同步");
            }
            draftList.setText(values.length() == 0 ? "当前租户暂无本机批次。" : summary.toString());
        } catch (Exception ignored) { draftList.setText("本机批次未能读取。请保留当前 App，避免卸载导致数据丢失。"); }
    }

    private boolean cloudCurrent(String tenant, int generation) {
        return generation == cloudGeneration && loggedIn && tenant.equals(tenantId) && !isFinishing() && !isDestroyed();
    }
    private String cloudMessage(Exception error) {
        return error instanceof CloudClient.CloudError ? error.getMessage() : "云端连接未完成，批次仍保留在手机，请稍后重试。";
    }
    private void requestCloud() {
        if (!loggedIn || !resumeVerified) { status.setText("请先完成牵牛花登录确认。"); return; }
        if (cloudBusy) return;
        if (cloud.connected(tenantId)) { syncCloud(); return; }
        final String tenant = tenantId; final int generation = cloudGeneration;
        cloudBusy = true; cloudButton.setEnabled(false); cloudStatus.setText("正在检查云端连接…");
        network.submit(() -> {
            try {
                if (!cloud.configured()) throw new CloudClient.CloudError("MOBILE_SETUP_REQUIRED");
                handler.post(() -> {
                    if (!cloudCurrent(tenant, generation)) return;
                    cloudBusy = false; cloudButton.setEnabled(true);
                    if (!active || !resumeVerified) { cloudStatus.setText("请返回鲜期后再次连接云端。"); return; }
                    if (getPreferences(MODE_PRIVATE).getBoolean("cloud-session-consent-v1", false)) connectCloud(tenant, generation);
                    else new AlertDialog.Builder(this).setTitle("启用当前租户云端同步")
                        .setMessage("为核实租户，鲜期会通过 HTTPS 将本机牵牛花登录会话临时发送到你的 Cloudflare 后台（qnh-shelf-life-api.w792294944.workers.dev），仅向牵牛花官方接口验证。后台不保存牵牛花会话、密码或验证码。商品名称、规格、SKU、主图和批次将保存在你的 Cloudflare 账号，供同租户成员查看。包装日期照片不会上传。")
                        .setNegativeButton("暂不连接", (dialog, which) -> cloudStatus.setText("批次仅保留在手机，尚未同步。"))
                        .setPositiveButton("同意并连接", (dialog, which) -> {
                            getPreferences(MODE_PRIVATE).edit().putBoolean("cloud-session-consent-v1", true).apply();
                            connectCloud(tenant, generation);
                        }).show();
                });
            } catch (Exception error) { handler.post(() -> {
                if (!cloudCurrent(tenant, generation)) return;
                cloudBusy = false; cloudButton.setEnabled(true); cloudStatus.setText(cloudMessage(error));
            }); }
        });
    }
    private void connectCloud(String tenant, int generation) {
        if (!cloudCurrent(tenant, generation) || !active || !resumeVerified || cloudBusy) return;
        String session = CookieManager.getInstance().getCookie(LOGIN_URL);
        if (session == null || session.length() < 8 || session.length() > 8192) { cloudStatus.setText("未能读取本机牵牛花登录状态，请重新登录后连接。"); return; }
        cloudBusy = true; cloudButton.setEnabled(false); cloudStatus.setText("正在通过牵牛花核实当前租户…");
        network.submit(() -> {
            try {
                cloud.connect(tenant, session);
                handler.post(() -> {
                    if (!cloudCurrent(tenant, generation)) return;
                    cloudBusy = false; cloudButton.setEnabled(true); cloudStatus.setText("租户已核实，正在同步…"); syncCloud();
                });
            } catch (Exception error) { handler.post(() -> {
                if (!cloudCurrent(tenant, generation)) return;
                cloudBusy = false; cloudButton.setEnabled(true); cloudStatus.setText(cloudMessage(error));
            }); }
        });
    }
    private void syncCloud() {
        if (!loggedIn || !resumeVerified || cloudBusy) return;
        final String tenant = tenantId; final int generation = cloudGeneration;
        if (!cloud.connected(tenant)) { cloudStatus.setText("请连接云端后同步本机批次。"); return; }
        cloudBusy = true; cloudButton.setEnabled(false); cloudStatus.setText("正在同步商品资料、主图和批次…");
        network.submit(() -> {
            int uploaded = 0; JSONArray rows = null; Exception failure = null;
            try {
                JSONArray pending = drafts.pending(tenant);
                for (int index = 0; index < pending.length(); index++) {
                    if (!cloud.connected(tenant) || Thread.currentThread().isInterrupted()) throw new CloudClient.CloudError("MOBILE_AUTH_REQUIRED");
                    JSONObject draft = pending.getJSONObject(index), saved = cloud.upload(tenant, draft);
                    drafts.markSynced(tenant, draft.getString("id"), saved.getString("imagePath")); uploaded++;
                }
                rows = cloud.list(tenant);
            } catch (Exception error) { failure = error; }
            final int count = uploaded; final JSONArray resultRows = rows; final Exception error = failure;
            handler.post(() -> {
                if (!cloudCurrent(tenant, generation)) return;
                cloudBusy = false; cloudButton.setEnabled(true); refreshDrafts();
                cloudStatus.setText(error == null ? "当前租户云端已连接；本次同步 " + count + " 个批次。" : cloudMessage(error));
                if (resultRows != null) renderCloudRows(resultRows, tenant, generation);
            });
        });
    }
    private String batchSummary(JSONObject row) throws Exception {
        JSONObject product = row.getJSONObject("product"); String unit = row.getString("shelfUnit");
        return product.getString("name") + "\n" + product.optString("spec") + "\nSKU：" + product.getString("sku")
            + "\n生产：" + row.getString("productionDate") + " · 保质期：" + row.getInt("shelfLife") + ("month".equals(unit) ? "个月" : "year".equals(unit) ? "年" : "天")
            + "\n到期：" + row.getString("expiryDate") + " · " + row.getInt("quantity") + " 件";
    }
    private void renderCloudRows(JSONArray rows, String tenant, int generation) {
        cloudRows.removeAllViews(); cloudRows.addView(label("最近云端批次（最多 100 条）", 17));
        if (rows.length() == 0) cloudRows.addView(label("当前租户暂无云端批次。", 14));
        try { for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.getJSONObject(index); String summary = batchSummary(row), path = row.getString("imagePath");
            cloudRows.addView(label(summary, 14)); cloudRows.addView(button("查看已归档商品主图", view -> showCloudImage(path, summary, tenant, generation)));
        } } catch (Exception ignored) { cloudStatus.setText("部分云端批次未能显示，请重试同步。"); }
    }
    private void showCloudImage(String path, String summary, String tenant, int generation) {
        if (!cloudCurrent(tenant, generation) || !resumeVerified) return;
        cloudStatus.setText("正在读取当前租户的商品主图…");
        network.submit(() -> {
            Bitmap loaded = null;
            try { loaded = decodeImage(cloud.image(tenant, path)); } catch (Exception ignored) { /* No provider bodies or credentials. */ }
            final Bitmap bitmap = loaded;
            handler.post(() -> {
                if (!cloudCurrent(tenant, generation) || !active || !resumeVerified) { if (bitmap != null) bitmap.recycle(); return; }
                if (bitmap == null) { cloudStatus.setText("商品主图未能读取，请重新连接后重试。"); return; }
                ImageView preview = new ImageView(this); preview.setImageBitmap(bitmap); preview.setAdjustViewBounds(true); preview.setContentDescription(summary);
                AlertDialog dialog = new AlertDialog.Builder(this).setTitle("云端商品主图").setView(preview).setPositiveButton("关闭", null).create();
                cloudImageDialog = dialog;
                dialog.setOnDismissListener(value -> { preview.setImageDrawable(null); bitmap.recycle(); if (cloudImageDialog == dialog) cloudImageDialog = null; }); dialog.show();
                cloudStatus.setText("已从当前租户的云端批次读取商品主图。");
            });
        });
    }
    private static Bitmap decodeImage(byte[] bytes) throws Exception {
        BitmapFactory.Options bounds = new BitmapFactory.Options(); bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth > 20000 || bounds.outHeight > 20000) throw new Exception();
        BitmapFactory.Options options = new BitmapFactory.Options(); options.inSampleSize = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / options.inSampleSize > 1024) options.inSampleSize *= 2;
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
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
        resumeVerified = true;
        if (!tenantId.isEmpty() && !tenantId.equals(observed)) { failQuery(""); result.setText(""); image.setImageDrawable(null); image.setVisibility(View.GONE); }
        boolean entering = !loggedIn || !tenantId.equals(observed);
        tenantId = observed; loggedIn = true; returnButton.setEnabled(true); tenantLabel.setText("已登录牵牛花 · 租户 " + tenantId);
        if (entering) { cloudStatus.setText("连接后可同步当前租户的批次。"); status.setText("牵牛花已登录，可以扫描 SKU 录入批次。"); refreshDrafts(); showWorkbench(); }
        if (restoreWorkbench && pendingSku.isEmpty()) { restoreWorkbench = false; refreshDrafts(); showWorkbench(); }
        applyCapture();
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
        resumeVerified = false; cloudGeneration++; cloud.clear(); cloudBusy = false;
        if (cloudImageDialog != null) { cloudImageDialog.dismiss(); cloudImageDialog = null; }
        if (cloudRows != null) cloudRows.removeAllViews();
        if (cloudStatus != null) cloudStatus.setText("请先登录牵牛花。");
        if (cloudButton != null) cloudButton.setEnabled(true);
        clearBatch(); pendingCapture = ""; captureTenant = "";
        if (draftList != null) draftList.setText("");
        if (returnButton == null) return;
        returnButton.setEnabled(false); failQuery(""); result.setText(""); image.setImageDrawable(null); image.setVisibility(View.GONE); imageStatus.setText("");
        workbench.setVisibility(View.GONE); web.setVisibility(View.VISIBLE); address.setVisibility(View.VISIBLE);
        if (previouslyLoggedIn) status.setText("牵牛花登录状态已变化，请在官方页面完成登录。");
    }
    private void showOfficial() { web.setVisibility(View.VISIBLE); address.setVisibility(View.VISIBLE); workbench.setVisibility(View.GONE); }
    private void showWorkbench() { web.setVisibility(View.GONE); address.setVisibility(View.GONE); workbench.setVisibility(View.VISIBLE); }
    private void startQuery() {
        String sku = skuInput.getText().toString().trim();
        if (!loggedIn || !resumeVerified) { showOfficial(); status.setText("请先完成牵牛花登录确认。"); return; }
        if (!sku.matches("[A-Za-z0-9._-]{1,64}")) { skuInput.setError("请输入完整 SKU 编码"); return; }
        operation++; pendingSku = sku; pendingTenant = tenantId; launched = false;
        clearBatch();
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
        currentProduct = new JSONObject(product.toString()); batchGeneration++; batchPanel.setVisibility(View.VISIBLE);
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
    @Override public void onResume() {
        super.onResume(); active = true; probing = false; resumeVerified = false; confirmations = 0; candidate = "";
        if (web != null) { web.onResume(); if (restoreWorkbench) showOfficial(); handler.removeCallbacks(tick); handler.post(tick); }
    }
    @Override public void onPause() { restoreWorkbench = workbench != null && workbench.getVisibility() == View.VISIBLE; active = false; resumeVerified = false; handler.removeCallbacks(tick); if (web != null) web.onPause(); super.onPause(); }
    @Override public void onBackPressed() {
        if (web != null && web.getVisibility() == View.VISIBLE && loggedIn) showWorkbench();
        else super.onBackPressed();
    }
    @Override public void onDestroy() {
        active = false; cloudGeneration++; cloud.clear(); if (cloudImageDialog != null) cloudImageDialog.dismiss(); handler.removeCallbacksAndMessages(null); images.shutdownNow(); network.shutdownNow();
        if (web != null) { web.stopLoading(); web.destroy(); web = null; }
        if (batchEngine != null) { batchEngine.destroy(); batchEngine = null; } if (drafts != null) drafts.close();
        super.onDestroy();
    }
}
