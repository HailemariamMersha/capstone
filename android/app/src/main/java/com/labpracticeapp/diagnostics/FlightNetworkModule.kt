package com.labpracticeapp.diagnostics

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.location.LocationManager
import android.content.Context
import android.os.Build
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
    private fun changed(network: Network, lost: Boolean = false, kind: String = "available") {
        val event = Arguments.createMap()
        event.putString("handle", network.networkHandle.toString())
        event.putBoolean("lost", lost)
        event.putString("kind", if (lost) "lost" else kind)
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("flightNetworkChanged", event)
    }
    @ReactMethod fun bindWifi(promise: Promise) {
        try {
            val location = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
            if (!location.isProviderEnabled(LocationManager.GPS_PROVIDER) && !location.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                promise.reject("LOCATION_DISABLED", "Enable location services before starting a trip."); return
            }
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
            val wifi = if (info?.ssid != null && info.ssid != "<unknown ssid>") info else if (fallbackAllowed) (context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).connectionInfo else null
            val ssid = wifi?.ssid?.trim('"')?.takeUnless { it == "<unknown ssid>" }
            val result = Arguments.createMap()
            result.putString("networkKey", ssid?.let { "ssid:$it" } ?: "network:${network.networkHandle}")
            result.putString("handle", network.networkHandle.toString())
            result.putString("ssid", ssid)
            result.putString("bssid", wifi?.bssid)
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
