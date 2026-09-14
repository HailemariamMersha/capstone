package com.labpracticeapp

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.modules.core.DeviceEventManagerModule

class MeasurementModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private var listenerCount = 0
  private val statusListener: () -> Unit = {
    if (listenerCount > 0 && context.hasActiveReactInstance()) {
      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("MeasurementServiceStatusChanged", MeasurementRuntime.snapshot())
    }
  }

  override fun getName() = "MeasurementModule"

  override fun initialize() {
    super.initialize()
    UiThreadUtil.runOnUiThread { MeasurementRuntime.listeners.add(statusListener) }
  }

  override fun invalidate() {
    UiThreadUtil.runOnUiThread { MeasurementRuntime.listeners.remove(statusListener); listenerCount = 0 }
    super.invalidate()
  }

  @ReactMethod
  fun startSession(config: ReadableMap, promise: Promise) {
    // M1 intentionally has no probe configuration; reject unsupported inputs rather than ignore them.
    if (config.keySetIterator().hasNextKey()) {
      promise.reject("INVALID_CONFIG", "Milestone 1 accepts an empty config object.")
      return
    }
    UiThreadUtil.runOnUiThread { MeasurementRuntime.start(context.applicationContext, promise) }
  }

  @ReactMethod
  fun stopSession(promise: Promise) {
    UiThreadUtil.runOnUiThread { MeasurementRuntime.stop(context.applicationContext, promise) }
  }

  @ReactMethod
  fun getServiceStatus(promise: Promise) {
    UiThreadUtil.runOnUiThread { promise.resolve(MeasurementRuntime.snapshot()) }
  }

  @ReactMethod
  fun addListener(eventName: String) {
    UiThreadUtil.runOnUiThread { listenerCount += 1 }
  }

  @ReactMethod
  fun removeListeners(count: Double) {
    UiThreadUtil.runOnUiThread { listenerCount = (listenerCount - count.toInt()).coerceAtLeast(0) }
  }
}
