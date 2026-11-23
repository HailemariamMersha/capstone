package com.labpracticeapp.diagnostics

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Opt-in aggregate-only inspection. Instrumentation restarts the app: use while stopped. */
@RunWith(AndroidJUnit4::class)
class UploadQueueStatusTest {
    @Test fun inspectStoppedUploadQueue() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("inspectUploadQueue") == "true")
        val context = ApplicationProvider.getApplicationContext<Context>()
        val report = JSONObject()
        SQLiteDatabase.openDatabase(context.getDatabasePath("capstone.sqlite").path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
            db.rawQuery("SELECT COUNT(*) FROM sessions WHERE state='active'", null).use { c ->
                c.moveToFirst(); check(c.getInt(0) == 0) { "Stop collection before inspection" }
            }
            val statuses = JSONArray()
            db.rawQuery("SELECT upload_status,COUNT(*) FROM sessions GROUP BY upload_status", null).use { c ->
                while (c.moveToNext()) statuses.put(JSONObject().put("status", c.getString(0) ?: JSONObject.NULL).put("sessions", c.getInt(1)))
            }
            val queue = JSONArray()
            db.rawQuery("SELECT state,COUNT(*),MAX(attempts),MIN(next_attempt_at) FROM sync_queue GROUP BY state", null).use { c ->
                while (c.moveToNext()) queue.put(JSONObject().put("state", c.getString(0)).put("records", c.getInt(1)).put("maxAttempts", c.getInt(2)).put("nextAttemptAtMs", c.getLong(3)))
            }
            val failures = JSONArray()
            // Return fixed categories only, never stored exception text or record payloads.
            db.rawQuery("SELECT CASE WHEN last_error LIKE '%timeout%' OR last_error LIKE '%timed out%' THEN 'timeout' WHEN last_error IS NULL THEN 'none' ELSE 'other' END,COUNT(*) FROM sync_queue WHERE state='pending' GROUP BY 1", null).use { c ->
                while (c.moveToNext()) failures.put(JSONObject().put("category", c.getString(0)).put("records", c.getInt(1)))
            }
            val retries = JSONArray()
            db.rawQuery("SELECT value_json FROM app_settings WHERE key LIKE 'upload-retry:%'", null).use { c ->
                while (c.moveToNext()) {
                    val saved = JSONObject(c.getString(0))
                    val safe = JSONObject().put("attempts", saved.optInt("attempts")).put("nextAt", saved.optLong("nextAt"))
                    for (key in listOf("stage", "code", "status")) if (saved.has(key)) safe.put(key, saved.get(key))
                    retries.put(safe)
                }
            }
            report.put("sessions", statuses).put("queue", queue).put("pendingErrors", failures).put("sessionRetries", retries)
        }
        InstrumentationRegistry.getInstrumentation().sendStatus(0, android.os.Bundle().apply { putString("uploadQueueStatus", report.toString()) })
    }
}
