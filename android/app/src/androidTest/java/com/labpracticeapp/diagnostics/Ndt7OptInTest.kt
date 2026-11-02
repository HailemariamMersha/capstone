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
        assumeTrue("Public IP/results publication needs explicit opt-in", InstrumentationRegistry.getArguments().getString("mlabPublicationConsent") == "skymeasure-flight-mlab-2026-11-02")
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
            module.run("opt-in-device-check", "skymeasure-flight-mlab-2026-11-02", wifi!!.networkHandle.toString(), promise)
            assertTrue("Bounded client callback", done.await(70, TimeUnit.SECONDS))
            assertNull("Native invocation failed", error)
            val data = JSONObject(result!!)
            File(context.filesDir, "ndt7-opt-in-device-check.json").writeText(data.toString())
            assertEquals("finished", data.getString("type"))
            assertEquals("Both directions must report", 2, data.getJSONArray("results").length())
            // A capped run is valid evidence but not a successful complete speed benchmark.
            for (i in 0..1) assertTrue(data.getJSONArray("results").getJSONObject(i).getBoolean("opened"))
        } finally {
            module.invalidate()
            manager.bindProcessToNetwork(prior)
        }
    }
}
