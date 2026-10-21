/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);

import BackgroundFetch from 'react-native-background-fetch';
import { backgroundUpload, syncAccount } from './src/sync/background';
BackgroundFetch.registerHeadlessTask(async ({ taskId, timeout }) => {
  if (timeout) {
    syncAccount.cancel();
    await BackgroundFetch.finish(taskId);
    return;
  }
  await backgroundUpload(taskId);
});
