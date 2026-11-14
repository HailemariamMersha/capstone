// Derived from upstream Uploader.kt; lifecycle/budget fixes documented in PATCHES.md.
package net.measurementlab.ndt7.android
import com.google.gson.Gson
import net.measurementlab.ndt7.android.models.*
import net.measurementlab.ndt7.android.utils.DataConverter.currentTimeInMicroseconds
import net.measurementlab.ndt7.android.utils.DataConverter.generateResponse
import net.measurementlab.ndt7.android.utils.PayloadTransformer
import net.measurementlab.ndt7.android.utils.SocketFactory
import okhttp3.*
import okio.ByteString
import java.util.concurrent.ExecutorService
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean

class Uploader(private val cbRegistry: CallbackRegistry, private val executor: ExecutorService, lock: Semaphore) : WebSocketListener() {
    private var startTime = 0L
    private var previous = 0L
    private var totalBytesSent = 0.0
    private var controlBytes = 0L
    private val done = AtomicBoolean(false)
    @Volatile private var closing = false
    private var socket: WebSocket? = null
    override fun onOpen(webSocket: WebSocket, response: Response) {
        if (done.get()) { webSocket.cancel(); return }
        startTime = currentTimeInMicroseconds(); previous = startTime; cbRegistry.onOpen()
        executor.submit { createBytePayloads(webSocket) }
    }
    @Synchronized override fun onMessage(webSocket: WebSocket, text: String) {
        if (done.get()) return
        controlBytes += text.toByteArray(Charsets.UTF_8).size
        if (controlBytes > 65536) { finish("invalid_response"); return }
        try { cbRegistry.measurementProgressCbk(Gson().fromJson(text, Measurement::class.java)) } catch (_: Exception) { finish("invalid_response") }
    }
    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        closing = true
        webSocket.close(1000, null)
    }
    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        finish(if (code == 1000) null else "network")
    }
    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { finish("network") }
    @Synchronized fun beginUpload(url: String, httpClient: OkHttpClient?) {
        if (!done.get()) socket = SocketFactory.establishSocketConnection(url, httpClient, this)
    }
    private fun createBytePayloads(ws: WebSocket) {
        var bytes = ByteString.of(*ByteArray(8192))
        try {
            while (!done.get() && !closing && currentTimeInMicroseconds() - startTime < 10000000) {
                synchronized(this) {
                    if (done.get()) return
                    bytes = PayloadTransformer.performDynamicTuning(bytes, ws.queueSize(), totalBytesSent)
                    if (cbRegistry.byteLimit != null && totalBytesSent + bytes.size > cbRegistry.byteLimit) { finish("data_threshold"); return }
                    if (ws.queueSize() + bytes.size < 16 * 1024 * 1024) {
                        if (!ws.send(bytes)) { finish("network"); return }
                        totalBytesSent += bytes.size
                    }
                    val now = currentTimeInMicroseconds()
                    if (now - previous >= 250000) {
                        cbRegistry.speedtestProgressCbk(generateResponse(startTime, (totalBytesSent - ws.queueSize()).coerceAtLeast(0.0), NDTTest.TestType.UPLOAD)); previous = now
                    }
                }
                // Avoid upstream's busy loop while retaining the WebSocket backpressure queue.
                Thread.sleep(1)
            }
            if (!done.get() && !closing) ws.close(1000, null)
            // Wait for server's final receiver counters and clean close, bounded by orchestrator.
        } catch (_: InterruptedException) { cancel() }
    }
    fun cancel(reason: String = "cancelled") { finish(reason) }
    @Synchronized private fun finish(reason: String?) {
        if (!done.compareAndSet(false, true)) return
        val queued = socket?.queueSize() ?: 0
        socket?.cancel()
        val result = if (startTime > 0) generateResponse(startTime, (totalBytesSent - queued).coerceAtLeast(0.0), NDTTest.TestType.UPLOAD) else ClientResponse(AppInfo(0, 0.0), test="upload")
        cbRegistry.onFinishedCbk(result, reason?.let { IllegalStateException(it) }, NDTTest.TestType.UPLOAD)
    }
}
