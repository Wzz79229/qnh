package com.xianqi.phonevalidation;

import org.json.JSONObject;
import org.json.JSONArray;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;

/** Fixed first-party endpoint. QNH cookies are used only for one transient identity verification POST. */
final class CloudClient {
    static final String BASE = "https://qnh-shelf-life-api.w792294944.workers.dev";
    private String token = "", tenant = "";
    private long expiresAt = 0;
    private int generation = 0;
    static final class CloudError extends Exception {
        final String code;
        CloudError(String code) { super(messageFor(code)); this.code = code; }
    }
    private static String messageFor(String code) {
        switch (code) {
            case "MOBILE_SETUP_REQUIRED": return "云端数据库或图片存储尚未配置，批次先保留在手机。";
            case "MOBILE_AUTH_REQUIRED": return "云端未能确认牵牛花登录，请重新连接。";
            case "MOBILE_TENANT_CHANGED": return "租户已变化，请重新连接云端。";
            case "MOBILE_AUTH_RATE": return "连接请求较多，请稍候一分钟再试。";
            case "PRODUCT_IMAGE_UNAVAILABLE": return "商品主图归档未完成，批次仍保留手机，请稍后重试。";
            case "MOBILE_BATCH_CONFLICT": return "云端已有不同内容的同一批次，请保留手机数据并核对。";
            case "INVALID_MOBILE_BATCH": return "批次商品资料、日期或件数无效，请重新核对。";
            default: return "云端暂时无法连接，批次仍保留在手机，请稍后重试。";
        }
    }
    synchronized boolean connected(String expectedTenant) { return !token.isEmpty() && tenant.equals(expectedTenant) && expiresAt > System.currentTimeMillis() + 10000; }
    synchronized void clear() { token = ""; tenant = ""; expiresAt = 0; generation++; }
    private HttpsURLConnection request(String path, String method, String expectedTenant, String credential) throws Exception {
        if (!path.startsWith("/api/mobile/") || path.contains("?") || path.contains("#") || path.contains("..")) throw new CloudError("MOBILE_UNAVAILABLE");
        HttpsURLConnection connection = (HttpsURLConnection) new java.net.URL(BASE + path).openConnection();
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(10000); connection.setReadTimeout(20000); connection.setRequestMethod(method);
        connection.setRequestProperty("Accept", "application/json");
        if (expectedTenant != null) connection.setRequestProperty("X-QNH-Tenant", expectedTenant);
        if (credential != null && !credential.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + credential);
        return connection;
    }
    private static byte[] read(InputStream input, int limit) throws Exception {
        if (input == null) throw new CloudError("MOBILE_UNAVAILABLE");
        ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] block = new byte[8192]; int count;
        while ((count = input.read(block)) != -1) { if (output.size() + count > limit) throw new CloudError("MOBILE_UNAVAILABLE"); output.write(block, 0, count); }
        return output.toByteArray();
    }
    private JSONObject json(String path, String method, JSONObject body, String expectedTenant, String credential) throws Exception {
        HttpsURLConnection connection = request(path, method, expectedTenant, credential);
        try {
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8); if (bytes.length > 16000) throw new CloudError("INVALID_MOBILE_BATCH");
                connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json; charset=utf-8"); connection.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode();
            if (status < 200 || status > 299) {
                String code = "MOBILE_UNAVAILABLE";
                try (InputStream input = connection.getErrorStream()) { code = new JSONObject(new String(read(input, 4096), StandardCharsets.UTF_8)).optString("code", code); }
                catch (Exception ignored) { /* Never show provider bodies or credentials. */ }
                throw new CloudError(code);
            }
            if (connection.getContentType() == null || !connection.getContentType().startsWith("application/json")) throw new CloudError("MOBILE_UNAVAILABLE");
            try (InputStream input = connection.getInputStream()) { return new JSONObject(new String(read(input, 1_000_000), StandardCharsets.UTF_8)); }
        } finally { connection.disconnect(); }
    }
    boolean configured() throws Exception { return json("/api/mobile/config", "GET", null, null, null).optBoolean("configured"); }
    void connect(String expectedTenant, String qnhCookie) throws Exception {
        final int current; synchronized (this) { current = generation; }
        JSONObject body = new JSONObject(); body.put("tenantId", expectedTenant); body.put("qnhCookie", qnhCookie);
        JSONObject response = json("/api/mobile/sessions", "POST", body, null, null);
        String issued = response.optString("token"), verified = response.optString("tenantId"); long expiration = response.optLong("expiresAt");
        if (!issued.matches("[a-f0-9]{64}") || !expectedTenant.equals(verified) || expiration <= System.currentTimeMillis()) throw new CloudError("MOBILE_AUTH_REQUIRED");
        synchronized (this) { if (current != generation) throw new CloudError("MOBILE_TENANT_CHANGED"); token = issued; tenant = verified; expiresAt = expiration; }
    }
    private synchronized String credential(String expectedTenant) throws CloudError {
        if (!connected(expectedTenant)) throw new CloudError("MOBILE_AUTH_REQUIRED"); return token;
    }
    JSONObject upload(String expectedTenant, JSONObject draft) throws Exception {
        if (!expectedTenant.equals(draft.optString("tenantId"))) throw new CloudError("MOBILE_TENANT_CHANGED");
        JSONObject body = new JSONObject(); for (String key : new String[]{"id", "product", "productionDate", "shelfLife", "shelfUnit", "expiryDate", "quantity"}) body.put(key, draft.get(key));
        JSONObject row = json("/api/mobile/batches", "POST", body, expectedTenant, credential(expectedTenant)).getJSONObject("batch");
        if (!draft.getString("id").equals(row.optString("id")) || !"cloud".equals(row.optString("syncStatus"))) throw new CloudError("MOBILE_UNAVAILABLE"); return row;
    }
    JSONArray list(String expectedTenant) throws Exception {
        JSONObject response = json("/api/mobile/batches", "GET", null, expectedTenant, credential(expectedTenant));
        if (!expectedTenant.equals(response.optString("tenantId"))) throw new CloudError("MOBILE_TENANT_CHANGED");
        JSONArray rows = response.getJSONArray("batches"); if (rows.length() > 100) throw new CloudError("MOBILE_UNAVAILABLE"); return rows;
    }
    byte[] image(String expectedTenant, String path) throws Exception {
        if (!path.matches("/api/mobile/images/[a-f0-9]{64}\\.(jpg|png|webp)")) throw new CloudError("MOBILE_UNAVAILABLE");
        HttpsURLConnection connection = request(path, "GET", expectedTenant, credential(expectedTenant));
        try {
            if (connection.getResponseCode() != 200 || connection.getContentType() == null || !connection.getContentType().startsWith("image/")) throw new CloudError("MOBILE_UNAVAILABLE");
            try (InputStream input = connection.getInputStream()) { return read(input, 2_000_000); }
        } finally { connection.disconnect(); }
    }
}
