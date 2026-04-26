const DEFAULT_TARGET_URL = 'https://example.com';

export function normalizeUrl(input) {
  const trimmedInput = (input || '').trim();
  let normalizedUrl = trimmedInput || DEFAULT_TARGET_URL;

  if (!/^https?:\/\//i.test(normalizedUrl)) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  console.log(`[url] Normalized URL: ${normalizedUrl}`);
  return normalizedUrl;
}
