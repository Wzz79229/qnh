package com.xianqi.phonevalidation;
import android.app.*;
import android.content.*;
import android.net.Uri;
import android.provider.MediaStore;
import android.widget.Button;
import java.util.concurrent.atomic.AtomicReference;
/** Public Android UI only: also runs against the optimized, non-debuggable APK. */
final class ScannerReleaseCheck {
 private final Instrumentation test;
 ScannerReleaseCheck(Instrumentation value){test=value;}
 private static void check(boolean ok,String message){if(!ok)throw new AssertionError(message);}
 private void main(Runnable action)throws Exception{AtomicReference<Throwable> error=new AtomicReference<>();test.runOnMainSync(()->{try{action.run();}catch(Throwable e){error.set(e);}});if(error.get()!=null)throw new AssertionError(error.get());}
 private Activity open()throws Exception{Intent intent=new Intent(test.getTargetContext(),BarcodeScanActivity.class);intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);Activity scan=test.startActivitySync(intent);check(scan!=null,"Release scanner missing");return scan;}
 private String frames(Activity scan)throws Exception{AtomicReference<String> text=new AtomicReference<>("");for(int attempt=0;attempt<35;attempt++){Thread.sleep(350);main(()->{Button copy=scan.findViewById(android.R.id.content).findViewWithTag("scan-diagnostics");check(copy!=null,"Release diagnostic action missing");copy.performClick();ClipData data=((ClipboardManager)test.getTargetContext().getSystemService(Context.CLIPBOARD_SERVICE)).getPrimaryClip();if(data!=null)text.set(data.getItemAt(0).coerceToText(test.getTargetContext()).toString());});if(text.get().matches("(?s).*识别帧：[1-9][0-9]*×[1-9][0-9]* / [1-9][0-9]* 帧.*"))return text.get();}throw new AssertionError("Release received no raw frames: "+text.get());}
 void run()throws Exception{for(int i=0;i<2;i++){Activity scan=open();frames(scan);main(scan::finish);Thread.sleep(500);}Activity scan=open();String diagnostic=frames(scan);
  Instrumentation.ActivityMonitor photo=new Instrumentation.ActivityMonitor(){@Override public Instrumentation.ActivityResult onStartActivity(Intent intent){if(!MediaStore.ACTION_IMAGE_CAPTURE.equals(intent.getAction()))return null;try{Uri uri=intent.getParcelableExtra(MediaStore.EXTRA_OUTPUT);try(java.io.InputStream input=test.getContext().getAssets().open("release-scan-barcode.png");java.io.OutputStream out=test.getTargetContext().getContentResolver().openOutputStream(uri)){byte[] buffer=new byte[8192];for(int n;(n=input.read(buffer))!=-1;)out.write(buffer,0,n);}return new Instrumentation.ActivityResult(Activity.RESULT_OK,new Intent());}catch(Exception e){throw new AssertionError(e);}}};test.addMonitor(photo);main(()->((Button)scan.findViewById(android.R.id.content).findViewWithTag("scan-photo")).performClick());for(int i=0;i<50&&!scan.isFinishing();i++)Thread.sleep(200);test.removeMonitor(photo);check(scan.isFinishing()&&photo.getHits()==1,"Optimized photo barcode did not decode");android.util.Log.i("KuguanReleaseScan","Raw frames and complete barcode decoded; "+diagnostic.replace('\n',' '));
 }
}
