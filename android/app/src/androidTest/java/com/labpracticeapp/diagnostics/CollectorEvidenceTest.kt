package com.labpracticeapp.diagnostics

import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Opt-in local export. Run only AFTER stopping collection: instrumentation restarts the app. */
@RunWith(AndroidJUnit4::class)
class CollectorEvidenceTest {
    @Test fun exportStoppedCollectorSessions() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("inspectCollectorEvidence") == "true")
        val context = ApplicationProvider.getApplicationContext<Context>()
        SQLiteDatabase.openDatabase(context.getDatabasePath("capstone.sqlite").path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
            db.rawQuery("SELECT COUNT(*) FROM sessions WHERE state='active'", null).use { cursor ->
                cursor.moveToFirst()
                check(cursor.getInt(0) == 0) { "Stop collection before inspecting local evidence" }
            }
            val directory = File(context.getExternalFilesDir(null), "collector-validation").apply { mkdirs() }
            db.rawQuery("SELECT * FROM sessions ORDER BY started_at DESC LIMIT 8", null).use { sessions ->
                while (sessions.moveToNext()) {
                    fun field(name: String): String? = sessions.getColumnIndex(name).let { if (it < 0 || sessions.isNull(it)) null else sessions.getString(it) }
                    val config = JSONObject(field("config_json")!!)
                    if (config.optString("collectorVersion") != "skymeasure-libraries-2") continue
                    val id = field("id")!!
                    val session = JSONObject().put("id", id).put("state", field("state"))
                        .put("startedAt", field("started_at")).put("endedAt", field("ended_at") ?: JSONObject.NULL)
                        .put("lastObservedAt", field("last_observed_at")).put("config", config)
                    val measurements = JSONArray()
                    db.rawQuery("SELECT result_json,scheduled_at,state FROM measurements WHERE session_id=? ORDER BY timestamp,rowid", arrayOf(id)).use { rows ->
                        while (rows.moveToNext()) measurements.put(JSONObject(rows.getString(0)).put("scheduledAt", rows.getString(1)).put("state", rows.getString(2)))
                    }
                    val events = JSONArray()
                    db.rawQuery("SELECT id,timestamp,kind,details_json FROM connectivity_events WHERE session_id=? ORDER BY timestamp,rowid", arrayOf(id)).use { rows ->
                        while (rows.moveToNext()) events.put(JSONObject().put("id", rows.getString(0)).put("timestamp", rows.getString(1))
                            .put("kind", rows.getString(2)).put("details", JSONObject(rows.getString(3))))
                    }
                    val snapshots = JSONArray()
                    db.rawQuery("SELECT payload_json FROM network_snapshots WHERE session_id=? ORDER BY timestamp,rowid", arrayOf(id)).use { rows ->
                        while (rows.moveToNext()) snapshots.put(JSONObject(rows.getString(0)))
                    }
                    session.put("measurementCount", measurements.length())
                    File(directory, "$id.json").writeText(JSONObject().put("schemaVersion", 4).put("session", session)
                        .put("measurements", measurements).put("events", events).put("snapshots", snapshots).toString())
                }
            }
        }
    }
}
