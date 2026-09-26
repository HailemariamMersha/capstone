"""Bounded Capstone UDP echo service. Run separately from the HTTP server."""
import argparse
import asyncio
import ipaddress
import time

PACKET_BYTES = 128
SAMPLE_COUNT = 20


def valid_packet(data: bytes) -> bool:
    return (
        len(data) == PACKET_BYTES
        and data[:8] == b"CPSUDP1:"
        and all(c in b"0123456789abcdef" for c in data[8:40])
        and data[40:41] == b":"
        and data[41:45].isdigit()
        and int(data[41:45]) < SAMPLE_COUNT
        and data[45:46] == b":"
        and data[46:] == b"." * 82
    )


class EchoProtocol(asyncio.DatagramProtocol):
    def __init__(self, allowed_networks, clock=time.monotonic, max_per_second=100):
        self.allowed_networks = allowed_networks
        self.clock = clock
        self.max_per_second = max_per_second
        self.window = clock()
        self.count = 0
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        if not valid_packet(data):
            return
        source = ipaddress.ip_address(addr[0])
        if not any(source in network for network in self.allowed_networks):
            return
        now = self.clock()
        if now - self.window >= 1:
            self.window, self.count = now, 0
        if self.count >= self.max_per_second:
            return
        self.count += 1
        # Identical size and contents: no payload amplification or arbitrary replies.
        self.transport.sendto(data, addr)


async def serve(host, port, allowed_networks):
    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(
        lambda: EchoProtocol(allowed_networks), local_addr=(host, port)
    )
    print(f"Capstone UDP echo listening on {host}:{port}", flush=True)
    try:
        await asyncio.Future()
    finally:
        transport.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9876)
    parser.add_argument("--allow", action="append", help="Allowed source IPv4 CIDR; repeatable. Defaults to loopback.")
    args = parser.parse_args()
    networks = [ipaddress.IPv4Network(value) for value in (args.allow or ["127.0.0.0/8"])]
    try:
        asyncio.run(serve(args.host, args.port, networks))
    except KeyboardInterrupt:
        pass
