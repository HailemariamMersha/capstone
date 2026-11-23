package com.labpracticeapp.diagnostics

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.DataOutputStream
import java.net.Socket
import java.security.MessageDigest

/** Explicit connected-device maintenance only. Never opens Keychain or resets app identity. */
@RunWith(AndroidJUnit4::class)
class HistoryMaintenanceTest {
    private val evidence = listOf("trips", "trip_payments", "sessions", "measurements", "connectivity_events", "network_snapshots", "sync_queue", "debug_logs")
    private val preserved = listOf("device_info", "app_settings")
    private fun hash(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer=ByteArray(65536); while(true) { val n=input.read(buffer); if(n<0)break; digest.update(buffer,0,n) } }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    }
    private fun inventory(db: SQLiteDatabase): JSONObject {
        val result=JSONObject()
        for(table in evidence+preserved) {
            val digest=MessageDigest.getInstance("SHA-256"); var count=0
            db.rawQuery("SELECT * FROM $table ORDER BY " + db.rawQuery("PRAGMA table_info($table)",null).use { c ->
                val names=mutableListOf<String>(); while(c.moveToNext())names.add('"'+c.getString(1)+'"'); names.joinToString(",")
            },null).use { c ->
                while(c.moveToNext()) {
                    val row=JSONArray()
                    for(i in 0 until c.columnCount) row.put(when(c.getType(i)) {
                        Cursor.FIELD_TYPE_NULL -> JSONObject.NULL
                        Cursor.FIELD_TYPE_INTEGER -> c.getLong(i)
                        Cursor.FIELD_TYPE_FLOAT -> c.getDouble(i)
                        Cursor.FIELD_TYPE_BLOB -> android.util.Base64.encodeToString(c.getBlob(i),android.util.Base64.NO_WRAP)
                        else -> c.getString(i)
                    })
                    digest.update((row.toString()+"\n").toByteArray(Charsets.UTF_8));count++
                }
            }
            result.put(table,JSONObject().put("count",count).put("sha256",digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }))
        }
        return result
    }
    @Test fun maintainStoppedHistory() {
        val args=InstrumentationRegistry.getArguments()
        val operation=args.getString("historyMaintenance")
        assumeTrue("Explicit history backup/cleanup opt-in required",operation in listOf("backup","clear","discardBackup"))
        val context=ApplicationProvider.getApplicationContext<Context>()
        val directory=File(context.getExternalFilesDir(null),"history-maintenance").apply{mkdirs()}
        val name=args.getString("archiveName") ?: "history.sqlite"
        require(name.matches(Regex("[a-zA-Z0-9_-]+\\.sqlite")))
        val target=File(directory,name);val manifestFile=File(directory,"$name.manifest.json");val paymentsFile=File(directory,"$name.payments.json")
        val report=JSONObject()
        if(operation=="discardBackup") {
            check(args.getString("archiveVerified")=="true")
            val manifest=JSONObject(manifestFile.readText())
            check(args.getString("expectedBackupSha256")==manifest.getString("databaseSha256"))
            check(hash(target)==manifest.getString("databaseSha256")&&hash(paymentsFile)==manifest.getString("paymentSha256"))
            val files=mutableListOf(target,paymentsFile,manifestFile)
            args.getString("discardFailedArchiveName")?.let { failed ->
                require(failed!=name&&failed.matches(Regex("[a-zA-Z0-9_-]+\\.sqlite")))
                files.addAll(listOf(File(directory,failed),File(directory,"$failed.payments.json"),File(directory,"$failed.manifest.json")))
            }
            files.forEach { check(!it.exists()||it.delete()) }
            InstrumentationRegistry.getInstrumentation().sendStatus(0,android.os.Bundle().apply { putString("historyMaintenanceStatus","{\"operation\":\"discardBackup\",\"hostCopyRetained\":true}") })
            return
        }
        SQLiteDatabase.openDatabase(context.getDatabasePath("capstone.sqlite").path,null,SQLiteDatabase.OPEN_READWRITE).use { db ->
            if(operation=="backup") {
                check(!target.exists()&&!manifestFile.exists()&&!paymentsFile.exists()) { "Do not overwrite a previous archive" }
                val before=inventory(db)
                db.execSQL("VACUUM INTO ?",arrayOf(target.absolutePath))
                SQLiteDatabase.openDatabase(target.path,null,SQLiteDatabase.OPEN_READWRITE).use { copy ->
                    copy.rawQuery("PRAGMA integrity_check",null).use { c->check(c.moveToFirst()&&c.getString(0)=="ok") }
                    check(inventory(copy).toString()==before.toString()) { "Restored archive differs" }
                    val payments=JSONArray();val columns=JSONArray()
                    copy.rawQuery("SELECT * FROM trip_payments ORDER BY trip_id",null).use { c ->
                        c.columnNames.forEach { columns.put(it) }
                        while(c.moveToNext()) { val row=JSONArray();for(i in 0 until c.columnCount)row.put(if(c.isNull(i))JSONObject.NULL else if(c.getType(i)==Cursor.FIELD_TYPE_INTEGER)c.getLong(i) else c.getString(i));payments.put(row) }
                    }
                    paymentsFile.writeText(JSONObject().put("columns",columns).put("rows",payments).toString())
                    copy.rawQuery("PRAGMA secure_delete=ON",null).use { it.moveToFirst() }
                    copy.execSQL("DELETE FROM trip_payments");copy.execSQL("VACUUM")
                }
                check(inventory(db).toString()==before.toString()) { "History changed during backup; retry with a new archive" }
                val manifest=JSONObject().put("version",1).put("databaseSha256",hash(target)).put("paymentSha256",hash(paymentsFile)).put("tables",before)
                manifestFile.writeText(manifest.toString())
                report.put("operation","backup").put("databaseSha256",hash(target)).put("bytes",target.length()).put("tables",before)
                args.getString("hostTransferPort")?.toInt()?.let { port ->
                    require(port in 1024..65535)
                    Socket("127.0.0.1",port).use { socket ->
                        DataOutputStream(socket.getOutputStream()).use { output ->
                            val files=listOf(target,paymentsFile,manifestFile)
                            output.writeInt(files.size)
                            for(file in files) {
                                output.writeUTF(file.name);output.writeLong(file.length())
                                file.inputStream().use { it.copyTo(output) }
                            }
                            output.flush()
                        }
                    }
                    report.put("hostTransferCompleted",true)
                }
            } else {
                check(args.getString("archiveVerified")=="true") { "A verified host archive is required" }
                val manifest=JSONObject(manifestFile.readText())
                val expected=args.getString("expectedBackupSha256")
                check(expected!=null&&expected==manifest.getString("databaseSha256")&&hash(target)==expected&&hash(paymentsFile)==manifest.getString("paymentSha256")) { "Archive checksum mismatch" }
                db.beginTransaction()
                try {
                    check(inventory(db).toString()==manifest.getJSONObject("tables").toString()) { "History changed after backup; create and verify a fresh archive" }
                    for(table in listOf("sync_queue","measurements","connectivity_events","network_snapshots","debug_logs","trip_payments","trips")) db.execSQL("DELETE FROM $table")
                    db.execSQL("UPDATE sessions SET resumed_from_id=NULL");db.execSQL("DELETE FROM sessions")
                    db.execSQL("DELETE FROM app_settings WHERE key LIKE 'upload-retry:%' OR key LIKE 'upload-batch:%'")
                    db.execSQL("INSERT OR REPLACE INTO app_settings(key,value_json) VALUES ('history-reset',?)",arrayOf(System.currentTimeMillis().toString()))
                    val after=inventory(db)
                    for(table in evidence)check(after.getJSONObject(table).getInt("count")==0)
                    check(after.getJSONObject("device_info").toString()==manifest.getJSONObject("tables").getJSONObject("device_info").toString())
                    db.setTransactionSuccessful()
                    report.put("operation","clear").put("tables",after).put("identityStorageUntouched",true)
                } finally { db.endTransaction() }
            }
        }
        InstrumentationRegistry.getInstrumentation().sendStatus(0,android.os.Bundle().apply{putString("historyMaintenanceStatus",report.toString())})
    }
}
