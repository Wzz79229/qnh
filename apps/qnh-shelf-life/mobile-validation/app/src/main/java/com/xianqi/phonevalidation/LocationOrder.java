package com.xianqi.phonevalidation;
import java.util.regex.*;
/** Natural ascending warehouse-location order: A10-1-2 precedes A10-1-10. */
final class LocationOrder {
    private static final Pattern PART=Pattern.compile("[0-9]+|[^0-9]+");
    static int compare(String left,String right){Matcher a=PART.matcher(left),b=PART.matcher(right);while(true){boolean x=a.find(),y=b.find();if(!x||!y)return x?1:y?-1:0;String l=a.group(),r=b.group();int order;if(Character.isDigit(l.charAt(0))&&Character.isDigit(r.charAt(0))){l=l.replaceFirst("^0+(?!$)","");r=r.replaceFirst("^0+(?!$)","");order=Integer.compare(l.length(),r.length());if(order==0)order=l.compareTo(r);}else order=l.compareToIgnoreCase(r);if(order!=0)return order;}}
}
