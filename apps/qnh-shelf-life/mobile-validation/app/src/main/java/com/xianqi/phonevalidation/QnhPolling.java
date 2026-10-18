package com.xianqi.phonevalidation;

/** Keep authentication checks, but stop frequent full inventory inspection while idle. */
public final class QnhPolling {
    private QnhPolling(){}
    public static long interval(boolean login,boolean inventory,boolean busy){return login?350:busy?350:inventory?2200:10000;}
}
