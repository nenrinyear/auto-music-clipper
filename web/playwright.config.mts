import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser-test',
  timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:8787', channel: process.env.PLAYWRIGHT_CHANNEL || undefined },
  webServer: {
    command: 'node node_modules/wrangler/bin/wrangler.js dev --ip 127.0.0.1 --port 8787',
    url: 'http://127.0.0.1:8787',
    reuseExistingServer: !process.env.CI,
  },
});
