package com.labpracticeapp.diagnostics

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.facebook.react.bridge.*
import me.impa.icmpenguin.ProbeResult
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class LibraryProbeTest {
    private class Reply {
        val latch = CountDownLatch(1)
        var result: ReadableMap? = null
        var error: ReadableMap? = null
        val promise = PromiseImpl(
            Callback { args -> result = args[0] as ReadableMap; latch.countDown() },
            Callback { args -> error = args[0] as ReadableMap; latch.countDown() })
        fun await() { assertTrue("Library callback did not settle", latch.await(55, TimeUnit.SECONDS)); assertNull(error) }
    }
    private fun context() = BridgeReactContext(ApplicationProvider.getApplicationContext())
    @Test fun libraryIcmpReturnsActualHeaderAndPayloadOnIpv4AndIpv6() {
        val module = LibraryIcmpModule(context())
        try {
            for (host in listOf("127.0.0.1", "::1")) {
                val reply = Reply(); val payload = "X".repeat(64)
                module.ping("loopback-$host", host, 2000, payload, reply.promise);reply.await()
                assertEquals("complete", reply.result!!.getString("reason"))
                val raw = reply.result!!.getMap("result")!!.getMap("rawResult")!!
                assertEquals("Success", raw.getString("variant"))
                val bytes = android.util.Base64.decode(raw.getString("dataBase64"), android.util.Base64.DEFAULT)
                assertEquals(72, bytes.size)
                assertEquals(if (host == "::1") 129 else 0, bytes[0].toInt() and 255)
                assertEquals(payload, String(bytes.copyOfRange(8, bytes.size), Charsets.US_ASCII))
            }
        } finally { module.invalidate() }
    }
    @Test fun udpTracerouteLoopbackUsesLibraryResults() {
        val module = TracerouteModule(context())
        try {
            val reply = Reply();module.trace("trace-loopback", "127.0.0.1", 2, 3, reply.promise);reply.await()
            val samples = reply.result!!.getArray("samples")!!
            assertTrue(samples.size() > 0)
            assertEquals("ConnectionRefused", samples.getMap(0)!!.getMap("rawResult")!!.getString("variant"))
            assertTrue(samples.getMap(0)!!.isNull("icmpType"))
        } finally { module.invalidate() }
    }
    @Test fun netErrorOriginIsNotMisreportedAsIcmpType() {
        val row = encodeLibraryProbe(1, ProbeResult.NetError(0,"127.0.0.1",32,28,"127.0.0.1",113,0,2,0))
        assertNull(row["icmpType"]);assertNull(row["icmpCode"])
        assertEquals(2,(row["rawResult"] as Map<*,*>)["errType"])
    }
    @Test fun cancellationSettlesAndAllowsAnotherCall() {
        val module = LibraryIcmpModule(context())
        try {
            val first = Reply();module.ping("cancel", "192.0.2.1", 2000, "X".repeat(64), first.promise)
            module.cancel("cancel");first.await()
            assertEquals("cancelled",first.result!!.getString("reason"))
            val next = Reply();module.ping("after-cancel", "127.0.0.1", 2000, "X".repeat(64), next.promise);next.await()
            assertEquals("complete", next.result!!.getString("reason"))
        } finally { module.invalidate() }
    }
}
