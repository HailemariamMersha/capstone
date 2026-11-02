'use client';
import Script from 'next/script';
import { useState } from 'react';
export default function Enrollment() {
  const [error, setError] = useState('');
  const sitekey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  return (
    <main className="p-6">
      <h1>Join SkyMeasure</h1>
      <p>Verify this enrollment. No email or password is required.</p>
      {!sitekey ? (
        <p>Enrollment verification is not configured.</p>
      ) : (
        <>
          <div id="enrollment-check" />
          <Script
            src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
            onLoad={() => {
              const target = window as unknown as {
                turnstile: {
                  render(
                    selector: string,
                    options: Record<string, unknown>,
                  ): void;
                };
                ReactNativeWebView?: { postMessage(value: string): void };
              };
              target.turnstile.render('#enrollment-check', {
                sitekey,
                callback: (token: string) =>
                  target.ReactNativeWebView?.postMessage(
                    JSON.stringify({ token }),
                  ),
                'error-callback': () =>
                  setError('Verification failed. Reopen the enrollment check.'),
              });
            }}
            onError={() =>
              setError('Verification could not load. Check your connection.')
            }
          />
        </>
      )}
      <p role="status">{error}</p>
    </main>
  );
}
