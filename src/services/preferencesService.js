import RNFS from 'react-native-fs';

const SETTINGS_FILE_NAME = 'app_settings.json';

function getSettingsPath() {
  return `${RNFS.DocumentDirectoryPath}/${SETTINGS_FILE_NAME}`;
}

async function readSettings() {
  const settingsPath = getSettingsPath();
  const exists = await RNFS.exists(settingsPath);

  if (!exists) {
    return {};
  }

  try {
    const fileContents = await RNFS.readFile(settingsPath, 'utf8');
    return JSON.parse(fileContents);
  } catch (error) {
    console.log(
      `[settings] Failed to read settings file: ${error?.message || String(error)}`,
    );
    return {};
  }
}

async function writeSettings(settings) {
  const settingsPath = getSettingsPath();
  await RNFS.writeFile(settingsPath, JSON.stringify(settings), 'utf8');
}

export async function hasPromptBeenShown(promptKey) {
  const settings = await readSettings();
  return settings[promptKey] === true;
}

export async function markPromptAsShown(promptKey) {
  const settings = await readSettings();
  settings[promptKey] = true;
  await writeSettings(settings);
}
