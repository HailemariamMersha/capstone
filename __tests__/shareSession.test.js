import * as FS from '@dr.pogodin/react-native-fs';
import Share from 'react-native-share';
import { measurementStore } from '../src/storage/database';
import { shareSession } from '../src/export/shareSession';
jest.mock('@dr.pogodin/react-native-fs', () => ({
  CachesDirectoryPath: '/cache',
  mkdir: jest.fn(),
  writeFile: jest.fn(),
}));
jest.mock('react-native-share', () => ({ open: jest.fn() }));
jest.mock('../src/storage/database', () => ({
  measurementStore: { exportSession: jest.fn() },
}));
beforeEach(() => {
  jest.clearAllMocks();
  measurementStore.exportSession.mockResolvedValue({
    session: { id: 's' },
    measurements: [],
    events: [],
    snapshots: [],
  });
});
test('CSV action writes and shares the full bundle including authoritative JSON', async () => {
  await shareSession('s', 'csv');
  expect(FS.writeFile).toHaveBeenCalledTimes(6);
  expect(Share.open).toHaveBeenCalledWith(
    expect.objectContaining({
      urls: expect.arrayContaining([
        'file:///cache/capstone-export/session.json',
        'file:///cache/capstone-export/samples.csv',
      ]),
    }),
  );
  expect(Share.open.mock.calls[0][0].urls).toHaveLength(6);
});
test('JSON action writes only the complete JSON export', async () => {
  await shareSession('s', 'json');
  expect(FS.writeFile).toHaveBeenCalledTimes(1);
  expect(JSON.parse(FS.writeFile.mock.calls[0][1])).toMatchObject({
    exportFormatVersion: 2,
    session: { id: 's' },
  });
});
