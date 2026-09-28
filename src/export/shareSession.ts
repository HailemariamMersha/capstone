import * as FS from '@dr.pogodin/react-native-fs';
import Share from 'react-native-share';
import { measurementStore } from '../storage/database';
import { sessionExportFiles, sessionJson } from './serialize';

export async function shareSession(
  sessionId: string,
  format: 'csv' | 'json',
): Promise<void> {
  const data = await measurementStore.exportSession(sessionId);
  // One stable filename per format keeps cached exports bounded. Never copy a live SQLite file.
  const directory = `${FS.CachesDirectoryPath}/capstone-export`;
  await FS.mkdir(directory);
  const files =
    format === 'csv'
      ? sessionExportFiles(data)
      : [{ name: 'session.json', content: sessionJson(data) }];
  const urls: string[] = [];
  for (const file of files) {
    const path = `${directory}/${file.name}`;
    await FS.writeFile(path, file.content, 'utf8');
    urls.push(`file://${path}`);
  }
  await Share.open({
    urls,
    type: format === 'csv' ? '*/*' : 'application/json',
    title: 'Export capstone session',
    failOnCancel: false,
  });
}
