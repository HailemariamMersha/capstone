package com.labpracticeapp.diagnostics

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.facebook.react.bridge.*
import com.labpracticeapp.BuildConfig
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Runs against the installed bundled release. No third-party speed test is started. */
@RunWith(AndroidJUnit4::class)
class AdapterSmokeTest {
    private class Reply {
        val latch = CountDownLatch(1)
        var result: ReadableMap? = null
        var error: ReadableMap? = null
        val promise = PromiseImpl(
            Callback { args -> result = args[0] as ReadableMap; latch.countDown() },
            Callback { args -> error = args[0] as ReadableMap; latch.countDown() }
        )
        fun await() { assertTrue("Native adapter did not settle", latch.await(55, TimeUnit.SECONDS)) }
    }
    private fun context() = BridgeReactContext(ApplicationProvider.getApplicationContext())

    @Test fun udpLoopbackReachesDestinationAndCleansUp() {
        val module = TracerouteModule(context())
        try {
            val first = Reply()
            module.trace("loopback", "127.0.0.1", 3, 1, first.promise)
            first.await()
            assertNull(first.error)
            val result = first.result!!
            assertEquals("complete", result.getString("reason"))
            val samples = result.getArray("samples")!!
            assertTrue("No loopback probe result", samples.size() > 0)
            val destination = (0 until samples.size()).map { samples.getMap(it)!! }.any {
                it.getString("kind") == "port_unreachable" && it.getString("address") == "127.0.0.1"
            }
            assertTrue("Loopback UDP did not expose destination port-unreachable", destination)
            val next = Reply()
            module.trace("next", "127.0.0.1", 1, 1, next.promise)
            next.await()
            assertNull("Previous native resources still busy", next.error)
        } finally { module.invalidate() }
    }
    @Test fun cancellationSettlesAndInvalidParametersSendNoProbes() {
        val module = TracerouteModule(context())
        try {
            val invalid = Reply()
            module.trace("invalid", "127.0.0.1", 1000, 3, invalid.promise)
            invalid.await()
            assertEquals("invalid_config", invalid.error!!.getString("code"))
            val running = Reply()
            module.trace("cancel", "192.0.2.1", 20, 3, running.promise)
            module.cancel("cancel")
            running.await()
            assertEquals("cancelled", running.result!!.getString("reason"))
        } finally { module.invalidate() }
    }
    @Test fun speedCheckerRejectsMissingConsentWithoutStartingSdk() {
        if (!BuildConfig.SPEEDCHECKER_ENABLED) return
        val module = DiagnosticsPackage().createNativeModules(context()).first { it.name == "CapstoneSpeedChecker" }
        try {
            val reply = Reply()
            module.javaClass.getMethod("start", String::class.java, Boolean::class.javaPrimitiveType, Promise::class.java)
                .invoke(module, "consent-test", false, reply.promise)
            reply.await()
            assertEquals("consent_required", reply.error!!.getString("code"))
        } finally { module.invalidate() }
    }
}
