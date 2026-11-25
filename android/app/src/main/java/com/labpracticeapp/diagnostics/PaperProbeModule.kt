package com.labpracticeapp.diagnostics

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.SystemClock
import com.facebook.react.bridge.*
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import okhttp3.OkHttpClient
import java.net.Inet4Address
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Binds existing OkHttp/Android DNS APIs to the selected Wi-Fi. */
class PaperProbeModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val worker = Executors.newSingleThreadExecutor()
    private val timer = Executors.newSingleThreadScheduledExecutor()
    private val active = AtomicReference<Run?>(null)
    private val registry by lazy { context.assets.open("paper-suite.json").bufferedReader().use { JsonParser.parseReader(it).asJsonObject } }
    private class Run(val id: String, val promise: Promise) {
        val observation = PaperHttpClient.Observation(id, SystemClock::elapsedRealtimeNanos)
        val settled = AtomicBoolean(false)
        fun finish(result: JsonObject) { result.addProperty("apiLevel", Build.VERSION.SDK_INT); if (settled.compareAndSet(false, true)) promise.resolve(result.toString()) }
    }
    override fun getName() = "CapstonePaperProbes"
    private fun network(handle: String, validated: Boolean = false): Network {
        check(manager.allNetworks.none { manager.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true })
        val n = manager.allNetworks.firstOrNull { it.networkHandle.toString() == handle } ?: error("route")
        val caps = manager.getNetworkCapabilities(n) ?: error("route")
        check(caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && manager.boundNetworkForProcess == n)
        check(!validated || caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
        return n
    }
    private fun begin(id: String, promise: Promise): Run? {
        if (!Regex("^[a-zA-Z0-9_-]{1,128}$").matches(id)) { promise.reject("CONFIG", "Invalid probe identifier"); return null }
        val run = Run(id, promise)
        if (!active.compareAndSet(null, run)) { promise.reject("BUSY", "Previous library request is cleaning up"); return null }
        return run
    }
    @ReactMethod fun resolve(id: String, host: String, handle: String, promise: Promise) {
        if (registry.getAsJsonArray("traces").none { it.asJsonObject["host"].asString == host }) { promise.reject("CONFIG", "Target is not in the study registry"); return }
        val run = begin(id, promise) ?: return
        val timeout = timer.schedule({ run.observation.cancel(); run.finish(run.observation.snapshot("timeout")) }, 20, TimeUnit.SECONDS)
        worker.execute {
            val start = SystemClock.elapsedRealtimeNanos()
            try {
                val selected = network(handle)
                val address = selected.getAllByName(host).firstOrNull { it is Inet4Address }?.hostAddress
                if (address == null) error("ipv4_unavailable")
                network(handle)
                run.finish(JsonObject().apply {
                    addProperty("runId", id); addProperty("reason", if (run.observation.cancelled.get()) "cancelled" else "complete")
                    addProperty("address", address); addProperty("resolutionMs", (SystemClock.elapsedRealtimeNanos() - start) / 1e6)
                })
            } catch (_: Exception) { run.finish(run.observation.snapshot(if (run.observation.cancelled.get()) "cancelled" else "resolution_failed")) }
            finally { timeout.cancel(false); active.compareAndSet(run, null) }
        }
    }
    @ReactMethod fun run(id: String, kind: String, target: String, nonce: String, handle: String, promise: Promise) {
        if (kind !in listOf("cdn_fetch", "dns_resolver") || !Regex("^[a-f0-9]{32}$").matches(nonce) ||
            (kind == "cdn_fetch" && registry.getAsJsonArray("cdns").none { it.asJsonObject["id"].asString == target })) { promise.reject("CONFIG", "Invalid paper probe"); return }
        val run = begin(id, promise) ?: return
        val timeout = timer.schedule({ run.observation.cancel(); run.finish(run.observation.snapshot("timeout")) }, if (kind == "cdn_fetch") 90 else 20, TimeUnit.SECONDS)
        worker.execute {
            try {
                val selected = network(handle, true)
                val properties = manager.getLinkProperties(selected)
                run.observation.put("configuredDnsServers", JsonArray().apply { properties?.dnsServers?.forEach { add(it.hostAddress) } })
                if (Build.VERSION.SDK_INT >= 28 && properties != null) run.observation.put("privateDnsActive", properties.isPrivateDnsActive)
                val client = OkHttpClient.Builder().socketFactory(selected.socketFactory).dns(object : okhttp3.Dns {
                    override fun lookup(host: String) = selected.getAllByName(host).filterIsInstance<Inet4Address>().take(1).also { if (it.isEmpty()) error("ipv4_unavailable") }
                }).build()
                val result = PaperHttpClient(registry, client, SystemClock::elapsedRealtimeNanos) {
                    try { network(handle, true) == selected } catch (_: Exception) { false }
                }.execute(run.observation, kind, target, nonce)
                run.finish(result)
            } catch (_: Exception) { run.finish(run.observation.snapshot("route_changed")) }
            finally { timeout.cancel(false); active.compareAndSet(run, null) }
        }
    }
    @ReactMethod fun cancel(id: String) { active.get()?.takeIf { it.id == id }?.let { it.observation.cancel() } }
    override fun invalidate() { active.get()?.observation?.cancel(); worker.shutdownNow(); timer.shutdownNow(); super.invalidate() }
}
