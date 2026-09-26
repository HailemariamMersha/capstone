import * as FS from '@dr.pogodin/react-native-fs';
import Share from 'react-native-share';
import { measurementStore } from '../storage/database';
import { measurementCsv } from './serialize';

export async function shareSession(
  sessionId: string,
  format: 'csv' | 'json',
): Promise<void> {
  const data = await measurementStore.exportSession(sessionId);
  // One stable filename per format keeps cached exports bounded. Never copy a live SQLite file.
  const directory = `${FS.CachesDirectoryPath}/capstone-export`;
  await FS.mkdir(directory);
  const path = `${directory}/session.${format}`;
  const content =
    format === 'json'
      ? JSON.stringify(data, null, 2)
      : measurementCsv(data.measurements as Record<string, unknown>[]);
  await FS.writeFile(path, content, 'utf8');
  await Share.open({
    url: `file://${path}`,
    type: format === 'csv' ? 'text/csv' : 'application/json',
    title: 'Export capstone session',
    failOnCancel: false,
  });
}
