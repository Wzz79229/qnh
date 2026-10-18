package com.xianqi.phonevalidation;
import org.junit.Test;
import static org.junit.Assert.*;
import java.io.*;
import java.nio.file.Files;
import java.util.*;
public class LabelBatchTest {
    private LabelBatch.Entry entry(String sku,String loc,byte...png){return new LabelBatch.Entry(LabelContent.create("合成测试商品","500ml",sku,loc),"合成测试仓",png);}
    @Test public void everySelectedImageRemainsSeparateEvenWithSameSku()throws Exception{LabelBatch b=new LabelBatch("777",List.of(entry("000123","A1",(byte)1),entry("000123","A1",(byte)2),entry("2110000000000198822","A2",(byte)3)));File folder=Files.createTempDirectory("labels-test").toFile();try{List<File> files=b.writeImages(folder);assertEquals(3,files.size());Set<String> names=new HashSet<>();for(int i=0;i<3;i++){assertTrue(names.add(files.get(i).getName()));assertArrayEquals(new byte[]{(byte)(i+1)},Files.readAllBytes(files.get(i).toPath()));assertTrue(files.get(i).getName().endsWith(".png"));assertEquals(folder.getCanonicalFile(),files.get(i).getCanonicalFile().getParentFile());}assertTrue(b.imageName(0).contains("000123"));}finally{for(File f:Objects.requireNonNull(folder.listFiles()))assertTrue(f.delete());assertTrue(folder.delete());}}
    @Test public void invalidScopeAndUnboundedBatchAreRejected(){for(String scope:new String[]{"","0","../777"})try{new LabelBatch(scope,List.of(entry("123","A1",(byte)1)));fail();}catch(IllegalArgumentException expected){}try{new LabelBatch("777",Collections.nCopies(LabelBatch.MAX_ITEMS+1,entry("123","A1",(byte)1)));fail();}catch(IllegalArgumentException expected){}try{new LabelBatch("777",List.of());fail();}catch(IllegalArgumentException expected){}}
}
