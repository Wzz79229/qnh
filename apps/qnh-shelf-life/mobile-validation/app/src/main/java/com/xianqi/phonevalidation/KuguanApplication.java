package com.xianqi.phonevalidation;

import android.app.Activity;
import android.app.Application;
import android.os.Bundle;

public final class KuguanApplication extends Application implements Application.ActivityLifecycleCallbacks, androidx.camera.core.CameraXConfig.Provider {
    private int started=0;
    @Override public void onCreate(){super.onCreate();LabelFonts.initialize(getAssets());registerActivityLifecycleCallbacks(this);}
    @Override public androidx.camera.core.CameraXConfig getCameraXConfig(){return androidx.camera.camera2.Camera2Config.defaultConfig();}
    @Override public void onActivityStarted(Activity activity){started++;QnhConnection.get(this).foreground(true);}
    @Override public void onActivityStopped(Activity activity){started=Math.max(0,started-1);if(started==0&&!activity.isChangingConfigurations())QnhConnection.get(this).foreground(false);}
    @Override public void onActivityDestroyed(Activity activity){QnhConnection.get(this).releaseHost(activity);}
    @Override public void onActivityCreated(Activity activity,Bundle state){}
    @Override public void onActivityResumed(Activity activity){}
    @Override public void onActivityPaused(Activity activity){}
    @Override public void onActivitySaveInstanceState(Activity activity,Bundle state){}
    @Override public void onTrimMemory(int level){super.onTrimMemory(level);QnhConnection.get(this).trimMemory(level);}
}
