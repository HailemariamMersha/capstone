export async function runPing({appState, targetUrl}) {
  const timestamp = new Date().toISOString();
  const startedAt = Date.now();

  console.log(`[ping] Starting ping to ${targetUrl} at ${timestamp}`);

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
    });
    const latencyMs = Date.now() - startedAt;
    const result = {
      timestamp,
      targetUrl,
      success: response.ok,
      latencyMs,
      httpStatus: response.status,
      appState,
      error: '',
    };

    console.log(
      `[ping] Success target=${targetUrl} status=${response.status} ok=${response.ok} latency=${latencyMs}ms`,
    );

    return result;
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const errorMessage = error?.message || String(error);
    const result = {
      timestamp,
      targetUrl,
      success: false,
      latencyMs,
      httpStatus: '',
      appState,
      error: errorMessage,
    };

    console.log(
      `[ping] Failure target=${targetUrl} latency=${latencyMs}ms error=${errorMessage}`,
    );

    return result;
  }
}
