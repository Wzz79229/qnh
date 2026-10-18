package com.xianqi.phonevalidation;

import org.junit.Test;
import static org.junit.Assert.*;

public class QnhGateTest {
    @Test public void launchAndSingleObservationCannotOpenFeatures(){QnhGate gate=new QnhGate();assertFalse(gate.verified());assertEquals("",gate.tenant());assertFalse(gate.observe(true,"12345"));assertFalse(gate.verified());assertTrue(gate.observe(true,"12345"));assertEquals("12345",gate.tenant());}
    @Test public void logoutAndBackgroundClearTheVerifiedIdentity(){QnhGate gate=new QnhGate();gate.observe(true,"12345");gate.observe(true,"12345");assertFalse(gate.observe(false,"12345"));assertEquals("",gate.tenant());gate.observe(true,"12345");gate.observe(true,"12345");gate.clear();assertFalse(gate.verified());assertFalse(gate.observe(true,"12345"));}
    @Test public void changingTenantRequiresFreshConsistentObservations(){QnhGate gate=new QnhGate();gate.observe(true,"12345");gate.observe(true,"12345");assertFalse(gate.observe(true,"67890"));assertEquals("",gate.tenant());assertTrue(gate.observe(true,"67890"));assertEquals("67890",gate.tenant());assertFalse(gate.observe(true,"not-a-tenant"));assertFalse(gate.observe(true,"67890"));}
}
