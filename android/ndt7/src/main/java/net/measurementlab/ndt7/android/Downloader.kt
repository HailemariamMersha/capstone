// Derived from upstream Downloader.kt; lifecycle/budget fixes documented in PATCHES.md.
package net.measurementlab.ndt7.android
import com.google.gson.Gson
import net.measurementlab.ndt7.android.models.*
import net.measurementlab.ndt7.android.utils.DataConverter.currentTimeInMicroseconds
import net.measurementlab.ndt7.android.utils.DataConverter.generateResponse
import net.measurementlab.ndt7.android.utils.SocketFactory
import okhttp3.*
import okio.ByteString
import java.util.concurrent.ExecutorService
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean

class Downloader(private val cbRegistry: CallbackRegistry, executor: ExecutorService, lock: Semaphore) : WebSocketListener() {
    private var startTime = 0L
    private var previous = 0L
    private var numBytes = 0.0
    private var controlBytes = 0L
    private val done = AtomicBoolean(false)
    private var webSocket: WebSocket? = null
    override fun onOpen(webSocket: WebSocket, response: Response) {
        if (done.get()) { webSocket.cancel(); return }
        startTime = currentTimeInMicroseconds(); previous = startTime; cbRegistry.onOpen()
    }
    @Synchronized override fun onMessage(webSocket: WebSocket, text: String) {
        if (done.get()) return
        controlBytes += text.toByteArray(Charsets.UTF_8).size
        if (controlBytes > 65536) { finish("invalid_response"); return }
        try { cbRegistry.measurementProgressCbk(Gson().fromJson(text, Measurement::class.java)) } catch (_: Exception) { finish("invalid_response") }
    }
    @Synchronized override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        if (done.get()) return
        numBytes += bytes.size
        val now = currentTimeInMicroseconds()
        if (now - previous >= 250000) {
            cbRegistry.speedtestProgressCbk(generateResponse(startTime, numBytes, NDTTest.TestType.DOWNLOAD)); previous = now
        }
        if (cbRegistry.byteLimit != null && numBytes >= cbRegistry.byteLimit) finish("data_threshold")
    }
    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(1000, null)
    }
    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        finish(if (code == 1000) null else "network")
    }
    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { finish("network") }
    @Synchronized fun beginDownload(url: String, httpClient: OkHttpClient?) {
        if (!done.get()) webSocket = SocketFactory.establishSocketConnection(url, httpClient, this)
    }
    fun cancel(reason: String = "cancelled") { finish(reason) }
    @Synchronized private fun finish(reason: String?) {
        if (!done.compareAndSet(false, true)) return
        webSocket?.cancel()
        val result = if (startTime > 0) generateResponse(startTime, numBytes, NDTTest.TestType.DOWNLOAD) else ClientResponse(AppInfo(0, 0.0), test="download")
        cbRegistry.onFinishedCbk(result, reason?.let { IllegalStateException(it) }, NDTTest.TestType.DOWNLOAD)
    }
}
