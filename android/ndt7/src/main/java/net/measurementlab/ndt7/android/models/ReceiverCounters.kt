package net.measurementlab.ndt7.android.models

/** Provenance must travel with the value: TCP counters include TLS/WebSocket overhead. */
data class ReceiverCounters(val bytes: Double, val seconds: Double, val source: String)
fun receiverCounters(measurement: Measurement?, upload: Boolean): ReceiverCounters? {
    val app = measurement?.appInfo
    if (app != null && app.numBytes.isFinite() && app.numBytes > 0 && app.elapsedTime > 0)
        return ReceiverCounters(app.numBytes, app.elapsedTime / 1e6, "app_info")
    val tcp = measurement?.tcpInfo
    if (upload && tcp?.bytesReceived != null && tcp.elapsedTime != null && tcp.bytesReceived > 0 && tcp.elapsedTime > 0)
        return ReceiverCounters(tcp.bytesReceived.toDouble(), tcp.elapsedTime / 1e6, "tcp_info")
    return null
}
