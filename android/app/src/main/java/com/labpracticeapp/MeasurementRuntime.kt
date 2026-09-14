package com.labpracticeapp

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.WritableMap
import java.util.UUID

/** All access is serialized on Android's main thread; no Activity or JS runtime owns this state. */
internal object MeasurementRuntime {
  private val handler = Handler(Looper.getMainLooper())
  var state = "stopped"
    private set
  var sessionId: String? = null
    private set
  private var startedAt: Long? = null
  private var startedElapsed = 0L
  private var heartbeats = 0
  private var lastHeartbeatAt: Long? = null
  private var error: String? = null
  val listeners = mutableSetOf<() -> Unit>()
  private val starts = mutableListOf<Promise>()
  private val stops = mutableListOf<Promise>()
  private var startupTimeout: Runnable? = null

  fun snapshot(): WritableMap = Arguments.createMap().apply {
    putString("state", state)
    putString("sessionId", sessionId)
    startedAt?.let { putDouble("startedAt", it.toDouble()) } ?: putNull("startedAt")
    putDouble("elapsedMs", if (startedAt != null) (SystemClock.elapsedRealtime() - startedElapsed).toDouble() else 0.0)
    putInt("heartbeatCount", heartbeats)
    lastHeartbeatAt?.let { putDouble("lastHeartbeatAt", it.toDouble()) } ?: putNull("lastHeartbeatAt")
    putString("error", error)
  }

  private fun publish() { listeners.toList().forEach { it() } }

  fun start(context: Context, promise: Promise) {
    if (state == "running") { promise.resolve(sessionId); return }
    if (state == "stopping") { promise.reject("SERVICE_STOPPING", "Wait for service shutdown before starting."); return }
    starts.add(promise)
    if (state == "starting") return
    state = "starting"
    sessionId = UUID.randomUUID().toString()
    error = null
    publish()
    startupTimeout = Runnable {
      context.stopService(Intent(context, MeasurementService::class.java))
      failed(IllegalStateException("Foreground service startup timed out."))
    }.also { handler.postDelayed(it, 10_000) }
    try {
      val intent = Intent(context, MeasurementService::class.java).putExtra("sessionId", sessionId)
      if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
    } catch (exception: Exception) { failed(exception) }
  }

  fun running() {
    cancelTimeout()
    state = "running"
    startedAt = System.currentTimeMillis()
    startedElapsed = SystemClock.elapsedRealtime()
    heartbeats = 0
    lastHeartbeatAt = null
    starts.toList().also { starts.clear() }.forEach { it.resolve(sessionId) }
    publish()
  }

  fun heartbeat() {
    heartbeats += 1
    lastHeartbeatAt = System.currentTimeMillis()
    publish()
  }

  fun stop(context: Context, promise: Promise? = null) {
    if (state == "stopped") { promise?.resolve(null); return }
    promise?.let { stops.add(it) }
    if (state == "stopping") return
    cancelTimeout()
    starts.toList().also { starts.clear() }.forEach { it.reject("START_CANCELLED", "Session stopped during startup.") }
    state = "stopping"
    publish()
    if (!context.stopService(Intent(context, MeasurementService::class.java))) stopped()
  }

  fun failed(exception: Exception) {
    error = exception.message ?: "Foreground service failed."
    starts.toList().also { starts.clear() }.forEach { it.reject("SERVICE_START_FAILED", exception) }
    stopped()
  }

  fun stopped() {
    cancelTimeout()
    starts.toList().also { starts.clear() }.forEach { it.reject("SERVICE_STOPPED", "Service stopped before startup completed.") }
    state = "stopped"
    sessionId = null
    startedAt = null
    startedElapsed = 0
    heartbeats = 0
    lastHeartbeatAt = null
    stops.toList().also { stops.clear() }.forEach { it.resolve(null) }
    publish()
  }

  private fun cancelTimeout() {
    startupTimeout?.let { handler.removeCallbacks(it) }
    startupTimeout = null
  }
}
