package com.labpracticeapp.diagnostics

import com.google.gson.JsonArray
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import okhttp3.*
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** OkHttp observations only. No raw sockets, packet interception or kernel telemetry. */
class PaperHttpClient(
    private val registry: JsonObject,
    private val base: OkHttpClient,
    private val clock: () -> Long,
    private val routeValid: () -> Boolean = { true },
) {
    class Observation(val id: String, private val clock: () -> Long) {
        val cancelled = AtomicBoolean(false)
        val call = AtomicReference<Call?>(null)
        private val start = clock()
        private val lock = Any()
        private val data = JsonObject().apply {
            addProperty("runId", id); addProperty("library", "okhttp"); addProperty("libraryVersion", "4.12.0")
            addProperty("bodyComplete", false); addProperty("requestSent", false); addProperty("bodyBytesKnown", false)
            add("bodyBytes", JsonNull.INSTANCE); add("headers", JsonObject()); add("callbacks", JsonArray())
        }
        private val starts = mutableMapOf<String, Long>()
        private var dropped = 0
        fun put(name: String, value: String?) = synchronized(lock) { data.addProperty(name, value) }
        fun put(name: String, value: Number?) = synchronized(lock) { data.addProperty(name, value) }
        fun put(name: String, value: Boolean) = synchronized(lock) { data.addProperty(name, value) }
        fun put(name: String, value: com.google.gson.JsonElement) = synchronized(lock) { data.add(name, value) }
        fun event(name: String, begin: String? = null, end: String? = null, offset: String? = null) = synchronized(lock) {
            val now = clock()
            if (begin != null) starts[begin] = now
            if (end != null && starts[end] != null) {
                val elapsed = (now - starts[end]!!) / 1e6
                data.addProperty(end, (data[end]?.takeUnless { it.isJsonNull }?.asDouble ?: 0.0) + elapsed)
                starts.remove(end)
            }
            if (offset != null) data.addProperty(offset, (now - start) / 1e6)
            val callbacks = data.getAsJsonArray("callbacks")
            if (callbacks.size() < 100) callbacks.add(JsonObject().apply {
                addProperty("event", name); addProperty("wallTimeMs", System.currentTimeMillis()); addProperty("elapsedNs", (now - start).toString()); addProperty("elapsedMs", (now - start) / 1e6)
            }) else dropped++
        }
        fun snapshot(reason: String): JsonObject = synchronized(lock) {
            data.deepCopy().apply { addProperty("reason", reason); addProperty("totalMs", (clock() - start) / 1e6); addProperty("droppedCallbacks", dropped) }
        }
        fun cancel() { cancelled.set(true); call.get()?.cancel() }
    }

    fun execute(run: Observation, kind: String, target: String, nonce: String): JsonObject {
        val cdn = registry.getAsJsonArray("cdns").firstOrNull { it.asJsonObject["id"].asString == target }?.asJsonObject
        require(kind == "dns_resolver" || (kind == "cdn_fetch" && cdn != null))
        require(Regex("^[a-f0-9]{32}$").matches(nonce))
        val url = if (kind == "cdn_fetch") cdn!!["url"].asString else "https://$nonce.${registry["resolverDomain"].asString}/"
        val limit = if (kind == "cdn_fetch") 524288 else 16384
        val timeout = if (kind == "cdn_fetch") 90000L else 20000L
        run.put("url", url); run.put("byteLimit", limit); run.put("targetId", target)
        val listener = object : EventListener() {
            override fun dnsStart(call: Call, domainName: String) { run.event("dnsStart", begin = "dnsLookupMs") }
            override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<java.net.InetAddress>) { run.event("dnsEnd", end = "dnsLookupMs") }
            override fun connectStart(call: Call, address: InetSocketAddress, proxy: Proxy) { run.event("connectStart", begin = "tcpConnectMs") }
            override fun secureConnectStart(call: Call) { run.event("secureConnectStart", end = "tcpConnectMs", begin = "tlsHandshakeMs") }
            override fun secureConnectEnd(call: Call, handshake: Handshake?) { run.event("secureConnectEnd", end = "tlsHandshakeMs") }
            override fun connectionAcquired(call: Call, connection: Connection) {
                run.put("remoteAddress", connection.socket().inetAddress.hostAddress)
                run.put("httpVersion", connection.protocol().toString()); run.event("connectionAcquired")
            }
            override fun requestHeadersEnd(call: Call, request: Request) { run.put("requestSent", true); run.event("requestHeadersEnd") }
            override fun responseHeadersStart(call: Call) { run.event("responseHeadersStart") }
            override fun responseHeadersEnd(call: Call, response: Response) { run.event("responseHeadersEnd", offset = "responseHeadersAfterMs") }
            override fun responseBodyStart(call: Call) { run.event("responseBodyStart", begin = "bodyReadMs") }
            override fun responseBodyEnd(call: Call, byteCount: Long) { run.event("responseBodyEnd", end = "bodyReadMs") }
        }
        val client = base.newBuilder().connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
            .protocols(listOf(Protocol.HTTP_1_1)).proxy(Proxy.NO_PROXY).cache(null).cookieJar(CookieJar.NO_COOKIES)
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .connectTimeout(minOf(30000L, timeout), TimeUnit.MILLISECONDS).readTimeout(timeout, TimeUnit.MILLISECONDS)
            .callTimeout(timeout, TimeUnit.MILLISECONDS).eventListener(listener).build()
        val call = client.newCall(Request.Builder().url(url).header("Accept-Encoding", "identity").header("User-Agent", "SkyMeasure/paper-core-v1").get().build())
        run.call.set(call)
        var reason = "network"
        try {
            if (run.cancelled.get()) call.cancel()
            check(routeValid()) { "route" }
            call.execute().use { response ->
                run.put("httpStatus", response.code)
                run.put("bodyBytesKnown", true); run.put("bodyBytes", 0)
                val headers = JsonObject()
                val allow = setOf("date", "server", "cache-control", "age", "expires", "via", "x-cache", "cf-cache-status", "cf-ray", "x-served-by", "x-timer", "content-type", "content-length", "content-encoding", "etag", "last-modified")
                var headerBytes = 0
                for (name in response.headers.names().sorted()) if (name.lowercase() in allow) {
                    val value = response.headers.values(name).joinToString(", ").take(1024)
                    if (headerBytes + value.length <= 16384) { headers.addProperty(name.lowercase(), value); headerBytes += value.length }
                }
                run.put("headers", headers)
                if (response.isRedirect) {
                    response.header("Location")?.let { location -> response.request.url.resolve(location)?.let {
                        run.put("redirectLocation", it.newBuilder().query(null).fragment(null).username("").password("").build().toString())
                    } }
                }
                val digest = MessageDigest.getInstance("SHA-256")
                val dnsBody = java.io.ByteArrayOutputStream()
                var count = 0
                var eof = false
                response.body?.byteStream()?.use { stream ->
                    val buffer = ByteArray(8192)
                    while (count < limit) {
                        if (run.cancelled.get()) throw IOException("cancelled")
                        if (!routeValid()) throw IOException("route")
                        val n = stream.read(buffer, 0, minOf(buffer.size, limit - count))
                        if (n == -1) { eof = true; break }
                        digest.update(buffer, 0, n)
                        if (kind == "dns_resolver") dnsBody.write(buffer, 0, n)
                        count += n; run.put("bodyBytes", count)
                    }
                }
                val hash = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
                run.put("sha256", hash); run.put("bodyComplete", eof)
                reason = when {
                    !eof -> "byte_limit"
                    response.isRedirect -> "http_redirect"
                    response.code != 200 -> "http"
                    kind == "cdn_fetch" -> {
                        val matches = count == registry["content"].asJsonObject["bytes"].asInt && hash == registry["content"].asJsonObject["sha256"].asString
                        run.put("contentMatches", matches)
                        if (matches) "complete" else "unexpected_content"
                    }
                    else -> {
                        val body = JsonParser.parseString(dnsBody.toString(Charsets.UTF_8.name())).asJsonObject
                        val safe = JsonObject()
                        for (key in listOf("status", "resolver", "srcIP", "server", "protocol")) body[key]?.takeIf { it.isJsonPrimitive }?.let { safe.addProperty(key, it.asString.take(256)) }
                        run.put("resolverResponse", safe)
                        val status = safe["status"]?.asString
                        run.put("resolverStatus", status)
                        val resolver = safe["resolver"]?.asString?.takeIf { validIp(it) }
                        run.put("observedResolverIp", resolver)
                        run.put("resolverUnavailableReason", if (resolver == null) "endpoint_did_not_report_resolver_ip" else null)
                        if (status in listOf("ok", "unconfigured")) "complete" else "invalid_response"
                    }
                }
            }
        } catch (_: Exception) {
            reason = when { run.cancelled.get() -> "cancelled"; !routeValid() -> "route_changed"; call.isCanceled() -> "timeout"; else -> "network" }
        } finally {
            client.connectionPool.evictAll()
        }
        run.event("finished")
        return run.snapshot(reason)
    }
    companion object {
        fun validIp(value: String): Boolean = when {
            value.contains(':') && Regex("^[0-9a-fA-F:.]+$").matches(value) -> try { java.net.InetAddress.getByName(value) is java.net.Inet6Address } catch (_: Exception) { false }
            else -> value.split('.').let { it.size == 4 && it.all { s -> s.toIntOrNull()?.let { n -> n in 0..255 && n.toString() == s } == true } }
        }
    }
}
