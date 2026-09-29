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
