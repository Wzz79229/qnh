package com.xianqi.phonevalidation;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Bundle;
import android.util.Size;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.activity.ComponentActivity;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Camera frames and photographs remain in RAM. No file, gallery entry or image upload is created. */
public final class CaptureActivity extends ComponentActivity {
    private final ExecutorService analyzer = Executors.newSingleThreadExecutor();
    private PreviewView preview;
    private TextView message;
    private Button shutter;
    private ProcessCameraProvider provider;
    private ImageCapture capture;
    private Camera camera;
    private BarcodeScanner scanner;
    private TextRecognizer recognizer;
    private volatile boolean processing = false, finished = false;
    private boolean scanMode, torch = false;
    private String lastSku = "";
    private int stable = 0;
    private long lastScan = 0;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        scanMode = "sku".equals(getIntent().getStringExtra("mode"));
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(15, 32, 28));
        root.setOnApplyWindowInsetsListener((view, insets) -> { view.setPadding(16, insets.getSystemWindowInsetTop(), 16, insets.getSystemWindowInsetBottom()); return insets; });
        message = new TextView(this); message.setTextColor(Color.WHITE); message.setTextSize(17); message.setPadding(12, 18, 12, 18);
        message.setText(scanMode ? "只对准一个 SKU 码，识别后自动查询商品。" : "请拍清生产日期或保质期及其标签。点击拍照后在本机识别，不保存照片。"); root.addView(message);
        preview = new PreviewView(this); preview.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE); preview.setScaleType(PreviewView.ScaleType.FIT_CENTER);
        root.addView(preview, new LinearLayout.LayoutParams(-1, 0, 1));
        LinearLayout buttons = new LinearLayout(this);
        Button cancel = new Button(this); cancel.setText("取消"); cancel.setOnClickListener(v -> finish()); buttons.addView(cancel, new LinearLayout.LayoutParams(0, -2, 1));
        Button light = new Button(this); light.setText("补光"); light.setOnClickListener(v -> {
            if (camera != null && camera.getCameraInfo().hasFlashUnit()) { torch = !torch; camera.getCameraControl().enableTorch(torch); }
        }); buttons.addView(light, new LinearLayout.LayoutParams(0, -2, 1));
        shutter = new Button(this); shutter.setText("拍照识别"); shutter.setEnabled(false); shutter.setOnClickListener(v -> takePicture());
        if (!scanMode) buttons.addView(shutter, new LinearLayout.LayoutParams(0, -2, 1)); root.addView(buttons); setContentView(root);
        if (scanMode) scanner = BarcodeScanning.getClient(new BarcodeScannerOptions.Builder().setBarcodeFormats(
            Barcode.FORMAT_CODE_128, Barcode.FORMAT_QR_CODE, Barcode.FORMAT_CODE_39, Barcode.FORMAT_CODE_93,
            Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8, Barcode.FORMAT_ITF, Barcode.FORMAT_DATA_MATRIX).build());
        else recognizer = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) openCamera();
        else requestPermissions(new String[]{Manifest.permission.CAMERA}, 41);
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(requestCode, permissions, grants);
        if (requestCode == 41 && grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED) openCamera();
        else message.setText("尚未获得相机权限。可以返回后重新点击扫码或拍照，按手机提示授权。");
    }
    private void openCamera() {
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            if (finished || isFinishing()) return;
            try {
                provider = future.get();
                Preview view = new Preview.Builder().build(); view.setSurfaceProvider(preview.getSurfaceProvider());
                provider.unbindAll();
                if (scanMode) {
                    ImageAnalysis analysis = new ImageAnalysis.Builder().setTargetResolution(new Size(1280, 720))
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build();
                    analysis.setAnalyzer(analyzer, this::analyzeBarcode);
                    camera = provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, view, analysis);
                } else {
                    capture = new ImageCapture.Builder().setTargetResolution(new Size(1920, 1440))
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build();
                    camera = provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, view, capture); shutter.setEnabled(true);
                }
            } catch (Exception ignored) { message.setText("未能打开后置相机，请关闭其他占用相机的应用后重试。"); }
        }, ContextCompat.getMainExecutor(this));
    }
    private void analyzeBarcode(ImageProxy frame) {
        if (finished || processing || scanner == null) { frame.close(); return; }
        processing = true;
        Bitmap bitmap;
        int rotation = frame.getImageInfo().getRotationDegrees();
        try { bitmap = frame.toBitmap(); } catch (Exception ignored) { frame.close(); processing = false; return; }
        frame.close();
        scanner.process(InputImage.fromBitmap(bitmap, rotation)).addOnCompleteListener(task -> {
            try {
                if (finished || !task.isSuccessful()) return;
                Set<String> candidates = new LinkedHashSet<>();
                for (Barcode code : task.getResult()) { String sku = SkuPolicy.decode(code.getRawValue()); if (sku != null) candidates.add(sku); }
                if (candidates.size() != 1) { stable = 0; lastSku = ""; if (candidates.size() > 1) message.setText("画面中有多个编码，请只对准一个 SKU 码。"); return; }
                String sku = candidates.iterator().next(); long now = android.os.SystemClock.elapsedRealtime();
                stable = sku.equals(lastSku) && now - lastScan < 1800 ? stable + 1 : 1; lastSku = sku; lastScan = now;
                if (stable >= 2) deliver(sku);
            } finally { bitmap.recycle(); processing = false; }
        });
    }
    private void takePicture() {
        if (capture == null || processing || finished) return;
        processing = true; shutter.setEnabled(false); message.setText("正在本机识别文字…");
        capture.takePicture(ContextCompat.getMainExecutor(this), new ImageCapture.OnImageCapturedCallback() {
            @Override public void onCaptureSuccess(ImageProxy frame) {
                if (finished) { frame.close(); return; }
                int rotation = frame.getImageInfo().getRotationDegrees(); Bitmap bitmap;
                try { bitmap = frame.toBitmap(); } catch (Exception ignored) { frame.close(); retryPhoto(); return; }
                frame.close();
                recognizer.process(InputImage.fromBitmap(bitmap, rotation)).addOnCompleteListener(task -> {
                    try {
                        if (finished) return;
                        if (!task.isSuccessful()) { retryPhoto(); return; }
                        String text = task.getResult().getText();
                        if (text.trim().isEmpty() || text.length() > 12000) { retryPhoto(); return; }
                        deliver(text);
                    } finally { bitmap.recycle(); processing = false; }
                });
            }
            @Override public void onError(ImageCaptureException error) { retryPhoto(); }
        });
    }
    private void retryPhoto() { processing = false; shutter.setEnabled(true); message.setText("未能清楚读取文字，请靠近、对焦后重新拍摄日期及其标签。"); }
    private void deliver(String value) {
        if (finished) return; finished = true;
        Intent result = new Intent(); result.putExtra("mode", scanMode ? "sku" : "date"); result.putExtra("value", value);
        setResult(RESULT_OK, result); finish();
    }
    @Override public void onDestroy() {
        finished = true; if (provider != null) provider.unbindAll(); analyzer.shutdownNow();
        if (scanner != null) scanner.close(); if (recognizer != null) recognizer.close(); super.onDestroy();
    }
}
