package com.xianqi.phonevalidation;
import org.junit.Test;
import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
public class TsplLabelJobTest {
    @Test public void framesExactPhysicalSizeAndRawBitmapWithWhitePadding(){byte[] job=TsplLabelJob.encode(2,3,(y,row)->{Arrays.fill(row,0xffffffff);if(y==0){row[0]=0xff000000;row[7]=0xff000000;row[8]=0xff000000;}});String head="SIZE 80 mm,60 mm\r\nGAP 3 mm,0 mm\r\nDIRECTION 1,0\r\nREFERENCE 0,0\r\nOFFSET 0 mm\r\nCLS\r\nBITMAP 0,0,80,480,0,";byte[] prefix=head.getBytes(StandardCharsets.US_ASCII);assertArrayEquals(prefix,Arrays.copyOf(job,prefix.length));assertEquals(0x7e,job[prefix.length]&255);assertEquals(0x7f,job[prefix.length+1]&255);assertEquals(255,job[prefix.length+2]&255);assertEquals(255,job[prefix.length+80]&255);String end="\r\nPRINT 1,2\r\n";assertEquals(prefix.length+80*480+end.length(),job.length);assertEquals(end,new String(job,prefix.length+80*480,end.length(),StandardCharsets.US_ASCII));}
    @Test public void invalidJobsNeverReadOrSendPixels(){for(int[] args:new int[][]{{0,2},{21,2},{1,-1},{1,6}})try{TsplLabelJob.encode(args[0],args[1],(y,row)->fail("Invalid job rendered pixels"));fail();}catch(IllegalArgumentException expected){}}
}
