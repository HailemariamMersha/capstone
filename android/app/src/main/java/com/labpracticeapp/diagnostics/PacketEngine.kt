package com.labpracticeapp.diagnostics

/** JNI calls are bounded and cancellation is checked at most every 50 ms while polling. */
object PacketEngine {
    init { System.loadLibrary("capstonepacket") }
    external fun begin(runId: String): Boolean
    external fun cancel(runId: String)
    external fun end(runId: String)
    external fun probe(runId: String, ip: String, protocol: String, port: Int, ttl: Int,
                       sequence: Int, payloadHex: String, timeoutMs: Int): String
}
