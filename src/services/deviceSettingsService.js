import {NativeModules, Platform} from 'react-native';

const {BatteryOptimizationModule} = NativeModules;

export async function isBatteryOptimizationDisabled() {
  if (Platform.OS !== 'android' || !BatteryOptimizationModule) {
    return false;
  }

  try {
    return await BatteryOptimizationModule.isIgnoringBatteryOptimizations();
  } catch (error) {
    console.log(
      `[battery] Failed to read optimization status: ${error?.message || String(error)}`,
    );
    return false;
  }
}

export async function requestBatteryOptimizationExemption() {
  if (Platform.OS !== 'android' || !BatteryOptimizationModule) {
    return false;
  }

  try {
    return await BatteryOptimizationModule.requestIgnoreBatteryOptimizations();
  } catch (error) {
    console.log(
      `[battery] Failed to request battery optimization exemption: ${error?.message || String(error)}`,
    );
    return false;
  }
}

export async function openBatteryOptimizationSettings() {
  if (Platform.OS !== 'android' || !BatteryOptimizationModule) {
    return false;
  }

  try {
    return await BatteryOptimizationModule.openBatteryOptimizationSettings();
  } catch (error) {
    console.log(
      `[battery] Failed to open battery optimization settings: ${error?.message || String(error)}`,
    );
    return false;
  }
}
