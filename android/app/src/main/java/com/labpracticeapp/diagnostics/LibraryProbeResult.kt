package com.labpracticeapp.diagnostics

import me.impa.icmpenguin.ProbeResult

internal fun encodeLibraryProbe(hop: Int, result: ProbeResult): Map<String, Any?> {
        val row = mutableMapOf<String, Any?>(
            "hop" to hop, "sequence" to result.sequence, "remote" to result.remote,
            "probeBytes" to result.probeSize, "overheadBytes" to result.overhead,
            "address" to null, "rttMs" to null, "icmpType" to null, "icmpCode" to null
        )
        // Retain every field exposed by the pinned ProbeResult variant. These are
        // library observations; do not fabricate ICMP headers from errno labels.
        val raw = mutableMapOf<String, Any?>(
            "sequence" to result.sequence, "remote" to result.remote,
            "probeSize" to result.probeSize, "overhead" to result.overhead
        )
        row["observedAtMs"] = System.currentTimeMillis().toDouble()
        row["rawResult"] = raw
        when (result) {
            is ProbeResult.Success -> {
                raw.putAll(mapOf("variant" to "Success", "elapsedUsec" to result.elapsedUsec,
                    "ttl" to result.ttl, "dataBase64" to android.util.Base64.encodeToString(result.data, android.util.Base64.NO_WRAP)))
                row["kind"] = "reply"; row["address"] = result.remote
                row["rttMs"] = result.elapsedUsec / 1000.0
            }
            is ProbeResult.Timeout -> { raw["variant"] = "Timeout"; row["kind"] = "timeout" }
            is ProbeResult.ConnectionRefused -> {
                raw.putAll(mapOf("variant" to "ConnectionRefused", "offender" to result.offender, "elapsedUsec" to result.elapsedUsec))
                row["kind"] = "port_unreachable"; row["address"] = result.offender
                row["rttMs"] = result.elapsedUsec / 1000.0
            }
            is ProbeResult.HostUnreachable -> {
                raw.putAll(mapOf("variant" to "HostUnreachable", "offender" to result.offender, "elapsedUsec" to result.elapsedUsec))
                row["kind"] = "host_unreachable"; row["address"] = result.offender
                row["rttMs"] = result.elapsedUsec / 1000.0
            }
            is ProbeResult.NetUnreachable -> {
                raw.putAll(mapOf("variant" to "NetUnreachable", "offender" to result.offender, "elapsedUsec" to result.elapsedUsec))
                row["kind"] = "network_unreachable"; row["address"] = result.offender
                row["rttMs"] = result.elapsedUsec / 1000.0
            }
            is ProbeResult.NetError -> {
                raw.putAll(mapOf("variant" to "NetError", "offender" to result.offender,
                    "errNo" to result.errNo, "errCode" to result.errCode, "errType" to result.errType, "errInfo" to result.errInfo))
                row["kind"] = "icmp_error"; row["address"] = result.offender
                // Upstream rc.3 errType is ee_origin, NOT the ICMP type.
                // Keep errType/errCode in rawResult without fabricating a header.
                // This variant exposes no elapsed time. Never invent a hop RTT.
            }
            is ProbeResult.Unknown -> { raw.putAll(mapOf("variant" to "Unknown", "error" to result.error)); row["kind"] = "error" }
        }
        return row
    }
