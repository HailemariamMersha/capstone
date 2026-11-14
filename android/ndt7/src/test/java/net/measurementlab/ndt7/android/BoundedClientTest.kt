package net.measurementlab.ndt7.android
import net.measurementlab.ndt7.android.models.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okio.ByteString
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.*
import java.util.concurrent.atomic.AtomicInteger

class BoundedClientTest {
    private fun exercise(upload: Boolean, limit: Long?, action: (WebSocket) -> Unit): Pair<ClientResponse, Throwable?> {
        val server = MockWebServer()
        val client = OkHttpClient()
        val worker = Executors.newSingleThreadExecutor()
        val done = CountDownLatch(1)
        val count = AtomicInteger()
        var result: ClientResponse? = null
        var error: Throwable? = null
        val registry = CallbackRegistry({}, {}, { r, e, _ -> result = r; error = e; count.incrementAndGet(); done.countDown() }, {}, limit)
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) { action(ws) }
            override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(code, null) }
        }))
        server.start()
        val url = server.url("/ndt/v7/${if (upload) "upload" else "download"}").toString()
        val down = Downloader(registry, worker, Semaphore(0))
        val up = Uploader(registry, worker, Semaphore(0))
        try {
            if (upload) up.beginUpload(url, client) else down.beginDownload(url, client)
            assertTrue("client must finish", done.await(5, TimeUnit.SECONDS))
            if (upload) up.cancel() else down.cancel()
            assertEquals(1, count.get())
            assertNotNull(result)
            return Pair(result!!, error)
        } finally {
            client.dispatcher.cancelAll(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdownNow()
            worker.shutdownNow(); server.close()
        }
    }
    @Test fun downloadCapRetainsBytesAndIsNotSuccess() {
        val (result, error) = exercise(false, 1024) { it.send(ByteString.of(*ByteArray(2048))) }
        assertEquals("data_threshold", error?.message)
        assertEquals(2048.0, result.appInfo.numBytes, 0.0)
    }
    @Test fun cleanDownloadCountsOnlyBinaryPayload() {
        val (result, error) = exercise(false, 10000) {
            it.send("{\"AppInfo\":{\"ElapsedTime\":1000000,\"NumBytes\":2048}}")
            it.send(ByteString.of(*ByteArray(2048))); it.close(1000, null)
        }
        assertNull(error); assertEquals(2048.0, result.appInfo.numBytes, 0.0)
    }
    @Test fun uploadRespectsLimitAndTerminates() {
        val (result, error) = exercise(true, 8192) { }
        assertEquals("data_threshold", error?.message)
        assertTrue(result.appInfo.numBytes <= 8192)
    }
    @Test fun nullLimitAllowsCleanDownloadPastAnExplicitCap() {
        val (result, error) = exercise(false, null) {
            it.send(ByteString.of(*ByteArray(16384))); it.close(1000, null)
        }
        assertNull(error); assertEquals(16384.0, result.appInfo.numBytes, 0.0)
    }
    @Test fun abnormalCloseIsNotSuccess() {
        val (_, error) = exercise(false, 10000) { it.close(1008, "test") }
        assertEquals("network", error?.message)
    }
}
