package com.labpracticeapp.diagnostics

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import okhttp3.OkHttpClient
import okhttp3.Dns
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import java.net.InetAddress
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

class PaperHttpClientTest {
    private lateinit var server: MockWebServer
    private lateinit var base: OkHttpClient
    private lateinit var registry: JsonObject
    private val body = "/* deterministic test object */"
    private val nonce = "a".repeat(32)
    @Before fun setup() {
        val cert = HeldCertificate.Builder().commonName("fixture.test").addSubjectAlternativeName("fixture.test").addSubjectAlternativeName("*.test.nextdns.io").build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        val clientTls = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        server = MockWebServer(); server.useHttps(serverTls.sslSocketFactory(), false); server.start()
        base = OkHttpClient.Builder().sslSocketFactory(clientTls.sslSocketFactory(), clientTls.trustManager)
            .dns(object : Dns { override fun lookup(hostname: String) = listOf(InetAddress.getByName("127.0.0.1")) }).build()
        val hash = MessageDigest.getInstance("SHA-256").digest(body.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
        registry = JsonParser.parseString("""{"cdns":[{"id":"fixture","url":"https://fixture.test:${server.port}/object.js"}],"content":{"bytes":${body.length},"sha256":"$hash"},"resolverDomain":"test.nextdns.io:${server.port}"}""").asJsonObject
    }
    @After fun cleanup() { server.shutdown(); base.connectionPool.evictAll(); base.dispatcher.executorService.shutdownNow() }
    private fun run(kind: String = "cdn_fetch", state: PaperHttpClient.Observation = PaperHttpClient.Observation("id", System::nanoTime)) =
        PaperHttpClient(registry, base, System::nanoTime).execute(state, kind, "fixture", nonce)
    @Test fun correctObjectAndNamedPhases() {
        server.enqueue(MockResponse().setBody(body).setHeader("Content-Type", "text/javascript").setHeader("X-Cache", "HIT").setHeader("Set-Cookie", "private=secret"))
        val r = run(); assertEquals("complete", r["reason"].asString); assertEquals(body.length, r["bodyBytes"].asInt)
        assertTrue(r["contentMatches"].asBoolean); assertTrue(r["bodyComplete"].asBoolean)
        for (key in listOf("dnsLookupMs", "tcpConnectMs", "tlsHandshakeMs", "responseHeadersAfterMs", "bodyReadMs")) assertTrue(key, r[key].asDouble >= 0)
        assertFalse(r.toString().contains("secret")); assertEquals("HIT", r["headers"].asJsonObject["x-cache"].asString)
        val req = server.takeRequest(); assertEquals("identity", req.getHeader("Accept-Encoding")); assertNull(req.getHeader("Cache-Control")); assertNull(req.getHeader("Cookie"))
    }
    @Test fun redirectNeverFollowedAndQueryRedacted() {
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://fixture.test/login?token=private"))
        val r = run(); assertEquals("http_redirect", r["reason"].asString); assertEquals(1, server.requestCount)
        assertEquals("https://fixture.test/login", r["redirectLocation"].asString); assertFalse(r.toString().contains("token="))
    }
    @Test fun mismatchedBodyRetainsEvidenceWithoutSuccessfulComparison() {
        server.enqueue(MockResponse().setBody("<html>portal</html>")); val r = run()
        assertEquals("unexpected_content", r["reason"].asString); assertTrue(r["bodyComplete"].asBoolean); assertFalse(r["contentMatches"].asBoolean)
    }
    @Test fun byteCeilingStopsBodyAndRetainsPartialCount() {
        server.enqueue(MockResponse().setBody("x".repeat(530000))); val r = run()
        assertEquals("byte_limit", r["reason"].asString); assertEquals(524288, r["bodyBytes"].asInt); assertFalse(r["bodyComplete"].asBoolean)
    }
    @Test fun unconfiguredResolverIsValidAndPrivateResponseFieldsAreRemoved() {
        server.enqueue(MockResponse().setBody("""{"status":"unconfigured","resolver":"192.0.2.53","server":"diagnostic","profile":"secret","clientName":"secret"}"""))
        val r = run("dns_resolver"); assertEquals("complete", r["reason"].asString)
        assertEquals("192.0.2.53", r["observedResolverIp"].asString); assertFalse(r.toString().contains("secret"))
        assertTrue(server.takeRequest().getHeader("Host")!!.startsWith("$nonce.test.nextdns.io"))
    }
    @Test fun nextDnsStatusWithoutResolverDoesNotInventItsIpOrLocation() {
        server.enqueue(MockResponse().setBody("""{"status":"ok","destIP":"192.0.2.9","server":"some-city"}"""))
        val r = run("dns_resolver"); assertEquals("complete", r["reason"].asString); assertTrue(r["observedResolverIp"].isJsonNull)
    }
    @Test fun cancellationFinishesAndFollowingRequestRemainsUsable() {
        server.enqueue(MockResponse().setBody(body).setBodyDelay(2, TimeUnit.SECONDS))
        val state = PaperHttpClient.Observation("id", System::nanoTime); val worker = Executors.newSingleThreadExecutor()
        try {
            val future = worker.submit<JsonObject> { run(state = state) }; server.takeRequest(3, TimeUnit.SECONDS); state.cancel()
            assertEquals("cancelled", future.get(3, TimeUnit.SECONDS)["reason"].asString)
            server.enqueue(MockResponse().setBody(body)); assertEquals("complete", run()["reason"].asString)
        } finally { worker.shutdownNow() }
    }
    @Test fun nanosecondStringsAndCallbackDropCountsRemainExact() {
        val clock = AtomicLong(0); val state = PaperHttpClient.Observation("id") { clock.get() }
        clock.set(9007199254740993L); repeat(105) { state.event("test") }
        val r = state.snapshot("complete"); assertEquals("9007199254740993", r["callbacks"].asJsonArray[0].asJsonObject["elapsedNs"].asString)
        assertEquals(100, r["callbacks"].asJsonArray.size()); assertEquals(5, r["droppedCallbacks"].asInt)
    }
}
