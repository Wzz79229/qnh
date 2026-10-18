package com.xianqi.phonevalidation;
import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.*;
import android.net.Uri;
import android.os.*;
import android.provider.*;
import android.util.Size;
import android.view.*;
import android.widget.*;
import androidx.camera.core.*;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.FileProvider;
import androidx.lifecycle.*;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.zxing.Result;
import java.io.File;
import java.util.concurrent.*;

/** CameraX handles device quirks, stream configuration, orientation and preview. */
public final class BarcodeScanActivity extends Activity implements LifecycleOwner {
    private final LifecycleRegistry lifecycle=new LifecycleRegistry(this);
    private final Handler main=new Handler(Looper.getMainLooper());
    private final ExecutorService worker=Executors.newSingleThreadExecutor(r->new Thread(r,"库管原始帧识别"));
    private final BarcodeDecoder decoder=new BarcodeDecoder();private final ScanConfirmation confirmation=new ScanConfirmation();
    private PreviewView preview;private TextView message;private Button light,retry,settings,photo,zoom;
    private ProcessCameraProvider provider;private androidx.camera.core.Camera camera;private ImageAnalysis analysis;
    private boolean resumed=false,done=false,opening=false,permissionRequested=false,torch=false,photoReady=false,photoDecoding=false;
    private volatile int generation=0;private volatile long lastFrame=0,lastAnalyzed=0,frameCount=0;private volatile int frameWidth=0,frameHeight=0;
    private String diagnostic="";private File photoFile;private float zoomRatio=1;
    @Override public Lifecycle getLifecycle(){return lifecycle;}
    @Override public void onCreate(Bundle saved){super.onCreate(saved);if(saved!=null){String path=saved.getString("scan-photo","");File candidate=new File(path);try{if(!path.isEmpty()&&candidate.getCanonicalFile().getParentFile().equals(new File(getCacheDir(),"labels").getCanonicalFile())&&candidate.getName().startsWith("scan-"))photoFile=candidate;}catch(Exception ignored){}}
        LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(0xff102b25);root.setOnApplyWindowInsetsListener((v,i)->{v.setPadding(0,i.getSystemWindowInsetTop(),0,i.getSystemWindowInsetBottom());return i;});
        message=new TextView(this);message.setText("对准条形码，可点画面对焦");message.setTextColor(Color.WHITE);message.setTextSize(16);message.setGravity(Gravity.CENTER);message.setPadding(16,18,16,18);root.addView(message);
        FrameLayout frame=new FrameLayout(this);preview=new PreviewView(this);preview.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);preview.setScaleType(PreviewView.ScaleType.FIT_CENTER);frame.addView(preview,new FrameLayout.LayoutParams(-1,-1));
        preview.setOnTouchListener((v,e)->{if(e.getAction()==MotionEvent.ACTION_UP){focus(e.getX(),e.getY());v.performClick();return true;}return true;});
        View guide=new View(this){final Paint p=new Paint(Paint.ANTI_ALIAS_FLAG);@Override protected void onDraw(Canvas c){p.setColor(0xccb5e7d0);p.setStyle(Paint.Style.STROKE);p.setStrokeWidth(3*getResources().getDisplayMetrics().density);c.drawRoundRect(getWidth()*.06f,getHeight()*.37f,getWidth()*.94f,getHeight()*.63f,14,14,p);}};frame.addView(guide,new FrameLayout.LayoutParams(-1,-1));root.addView(frame,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout tools=new LinearLayout(this);zoom=WarehouseUi.button(this,"放大 1×",false,v->changeZoom());zoom.setEnabled(false);tools.addView(zoom,new LinearLayout.LayoutParams(0,-2,1));light=WarehouseUi.button(this,"补光",false,v->toggleLight());light.setEnabled(false);tools.addView(light,new LinearLayout.LayoutParams(0,-2,1));root.addView(tools);
        LinearLayout helpers=new LinearLayout(this);retry=WarehouseUi.button(this,"重试相机",false,v->{closeCamera();done=false;confirmation.clear();lastFrame=0;if(hasPermission())open();else requestCamera();});retry.setTag("scan-retry");helpers.addView(retry,new LinearLayout.LayoutParams(0,-2,1));photo=WarehouseUi.button(this,"拍照扫码",false,v->takePhoto());photo.setTag("scan-photo");helpers.addView(photo,new LinearLayout.LayoutParams(0,-2,1));root.addView(helpers);
        settings=WarehouseUi.button(this,"相机权限设置",false,v->startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName()))));root.addView(settings);settings.setVisibility(View.GONE);
        LinearLayout buttons=new LinearLayout(this);buttons.setPadding(16,12,16,16);buttons.addView(WarehouseUi.button(this,"返回",false,v->finish()),new LinearLayout.LayoutParams(0,-2,1));Button copy=WarehouseUi.button(this,"复制诊断",false,v->{((ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("库管扫码诊断",diagnostic()));Toast.makeText(this,"已复制诊断，不包含账号或条码内容",Toast.LENGTH_SHORT).show();});copy.setTag("scan-diagnostics");buttons.addView(copy,new LinearLayout.LayoutParams(0,-2,1));root.addView(buttons);setContentView(root);lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_CREATE);
        preview.getPreviewStreamState().observe(this,state->{if(state==PreviewView.StreamState.STREAMING&&resumed){retry.setVisibility(View.GONE);settings.setVisibility(View.GONE);focus(preview.getWidth()/2f,preview.getHeight()/2f);}});
    }
    private boolean hasPermission(){return checkSelfPermission(Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED;}
    private void requestCamera(){settings.setVisibility(View.VISIBLE);message.setText("扫码需要相机权限，请允许使用相机。");if(!permissionRequested||shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)){permissionRequested=true;requestPermissions(new String[]{Manifest.permission.CAMERA},61);}}
    @Override protected void onStart(){super.onStart();lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START);}
    @Override protected void onResume(){super.onResume();lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_RESUME);resumed=true;done=false;confirmation.clear();lastAnalyzed=0;if(photoReady&&photoFile!=null){decodePhoto();return;}if(!hasPermission())requestCamera();else open();}
    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] grants){super.onRequestPermissionsResult(code,permissions,grants);if(code==61){if(hasPermission())open();else{message.setText("相机权限未允许，可在设置中开启后重试。");settings.setVisibility(View.VISIBLE);}}}
    private void open(){if(!resumed||done||opening||camera!=null||photoReady||photoDecoding)return;if(!hasPermission()){requestCamera();return;}int ticket=generation;opening=true;message.setText("正在启动扫码相机…");
        ListenableFuture<ProcessCameraProvider> future=ProcessCameraProvider.getInstance(this);future.addListener(()->{if(!resumed||ticket!=generation)return;try{provider=future.get();provider.unbindAll();int rotation=getWindowManager().getDefaultDisplay().getRotation();Preview stream=new Preview.Builder().setTargetRotation(rotation).build();stream.setSurfaceProvider(preview.getSurfaceProvider());
            analysis=new ImageAnalysis.Builder().setTargetResolution(new Size(1280,960)).setMaxResolution(new Size(1920,1440)).setTargetRotation(rotation).setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888).build();analysis.setAnalyzer(worker,this::analyze);
            camera=provider.bindToLifecycle(this,CameraSelector.DEFAULT_BACK_CAMERA,stream,analysis);opening=false;light.setEnabled(camera.getCameraInfo().hasFlashUnit());zoom.setEnabled(true);zoomRatio=1;camera.getCameraControl().setZoomRatio(zoomRatio);message.setText("对准条形码，可点画面对焦；较小条码可放大");
            camera.getCameraInfo().getCameraState().observe(this,state->{CameraState.StateError error=state.getError();if(error!=null&&resumed&&ticket==generation)failure("相机状态异常（"+error.getCode()+"）",error.getCause());});
            main.postDelayed(()->{if(resumed&&ticket==generation&&lastFrame==0)failure("相机尚未返回识别画面，可重试或拍照扫码",null);},8000);
        }catch(Exception error){opening=false;failure("扫码相机未能启动",error);}},androidx.core.content.ContextCompat.getMainExecutor(this));
    }
    private void analyze(ImageProxy image){int ticket=generation;long now=SystemClock.elapsedRealtime();try{lastFrame=now;frameCount++;frameWidth=image.getWidth();frameHeight=image.getHeight();if(!resumed||done||photoDecoding||now-lastAnalyzed<180)return;lastAnalyzed=now;ImageProxy.PlaneProxy plane=image.getPlanes()[0];byte[] bytes=BarcodeDecoder.luminance(plane.getBuffer(),plane.getRowStride(),plane.getPixelStride(),image.getWidth(),image.getHeight());Result value=decoder.decode(bytes,image.getWidth(),image.getHeight());main.post(()->{if(!resumed||done||ticket!=generation)return;if(confirmation.observe(value==null?null:value.getBarcodeFormat()+":"+value.getText(),now))complete(value);});}catch(Exception error){main.post(()->{if(resumed&&ticket==generation)failure("无法识别相机原始画面",error);});}finally{image.close();}}
    private void complete(Result value){if(value==null||done)return;done=true;setResult(RESULT_OK,new Intent().putExtra("value",value.getText()).putExtra("format",value.getBarcodeFormat().name()));finish();}
    private void focus(float x,float y){if(camera==null||preview.getWidth()==0)return;try{MeteringPoint point=preview.getMeteringPointFactory().createPoint(x,y);camera.getCameraControl().startFocusAndMetering(new FocusMeteringAction.Builder(point,FocusMeteringAction.FLAG_AF|FocusMeteringAction.FLAG_AE).setAutoCancelDuration(3,TimeUnit.SECONDS).build());}catch(Exception ignored){}}
    private void changeZoom(){if(camera==null)return;ZoomState state=camera.getCameraInfo().getZoomState().getValue();if(state==null)return;float next=zoomRatio<1.4f?1.5f:zoomRatio<1.9f?2f:1f;zoomRatio=Math.min(state.getMaxZoomRatio(),Math.max(state.getMinZoomRatio(),next));camera.getCameraControl().setZoomRatio(zoomRatio);zoom.setText("放大 "+zoomRatio+"×");focus(preview.getWidth()/2f,preview.getHeight()/2f);}
    private void toggleLight(){if(camera==null||!camera.getCameraInfo().hasFlashUnit())return;torch=!torch;camera.getCameraControl().enableTorch(torch);light.setText(torch?"关闭补光":"补光");}
    private void takePhoto(){if(!hasPermission()){requestCamera();return;}try{closeCamera();File folder=new File(getCacheDir(),"labels");if(!folder.exists()&&!folder.mkdirs())throw new java.io.IOException("临时目录不可用");photoFile=File.createTempFile("scan-",".jpg",folder);Uri uri=FileProvider.getUriForFile(this,getPackageName()+".labels",photoFile);Intent intent=new Intent(MediaStore.ACTION_IMAGE_CAPTURE);intent.putExtra(MediaStore.EXTRA_OUTPUT,uri);intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_READ_URI_PERMISSION);intent.setClipData(ClipData.newRawUri("扫码临时照片",uri));startActivityForResult(intent,79);}catch(Exception error){deletePhoto();failure("无法打开系统相机",error);}}
    @Override public void onActivityResult(int code,int result,Intent data){super.onActivityResult(code,result,data);if(code==79){photoReady=result==RESULT_OK&&photoFile!=null&&photoFile.length()>0;if(!photoReady)deletePhoto();else if(resumed)decodePhoto();}}
    private void decodePhoto(){File file=photoFile;photoReady=false;photoDecoding=true;message.setText("正在本机识别条码，照片不会保存或上传…");int ticket=generation;worker.execute(()->{Result found=null;Bitmap bitmap=null;try{BitmapFactory.Options bounds=new BitmapFactory.Options();bounds.inJustDecodeBounds=true;BitmapFactory.decodeFile(file.getPath(),bounds);if(bounds.outWidth<1||bounds.outHeight<1||file.length()>30L*1024*1024)throw new IllegalArgumentException();BitmapFactory.Options options=new BitmapFactory.Options();options.inPreferredConfig=Bitmap.Config.RGB_565;options.inSampleSize=1;while((long)(bounds.outWidth/options.inSampleSize)*(bounds.outHeight/options.inSampleSize)>1280L*960)options.inSampleSize*=2;bitmap=BitmapFactory.decodeFile(file.getPath(),options);if(bitmap!=null){int w=bitmap.getWidth(),h=bitmap.getHeight();int[] pixels=new int[w*h];bitmap.getPixels(pixels,0,w,0,0,w,h);found=decoder.decode(BarcodeDecoder.rgb(pixels,w,h),w,h);}}catch(Exception error){diagnostic=error.getClass().getSimpleName();}finally{if(bitmap!=null)bitmap.recycle();file.delete();}Result value=found;main.post(()->{if(ticket!=generation||!resumed)return;photoFile=null;photoDecoding=false;if(value!=null)complete(value);else{message.setText("未识别到清晰条码，请靠近条码重新拍照，或重试实时扫码。");retry.setVisibility(View.VISIBLE);}});});}
    private void deletePhoto(){if(photoFile!=null)photoFile.delete();photoFile=null;photoReady=false;}
    private String diagnostic(){return "库管 0.8.3 / CameraX 1.4.2\n设备："+Build.MANUFACTURER+" "+Build.MODEL+" / Android "+Build.VERSION.RELEASE+"\n识别帧："+frameWidth+"×"+frameHeight+" / "+frameCount+" 帧\n相机权限："+hasPermission()+"\n诊断："+diagnostic;}
    private void failure(String value,Throwable error){diagnostic=error==null?value:error.getClass().getSimpleName()+": "+String.valueOf(error.getMessage());if(diagnostic.length()>240)diagnostic=diagnostic.substring(0,240);android.util.Log.w("KuguanCamera",diagnostic);if(!resumed||isFinishing())return;message.setText(value+"。可重试或拍照扫码。");retry.setVisibility(View.VISIBLE);settings.setVisibility(View.VISIBLE);}
    private void closeCamera(){generation++;opening=false;light.setEnabled(false);zoom.setEnabled(false);if(analysis!=null){analysis.clearAnalyzer();analysis=null;}if(provider!=null)provider.unbindAll();camera=null;torch=false;}
    @Override protected void onSaveInstanceState(Bundle state){if(photoFile!=null)state.putString("scan-photo",photoFile.getPath());super.onSaveInstanceState(state);}
    @Override protected void onPause(){resumed=false;photoDecoding=false;closeCamera();lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE);super.onPause();}
    @Override protected void onStop(){lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_STOP);super.onStop();}
    @Override protected void onDestroy(){if(isFinishing())deletePhoto();lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY);worker.shutdown();super.onDestroy();}
}
