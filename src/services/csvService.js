import RNFS from 'react-native-fs';

const CSV_FILE_NAME = 'network_log.csv';
const CSV_HEADER =
  'timestamp,target_url,success,latency_ms,http_status,app_state,error\n';

function escapeCsvValue(value) {
  const stringValue = value === null || value === undefined ? '' : String(value);
  return `"${stringValue.replace(/"/g, '""')}"`;
}

export function getCsvPath() {
  return `${RNFS.DocumentDirectoryPath}/${CSV_FILE_NAME}`;
}

export async function ensureCsvExists() {
  const csvPath = getCsvPath();
  const exists = await RNFS.exists(csvPath);

  if (!exists) {
    await RNFS.writeFile(csvPath, CSV_HEADER, 'utf8');
    console.log(`[csv] Created CSV file at ${csvPath}`);
  }

  return csvPath;
}

export async function appendCsvRow(result) {
  const csvPath = await ensureCsvExists();
  const row = [
    result.timestamp,
    result.targetUrl,
    result.success,
    result.latencyMs,
    result.httpStatus,
    result.appState,
    result.error,
  ]
    .map(escapeCsvValue)
    .join(',');

  try {
    await RNFS.appendFile(csvPath, `${row}\n`, 'utf8');
  } catch (error) {
    console.log(`[csv] Failed to append row: ${error?.message || String(error)}`);
    throw error;
  }

  return csvPath;
}

function parseCsvLine(line) {
  const values = [];
  let currentValue = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"') {
      if (inQuotes && nextCharacter === '"') {
        currentValue += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === ',' && !inQuotes) {
      values.push(currentValue);
      currentValue = '';
      continue;
    }

    currentValue += character;
  }

  values.push(currentValue);
  return values;
}

function mapCsvRowToLog(line) {
  const [
    timestamp = '',
    targetUrl = '',
    success = '',
    latencyMs = '',
    httpStatus = '',
    appState = '',
    error = '',
  ] = parseCsvLine(line);

  return {
    timestamp,
    targetUrl,
    success: success === 'true',
    latencyMs: latencyMs === '' ? null : Number(latencyMs),
    httpStatus,
    appState,
    error,
  };
}

export async function readRecentCsvRows(limit = 30) {
  const csvPath = getCsvPath();
  const exists = await RNFS.exists(csvPath);

  if (!exists) {
    return [];
  }

  const fileContents = await RNFS.readFile(csvPath, 'utf8');
  const lines = fileContents.split('\n').map(line => line.trim()).filter(Boolean);

  if (lines.length <= 1) {
    return [];
  }

  return lines
    .slice(1)
    .slice(-limit)
    .reverse()
    .map(mapCsvRowToLog);
}

export async function getMeasurementCount() {
  const csvPath = getCsvPath();
  const exists = await RNFS.exists(csvPath);

  if (!exists) {
    return 0;
  }

  const fileContents = await RNFS.readFile(csvPath, 'utf8');
  const lines = fileContents.split('\n').map(line => line.trim()).filter(Boolean);

  if (lines.length <= 1) {
    return 0;
  }

  return lines.length - 1;
}
