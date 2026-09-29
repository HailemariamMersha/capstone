// Capstone active-probe engine. Captures only data returned by our own sockets.
// No raw-socket privilege, VPN, fabricated IP headers, or external dependency.
#include <jni.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <linux/errqueue.h>
#include <linux/tcp.h>
#include <sys/socket.h>
#include <poll.h>
#include <unistd.h>
#include <time.h>
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

namespace {
std::mutex tokensMutex;
std::map<std::string, std::shared_ptr<std::atomic<bool>>> tokens;
std::string utf(JNIEnv* env, jstring value) {
    const char* chars = env->GetStringUTFChars(value, nullptr);
    std::string result(chars ? chars : "");
    if (chars) env->ReleaseStringUTFChars(value, chars);
    return result;
}
std::string quote(const std::string& value) {
    std::ostringstream out; out << '"';
    for (unsigned char c : value) {
        if (c == '"' || c == '\\') out << '\\' << c;
        else if (c < 32) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << int(c);
        else out << c;
    }
    out << '"'; return out.str();
}
struct Json {
    std::vector<std::pair<std::string, std::string>> fields;
    void raw(const std::string& key, const std::string& value) {
        for (auto& field : fields) if (field.first == key) { field.second = value; return; }
        fields.emplace_back(key, value);
    }
    void str(const std::string& key, const std::string& value) { raw(key, quote(value)); }
    void num(const std::string& key, int64_t value) { raw(key, std::to_string(value)); }
    void boolean(const std::string& key, bool value) { raw(key, value ? "true" : "false"); }
    std::string dump() const {
        std::string out = "{";
        for (const auto& field : fields) { if (out.size() > 1) out += ','; out += quote(field.first) + ':' + field.second; }
        return out + '}';
    }
};
std::string array(const std::vector<std::string>& values) {
    std::string out = "[";
    for (const auto& value : values) { if (out.size() > 1) out += ','; out += value; }
    return out + ']';
}
int64_t now(clockid_t clock) { timespec t{}; clock_gettime(clock, &t); return int64_t(t.tv_sec) * 1000000000LL + t.tv_nsec; }
std::string hex(const void* data, size_t size) {
    const auto* p = static_cast<const uint8_t*>(data); const char* digits = "0123456789abcdef";
    std::string out; out.reserve(size * 2);
    for (size_t i = 0; i < size; ++i) { out += digits[p[i] >> 4]; out += digits[p[i] & 15]; }
    return out;
}
std::vector<uint8_t> unhex(const std::string& value) {
    std::vector<uint8_t> out;
    if (value.size() % 2) return out;
    auto digit = [](char c) -> int { if (c >= '0' && c <= '9') return c - '0'; if (c >= 'a' && c <= 'f') return c - 'a' + 10; return -1; };
    for (size_t i = 0; i < value.size(); i += 2) {
        int a = digit(value[i]), b = digit(value[i + 1]); if (a < 0 || b < 0) return {};
        out.push_back(uint8_t((a << 4) | b));
    }
    return out;
}
uint16_t u16(const uint8_t* p) { return uint16_t((p[0] << 8) | p[1]); }
std::string address(const sockaddr_storage& value) {
    char text[INET6_ADDRSTRLEN]{};
    if (value.ss_family == AF_INET) inet_ntop(AF_INET, &reinterpret_cast<const sockaddr_in*>(&value)->sin_addr, text, sizeof(text));
    else if (value.ss_family == AF_INET6) inet_ntop(AF_INET6, &reinterpret_cast<const sockaddr_in6*>(&value)->sin6_addr, text, sizeof(text));
    return text;
}
int port(const sockaddr_storage& value) {
    if (value.ss_family == AF_INET) return ntohs(reinterpret_cast<const sockaddr_in*>(&value)->sin_port);
    if (value.ss_family == AF_INET6) return ntohs(reinterpret_cast<const sockaddr_in6*>(&value)->sin6_port);
    return 0;
}
struct Socket { int fd; explicit Socket(int value) : fd(value) {} ~Socket() { if (fd >= 0) close(fd); } };
Json failure(Json out, const std::string& stage, int err) {
    out.str("outcome", "socket_error"); out.str("errorStage", stage); out.num("errno", err); out.str("errorMessage", strerror(err)); return out;
}
void endpoints(Json& out, int fd) {
    sockaddr_storage local{}; socklen_t size = sizeof(local);
    if (getsockname(fd, reinterpret_cast<sockaddr*>(&local), &size) == 0) { out.str("localAddress", address(local)); out.num("localPort", port(local)); }
}
Json tcpInfo(int fd) {
    tcp_info info{}; socklen_t size = sizeof(info); Json result;
    if (getsockopt(fd, IPPROTO_TCP, TCP_INFO, &info, &size) != 0) { result.num("errno", errno); return result; }
    result.num("returnedBytes", size); result.str("structHex", hex(&info, std::min<size_t>(size, sizeof(info))));
#define FIELD(name) if (size_t(size) >= offsetof(tcp_info, name) + sizeof(info.name)) result.num(#name, info.name)
    FIELD(tcpi_state); FIELD(tcpi_ca_state); FIELD(tcpi_retransmits); FIELD(tcpi_probes);
    FIELD(tcpi_backoff); FIELD(tcpi_options); FIELD(tcpi_rto); FIELD(tcpi_ato);
    FIELD(tcpi_snd_mss); FIELD(tcpi_rcv_mss); FIELD(tcpi_unacked); FIELD(tcpi_sacked);
    FIELD(tcpi_lost); FIELD(tcpi_retrans); FIELD(tcpi_fackets); FIELD(tcpi_pmtu);
    FIELD(tcpi_rtt); FIELD(tcpi_rttvar); FIELD(tcpi_snd_ssthresh); FIELD(tcpi_snd_cwnd);
    FIELD(tcpi_advmss); FIELD(tcpi_reordering); FIELD(tcpi_rcv_rtt); FIELD(tcpi_rcv_space); FIELD(tcpi_total_retrans);
#undef FIELD
    return result;
}
Json probe(const std::shared_ptr<std::atomic<bool>>& cancelled, const std::string& ip,
           const std::string& protocol, int targetPort, int ttl, int sequence,
           const std::vector<uint8_t>& payload, int timeoutMs) {
    Json out; out.str("engine", "capstone-linux-sockets"); out.num("schemaVersion", 1);
    out.str("protocol", protocol); out.str("targetAddress", ip); out.num("targetPort", targetPort);
    out.num("timeoutMs", timeoutMs); out.num("observationLimit", 8);
    out.num("receiveBufferBytes", 2048); out.num("controlBufferBytes", 1024);
    out.num("probeTtl", ttl); out.num("sequence", sequence); out.num("payloadBytes", payload.size());
    out.str("clock", "CLOCK_MONOTONIC"); out.boolean("packetCapture", false);
    if (cancelled->load()) { out.str("outcome", "cancelled"); return out; }
    if ((protocol != "icmp" && protocol != "udp" && protocol != "tcp") || ttl < 1 || ttl > 255 ||
        timeoutMs < 1 || timeoutMs > 10000 || payload.size() > 1400 || sequence < 0 || sequence > 65535 ||
        targetPort < 0 || targetPort > 65535) return failure(out, "arguments", EINVAL);
    sockaddr_storage target{}; socklen_t targetLength;
    auto* v4 = reinterpret_cast<sockaddr_in*>(&target); auto* v6 = reinterpret_cast<sockaddr_in6*>(&target);
    if (inet_pton(AF_INET, ip.c_str(), &v4->sin_addr) == 1) {
        target.ss_family = AF_INET; v4->sin_port = htons(protocol == "icmp" ? 0 : targetPort); targetLength = sizeof(sockaddr_in);
    } else if (inet_pton(AF_INET6, ip.c_str(), &v6->sin6_addr) == 1) {
        target.ss_family = AF_INET6; v6->sin6_port = htons(protocol == "icmp" ? 0 : targetPort); targetLength = sizeof(sockaddr_in6);
    } else return failure(out, "numeric_address", EINVAL);
    out.str("targetAddress", address(target)); // Canonicalize IPv6 for destination comparison.
    bool ipv6 = target.ss_family == AF_INET6; out.num("ipVersion", ipv6 ? 6 : 4);
    const int transport = protocol == "icmp" ? (ipv6 ? IPPROTO_ICMPV6 : IPPROTO_ICMP) : (protocol == "udp" ? IPPROTO_UDP : IPPROTO_TCP);
    Socket sock(socket(target.ss_family, (protocol == "tcp" ? SOCK_STREAM : SOCK_DGRAM) | SOCK_NONBLOCK | SOCK_CLOEXEC, transport));
    if (sock.fd < 0) return failure(out, "socket", errno);
    int level = ipv6 ? IPPROTO_IPV6 : IPPROTO_IP;
    if (setsockopt(sock.fd, level, ipv6 ? IPV6_UNICAST_HOPS : IP_TTL, &ttl, sizeof(ttl)) != 0) return failure(out, "set_ttl", errno);
    const int one = 1; Json capabilities;
    capabilities.boolean("errorQueue", setsockopt(sock.fd, level, ipv6 ? IPV6_RECVERR : IP_RECVERR, &one, sizeof(one)) == 0);
    capabilities.boolean("receiveTtl", setsockopt(sock.fd, level, ipv6 ? IPV6_RECVHOPLIMIT : IP_RECVTTL, &one, sizeof(one)) == 0);
    capabilities.boolean("kernelReceiveTimestamp", setsockopt(sock.fd, SOL_SOCKET, SO_TIMESTAMPNS, &one, sizeof(one)) == 0);
    out.raw("capabilities", capabilities.dump());
    int64_t started = now(CLOCK_MONOTONIC);
    out.str("startedMonotonicNs", std::to_string(started)); out.num("startedWallTimeMs", now(CLOCK_REALTIME) / 1000000);
    int connection = connect(sock.fd, reinterpret_cast<sockaddr*>(&target), targetLength);
    if (connection != 0 && errno != EINPROGRESS) return failure(out, "connect", errno);
    endpoints(out, sock.fd);
    if (protocol == "tcp") {
        out.raw("tcpInfoBefore", tcpInfo(sock.fd).dump());
        bool connected = connection == 0;
        while (!connected && now(CLOCK_MONOTONIC) - started < int64_t(timeoutMs) * 1000000 && !cancelled->load()) {
            pollfd p{sock.fd, POLLOUT, 0}; int ready = poll(&p, 1, 50);
            if (ready < 0 && errno != EINTR) return failure(out, "poll", errno);
            if (ready > 0) { int err = 0; socklen_t len = sizeof(err); if (getsockopt(sock.fd, SOL_SOCKET, SO_ERROR, &err, &len)) err = errno;
                if (err) { out.raw("tcpInfoAfter", tcpInfo(sock.fd).dump()); return failure(out, "connect", err); }
                connected = true;
            }
        }
        out.str("outcome", cancelled->load() ? "cancelled" : connected ? "connected" : "timeout");
        out.num("connectDurationUs", (now(CLOCK_MONOTONIC) - started) / 1000);
        out.raw("tcpInfoAfter", tcpInfo(sock.fd).dump()); endpoints(out, sock.fd); return out;
    }
    std::vector<uint8_t> sendBuffer;
    if (protocol == "icmp") {
        sendBuffer = {uint8_t(ipv6 ? 128 : 8), 0, 0, 0, 0, 0, uint8_t(sequence >> 8), uint8_t(sequence & 255)};
        out.str("sendBufferScope", "icmp_message_before_kernel_identifier_and_checksum");
    } else out.str("sendBufferScope", "udp_payload");
    sendBuffer.insert(sendBuffer.end(), payload.begin(), payload.end());
    out.str("sendBufferHex", hex(sendBuffer.data(), sendBuffer.size()));
    int64_t sentAt = now(CLOCK_MONOTONIC); out.str("sendMonotonicNs", std::to_string(sentAt)); out.num("sendWallTimeMs", now(CLOCK_REALTIME) / 1000000);
    ssize_t sent = send(sock.fd, sendBuffer.data(), sendBuffer.size(), 0);
    if (sent < 0) return failure(out, "send", errno);
    out.num("sentSocketBytes", sent); endpoints(out, sock.fd);
    sockaddr_storage local{}; socklen_t localSize = sizeof(local); getsockname(sock.fd, reinterpret_cast<sockaddr*>(&local), &localSize);
    std::vector<std::string> observations; int ignored = 0;
    while (now(CLOCK_MONOTONIC) - sentAt < int64_t(timeoutMs) * 1000000 && !cancelled->load()) {
        pollfd p{sock.fd, POLLIN | POLLERR, 0}; int ready = poll(&p, 1, 50);
        if (ready < 0) { if (errno == EINTR) continue; return failure(out, "poll", errno); }
        if (!ready) continue;
        // Inspect the error queue before recvmsg consumes the socket's pending errno.
        bool errorQueue = p.revents & POLLERR;
        uint8_t data[2048]{}; alignas(cmsghdr) uint8_t control[1024]{}; sockaddr_storage source{};
        iovec iov{data, sizeof(data)}; msghdr msg{}; msg.msg_name = &source; msg.msg_namelen = sizeof(source);
        msg.msg_iov = &iov; msg.msg_iovlen = 1; msg.msg_control = control; msg.msg_controllen = sizeof(control);
        ssize_t count = recvmsg(sock.fd, &msg, MSG_DONTWAIT | (errorQueue ? MSG_ERRQUEUE : 0));
        if (count < 0) { if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) continue; return failure(out, "recvmsg", errno); }
        int64_t receivedAt = now(CLOCK_MONOTONIC); Json event;
        event.str("receiveMonotonicNs", std::to_string(receivedAt)); event.num("receiveWallTimeMs", now(CLOCK_REALTIME) / 1000000);
        event.num("elapsedUs", (receivedAt - sentAt) / 1000); event.num("recvmsgFlags", msg.msg_flags);
        event.str("sourceAddress", address(source)); event.num("sourcePort", port(source));
        event.num("receivedSocketBytes", count); event.str("receivedHex", hex(data, std::min<size_t>(count, sizeof(data))));
        event.str("receivedScope", errorQueue ? "error_queue_original_payload" : protocol == "icmp" ? "icmp_message" : "udp_payload");
        event.boolean("dataTruncated", msg.msg_flags & MSG_TRUNC); event.boolean("controlTruncated", msg.msg_flags & MSG_CTRUNC);
        std::vector<std::string> ancillary;
        bool hasExtendedError = false; int origin = -1; std::string offender;
        for (cmsghdr* c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c)) {
            if (c->cmsg_len < CMSG_LEN(0)) break;
            size_t bytes = c->cmsg_len - CMSG_LEN(0); Json item;
            item.num("level", c->cmsg_level); item.num("type", c->cmsg_type); item.str("dataHex", hex(CMSG_DATA(c), bytes)); ancillary.push_back(item.dump());
            if (c->cmsg_level == level && c->cmsg_type == (ipv6 ? IPV6_RECVERR : IP_RECVERR) && bytes >= sizeof(sock_extended_err)) {
                sock_extended_err err{}; memcpy(&err, CMSG_DATA(c), sizeof(err)); Json extended;
                extended.num("errno", err.ee_errno); extended.num("origin", err.ee_origin); extended.num("type", err.ee_type);
                extended.num("code", err.ee_code); extended.num("info", err.ee_info); extended.num("data", err.ee_data);
                if (bytes >= sizeof(err) + sizeof(sa_family_t)) {
                    sockaddr_storage reported{}; memcpy(&reported, CMSG_DATA(c) + sizeof(err), std::min(bytes - sizeof(err), sizeof(reported)));
                    offender = address(reported); extended.str("offenderAddress", offender);
                }
                event.raw("extendedError", extended.dump()); origin = err.ee_origin; hasExtendedError = true;
                if (origin == SO_EE_ORIGIN_ICMP || origin == SO_EE_ORIGIN_ICMP6) { event.num("icmpType", err.ee_type); event.num("icmpCode", err.ee_code); }
            }
            if (c->cmsg_level == level && c->cmsg_type == (ipv6 ? IPV6_HOPLIMIT : IP_TTL) && bytes >= sizeof(int)) {
                int value; memcpy(&value, CMSG_DATA(c), sizeof(value)); event.num("replyTtl", value);
            }
            if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SO_TIMESTAMPNS && bytes >= sizeof(timespec)) {
                timespec stamp{}; memcpy(&stamp, CMSG_DATA(c), sizeof(stamp));
                event.str("kernelReceiveRealtimeNs", std::to_string(int64_t(stamp.tv_sec) * 1000000000LL + stamp.tv_nsec));
            }
        }
        event.raw("ancillary", array(ancillary));
        bool matched = false;
        if (errorQueue) {
            // Linux associates this error with this connected socket's only datagram.
            // Preserve the original quotation even when it is too short to match payload.
            matched = hasExtendedError;
            event.str("correlation", "kernel_socket_error_queue"); event.str("responderAddress", offender);
        } else if (protocol == "icmp" && count >= 8) {
            event.num("icmpType", data[0]); event.num("icmpCode", data[1]); event.num("icmpChecksum", u16(data + 2));
            event.num("icmpIdentifier", u16(data + 4)); event.num("icmpSequence", u16(data + 6));
            matched = data[0] == (ipv6 ? 129 : 0) && data[1] == 0 && u16(data + 4) == port(local) && u16(data + 6) == sequence &&
                size_t(count) == payload.size() + 8 && std::equal(payload.begin(), payload.end(), data + 8);
            event.str("correlation", "identifier_sequence_payload"); event.str("responderAddress", address(source));
        } else if (protocol == "udp") {
            matched = size_t(count) == payload.size() && std::equal(payload.begin(), payload.end(), data);
            event.str("correlation", "connected_peer_and_payload"); event.str("responderAddress", address(source));
        }
        event.boolean("matched", matched);
        if (observations.size() < 8) observations.push_back(event.dump()); else ignored++;
        out.raw("observations", array(observations)); out.num("droppedObservations", ignored);
        if (matched) {
            out.str("outcome", errorQueue ? (origin == SO_EE_ORIGIN_LOCAL ? "local_error" : "icmp_error") : "reply");
            out.raw("response", event.dump()); out.raw("observations", array(observations)); out.num("droppedObservations", ignored); return out;
        }
    }
    out.str("outcome", cancelled->load() ? "cancelled" : "timeout"); out.raw("observations", array(observations)); out.num("droppedObservations", ignored);
    return out;
}
}
extern "C" JNIEXPORT jboolean JNICALL Java_com_labpracticeapp_diagnostics_PacketEngine_begin(JNIEnv* env, jobject, jstring runId) {
    std::lock_guard<std::mutex> lock(tokensMutex); auto id = utf(env, runId);
    if (tokens.count(id) || tokens.size() >= 4) return false;
    tokens[id] = std::make_shared<std::atomic<bool>>(false); return true;
}
extern "C" JNIEXPORT void JNICALL Java_com_labpracticeapp_diagnostics_PacketEngine_cancel(JNIEnv* env, jobject, jstring runId) {
    std::lock_guard<std::mutex> lock(tokensMutex); auto it = tokens.find(utf(env, runId)); if (it != tokens.end()) it->second->store(true);
}
extern "C" JNIEXPORT void JNICALL Java_com_labpracticeapp_diagnostics_PacketEngine_end(JNIEnv* env, jobject, jstring runId) {
    std::lock_guard<std::mutex> lock(tokensMutex); tokens.erase(utf(env, runId));
}
extern "C" JNIEXPORT jstring JNICALL Java_com_labpracticeapp_diagnostics_PacketEngine_probe(JNIEnv* env, jobject, jstring runId, jstring ip, jstring protocol, jint targetPort, jint ttl, jint sequence, jstring payloadHex, jint timeoutMs) {
    std::shared_ptr<std::atomic<bool>> cancelled;
    { std::lock_guard<std::mutex> lock(tokensMutex); auto it = tokens.find(utf(env, runId)); if (it != tokens.end()) cancelled = it->second; }
    if (!cancelled) return env->NewStringUTF("{\"outcome\":\"cancelled\"}");
    auto result = probe(cancelled, utf(env, ip), utf(env, protocol), targetPort, ttl, sequence, unhex(utf(env, payloadHex)), timeoutMs);
    return env->NewStringUTF(result.dump().c_str());
}
