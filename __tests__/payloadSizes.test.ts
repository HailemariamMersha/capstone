import {
  DEFAULT_PROBE_CONFIG,
  MAX_PAYLOAD_BYTES,
  MIB,
  payloadBytesFromMiB,
  validateProbeConfig,
} from '../src/measurements/config';

test('MiB input supports decimals and rounds explicitly to whole bytes', () => {
  expect(payloadBytesFromMiB(' 2.5 ')).toBe(2621440);
  expect(payloadBytesFromMiB('.75')).toBe(786432);
  expect(payloadBytesFromMiB('0.1')).toBe(104858);
  expect(payloadBytesFromMiB('2')).toBe(2 * MIB);
  for (const text of ['', ' ', 'NaN', 'Infinity', '0x10', '1e2', 'abc']) {
    expect(payloadBytesFromMiB(text)).toBeNaN();
  }
});

test('arbitrary whole-byte sizes and the upper boundary are accepted', () => {
  for (const bytes of [1, 99, MIB + 1, MAX_PAYLOAD_BYTES]) {
    expect(
      validateProbeConfig({
        ...DEFAULT_PROBE_CONFIG,
        downloadBytes: bytes,
        uploadBytes: bytes,
      }),
    ).toMatchObject({ downloadBytes: bytes, uploadBytes: bytes });
  }
});

test.each([0, -1, 1.5, NaN, Infinity, MAX_PAYLOAD_BYTES + 1])(
  'rejects invalid sizes before measurement: %s',
  bytes => {
    for (const key of ['downloadBytes', 'uploadBytes']) {
      expect(() =>
        validateProbeConfig({ ...DEFAULT_PROBE_CONFIG, [key]: bytes }),
      ).toThrow('between 1 byte and 100 MiB');
    }
  },
);
