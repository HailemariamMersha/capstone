package com.labpracticeapp.diagnostics

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.facebook.react.bridge.*
import com.google.gson.Gson
import net.measurementlab.ndt7.android.NDTTest
import net.measurementlab.ndt7.android.models.ClientResponse
import net.measurementlab.ndt7.android.models.Measurement
import net.measurementlab.ndt7.android.models.receiverCounters
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** React Native adapter to the pinned, patched M-Lab Android library. No WebView. */
class Ndt7Module(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val worker = Executors.newSingleThreadExecutor()
    private val watchdog = Executors.newSingleThreadScheduledExecutor()
    @Volatile private var active: NDTTest? = null
    @Volatile private var runId: String? = null
    override fun getName() = "CapstoneNdt7"
    @ReactMethod @Synchronized fun run(id: String, consent: String, networkHandle: String, promise: Promise) {
        if (consent != "skymeasure-flight-mlab-2026-11-02") { promise.reject("CONSENT", "Review M-Lab publication consent first"); return }
        if (runId != null) { promise.reject("BUSY", "A reference test is running"); return }
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = manager.boundNetworkForProcess
        if (network == null || network.networkHandle.toString() != networkHandle || manager.getNetworkCapabilities(network)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) != true) {
            promise.reject("ROUTE", "Selected Wi-Fi is unavailable"); return
        }
        val prefs = context.getSharedPreferences("skymeasure.ndt7.frequency", Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val history = try { JSONArray(prefs.getString("starts", "[]")) } catch (_: Exception) { promise.reject("QUOTA", "Frequency history unavailable"); return }
        val starts = try {
            (0 until history.length()).map { history.getLong(it) }.also { values -> require(values.all { it >= 0 }) }.filter { it > now - 86400000 }
        } catch (_: Exception) { promise.reject("QUOTA", "Frequency history unavailable"); return }
        if (starts.size >= 4) { promise.reject("QUOTA", "Four M-Lab attempts already reserved in the last 24 hours"); return }
        // Commit before network traffic. Clock rollback retains future reservations.
        if (!prefs.edit().putString("starts", JSONArray(starts + now).toString()).commit()) { promise.reject("STORAGE", "Cannot reserve test"); return }
        val client = OkHttpClient.Builder()
            .socketFactory(network.socketFactory).dns(object : okhttp3.Dns { override fun lookup(hostname: String) = network.getAllByName(hostname).toList() })
            .followRedirects(false).followSslRedirects(false)
            .connectTimeout(8, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(10, TimeUnit.SECONDS).callTimeout(60, TimeUnit.SECONDS).build()
        val results = JSONArray()
        val callbacks = mutableMapOf<String, JSONArray>()
        val servers = mutableMapOf<String, Measurement>()
        val dropped = mutableMapOf<String, Int>()
        var overall = "complete"
        val started = System.nanoTime()
        val gson = Gson()
        fun log(direction: String, value: Any) {
            val rows = callbacks.getOrPut(direction) { JSONArray() }
            if (rows.length() >= 100) { dropped[direction] = (dropped[direction] ?: 0) + 1; return }
            rows.put(JSONObject().put("observedAt", SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())).put("elapsedMs", (System.nanoTime() - started) / 1e6).put("value", JSONObject(gson.toJson(value))))
        }
        val test = object : NDTTest(client, 90L * 1024 * 1024) {
            override fun onDownloadProgress(clientResponse: ClientResponse) = log("download", clientResponse)
            override fun onUploadProgress(clientResponse: ClientResponse) = log("upload", clientResponse)
            override fun onMeasurementDownloadProgress(measurement: Measurement) { servers["download"] = measurement; log("download", measurement) }
            override fun onMeasurementUploadProgress(measurement: Measurement) { servers["upload"] = measurement; log("upload", measurement) }
            override fun onFinished(clientResponse: ClientResponse?, error: Throwable?, testType: TestType) {
                val reason = error?.message?.takeIf { it in listOf("cancelled", "network", "timeout", "data_threshold", "invalid_response") } ?: if (error == null) "complete" else "network"
                if (reason != "complete") overall = reason
                if (host.isEmpty() || testType == TestType.DOWNLOAD_AND_UPLOAD) return
                val direction = testType.value
                val server = receiverCounters(servers[direction], direction == "upload")
                results.put(JSONObject().put("direction", direction).put("reason", reason).put("host", host)
                    .put("clientBytes", clientResponse?.appInfo?.numBytes ?: JSONObject.NULL)
                    .put("clientSeconds", clientResponse?.appInfo?.elapsedTime?.div(1e6) ?: JSONObject.NULL)
                    .put("serverBytes", server?.bytes ?: JSONObject.NULL)
                    .put("serverSeconds", server?.seconds ?: JSONObject.NULL)
                    .put("serverCounterSource", server?.source ?: JSONObject.NULL)
                    .put("opened", opened).put("cleanClose", error == null && opened)
                    .put("callbacks", callbacks[direction] ?: JSONArray()).put("droppedCallbacks", dropped[direction] ?: 0))
            }
        }
        runId = id
        active = test
        val deadline = watchdog.schedule({ test.stopTest("timeout") }, 60, TimeUnit.SECONDS)
        worker.submit {
            try {
                test.startTest(NDTTest.TestType.DOWNLOAD_AND_UPLOAD)
                test.stopReason?.let { overall = it }
            } catch (_: Exception) { overall = "network" }
            finally {
                test.stopTest()
                deadline.cancel(false)
                client.dispatcher.cancelAll()
                client.connectionPool.evictAll()
                client.dispatcher.executorService.shutdown()
                synchronized(this) { active = null; runId = null }
                promise.resolve(JSONObject().put("version", 1).put("runId", id).put("type", "finished").put("reason", overall).put("results", results).toString())
            }
        }
    }
    @ReactMethod fun cancel(id: String) { if (runId == id) active?.stopTest() }
    override fun invalidate() { active?.stopTest(); worker.shutdown(); watchdog.shutdownNow(); super.invalidate() }
}
