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
        if (!Regex("^[a-zA-Z0-9:][a-zA-Z0-9.:-]{0,252}$").matches(host) ||
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
                        val row = encodeLibraryProbe(hop, probe)
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

}
