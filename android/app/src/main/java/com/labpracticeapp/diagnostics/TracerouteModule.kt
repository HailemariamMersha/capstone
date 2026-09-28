package com.labpracticeapp.diagnostics

import com.facebook.react.bridge.*
import kotlinx.coroutines.*
import me.impa.icmpenguin.ProbeResult
import me.impa.icmpenguin.ProbeType
import me.impa.icmpenguin.trace.PortStrategy
import me.impa.icmpenguin.trace.ProbeSize
import me.impa.icmpenguin.trace.TraceStrategy
import me.impa.icmpenguin.trace.Tracer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Only OS/library adaptation lives here; scheduling, persistence and interpretation stay in TS. */
class TracerouteModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val active = AtomicReference<Run?>(null)
    override fun getName() = "CapstoneTraceroute"
    override fun getConstants(): Map<String, Any> = mapOf("libraryVersion" to "1.0.0-rc.3")

    private inner class Run(val id: String, val promise: Promise) {
        var job: Job? = null
        val cancelled = AtomicBoolean(false)
        val finished = AtomicBoolean(false)
        val samples = mutableListOf<Map<String, Any?>>()
        @Volatile var reason = "cancelled"
        @Volatile var error: String? = null
        fun finish() {
            if (!finished.compareAndSet(false, true)) return
            val rows = synchronized(samples) { samples.toList() }
            val result = Arguments.createMap().apply {
                putString("runId", id)
                putString("reason", reason)
                putString("error", error)
                putArray("samples", Arguments.makeNativeArray(rows))
            }
            active.compareAndSet(this, null)
            promise.resolve(result)
        }
    }

    @ReactMethod
    fun trace(runId: String, host: String, maxHops: Int, probesPerHop: Int, promise: Promise) {
        if (!Regex("^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$").matches(host) ||
            maxHops !in 1..30 || probesPerHop !in 1..3 || runId.length !in 1..128) {
            promise.reject("invalid_config", "Invalid traceroute target or limits.")
            return
        }
        val run = Run(runId, promise)
        if (!active.compareAndSet(null, run)) {
            promise.reject("busy", "Previous traceroute is still cleaning up.")
            return
        }
        run.job = scope.launch {
            try {
                if (run.cancelled.get()) throw CancellationException()
                withTimeout(45_000L) {
                    Tracer(
                        host = host,
                        probeType = ProbeType.UDP,
                        traceStrategy = TraceStrategy.Stepped(
                            maxHops = maxHops, probesPerHop = probesPerHop, concurrency = 1
                        ),
                        portStrategy = PortStrategy.Sequential(start = 33434),
                        probeSize = ProbeSize.Static(32),
                        timeout = 1000
                    ).trace { hop, probe ->
                        val row = encode(hop, probe)
                        synchronized(run.samples) {
                            // Native library may have a small number of in-flight probes at cutoff.
                            if (run.samples.size < maxHops * probesPerHop) run.samples.add(row)
                        }
                    }
                }
                run.reason = "complete"
            } catch (_: TimeoutCancellationException) {
                run.reason = "timeout"
            } catch (_: CancellationException) {
                run.reason = "cancelled"
            } catch (error: Exception) {
                run.reason = "network"
                run.error = error.message?.take(300) ?: "Traceroute library failed."
            } catch (_: LinkageError) {
                run.reason = "unsupported"
                run.error = "Traceroute native library could not load on this device."
            } finally {
                run.finish()
            }
        }
        // Also handles cancellation before the coroutine's first instruction.
        run.job!!.invokeOnCompletion { run.finish() }
        if (run.cancelled.get()) run.job!!.cancel()
    }

    @ReactMethod
    fun cancel(runId: String) {
        active.get()?.takeIf { it.id == runId }?.let {
            it.cancelled.set(true)
            it.job?.cancel()
        }
    }

    override fun invalidate() {
        active.get()?.cancelled?.set(true)
        scope.cancel()
        super.invalidate()
    }

    private fun encode(hop: Int, result: ProbeResult): Map<String, Any?> {
        val row = mutableMapOf<String, Any?>(
            "hop" to hop, "sequence" to result.sequence, "remote" to result.remote,
            "probeBytes" to result.probeSize, "overheadBytes" to result.overhead,
            "address" to null, "rttMs" to null, "icmpType" to null, "icmpCode" to null
        )
        // Retain every field exposed by the pinned ProbeResult variant. These are
        // library observations; do not fabricate ICMP headers from errno labels.
        val raw = mutableMapOf<String, Any?>(
            "sequence" to result.sequence, "remote" to result.remote,
            "probeSize" to result.probeSize, "overhead" to result.overhead
        )
        row["observedAtMs"] = System.currentTimeMillis().toDouble()
        row["rawResult"] = raw
        when (result) {
            is ProbeResult.Success -> {
                raw.putAll(mapOf("variant" to "Success", "elapsedUsec" to result.elapsedUsec,
                    "ttl" to result.ttl, "dataBase64" to android.util.Base64.encodeToString(result.data, android.util.Base64.NO_WRAP)))
                row["kind"] = "reply"; row["address"] = result.remote
                row["rttMs"] = result.elapsedUsec / 1000.0
            }
            is ProbeResult.Timeout -> { raw["variant"] = "Timeout"; row["kind"] = "timeout" }
            is ProbeResult.ConnectionRefused -> {
                raw.putAll(mapOf("variant" to "ConnectionRefused", "offender" to result.offender, "elapsedUsec" to result.elapsedUsec))
                row["kind"] = "port_unreachable"; row["address"] = result.offender
                row["rttMs"] = result.elapsedUsec / 1000.0
            }
            is ProbeResult.HostUnreachable -> {
                raw.putAll(mapOf("variant" to "HostUnreachable", "offender" to result.offender, "elapsedUsec" to result.elapsedUsec))
                row["kind"] = "host_unreachable"; row["address"] = result.offender
                row["rttMs"] = result.elapsedUsec / 1000.0
            }
            is ProbeResult.NetUnreachable -> {
                raw.putAll(mapOf("variant" to "NetUnreachable", "offender" to result.offender, "elapsedUsec" to result.elapsedUsec))
                row["kind"] = "network_unreachable"; row["address"] = result.offender
                row["rttMs"] = result.elapsedUsec / 1000.0
            }
            is ProbeResult.NetError -> {
                raw.putAll(mapOf("variant" to "NetError", "offender" to result.offender,
                    "errNo" to result.errNo, "errCode" to result.errCode, "errType" to result.errType, "errInfo" to result.errInfo))
                row["kind"] = "icmp_error"; row["address"] = result.offender
                row["icmpType"] = result.errType; row["icmpCode"] = result.errCode
                // This variant exposes no elapsed time. Never invent a hop RTT.
            }
            is ProbeResult.Unknown -> { raw.putAll(mapOf("variant" to "Unknown", "error" to result.error)); row["kind"] = "error" }
        }
        return row
    }
}
