package com.labpracticeapp.diagnostics

import androidx.test.core.app.ApplicationProvider
import androidx.test.core.app.ActivityScenario
import com.labpracticeapp.MainActivity
import com.labpracticeapp.MainApplication
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.*
import com.oblador.keychain.KeychainModule
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Explicit, read-only diagnostic. Credentials stay in memory and go only to their existing services. */
@RunWith(AndroidJUnit4::class)
class AuthConnectivityTest {
    @Test fun inspectSavedSessionAgainstItsServices() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Saved-auth inspection requires opt-in", args.getString("inspectSavedAuth") == "true")
        val authUrl = args.getString("authUrl") ?: error("Public auth configuration required")
        val apiUrl = args.getString("apiUrl") ?: error("Public API configuration required")
        require(authUrl == "https://ospntgsbsmssfeqwtwbl.supabase.co" && apiUrl == "https://api.hailemariam.com")
        val publicKey = args.getString("publishableKey") ?: error("Public key required")
        require(publicKey.startsWith("sb_publishable_"))
        val application = ApplicationProvider.getApplicationContext<MainApplication>()
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        val deadline = android.os.SystemClock.elapsedRealtime() + 15000
        while (application.reactHost.currentReactContext == null && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(100)
        val context = application.reactHost.currentReactContext as ReactApplicationContext
        // Reuse the app's module: Android DataStore prohibits two instances for one file.
        val keychain = context.getNativeModule(KeychainModule::class.java)!!
        val report = JSONObject()
        val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).callTimeout(15, TimeUnit.SECONDS).build()
        try {
            for (service in listOf("skymeasure.skymeasure.auth", "skymeasure.participant.identity")) {
                val done = CountDownLatch(1)
                var value: ReadableMap? = null
                var failed = false
                var storageCode: String? = null
                keychain.getGenericPasswordForOptions(Arguments.createMap().apply { putString("service", service); putMap("authenticationPrompt", Arguments.createMap().apply { putString("title", "SkyMeasure secure storage"); putString("cancel", "Cancel") }) }, PromiseImpl(
                    Callback { a -> value = a.firstOrNull() as? ReadableMap; done.countDown() },
                    Callback { a -> failed = true; storageCode = (a.firstOrNull() as? ReadableMap)?.getString("code"); done.countDown() }
                ))
                assertTrue("Secure storage callback", done.await(10, TimeUnit.SECONDS))
                val summary = JSONObject().put("present", value != null).put("storageError", failed).put("storageCode", storageCode ?: JSONObject.NULL)
                report.put(service.substringAfter("skymeasure."), summary)
                if (value == null) continue
                val saved = JSONObject(value!!.getString("password")!!)
                val user = saved.optJSONObject("user")
                summary.put("anonymous", user?.optBoolean("is_anonymous"))
                    .put("provider", user?.optJSONObject("app_metadata")?.optString("provider"))
                    .put("expired", saved.optLong("expires_at") * 1000 < System.currentTimeMillis())
                val token = saved.optString("access_token")
                if (token.isEmpty()) continue
                client.newCall(Request.Builder().url("$authUrl/auth/v1/user").header("apikey", publicKey).header("Authorization", "Bearer $token").build()).execute().use { response ->
                    summary.put("supabaseStatus", response.code)
                    if (response.isSuccessful) {
                        val current = JSONObject(response.body!!.string())
                        summary.put("sameOwner", current.optString("id") == user?.optString("id"))
                    }
                }
                client.newCall(Request.Builder().url("$apiUrl/api/v2/profile").header("Authorization", "Bearer $token").build()).execute().use { response ->
                    summary.put("profileStatus", response.code)
                    val body = JSONObject(response.body!!.string())
                    if (response.isSuccessful) summary.put("role", body.optString("role"))
                    else {
                        val detail = body.optString("detail")
                        val safe = setOf("Sign in again before uploading", "Sign in required", "Invalid account", "Account deletion requested; uploads are disabled", "Authentication temporarily unavailable")
                        summary.put("profileReason", if (detail in safe) detail else "other_service_error")
                    }
                }
            }
            InstrumentationRegistry.getInstrumentation().sendStatus(0, android.os.Bundle().apply { putString("authStatus", report.toString()) })
        } finally {
            client.dispatcher.cancelAll(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown()
            scenario.close()
        }
    }
}
