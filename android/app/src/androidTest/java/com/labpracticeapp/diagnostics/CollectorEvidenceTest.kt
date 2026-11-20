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
            val requestedTrip = InstrumentationRegistry.getArguments().getString("diagnosticTrip")
            // Export every segment of the requested stopped trip, rather than
            // silently limiting a long-run audit to its newest eight segments.
            val selection = "SELECT * FROM sessions ORDER BY started_at DESC" + if (requestedTrip == null) " LIMIT 8" else ""
            db.rawQuery(selection, null).use { sessions ->
                while (sessions.moveToNext()) {
                    fun field(name: String): String? = sessions.getColumnIndex(name).let { if (it < 0 || sessions.isNull(it)) null else sessions.getString(it) }
                    val config = JSONObject(field("config_json")!!)
                    if (config.optString("collectorVersion") != "skymeasure-libraries-2") continue
                    if (requestedTrip != null && config.optString("tripId") != requestedTrip) continue
                    val id = field("id")!!
                    val session = JSONObject().put("id", id).put("state", field("state"))
                        .put("startedAt", field("started_at")).put("endedAt", field("ended_at") ?: JSONObject.NULL)
                        .put("lastObservedAt", field("last_observed_at")).put("resumedFromId", field("resumed_from_id") ?: JSONObject.NULL).put("config", config)
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
                    // Local retry metadata only; never export auth/app settings wholesale.
                    val upload = JSONObject().put("status", field("upload_status") ?: JSONObject.NULL)
                    db.rawQuery("SELECT value_json FROM app_settings WHERE key LIKE ?", arrayOf("upload-retry:%:$id")).use { rows ->
                        if (rows.moveToFirst()) upload.put("sessionRetry", JSONObject(rows.getString(0)))
                    }
                    val queue = JSONArray()
                    db.rawQuery("""SELECT state,COUNT(*),MIN(next_attempt_at),MAX(attempts) FROM sync_queue WHERE
                        (entity_type='session' AND entity_id=?) OR
                        (entity_type='measurement' AND entity_id IN (SELECT id FROM measurements WHERE session_id=?)) OR
                        (entity_type='event' AND entity_id IN (SELECT id FROM connectivity_events WHERE session_id=?)) OR
                        (entity_type='snapshot' AND entity_id IN (SELECT id FROM network_snapshots WHERE session_id=?)) GROUP BY state""",
                        arrayOf(id,id,id,id)).use { rows ->
                        while (rows.moveToNext()) queue.put(JSONObject().put("state",rows.getString(0))
                            .put("count",rows.getInt(1)).put("nextAttemptAtMs",rows.getLong(2)).put("maxAttempts",rows.getInt(3)))
                    }
                    val records = JSONArray()
                    db.rawQuery("""SELECT entity_type,entity_id,state,version,attempts,next_attempt_at,last_error FROM sync_queue WHERE
                        (entity_type='session' AND entity_id=?) OR
                        (entity_type='measurement' AND entity_id IN (SELECT id FROM measurements WHERE session_id=?)) OR
                        (entity_type='event' AND entity_id IN (SELECT id FROM connectivity_events WHERE session_id=?)) OR
                        (entity_type='snapshot' AND entity_id IN (SELECT id FROM network_snapshots WHERE session_id=?))""",
                        arrayOf(id,id,id,id)).use { rows ->
                        while (rows.moveToNext()) records.put(JSONObject().put("type",rows.getString(0)).put("id",rows.getString(1))
                            .put("state",rows.getString(2)).put("version",rows.getInt(3)).put("attempts",rows.getInt(4))
                            .put("nextAttemptAtMs",rows.getLong(5)).put("lastError",if(rows.isNull(6)) JSONObject.NULL else rows.getString(6).take(256)))
                    }
                    upload.put("records",records)
                    upload.put("queue",queue)
                    File(directory, "$id.json").writeText(JSONObject().put("schemaVersion", 4).put("session", session)
                        .put("measurements", measurements).put("events", events).put("snapshots", snapshots)
                        .put("localUploadDiagnostics",upload).toString())
                }
            }
            if (requestedTrip != null) {
                db.rawQuery("SELECT payload_json FROM trips WHERE id=?", arrayOf(requestedTrip)).use { rows ->
                    if (rows.moveToFirst()) {
                        val saved = JSONObject(rows.getString(0)).apply { remove("ownerId") }
                        File(directory, "$requestedTrip-trip.json").writeText(saved.toString())
                    }
                }
                db.rawQuery("SELECT uploaded FROM trip_payments WHERE trip_id=?", arrayOf(requestedTrip)).use { rows ->
                    val present = rows.moveToFirst()
                    val report = JSONObject().put("tripId", requestedTrip).put("mappingPresent", present)
                        .put("uploaded", present && rows.getInt(0) == 1)
                    File(directory, "$requestedTrip-payment-status.json").writeText(report.toString())
                }
                val states = JSONArray()
                db.rawQuery("SELECT payload_json FROM trips WHERE owner_id=(SELECT owner_id FROM trips WHERE id=?)", arrayOf(requestedTrip)).use { rows ->
                    while (rows.moveToNext()) {
                        val t = JSONObject(rows.getString(0))
                        states.put(JSONObject().put("id", t.optString("id")).put("state", t.optString("state"))
                            .put("revision", t.opt("revision")).put("uploadedRevision", t.opt("uploadedRevision") ?: JSONObject.NULL)
                            .put("segmentCount", t.opt("segmentCount")).put("policyVersion", t.optJSONObject("policy")?.optString("version")))
                    }
                }
                val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
                val caps = manager.getNetworkCapabilities(manager.activeNetwork)
                val report = JSONObject().put("trips", states)
                    .put("defaultWifi", caps?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI))
                    .put("defaultCellular", caps?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR))
                    .put("validated", caps?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED))
                InstrumentationRegistry.getInstrumentation().sendStatus(2, android.os.Bundle().apply {
                    putString("stoppedSyncState", report.toString())
                })
            }
        }
    }
}
