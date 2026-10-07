const { compare, summarize } = require('../scripts/compare-packet-engines.cjs');
const session = { id: 's', state: 'completed', config: {} };
test('comparison distinguishes genuine zero RTT from missing values and separates method scopes', () => {
  const custom = {
    session,
    measurements: [
      {
        id: 'a',
        type: 'tcp_connect',
        success: true,
        value: 0,
        method: 'native_tcp_connect_and_info',
        packet: {
          engine: 'capstone-linux-sockets',
          tcpInfoAfter: { tcpi_rtt: 0 },
        },
      },
    ],
  };
  const library = {
    session: { ...session, config: { timeoutMs: 1000 } },
    measurements: [
      {
        id: 'b',
        type: 'tcp_connect',
        success: false,
        value: null,
        method: 'tcp_connect_with_resolution',
        raw: { library: 'react-native-tcp-socket', version: '6.4.3' },
      },
    ],
  };
  const result = compare(custom, library);
  expect(result.custom.groups.tcp_connect.medianSuccessfulValue).toBe(0);
  expect(result.library.groups.tcp_connect.medianSuccessfulValue).toBeNull();
  expect(result.custom.groups.tcp_connect.fields.tcpInfo).toBe(1);
  expect(result.library.groups.tcp_connect.fields.tcpInfo).toBe(0);
  expect(result.configDifferences).toEqual([
    { field: 'timeoutMs', custom: null, library: 1000 },
  ]);
});
test('comparison rejects duplicate records instead of inflating success counts', () => {
  expect(() =>
    summarize({
      session,
      measurements: [
        { id: 'same', type: 'icmp_burst' },
        { id: 'same', type: 'icmp_burst' },
      ],
    }),
  ).toThrow('duplicate');
});
