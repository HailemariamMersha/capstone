package com.labpracticeapp.diagnostics

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.Manifest
import android.content.pm.PackageManager
import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.content.Intent
import android.provider.Settings
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.network.OkHttpClientProvider

/** Routes library-created connections; does not implement a measurement socket. */
class FlightNetworkModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private var selected: Network? = null
    private var callback: ConnectivityManager.NetworkCallback? = null
    override fun getName() = "FlightNetwork"
    @ReactMethod fun addListener(name: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
    /** Lifecycle/clock evidence only; no location or participant traffic capture. */
    @ReactMethod fun runtimeState(promise: Promise) {
        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val result = Arguments.createMap()
        result.putDouble("wallTimeMs", System.currentTimeMillis().toDouble())
        result.putDouble("elapsedRealtimeMs", SystemClock.elapsedRealtime().toDouble())
        result.putDouble("uptimeMs", SystemClock.uptimeMillis().toDouble())
        result.putBoolean("powerSave", power.isPowerSaveMode)
        result.putBoolean("deviceIdle", power.isDeviceIdleMode)
        result.putBoolean("interactive", power.isInteractive)
        result.putBoolean("batteryExempt", power.isIgnoringBatteryOptimizations(context.packageName))
        result.putInt("processId", android.os.Process.myPid())
        promise.resolve(result)
    }
    @ReactMethod fun openBatterySettings(promise: Promise) {
        try {
            context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            promise.resolve(null)
        } catch (e: Exception) { promise.reject("SETTINGS", "Battery settings unavailable", e) }
    }
    private fun changed(network: Network, lost: Boolean = false, kind: String = "available") {
        val event = Arguments.createMap()
        event.putString("handle", network.networkHandle.toString())
        event.putBoolean("lost", lost)
        event.putString("kind", if (lost) "lost" else kind)
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("flightNetworkChanged", event)
    }
    @ReactMethod fun bindWifi(promise: Promise) {
        try {
            if (callback == null) {
                callback = object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) { changed(network) }
                    override fun onLost(network: Network) { changed(network, true) }
                    override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) { changed(network, false, "capabilities") }
                }
                manager.registerNetworkCallback(NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), callback!!)
            }
            val network = manager.activeNetwork?.takeIf { manager.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true } ?: manager.allNetworks.firstOrNull { manager.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true }
            if (network == null) { promise.resolve(null); return }
            // An active VPN makes attribution ambiguous: never silently bypass it for research.
            if (manager.allNetworks.any { manager.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true }) {
                promise.reject("VPN", "Wi-Fi attribution is unavailable while a VPN is active."); return
            }
            if (selected != network) {
                if (!manager.bindProcessToNetwork(network)) { promise.reject("BIND", "Cannot bind measurements to Wi-Fi"); return }
                OkHttpClientProvider.getOkHttpClient().connectionPool.evictAll()
                selected = network
            }
            val caps = manager.getNetworkCapabilities(network)
            val info = if (Build.VERSION.SDK_INT >= 29) caps?.transportInfo as? WifiInfo else null
            @Suppress("DEPRECATION")
            val fallbackAllowed = manager.activeNetwork == network || manager.allNetworks.count { manager.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true } == 1
            // Wi-Fi selection/binding does not depend on optional SSID permission.
            val wifi = try {
                if (context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) null
                else if (info?.ssid != null && info.ssid != "<unknown ssid>") info
                else if (fallbackAllowed) (context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).connectionInfo
                else null
            } catch (_: SecurityException) { null }
            val ssid = wifi?.ssid?.trim('"')?.takeUnless { it == "<unknown ssid>" }
            val result = Arguments.createMap()
            result.putString("networkKey", "network:${network.networkHandle}")
            result.putString("handle", network.networkHandle.toString())
            result.putString("ssid", ssid)
            result.putString("bssid", wifi?.bssid?.takeUnless { it == "02:00:00:00:00:00" })
            result.putBoolean("validated", caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true)
            result.putBoolean("bound", manager.boundNetworkForProcess == network)
            promise.resolve(result)
        } catch (e: Exception) { promise.reject("NETWORK", "Wi-Fi selection unavailable", e) }
    }
    @ReactMethod fun release(promise: Promise) {
        callback?.let { manager.unregisterNetworkCallback(it) }; callback = null
        manager.bindProcessToNetwork(null); selected = null
        OkHttpClientProvider.getOkHttpClient().connectionPool.evictAll()
        promise.resolve(null)
    }
}
