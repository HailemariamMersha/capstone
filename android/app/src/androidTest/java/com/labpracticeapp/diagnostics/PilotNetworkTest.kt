package com.labpracticeapp.diagnostics

import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.labpracticeapp.MainApplication
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.TimeUnit

/** Opt-in context-only check: no speed test, credentials, public IP or Wi-Fi identifiers in the report. */
@RunWith(AndroidJUnit4::class)
class PilotNetworkTest {
    @Test fun inspectSelectedWifiAsn() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Explicit network inspection required", args.getString("inspectNetwork") == "true")
        assertTrue(com.labpracticeapp.BuildConfig.FLIGHT_PILOT)
        val api = args.getString("apiUrl") ?: error("Public API URL required")
        require(api == "https://api.hailemariam.com")
        val app = ApplicationProvider.getApplicationContext<MainApplication>()
        val manager = app.getSystemService(android.content.Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val wifi = manager.allNetworks.firstOrNull { manager.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true }
        assumeTrue("Wi-Fi required", wifi != null)
        assumeTrue("VPN attribution unsupported", manager.allNetworks.none { manager.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true })
        val client = OkHttpClient.Builder().socketFactory(wifi!!.socketFactory)
            .dns(object : okhttp3.Dns { override fun lookup(hostname: String) = wifi.getAllByName(hostname).toList() })
            .followRedirects(false).callTimeout(15, TimeUnit.SECONDS).build()
        try {
            client.newCall(Request.Builder().url("$api/api/v1/context").build()).execute().use { response ->
                assertEquals(200, response.code)
                val body = JSONObject(response.body!!.string())
                val report = JSONObject().put("pilotBuild", true).put("asn", body.opt("asn"))
                    .put("asnOrganization", body.opt("asnOrganization")).put("asnUnavailable", body.opt("asnUnavailable"))
                    .put("matchesPilotTestAsn", body.optInt("asn", -1) == 12)
                File(app.filesDir, "pilot-network-check.json").writeText(report.toString())
                assertTrue("ASN must be available", body.optInt("asn", -1) > 0)
            }
        } finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdownNow() }
    }
}
