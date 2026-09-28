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

test('a long session may reserve a multi-GiB budget without removing its bound', () => {
  const {
    DEFAULT_SESSION_CONFIG,
    MAX_SESSION_PAYLOAD_BYTES,
    validateSessionConfig,
  } = require('../src/sessions/config');
  const config = {
    ...DEFAULT_SESSION_CONFIG,
    downloadBytes: 50 * MIB,
    uploadBytes: 50 * MIB,
    maxPayloadBytes: 3072 * MIB,
  };
  expect(validateSessionConfig(config).maxPayloadBytes).toBe(3221225472);
  expect(
    validateSessionConfig({
      ...config,
      maxPayloadBytes: MAX_SESSION_PAYLOAD_BYTES,
    }).maxPayloadBytes,
  ).toBe(MAX_SESSION_PAYLOAD_BYTES);
  expect(() =>
    validateSessionConfig({
      ...config,
      maxPayloadBytes: MAX_SESSION_PAYLOAD_BYTES + 1,
    }),
  ).toThrow('Payload budget');
});
