import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: { baseURL: 'http://127.0.0.1:3100', screenshot: 'only-on-failure' },
  webServer: {
    command: 'npm run dev -- --hostname 127.0.0.1 --port 3100',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: false,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: 'https://skymeasure-test.supabase.co',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-public-key',
      NEXT_PUBLIC_API_URL: 'http://127.0.0.1:8900',
    },
  },
});
