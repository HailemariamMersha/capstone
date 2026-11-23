package net.measurementlab.ndt7.android.models

/** Allowlisted transport diagnostics. Never include URLs, peer close text,
 * response bodies/headers, or exception messages containing signed credentials. */
data class TransportObservation(
    val event: String,
    val phase: String,
    val queuedBytes: Long,
    val closeCode: Int? = null,
    val httpStatus: Int? = null,
    val failureCategory: String? = null
)

fun transportFailureCategory(error: Throwable): String = when (error) {
    is javax.net.ssl.SSLException -> "tls"
    is java.net.SocketTimeoutException -> "timeout"
    is java.io.EOFException -> "eof"
    is java.net.ProtocolException -> "protocol"
    is java.io.InterruptedIOException -> "io_interrupted"
    is java.io.IOException -> "io"
    else -> "transport"
}
