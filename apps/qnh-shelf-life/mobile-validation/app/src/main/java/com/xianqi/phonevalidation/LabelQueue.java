package com.xianqi.phonevalidation;
import java.util.*;
/** Generated labels in reverse creation order. Compressed PNGs survive queries and rotation. */
final class LabelQueue {
    static final class Item {final long id;final LabelBatch.Entry entry;Item(long id,LabelBatch.Entry entry){this.id=id;this.entry=entry;}}
    private String tenant="";private long sequence=0;private List<Item> entries=new ArrayList<>();
    int size(){return entries.size();}String tenant(){return tenant;}
    List<Item> items(){return Collections.unmodifiableList(new ArrayList<>(entries));}
    void clear(){entries.clear();tenant="";}
    void prepend(LabelBatch batch){
        if(!tenant.isEmpty()&&!tenant.equals(batch.tenant))throw new IllegalArgumentException("租户已变化，请重新查询商品。");
        List<Item> next=new ArrayList<>();for(int i=0;i<batch.size();i++)next.add(new Item(sequence+batch.size()-i,batch.get(i)));next.addAll(entries);
        List<LabelBatch.Entry> values=new ArrayList<>();for(Item item:next)values.add(item.entry);
        new LabelBatch(batch.tenant,values);entries=next;tenant=batch.tenant;sequence+=batch.size();
    }
    boolean remove(long id,String expected){if(!tenant.equals(expected))throw new IllegalArgumentException("租户已变化，请重新登录。");return entries.removeIf(item->item.id==id);}
    LabelBatch snapshot(String expected){if(!tenant.equals(expected)||entries.isEmpty())throw new IllegalArgumentException("尚未生成标签。");List<LabelBatch.Entry> values=new ArrayList<>();for(Item item:entries)values.add(item.entry);return new LabelBatch(tenant,values);}
}
