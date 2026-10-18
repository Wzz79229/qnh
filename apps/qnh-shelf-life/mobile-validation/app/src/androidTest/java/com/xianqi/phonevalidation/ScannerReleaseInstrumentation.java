package com.xianqi.phonevalidation;

import android.app.Activity;
import android.app.Instrumentation;
import android.os.Bundle;

/** Independent entry point: never links unminified internal production classes. */
public final class ScannerReleaseInstrumentation extends Instrumentation {
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    @Override public void onStart() {
        Bundle report = new Bundle();
        try {
            new ScannerReleaseCheck(this).run();
            report.putString("stream", "CHECKS PASSED: optimized APK CameraX raw frames, reopen lifecycle, system-photo full SKU decoding.\n");
            finish(Activity.RESULT_OK, report);
        } catch (Throwable error) {
            android.util.Log.e("KuguanReleaseScan", "Release verification failed", error);
            report.putString("stream", "CHECKS FAILED: " + error + "\n");
            finish(Activity.RESULT_CANCELED, report);
        }
    }
}
