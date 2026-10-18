package com.xianqi.phonevalidation;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.widget.LinearLayout;
import android.widget.NumberPicker;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** User-initiated local printing to a paired classic Bluetooth TSPL printer. No device scanning. */
@SuppressLint("MissingPermission")
final class BluetoothLabelPrinter {
    interface Host {boolean allowed(String tenant,LabelContent content);void message(String text);}
    private static final int PERMISSION=6101,ENABLE=6102;
    private static final UUID SPP=UUID.fromString("00001101-0000-1000-8000-00805f9b34fb");
    private final Activity activity;private final Host host;private final SharedPreferences preferences;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();private final ScheduledExecutorService timer=Executors.newSingleThreadScheduledExecutor();private final Handler main=new Handler(Looper.getMainLooper());
    private volatile BluetoothSocket socket;private int socketTicket=0;private volatile int generation=0;private volatile boolean closed=false;private boolean busy=false;
    private LabelContent content;private String tenant="";private AlertDialog dialog,progress;
    BluetoothLabelPrinter(Activity activity,Host host){this.activity=activity;this.host=host;preferences=activity.getSharedPreferences("label-printer",Context.MODE_PRIVATE);}
    void print(LabelContent value,String scope){if(closed||busy){host.message("正在发送上一张标签，请稍候。");return;}content=value;tenant=scope;prepare();}
    private boolean allowed(){return !closed&&content!=null&&host.allowed(tenant,content);}
    private void prepare(){if(!allowed())return;
        if(Build.VERSION.SDK_INT>=31&&activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)!=PackageManager.PERMISSION_GRANTED){activity.requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT},PERMISSION);return;}
        BluetoothAdapter adapter=adapter();if(adapter==null){host.message("此手机不支持蓝牙，可使用系统打印或分享图片。");return;}
        if(!adapter.isEnabled()){try{activity.startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE),ENABLE);}catch(Exception error){host.message("请在手机设置中打开蓝牙后再打印。");}return;}
        choose(adapter,false);
    }
    private BluetoothAdapter adapter(){BluetoothManager manager=activity.getSystemService(BluetoothManager.class);return manager==null?null:manager.getAdapter();}
    private void choose(BluetoothAdapter adapter,boolean change){if(!allowed())return;ArrayList<BluetoothDevice> devices=new ArrayList<>(adapter.getBondedDevices());devices.sort(Comparator.comparing(d->name(d).toLowerCase(java.util.Locale.ROOT)));
        if(devices.isEmpty()){dialog=new AlertDialog.Builder(activity).setTitle("尚未配对打印机").setMessage("请先在手机系统蓝牙设置中配对 DL-720W(NEW)，再返回库管打印。").setPositiveButton("打开蓝牙设置",(d,w)->activity.startActivity(new Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS))).setNegativeButton("取消",null).show();return;}
        String saved=preferences.getString("address","");if(!change)for(BluetoothDevice device:devices)if(device.getAddress().equals(saved)){confirm(device);return;}
        String[] labels=new String[devices.size()];for(int i=0;i<labels.length;i++){BluetoothDevice d=devices.get(i);labels[i]=name(d)+"\n"+d.getAddress();}
        dialog=new AlertDialog.Builder(activity).setTitle("选择已配对的得力打印机").setItems(labels,(d,index)->confirm(devices.get(index))).setNegativeButton("取消",null).show();
    }
    private static String name(BluetoothDevice device){String name=device.getName();return name==null||name.isEmpty()?"蓝牙设备":name;}
    private void confirm(BluetoothDevice device){if(!allowed())return;LinearLayout box=new LinearLayout(activity);box.setOrientation(LinearLayout.VERTICAL);int p=WarehouseUi.dp(activity,20);box.setPadding(p,p,p,p);
        box.addView(WarehouseUi.text(activity,name(device)+"\n80 × 60 毫米 · 库位 "+content.location,15,WarehouseUi.INK,true));WarehouseUi.space(box,12);box.addView(WarehouseUi.text(activity,"打印份数（首次建议1张）",13,WarehouseUi.MUTED,false));NumberPicker copies=new NumberPicker(activity);copies.setMinValue(1);copies.setMaxValue(20);copies.setValue(1);copies.setWrapSelectorWheel(false);box.addView(copies,new LinearLayout.LayoutParams(-1,WarehouseUi.dp(activity,110)));
        box.addView(WarehouseUi.text(activity,"标签间隙（毫米，0为连续纸）",13,WarehouseUi.MUTED,false));NumberPicker gap=new NumberPicker(activity);gap.setMinValue(0);gap.setMaxValue(5);gap.setValue(preferences.getInt("gap",2));gap.setWrapSelectorWheel(false);box.addView(gap,new LinearLayout.LayoutParams(-1,WarehouseUi.dp(activity,100)));
        dialog=new AlertDialog.Builder(activity).setTitle("得力720W · 蓝牙打印").setView(box).setPositiveButton("打印",(d,w)->{if(!allowed())return;preferences.edit().putString("address",device.getAddress()).putInt("gap",gap.getValue()).apply();start(device,content,tenant,copies.getValue(),gap.getValue());}).setNeutralButton("更换打印机",(d,w)->choose(adapter(),true)).setNegativeButton("取消",null).show();
    }
    private void start(BluetoothDevice device,LabelContent label,String scope,int copies,int gap){busy=true;int ticket=++generation;progress=new AlertDialog.Builder(activity).setTitle("正在发送标签").setMessage("正在连接打印机并发送，请稍候。").setCancelable(false).setNegativeButton("停止发送",(d,w)->{generation++;closeSocket();busy=false;host.message("已停止发送。请先检查打印机是否已出纸，再重试。");}).show();
        worker.execute(()->{Bitmap bitmap=null;try{bitmap=LocationLabelRenderer.renderFor720W(label);final Bitmap image=bitmap;byte[] bytes=TsplLabelJob.encode(copies,gap,(y,row)->image.getPixels(row,0,640,0,y,640,1));bitmap.recycle();bitmap=null;
            main.post(()->{if(closed||ticket!=generation)return;if(!host.allowed(scope,label)){finish(ticket,"登录或商品已变化，请重新核对标签后打印。");return;}worker.execute(()->send(device,bytes,ticket));});
        }catch(Exception error){if(bitmap!=null&&!bitmap.isRecycled())bitmap.recycle();main.post(()->finish(ticket,error instanceof IllegalArgumentException?error.getMessage():"标签生成未完成，请重试。"));}});
    }
    private void send(BluetoothDevice device,byte[] bytes,int ticket){if(closed||ticket!=generation)return;AtomicBoolean timeout=new AtomicBoolean(false),writing=new AtomicBoolean(false);ScheduledFuture<?> deadline=timer.schedule(()->{if(ticket==generation){timeout.set(true);closeSocket(ticket);}},20,TimeUnit.SECONDS);
        try{if(ticket!=generation)return;BluetoothSocket next=device.createRfcommSocketToServiceRecord(SPP);if(!install(next,ticket))return;
            try{next.connect();}catch(IOException first){closeSocket(ticket);if(timeout.get()||ticket!=generation)throw first;next=device.createInsecureRfcommSocketToServiceRecord(SPP);if(!install(next,ticket))return;next.connect();}
            if(ticket!=generation||timeout.get())throw new IOException();OutputStream out=next.getOutputStream();for(int offset=0;offset<bytes.length;offset+=1024){if(ticket!=generation||timeout.get())throw new IOException();writing.set(true);out.write(bytes,offset,Math.min(1024,bytes.length-offset));}out.flush();Thread.sleep(300);
            main.post(()->finish(ticket,"标签已发送到打印机，请检查是否正常出纸。"));
        }catch(Exception error){String text=writing.get()?"发送中断，请先检查打印机是否已出纸，再重试。":timeout.get()?"蓝牙连接超时，请确认打印机已开机、空闲且在附近。":"蓝牙连接未成功。请确认已在系统蓝牙中配对720W，且未被其他App占用。";main.post(()->finish(ticket,text));}
        finally{deadline.cancel(false);closeSocket(ticket);}
    }
    private synchronized boolean install(BluetoothSocket value,int ticket)throws IOException{if(closed||ticket!=generation){value.close();return false;}socket=value;socketTicket=ticket;return true;}
    private synchronized void closeSocket(int ticket){if(socketTicket==ticket)closeSocket();}
    private synchronized void closeSocket(){BluetoothSocket current=socket;socket=null;if(current!=null)try{current.close();}catch(IOException ignored){}}
    private void finish(int ticket,String message){if(closed||ticket!=generation)return;busy=false;if(progress!=null){progress.dismiss();progress=null;}host.message(message);}
    boolean activityResult(int request,int result){if(request!=ENABLE)return false;if(result==Activity.RESULT_OK)prepare();else host.message("蓝牙未开启，未发送标签。");return true;}
    void permissionsResult(int request,int[] results){if(request!=PERMISSION)return;if(results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED)prepare();else host.message("未获得附近设备权限，未发送标签。可在手机设置中允许库管连接蓝牙设备。");}
    void destroy(){closed=true;generation++;closeSocket();worker.shutdownNow();timer.shutdownNow();main.removeCallbacksAndMessages(null);if(dialog!=null)dialog.dismiss();if(progress!=null)progress.dismiss();}
}
