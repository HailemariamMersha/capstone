package com.labpracticeapp.diagnostics

import android.Manifest
import android.content.pm.PackageManager
import android.location.LocationManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import com.speedchecker.android.sdk.SpeedcheckerSDK
import com.speedchecker.android.sdk.Public.SpeedTestListener
import com.speedchecker.android.sdk.Public.SpeedTestResult

/** Opt-in active tests only. Constructing or registering this module never initializes the SDK. */
class SpeedCheckerModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
    private val handler = Handler(Looper.getMainLooper())
    private var active: Run? = null
    private var quarantined = false
    init { context.addLifecycleEventListener(this) }
    override fun getName() = "CapstoneSpeedChecker"
    override fun getConstants(): Map<String, Any> = mapOf("sdkVersion" to "4.2.299")

    private inner class Run(val id: String, val promise: Promise) {
        val started = SystemClock.elapsedRealtime()
        var stopped: String? = null
        var settled = false
        var downloadMbps: Double? = null
        var uploadMbps: Double? = null
        var pingMs: Double? = null
        var jitterMs: Double? = null
        var downloadMb = 0.0
        var uploadMb = 0.0
        var server: String? = null
        val callbacks = mutableListOf<Map<String, Any?>>()
        var droppedCallbacks = 0
        var callbackCharacters = 0
        fun record(name: String, args: Map<String, Any?> = emptyMap()) {
            val safeArgs = args.mapValues { (_, value) -> if (value is Double && !value.isFinite()) value.toString() else value }
            val formatter = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
            formatter.timeZone = java.util.TimeZone.getTimeZone("UTC")
            val item = mapOf("observedAt" to formatter.format(java.util.Date()),
                "elapsedMs" to (SystemClock.elapsedRealtime() - started).toDouble(),
                "value" to mapOf("callback" to name, "arguments" to safeArgs))
            val size = org.json.JSONObject(item).toString().length
            if (callbacks.size < 256 && callbackCharacters + size <= 262144) { callbacks.add(item); callbackCharacters += size }
            else droppedCallbacks++
        }
        val deadline = Runnable { stop("timeout") }
        val cleanupDeadline = Runnable { finish("cleanup_unconfirmed", false) }
        fun stop(reason: String) {
            if (settled || stopped != null) return
            stopped = reason
            handler.removeCallbacks(deadline)
            handler.postDelayed(cleanupDeadline, 5000)
            try { SpeedcheckerSDK.SpeedTest.interruptTest() }
            catch (_: Exception) { finish("cleanup_unconfirmed", false) }
        }
        fun checkThreshold() {
            // SDK exposes decimal megabytes. This is a best-effort combined threshold.
            if (downloadMb + uploadMb >= 100.0) stop("data_threshold")
        }
        fun finish(reason: String, cleanupConfirmed: Boolean = true) {
            if (settled) return
            settled = true
            handler.removeCallbacks(deadline)
            handler.removeCallbacks(cleanupDeadline)
            if (!cleanupConfirmed) quarantined = true
            if (active === this) active = null
            promise.resolve(Arguments.createMap().apply {
                putString("runId", id); putString("reason", stopped ?: reason)
                putBoolean("cleanupConfirmed", cleanupConfirmed)
                putDouble("durationMs", (SystemClock.elapsedRealtime() - started).toDouble())
                fun number(key: String, value: Double?) {
                    if (value != null && value.isFinite() && value >= 0) putDouble(key, value) else putNull(key)
                }
                number("downloadMbps", downloadMbps); number("uploadMbps", uploadMbps)
                number("pingMs", pingMs); number("jitterMs", jitterMs)
                number("downloadMb", downloadMb); number("uploadMb", uploadMb)
                putString("server", server)
                putArray("callbacks", Arguments.makeNativeArray(callbacks))
                putInt("droppedCallbacks", droppedCallbacks)
            })
        }
    }
    private fun onMain(run: Run, action: () -> Unit) {
        handler.post { if (active === run && !run.settled) action() }
    }
    @ReactMethod
    fun start(runId: String, consent: Boolean, promise: Promise) {
        handler.post {
            if (!consent || runId.length !in 1..128) {
                promise.reject("consent_required", "Explicit SpeedChecker consent is required."); return@post
            }
            if (active != null || quarantined) {
                promise.reject("busy", "SpeedChecker cannot start until cleanup completes or the app is restarted."); return@post
            }
            if (reactApplicationContext.lifecycleState != LifecycleState.RESUMED) {
                promise.reject("cancelled", "Keep the app in the foreground."); return@post
            }
            val fine = ContextCompat.checkSelfPermission(reactApplicationContext, Manifest.permission.ACCESS_FINE_LOCATION)
            val location = reactApplicationContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
            if (fine != PackageManager.PERMISSION_GRANTED || !LocationManagerCompat.isLocationEnabled(location)) {
                promise.reject("permission", "SpeedChecker free mode requires precise location permission and system Location enabled."); return@post
            }
            val run = Run(runId, promise)
            active = run
            try {
                // Every SDK call is after consent/permission/foreground checks.
                SpeedcheckerSDK.setPassiveMeasurementsEnabled(reactApplicationContext, false)
                SpeedcheckerSDK.setBackgroundNetworkTesting(reactApplicationContext, false)
                SpeedcheckerSDK.init(reactApplicationContext)
                SpeedcheckerSDK.SpeedTest.setOnSpeedTestListener(object : SpeedTestListener {
                    override fun onTestStarted() = onMain(run) { run.record("onTestStarted") }
                    override fun onFindingBestServerStarted() = onMain(run) { run.record("onFindingBestServerStarted") }
                    override fun onPingStarted() = onMain(run) { run.record("onPingStarted") }
                    override fun onDownloadTestStarted() = onMain(run) { run.record("onDownloadTestStarted") }
                    override fun onUploadTestStarted() = onMain(run) { run.record("onUploadTestStarted") }
                    override fun onTestWarning(warning: String?) = onMain(run) { run.record("onTestWarning", mapOf("warning" to warning)) }
                    override fun onFetchServerFailed(code: Int?) = onMain(run) { run.record("onFetchServerFailed", mapOf("code" to code)); run.finish("server_unavailable") }
                    override fun onTestFatalError(error: String?) = onMain(run) { run.record("onTestFatalError", mapOf("error" to error)); run.finish("network") }
                    override fun onTestInterrupted(error: String?) = onMain(run) { run.record("onTestInterrupted", mapOf("error" to error)); run.finish("cancelled") }
                    override fun onPingFinished(ping: Int, jitter: Int) = onMain(run) {
                        run.record("onPingFinished", mapOf("ping" to ping, "jitter" to jitter))
                        run.pingMs = ping.toDouble(); run.jitterMs = jitter.toDouble()
                    }
                    override fun onDownloadTestProgress(percent: Int, speedMbs: Double, transferredMb: Double) = onMain(run) {
                        run.record("onDownloadTestProgress", mapOf("percent" to percent, "speedMbs" to speedMbs, "transferredMb" to transferredMb))
                        if (transferredMb.isFinite() && transferredMb >= 0) run.downloadMb = transferredMb
                        run.checkThreshold()
                    }
                    override fun onUploadTestProgress(percent: Int, speedMbs: Double, transferredMb: Double) = onMain(run) {
                        run.record("onUploadTestProgress", mapOf("percent" to percent, "speedMbs" to speedMbs, "transferredMb" to transferredMb))
                        if (transferredMb.isFinite() && transferredMb >= 0) run.uploadMb = transferredMb
                        run.checkThreshold()
                    }
                    override fun onDownloadTestFinished(speedMbs: Double) = onMain(run) { run.record("onDownloadTestFinished", mapOf("speedMbs" to speedMbs)); run.downloadMbps = speedMbs }
                    override fun onUploadTestFinished(speedMbs: Double) = onMain(run) { run.record("onUploadTestFinished", mapOf("speedMbs" to speedMbs)); run.uploadMbps = speedMbs }
                    override fun onTestFinished(result: SpeedTestResult) = onMain(run) {
                        run.record("onTestFinished", mapOf(
                            "downloadSpeed" to result.downloadSpeed?.toDouble(), "uploadSpeed" to result.uploadSpeed?.toDouble(),
                            "ping" to result.ping?.toDouble(), "jitter" to result.jitter?.toDouble(),
                            "downloadTransferredMb" to result.downloadTransferredMb, "uploadTransferredMb" to result.uploadTransferredMb,
                            "isDownloadSpeedValid" to result.isDownloadSpeedValid, "isUploadSpeedValid" to result.isUploadSpeedValid,
                            "isPingValid" to result.isPingValid, "serverDomain" to result.server?.Domain))
                        run.downloadMbps = if (result.isDownloadSpeedValid) result.downloadSpeed?.toDouble() else null
                        run.uploadMbps = if (result.isUploadSpeedValid) result.uploadSpeed?.toDouble() else null
                        run.pingMs = if (result.isPingValid) result.ping?.toDouble() else null
                        run.jitterMs = result.jitter?.toDouble()
                        run.downloadMb = result.downloadTransferredMb
                        run.uploadMb = result.uploadTransferredMb
                        run.server = result.server?.Domain?.takeIf { it.matches(Regex("[a-zA-Z0-9.-]{1,253}")) }
                        run.finish(if (run.downloadMb + run.uploadMb >= 100.0) "data_threshold" else "complete")
                    }
                })
                handler.postDelayed(run.deadline, 90_000)
                SpeedcheckerSDK.SpeedTest.startTest(reactApplicationContext)
            } catch (_: Exception) {
                run.stop("network")
            } catch (_: LinkageError) {
                run.finish("unsupported", false)
            }
        }
    }
    @ReactMethod
    fun cancel(runId: String) { handler.post { active?.takeIf { it.id == runId }?.stop("cancelled") } }
    override fun onHostPause() { handler.post { active?.stop("cancelled") } }
    override fun onHostDestroy() { handler.post { active?.stop("cancelled") } }
    override fun onHostResume() = Unit
    override fun invalidate() {
        reactApplicationContext.removeLifecycleEventListener(this)
        handler.post { active?.stop("cancelled") }
        super.invalidate()
    }
}
