// Derived from m-lab/ndt7-client-android; see PATCHES.md and LICENSE.
package net.measurementlab.ndt7.android

import com.google.gson.Gson
import net.measurementlab.ndt7.android.models.*
import okhttp3.*
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Blocking orchestrator: callers own the worker thread and cancel before releasing routing. */
abstract class NDTTest(private val httpClient: OkHttpClient, private val byteLimit: Long) : DataPublisher {
    @Volatile private var stopped = false
    @Volatile private var call: Call? = null
    @Volatile private var cancelDirection: ((String) -> Unit)? = null
    @Volatile var stopReason: String? = null; private set
    var host: String = ""; private set
    @Volatile var opened: Boolean = false; private set
    fun stopTest(reason: String = "cancelled") {
        stopReason = reason
        stopped = true
        call?.cancel()
        cancelDirection?.invoke(reason)
    }
    fun startTest(testType: TestType) {
        if (stopped) return
        val request = Request.Builder().url("https://locate.measurementlab.net/v2/nearest/ndt/ndt7?client_name=skymeasure-android&client_version=0.2.1-skymeasure.1").build()
        val urls = try {
            val discovery = httpClient.newCall(request)
            call = discovery
            if (stopped) discovery.cancel()
            discovery.execute().use { response ->
                if (!response.isSuccessful || response.code == 204) throw IllegalStateException("discovery_unavailable")
                val source = response.body?.source() ?: throw IllegalStateException("empty_discovery")
                source.request(262145)
                val data = source.buffer.readByteArray()
                if (data.size > 262144) throw IllegalStateException("discovery_too_large")
                Gson().fromJson(String(data, Charsets.UTF_8), HostnameResponse::class.java).results?.firstOrNull()?.urls
                    ?: throw IllegalStateException("no_server")
            }
        } catch (e: Exception) {
            onFinished(null, IllegalStateException(if (stopped) stopReason ?: "cancelled" else "network"), testType)
            return
        } finally { call = null }
        val directions = if (testType == TestType.DOWNLOAD_AND_UPLOAD) listOf(TestType.DOWNLOAD, TestType.UPLOAD) else listOf(testType)
        for (direction in directions) {
            if (stopped) break
            val url = if (direction == TestType.DOWNLOAD) urls.ndt7DownloadWSS else urls.ndt7UploadWSS
            val uri = java.net.URI(url)
            if (uri.scheme != "wss" || !uri.host.orEmpty().endsWith(".measurement-lab.org") || uri.userInfo != null || uri.port !in listOf(-1, 443) || uri.path != "/ndt/v7/${direction.value}") {
                onFinished(null, IllegalStateException("invalid_response"), direction); break
            }
            host = uri.host
            opened = false
            val done = CountDownLatch(1)
            val completed = AtomicBoolean(false)
            val worker = Executors.newSingleThreadExecutor()
            val registry = CallbackRegistry(
                { if (direction == TestType.DOWNLOAD) onDownloadProgress(it) else onUploadProgress(it) },
                { if (direction == TestType.DOWNLOAD) onMeasurementDownloadProgress(it) else onMeasurementUploadProgress(it) },
                { result, error, type ->
                    if (completed.compareAndSet(false, true)) {
                        try { onFinished(result, error, type) } finally { done.countDown() }
                    }
                },
                { opened = true }, byteLimit
            )
            try {
                if (direction == TestType.DOWNLOAD) {
                    val downloader = Downloader(registry, worker, Semaphore(0))
                    cancelDirection = { downloader.cancel(it) }
                    if (stopped) downloader.cancel(stopReason ?: "cancelled") else downloader.beginDownload(url, httpClient)
                } else {
                    val uploader = Uploader(registry, worker, Semaphore(0))
                    cancelDirection = { uploader.cancel(it) }
                    if (stopped) uploader.cancel(stopReason ?: "cancelled") else uploader.beginUpload(url, httpClient)
                }
                if (!done.await(25, TimeUnit.SECONDS)) {
                    // Preserve explicit timeout before cancellation closes the socket.
                    if (completed.compareAndSet(false, true)) onFinished(null, IllegalStateException("timeout"), direction)
                }
            } finally {
                cancelDirection?.invoke("cancelled")
                cancelDirection = null
                worker.shutdownNow()
                worker.awaitTermination(2, TimeUnit.SECONDS)
            }
        }
    }
    enum class TestType(val value: String) { UPLOAD("upload"), DOWNLOAD("download"), DOWNLOAD_AND_UPLOAD("DownloadAndUpload") }
}
