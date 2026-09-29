package com.labpracticeapp.diagnostics

import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.labpracticeapp.MainActivity
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Starts the actual bundled JS app; catches missing RN core registration that socket tests cannot. */
@RunWith(AndroidJUnit4::class)
class AppLaunchTest {
    private fun containsText(view: View, text: String): Boolean {
        if (view is TextView && view.text.toString().contains(text)) return true
        if (view is ViewGroup) for (i in 0 until view.childCount) {
            if (containsText(view.getChildAt(i), text)) return true
        }
        return false
    }
    @Test fun bundledAppRendersWithoutStartingMeasurements() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val deadline = android.os.SystemClock.elapsedRealtime() + 15000
            var rendered = false
            while (!rendered && android.os.SystemClock.elapsedRealtime() < deadline) {
                scenario.onActivity { activity ->
                    rendered = containsText(activity.window.decorView, "Packet measurement session")
                }
                if (!rendered) Thread.sleep(100)
            }
            assertTrue("Bundled React Native screen did not render", rendered)
        }
    }
}
