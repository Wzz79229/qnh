package com.xianqi.phonevalidation;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Encrypted, tenant-scoped offline drafts. This is not a backend identity credential. */
final class DraftStore extends SQLiteOpenHelper {
    private static final String ALIAS = "xianqi-local-batches-v1";
    DraftStore(Context context) { super(context, "xianqi-drafts.db", null, 1); }
    @Override public void onCreate(SQLiteDatabase database) {
        database.execSQL("CREATE TABLE drafts (tenant_key TEXT NOT NULL, batch_id TEXT NOT NULL, payload BLOB NOT NULL, created_at TEXT NOT NULL, sync_status TEXT NOT NULL DEFAULT 'local', PRIMARY KEY(tenant_key,batch_id))");
    }
    @Override public void onUpgrade(SQLiteDatabase database, int oldVersion, int newVersion) { throw new IllegalStateException("Migration required"); }
    private String tenantKey(String tenantId) throws Exception {
        if (tenantId == null || !tenantId.matches("[1-9][0-9]{0,19}")) throw new Exception();
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(tenantId.getBytes(StandardCharsets.UTF_8));
        StringBuilder value = new StringBuilder(); for (byte b : hash) value.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return value.toString();
    }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    private byte[] encrypt(String value, String tenantId) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(tenantId.getBytes(StandardCharsets.UTF_8)); byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV(); byte[] output = new byte[1 + iv.length + encrypted.length]; output[0] = (byte) iv.length;
        System.arraycopy(iv, 0, output, 1, iv.length); System.arraycopy(encrypted, 0, output, 1 + iv.length, encrypted.length); return output;
    }
    private JSONObject decrypt(byte[] value, String tenantId) throws Exception {
        if (value.length < 30 || value.length > 20_000 || value[0] != 12) throw new Exception();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, value, 1, 12));
        cipher.updateAAD(tenantId.getBytes(StandardCharsets.UTF_8));
        JSONObject result = new JSONObject(new String(cipher.doFinal(value, 13, value.length - 13), StandardCharsets.UTF_8));
        if (!tenantId.equals(result.optString("tenantId"))) throw new Exception(); return result;
    }
    synchronized void save(String tenantId, JSONObject draft) throws Exception {
        String scope = tenantKey(tenantId), id = draft.getString("id");
        if (!tenantId.equals(draft.optString("tenantId")) || !id.matches("[a-f0-9-]{36}") || draft.toString().length() > 12000) throw new Exception();
        JSONObject clean = new JSONObject();
        for (String field : new String[]{"id", "tenantId", "product", "productionDate", "shelfLife", "shelfUnit", "expiryDate", "quantity", "unit", "createdAt"}) clean.put(field, draft.get(field));
        clean.put("syncStatus", "local");
        ContentValues values = new ContentValues(); values.put("tenant_key", scope); values.put("batch_id", id);
        values.put("payload", encrypt(clean.toString(), tenantId)); values.put("created_at", clean.getString("createdAt"));
        long inserted = getWritableDatabase().insertWithOnConflict("drafts", null, values, SQLiteDatabase.CONFLICT_IGNORE);
        if (inserted == -1) {
            try (Cursor cursor = getReadableDatabase().query("drafts", new String[]{"payload"}, "tenant_key=? AND batch_id=?", new String[]{scope, id}, null, null, null)) {
                if (!cursor.moveToFirst() || !decrypt(cursor.getBlob(0), tenantId).toString().equals(clean.toString())) throw new Exception();
            }
        }
    }
    synchronized JSONArray list(String tenantId) throws Exception {
        JSONArray result = new JSONArray();
        try (Cursor cursor = getReadableDatabase().query("drafts", new String[]{"payload"}, "tenant_key=?", new String[]{tenantKey(tenantId)}, null, null, "created_at DESC", "20")) {
            while (cursor.moveToNext()) result.put(decrypt(cursor.getBlob(0), tenantId));
        }
        return result;
    }
    synchronized JSONArray pending(String tenantId) throws Exception {
        JSONArray result = new JSONArray();
        try (Cursor cursor = getReadableDatabase().query("drafts", new String[]{"payload"}, "tenant_key=? AND sync_status='local'", new String[]{tenantKey(tenantId)}, null, null, "created_at ASC", "100")) {
            while (cursor.moveToNext()) result.put(decrypt(cursor.getBlob(0), tenantId));
        } return result;
    }
    synchronized void markSynced(String tenantId, String id, String imagePath) throws Exception {
        if (imagePath == null || !imagePath.matches("/api/mobile/images/[a-f0-9]{64}\\.(jpg|png|webp)")) throw new Exception();
        String scope = tenantKey(tenantId);
        try (Cursor cursor = getReadableDatabase().query("drafts", new String[]{"payload"}, "tenant_key=? AND batch_id=?", new String[]{scope, id}, null, null, null)) {
            if (!cursor.moveToFirst()) throw new Exception(); JSONObject value = decrypt(cursor.getBlob(0), tenantId);
            value.put("syncStatus", "cloud"); value.put("cloudImagePath", imagePath);
            ContentValues update = new ContentValues(); update.put("payload", encrypt(value.toString(), tenantId)); update.put("sync_status", "cloud");
            if (getWritableDatabase().update("drafts", update, "tenant_key=? AND batch_id=?", new String[]{scope, id}) != 1) throw new Exception();
        }
    }
}
