package com.labpracticeapp.diagnostics

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Never contacts public M-Lab in a normal test run. Requires explicit informed opt-in. */
@RunWith(AndroidJUnit4::class)
class Ndt7OptInTest {
    @Test fun publicPairOnSelectedWifi() {
        assumeTrue("Public IP/results publication needs explicit opt-in", InstrumentationRegistry.getArguments().getString("mlabPublicationConsent") == "skymeasure-flight-pilot-2026-11-14")
        val context = BridgeReactContext(ApplicationProvider.getApplicationContext())
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        assertFalse("Disable VPN for attribution", manager.allNetworks.any { manager.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true })
        val wifi = manager.allNetworks.firstOrNull { manager.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true }
        assertNotNull("Wi-Fi required", wifi)
        val prior = manager.boundNetworkForProcess
        assertTrue(manager.bindProcessToNetwork(wifi))
        val module = Ndt7Module(context)
        val done = CountDownLatch(1)
        var result: String? = null
        var error: Any? = null
        val promise = PromiseImpl(Callback { args -> result = args[0] as String; done.countDown() }, Callback { args -> error = args[0]; done.countDown() })
        try {
            module.run("opt-in-device-check", "skymeasure-flight-pilot-2026-11-14", wifi!!.networkHandle.toString(), com.labpracticeapp.BuildConfig.FLIGHT_PILOT, promise)
            assertTrue("Bounded client callback", done.await(70, TimeUnit.SECONDS))
            assertNull("Native invocation failed", error)
            val data = JSONObject(result!!)
            File(context.filesDir, "ndt7-opt-in-device-check.json").writeText(data.toString())
            val summary = JSONObject(data.toString())
            for (i in 0 until summary.getJSONArray("results").length()) {
                summary.getJSONArray("results").getJSONObject(i).remove("callbacks")
            }
            InstrumentationRegistry.getInstrumentation().sendStatus(0, android.os.Bundle().apply {
                putString("mlabSummary", summary.toString())
            })
            assertEquals("finished", data.getString("type"))
            assertEquals("Both directions must report", 2, data.getJSONArray("results").length())
            // A capped run is valid evidence but not a successful complete speed benchmark.
            for (i in 0..1) assertTrue(data.getJSONArray("results").getJSONObject(i).getBoolean("opened"))
        } finally {
            module.invalidate()
            manager.bindProcessToNetwork(prior)
        }
    }
    @Test fun inspectSavedResultWithoutNetwork() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val file = File(context.filesDir, "ndt7-opt-in-device-check.json")
        assumeTrue("No saved opt-in test", file.exists())
        val data = JSONObject(file.readText())
        val summary = org.json.JSONArray()
        val results = data.getJSONArray("results")
        for (i in 0 until results.length()) {
            val result = results.getJSONObject(i)
            val callbacks = result.getJSONArray("callbacks")
            val rows = org.json.JSONArray()
            for (j in 0 until callbacks.length()) {
                val value = callbacks.getJSONObject(j).getJSONObject("value")
                if (value.has("TCPInfo") || value.has("ConnectionInfo")) {
                    val tcp = value.optJSONObject("TCPInfo")
                    rows.put(JSONObject().put("keys", org.json.JSONArray(value.keys().asSequence().toList()))
                        .put("AppInfo", value.optJSONObject("AppInfo") ?: JSONObject.NULL)
                        .put("tcpBytesReceived", tcp?.opt("BytesReceived") ?: JSONObject.NULL)
                        .put("tcpElapsedTime", tcp?.opt("ElapsedTime") ?: JSONObject.NULL))
                }
            }
            val report = JSONObject().put("direction", result.getString("direction")).put("serverCallbacks", rows)
            if (result.getString("direction") == "upload" && rows.length() > 0) {
                val last = rows.getJSONObject(rows.length() - 1)
                val measurement = com.google.gson.Gson().fromJson(JSONObject().put("TCPInfo", JSONObject()
                    .put("BytesReceived", last.getLong("tcpBytesReceived"))
                    .put("ElapsedTime", last.getLong("tcpElapsedTime"))).toString(), net.measurementlab.ndt7.android.models.Measurement::class.java)
                val counters = net.measurementlab.ndt7.android.models.receiverCounters(measurement, true)
                assertNotNull("Replay must preserve valid server counters", counters)
                assertEquals("tcp_info", counters!!.source)
                report.put("replayedMbps", counters.bytes * 8 / counters.seconds / 1000000)
            }
            summary.put(report)
        }
        InstrumentationRegistry.getInstrumentation().sendStatus(0, android.os.Bundle().apply { putString("savedTelemetry", summary.toString()) })
    }

}
