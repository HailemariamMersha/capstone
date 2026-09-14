package com.labpracticeapp

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log

class MeasurementService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var activeSessionId: String? = null
  private val heartbeat = object : Runnable {
    override fun run() {
      if (MeasurementRuntime.state != "running") return
      MeasurementRuntime.heartbeat()
      Log.i(TAG, "Heartbeat session=$activeSessionId")
      handler.postDelayed(this, 60_000)
    }
  }

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= 26) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL, "Measurement sessions", NotificationManager.IMPORTANCE_LOW)
      )
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      MeasurementRuntime.stop(this)
      stopSelf()
      return START_NOT_STICKY
    }
    val requestedId = intent?.getStringExtra("sessionId")
    if (requestedId == null || requestedId != MeasurementRuntime.sessionId ||
        MeasurementRuntime.state !in listOf("starting", "running")) {
      stopSelf()
      return START_NOT_STICKY
    }
    if (activeSessionId == requestedId) return START_NOT_STICKY
    activeSessionId = requestedId
    try {
      val notification = notification()
      if (Build.VERSION.SDK_INT >= 34) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      MeasurementRuntime.running()
      Log.i(TAG, "Started session=$activeSessionId")
      handler.post(heartbeat)
    } catch (exception: Exception) {
      Log.e(TAG, "Foreground startup failed", exception)
      MeasurementRuntime.failed(exception)
      stopSelf()
    }
    return START_NOT_STICKY
  }

  private fun notification(): Notification {
    val open = PendingIntent.getActivity(this, 0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val stop = PendingIntent.getService(this, 1,
      Intent(this, MeasurementService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
    return builder.setSmallIcon(R.drawable.ic_measurement)
      .setContentTitle("Capstone session active")
      .setContentText("Native service proof • no network probes yet")
      .setContentIntent(open)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(true)
      .setWhen(System.currentTimeMillis())
      .setUsesChronometer(true)
      .addAction(Notification.Action.Builder(null, "Stop session", stop).build())
      .build()
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    stopForeground(STOP_FOREGROUND_REMOVE)
    Log.i(TAG, "Stopped session=$activeSessionId")
    // Ignore destruction of an obsolete instance if a different session has since started.
    if ((activeSessionId != null && activeSessionId == MeasurementRuntime.sessionId) ||
        MeasurementRuntime.state == "stopping") MeasurementRuntime.stopped()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  companion object {
    private const val TAG = "MeasurementService"
    private const val CHANNEL = "measurement_sessions"
    private const val NOTIFICATION_ID = 1001
    private const val ACTION_STOP = "com.labpracticeapp.STOP_MEASUREMENT"
  }
}
