import {appendCsvRow} from './csvService';
import {runPing} from './pingService';

export async function performMeasurement({appState, targetUrl}) {
  const result = await runPing({
    appState,
    targetUrl,
  });

  try {
    await appendCsvRow(result);
  } catch (error) {
    const csvErrorMessage = error?.message || String(error);
    result.error = result.error
      ? `${result.error} | CSV append failed: ${csvErrorMessage}`
      : `CSV append failed: ${csvErrorMessage}`;
  }

  return result;
}
