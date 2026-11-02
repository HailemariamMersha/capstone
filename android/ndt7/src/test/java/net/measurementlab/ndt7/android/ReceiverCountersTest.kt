package net.measurementlab.ndt7.android
import com.google.gson.Gson
import net.measurementlab.ndt7.android.models.*
import org.junit.Assert.*
import org.junit.Test

class ReceiverCountersTest {
    @Test fun realSanitizedUploadUsesExplicitServerTcpProvenance() {
        val raw = javaClass.classLoader!!.getResource("server-upload-sanitized.json")!!.readText()
        val measurement = Gson().fromJson(raw, Measurement::class.java)
        val result = receiverCounters(measurement, true)!!
        assertEquals("tcp_info", result.source)
        assertEquals(61.4253572, result.bytes * 8 / result.seconds / 1000000, 0.00001)
        assertNull("Server ACK-side bytes are not download receiver bytes", receiverCounters(measurement, false))
    }
    @Test fun appPayloadCountersTakePrecedenceAndMissingValuesStayMissing() {
        val measurement = Gson().fromJson("""{"AppInfo":{"NumBytes":1000,"ElapsedTime":1000000},"TCPInfo":{"BytesReceived":2000,"ElapsedTime":1000000}}""", Measurement::class.java)
        assertEquals("app_info", receiverCounters(measurement, true)?.source)
        assertEquals(1000.0, receiverCounters(measurement, true)!!.bytes, 0.0)
        assertNull(receiverCounters(null, true))
        assertNull(receiverCounters(Gson().fromJson("""{"TCPInfo":{"BytesReceived":0,"ElapsedTime":0}}""", Measurement::class.java), true))
    }
}
