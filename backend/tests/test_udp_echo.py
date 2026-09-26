from ipaddress import IPv4Network
from unittest.mock import Mock

from backend.udp_echo import EchoProtocol, valid_packet


def packet(sequence=0):
    return f"CPSUDP1:{'a' * 32}:{sequence:04d}:".ljust(128, '.').encode('ascii')


def test_contract_rejects_wrong_size_nonce_padding_and_sequence():
    assert valid_packet(packet())
    assert valid_packet(packet(19))
    for data in [b'', packet()[:-1], packet() + b'.', packet(20), packet().replace(b'a', b'z'), packet()[:-1] + b'x']:
        assert not valid_packet(data)


def test_only_allowed_sources_receive_same_size_echo_and_rate_is_bounded():
    clock = Mock(return_value=0)
    protocol = EchoProtocol([IPv4Network('192.168.1.0/24')], clock=clock, max_per_second=2)
    transport = Mock()
    protocol.connection_made(transport)
    protocol.datagram_received(packet(), ('10.0.0.1', 1234))
    transport.sendto.assert_not_called()
    for _ in range(3):
        protocol.datagram_received(packet(), ('192.168.1.3', 1234))
    assert transport.sendto.call_count == 2
    transport.sendto.assert_called_with(packet(), ('192.168.1.3', 1234))
    clock.return_value = 1
    protocol.datagram_received(packet(), ('192.168.1.3', 1234))
    assert transport.sendto.call_count == 3
