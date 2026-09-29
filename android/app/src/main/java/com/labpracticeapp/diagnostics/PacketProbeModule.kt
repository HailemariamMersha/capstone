package com.labpracticeapp.diagnostics

import com.facebook.react.bridge.*
import kotlinx.coroutines.*
import org.json.JSONObject
import java.net.InetAddress
import java.util.concurrent.*
import java.util.concurrent.atomic.AtomicReference

/** Thin OS adapter. Measurement scheduling, interpretation, persistence and exports remain in TS. */
class PacketProbeModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val active = AtomicReference<String?>(null)
    // DNS can ignore thread interruption. No queue: at most one resolver can linger.
    private val resolver = ThreadPoolExecutor(0, 1, 10, TimeUnit.SECONDS, SynchronousQueue())
    override fun getName() = "CapstonePacketProbe"
    override fun getConstants(): Map<String, Any> = mapOf("engineVersion" to "1.0.0", "schemaVersion" to 1)

    @ReactMethod
    fun probe(runId: String, host: String, protocol: String, port: Double, ttl: Double,
              sequence: Double, payloadHex: String, timeoutMs: Double, promise: Promise) {
        val numbers = listOf(port, ttl, sequence, timeoutMs)
        if (runId.length !in 1..160 || !Regex("^[a-zA-Z0-9:][a-zA-Z0-9.:-]{0,252}$").matches(host) ||
            protocol !in listOf("icmp", "udp", "tcp") || numbers.any { !it.isFinite() || it != it.toInt().toDouble() } ||
            port !in 0.0..65535.0 || ttl !in 1.0..255.0 || sequence !in 0.0..65535.0 || timeoutMs !in 1.0..10000.0 ||
            payloadHex.length !in 0..2800 || payloadHex.length % 2 != 0 || !Regex("[0-9a-f]*").matches(payloadHex) ||
            (protocol != "icmp" && port == 0.0)) {
            promise.reject("invalid_config", "Invalid packet probe arguments."); return
        }
        if (!active.compareAndSet(null, runId)) { promise.reject("busy", "Previous packet probe has not settled."); return }
        try {
            if (!PacketEngine.begin(runId)) { active.set(null); promise.reject("busy", "Packet engine is busy."); return }
        } catch (error: LinkageError) { active.set(null); promise.reject("unsupported", "Packet engine unavailable on this build."); return }
        scope.launch {
            val began = android.os.SystemClock.elapsedRealtime()
            var dns: Future<InetAddress>? = null
            var output: String
            try {
                dns = resolver.submit(Callable { InetAddress.getByName(host) })
                val ip = dns.get(minOf(timeoutMs.toLong(), 3000L), TimeUnit.MILLISECONDS).hostAddress!!
                val remaining = timeoutMs.toInt() - (android.os.SystemClock.elapsedRealtime() - began).toInt()
                val result = if (remaining <= 0) JSONObject().put("outcome", "timeout").put("errorStage", "resolution")
                    else JSONObject(PacketEngine.probe(runId, ip, protocol, port.toInt(), ttl.toInt(), sequence.toInt(), payloadHex, remaining))
                result.put("runId", runId).put("targetHost", host).put("resolvedAddress", ip)
                    .put("resolutionAndProbeDurationMs", android.os.SystemClock.elapsedRealtime() - began)
                    .put("engineVersion", "1.0.0")
                output = result.toString()
            } catch (error: Exception) {
                dns?.cancel(true)
                output = JSONObject().put("runId", runId).put("engineVersion", "1.0.0")
                    .put("targetHost", host).put("outcome", if (error is TimeoutException) "timeout" else "socket_error")
                    .put("errorStage", "resolution_or_adapter").put("errorMessage", error.message ?: error.javaClass.simpleName).toString()
            } finally { PacketEngine.end(runId); active.compareAndSet(runId, null) }
            promise.resolve(output)
        }
    }
    @ReactMethod fun cancel(runId: String) { PacketEngine.cancel(runId) }
    override fun invalidate() {
        active.get()?.let { PacketEngine.cancel(it) }
        // Let the in-flight operation settle and close its socket before the scope ends.
        (scope.coroutineContext[Job] as? CompletableJob)?.complete()
        resolver.shutdownNow()
        super.invalidate()
    }
}
