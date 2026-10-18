package com.xianqi.phonevalidation;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/** Compressed images only: a batch never retains one bitmap per product. */
final class LabelBatch {
    static final int MAX_ITEMS=50;
    static final class Entry {
        final LabelContent content;final String store;final byte[] png;
        Entry(LabelContent content,String store,byte[] png){if(content==null||png==null||png.length==0)throw new IllegalArgumentException("标签图片不完整。");this.content=content;this.store=store;this.png=png;}
    }
    final String tenant;
    private final List<Entry> entries;
    LabelBatch(String tenant,List<Entry> entries){
        if(tenant==null||!tenant.matches("[1-9][0-9]{0,19}")||entries==null||entries.isEmpty()||entries.size()>MAX_ITEMS)throw new IllegalArgumentException("每批请选择1至50个商品与库位。");
        long bytes=0;for(Entry entry:entries){if(entry==null)throw new IllegalArgumentException("标签图片不完整。");bytes+=entry.png.length;}if(bytes>16*1024*1024)throw new IllegalArgumentException("本批图片过大，请减少所选商品。");
        this.tenant=tenant;this.entries=Collections.unmodifiableList(new ArrayList<>(entries));
    }
    int size(){return entries.size();}
    Entry get(int index){return entries.get(index);}
    String imageName(int index){return String.format(Locale.ROOT,"%03d_%s",index+1,get(index).content.fileName());}
    List<File> writeImages(File folder)throws IOException{
        if(!folder.mkdirs()&&!folder.isDirectory())throw new IOException("图片目录创建失败。");List<File> files=new ArrayList<>();
        for(int i=0;i<size();i++){if(Thread.currentThread().isInterrupted())throw new IOException("已取消导出。");File file=new File(folder,imageName(i));try(OutputStream out=new FileOutputStream(file)){out.write(get(i).png);}files.add(file);}return files;
    }
}
