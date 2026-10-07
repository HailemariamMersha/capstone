package com.labpracticeapp.diagnostics

import com.facebook.react.bridge.*
import kotlinx.coroutines.*
import me.impa.icmpenguin.ping.Pinger
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Library lifecycle/serialization only: socket creation and probing belong to icmpenguin. */
class LibraryIcmpModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val active = AtomicReference<Run?>(null)
    override fun getName() = "CapstoneLibraryIcmp"
    override fun getConstants(): Map<String, Any> = mapOf("libraryVersion" to "1.0.0-rc.3")
    private inner class Run(val id: String, val promise: Promise) {
        var job: Job? = null
        val cancelled = AtomicBoolean(false)
        val finished = AtomicBoolean(false)
        @Volatile var reason = "cancelled"
        @Volatile var error: String? = null
        @Volatile var result: Map<String, Any?>? = null
        fun finish() {
            if (!finished.compareAndSet(false, true)) return
            active.compareAndSet(this, null)
            promise.resolve(Arguments.createMap().apply {
                putString("runId", id); putString("reason", reason); putString("error", error)
                result?.let { putMap("result", Arguments.makeNativeMap(it)) } ?: putNull("result")
            })
        }
    }
    @ReactMethod
    fun ping(runId: String, host: String, timeoutMs: Int, payload: String, promise: Promise) {
        if (!Regex("^[a-zA-Z0-9:][a-zA-Z0-9.:-]{0,252}$").matches(host) ||
            timeoutMs !in 1..10000 || runId.length !in 1..128 ||
            payload.length != 64 || payload.any { it.code !in 32..126 }) {
            promise.reject("invalid_config", "Invalid ICMP target, timeout or payload."); return
        }
        val run = Run(runId, promise)
        if (!active.compareAndSet(null, run)) {
            promise.reject("busy", "Previous ICMP call is still cleaning up."); return
        }
        run.job = scope.launch {
            try {
                if (run.cancelled.get()) throw CancellationException()
                withTimeout(timeoutMs.toLong() + 1000) {
                    // rc.3 probeSize includes the 8-byte ICMP header (verified in source).
                    Pinger(host = host, ttl = 64, timeout = timeoutMs, maxPingCount = 1,
                        interval = 0, probeSize = 72, pattern = payload.toByteArray(Charsets.US_ASCII))
                        .ping { run.result = encodeLibraryProbe(64, it) }
                }
                run.reason = "complete"
            } catch (_: TimeoutCancellationException) {
                run.reason = "timeout"
            } catch (_: CancellationException) {
                run.reason = "cancelled"
            } catch (error: Exception) {
                run.reason = "network"; run.error = error.message ?: "ICMP library failed."
            } catch (_: LinkageError) {
                run.reason = "unsupported"; run.error = "ICMP library could not load."
            } finally { run.finish() }
        }
        run.job!!.invokeOnCompletion { run.finish() }
        if (run.cancelled.get()) run.job!!.cancel()
    }
    @ReactMethod
    fun cancel(runId: String) {
        active.get()?.takeIf { it.id == runId }?.let {
            it.cancelled.set(true); it.job?.cancel()
        }
    }
    override fun invalidate() {
        active.get()?.cancelled?.set(true); scope.cancel(); super.invalidate()
    }
}
