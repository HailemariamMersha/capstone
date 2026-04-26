import {Platform} from 'react-native';
import BackgroundService from 'react-native-background-actions';
import {getMeasurementCount} from './csvService';
import {performMeasurement} from './measurementService';

const BACKGROUND_DELAY_MS = 10000;

function sleep(delayMs) {
  return new Promise(resolve => {
    setTimeout(resolve, delayMs);
  });
}

function buildNotificationDescription(result, targetUrl, measurementCount) {
  if (!result) {
    return `Request #${measurementCount}: monitoring ${targetUrl}`;
  }

  if (result.success) {
    return `Request #${measurementCount}: ${result.latencyMs} ms (${result.httpStatus})`;
  }

  return `Request #${measurementCount}: ${result.error || 'Unknown error'}`;
}

async function backgroundMeasurementTask(taskData) {
  const {targetUrl} = taskData;

  console.log(`[background-service] Task started for ${targetUrl}`);

  while (BackgroundService.isRunning()) {
    const result = await performMeasurement({
      appState: 'background-service',
      targetUrl,
    });
    const measurementCount = await getMeasurementCount();

    try {
      await BackgroundService.updateNotification({
        taskDesc: buildNotificationDescription(
          result,
          targetUrl,
          measurementCount,
        ),
      });
    } catch (error) {
      console.log(
        `[background-service] Failed to update notification: ${error?.message || String(error)}`,
      );
    }

    await sleep(BACKGROUND_DELAY_MS);
  }

  console.log('[background-service] Task loop exited');
}

function buildTaskOptions(targetUrl) {
  return {
    taskName: 'LabPracticeMeasurement',
    taskTitle: 'LabPracticeApp is measuring network latency',
    taskDesc: `Request #0: monitoring ${targetUrl}`,
    taskIcon: {
      name: 'ic_launcher',
      type: 'mipmap',
    },
    color: '#2563eb',
    parameters: {
      targetUrl,
    },
  };
}

export function isAndroidBackgroundMeasurementRunning() {
  if (Platform.OS !== 'android') {
    return false;
  }

  return BackgroundService.isRunning();
}

export async function startAndroidBackgroundMeasurement(targetUrl) {
  if (Platform.OS !== 'android') {
    throw new Error('Android background measurement is only available on Android.');
  }

  if (BackgroundService.isRunning()) {
    console.log('[background-service] Start ignored because the service is already running');
    return;
  }

  await BackgroundService.start(
    backgroundMeasurementTask,
    buildTaskOptions(targetUrl),
  );
  console.log(`[background-service] Foreground service started for ${targetUrl}`);
}

export async function stopAndroidBackgroundMeasurement() {
  if (Platform.OS !== 'android') {
    return;
  }

  if (!BackgroundService.isRunning()) {
    console.log('[background-service] Stop ignored because no service is running');
    return;
  }

  await BackgroundService.stop();
  console.log('[background-service] Foreground service stopped');
}
