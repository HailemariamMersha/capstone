package com.labpracticeapp.diagnostics

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.core.app.ApplicationProvider
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.PromiseImpl
import java.util.concurrent.CountDownLatch
import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Local sockets only. Exercises real recvmsg/error-queue/header behavior, not mocked metrics. */
@RunWith(AndroidJUnit4::class)
class PacketEngineTest {
    private val payload = "43617073746f6e655061636b657454657374" // CapstonePacketTest
    private fun probe(protocol: String, port: Int = 0, host: String = "127.0.0.1", ttl: Int = 64): JSONObject {
        val id = "test-${System.nanoTime()}"
        assertTrue(PacketEngine.begin(id))
        return try { JSONObject(PacketEngine.probe(id, host, protocol, port, ttl, 17, payload, 1500)) }
        finally { PacketEngine.end(id) }
    }
    @Test fun icmpReplyContainsRealHeaderAndPayload() {
        val result = probe("icmp")
        assertEquals(result.toString(), "reply", result.getString("outcome"))
        val response = result.getJSONObject("response")
        assertEquals(0, response.getInt("icmpType"))
        assertEquals(0, response.getInt("icmpCode"))
        assertEquals(17, response.getInt("icmpSequence"))
        assertEquals(result.getInt("localPort"), response.getInt("icmpIdentifier"))
        assertTrue(response.getString("receivedHex").endsWith(payload))
        assertTrue(response.getInt("replyTtl") > 0)
        assertTrue(response.getLong("elapsedUs") >= 0)
        assertTrue(response.getString("kernelReceiveRealtimeNs").toLong() > 0)
    }
    @Test fun udpClosedPortPreservesOriginalIcmpTypeCodeAndPayload() {
        val port = DatagramSocket(0, InetAddress.getLoopbackAddress()).use { it.localPort }
        val result = probe("udp", port)
        assertEquals(result.toString(), "icmp_error", result.getString("outcome"))
        val response = result.getJSONObject("response")
        assertEquals(3, response.getInt("icmpType"))
        assertEquals(3, response.getInt("icmpCode"))
        assertEquals(2, response.getJSONObject("extendedError").getInt("origin"))
        assertEquals("127.0.0.1", response.getString("responderAddress"))
        assertEquals(payload, response.getString("receivedHex"))
    }
    @Test fun ipv6IcmpReplyAndErrorQueueKeepIpv6Codes() {
        val echo = probe("icmp", host = "::1")
        assertEquals(echo.toString(), "reply", echo.getString("outcome"))
        assertEquals(129, echo.getJSONObject("response").getInt("icmpType"))
        val port = DatagramSocket(0, InetAddress.getByName("::1")).use { it.localPort }
        val error = probe("udp", port, "::1")
        assertEquals(error.toString(), "icmp_error", error.getString("outcome"))
        assertEquals(1, error.getJSONObject("response").getInt("icmpType"))
        assertEquals(4, error.getJSONObject("response").getInt("icmpCode"))
    }
    @Test fun udpEchoMatchesExactPayloadAndTimeoutKeepsSendEvidence() {
        DatagramSocket(0, InetAddress.getByName("127.0.0.1")).use { server ->
            server.soTimeout = 3000
            val executor = Executors.newSingleThreadExecutor()
            try {
                val echo = executor.submit { val packet = DatagramPacket(ByteArray(2048), 2048); server.receive(packet); server.send(packet) }
                val result = probe("udp", server.localPort)
                assertEquals(result.toString(), "reply", result.getString("outcome"))
                assertEquals(payload, result.getJSONObject("response").getString("receivedHex"))
                echo.get(3, TimeUnit.SECONDS)
                val timeout = probe("udp", server.localPort)
                assertEquals("timeout", timeout.getString("outcome"))
                assertEquals(payload, timeout.getString("sendBufferHex"))
                assertFalse(timeout.has("response"))
            } finally { executor.shutdownNow() }
        }
    }
    @Test fun tcpCollectsKernelInfoWithoutClaimingCapturedSegments() {
        ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { server ->
            val result = probe("tcp", server.localPort)
            assertEquals(result.toString(), "connected", result.getString("outcome"))
            val info = result.getJSONObject("tcpInfoAfter")
            assertTrue(info.getInt("returnedBytes") > 0)
            assertEquals(1, info.getInt("tcpi_state"))
            assertTrue(info.has("tcpi_rtt"))
            assertFalse(result.getBoolean("packetCapture"))
            server.accept().close()
        }
    }
    @Test fun bridgeResolvesIpv6AndReleasesBeforeNextPromise() {
        val module = PacketProbeModule(BridgeReactContext(ApplicationProvider.getApplicationContext()))
        try {
            repeat(3) { sequence ->
                val latch = CountDownLatch(1)
                var text: String? = null
                var error: String? = null
                val promise = PromiseImpl(
                    Callback { args -> text = args[0] as String; latch.countDown() },
                    Callback { args -> error = args[0].toString(); latch.countDown() }
                )
                module.probe("bridge-$sequence", "::1", "icmp", 0.0, 64.0, sequence.toDouble(), payload, 1500.0, promise)
                assertTrue(latch.await(3, TimeUnit.SECONDS))
                assertNull(error)
                val result = JSONObject(text!!)
                assertEquals("reply", result.getString("outcome"))
                assertEquals("::1", result.getString("targetAddress"))
                assertEquals(sequence, result.getJSONObject("response").getInt("icmpSequence"))
                // A real engine result for offline export validation; contains loopback probes only.
                File(ApplicationProvider.getApplicationContext<android.content.Context>().getExternalFilesDir(null),
                    "packet-engine-validation.json").writeText(result.toString(2))
            }
        } finally { module.invalidate() }
    }
    @Test fun cancellationStopsPollingAndReleasesRunToken() {
        DatagramSocket(0, InetAddress.getByName("127.0.0.1")).use { server ->
            val id = "cancel-test"
            assertTrue(PacketEngine.begin(id))
            val executor = Executors.newSingleThreadExecutor()
            try {
                val pending = executor.submit<String> { PacketEngine.probe(id, "127.0.0.1", "udp", server.localPort, 64, 0, payload, 10000) }
                Thread.sleep(80)
                PacketEngine.cancel(id)
                assertEquals("cancelled", JSONObject(pending.get(2, TimeUnit.SECONDS)).getString("outcome"))
            } finally { PacketEngine.end(id); executor.shutdownNow() }
            assertTrue(PacketEngine.begin(id)); PacketEngine.end(id)
        }
    }
}
