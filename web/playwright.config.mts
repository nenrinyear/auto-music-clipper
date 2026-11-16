import { defineConfig } from '@playwright/test';

const port = 8788;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './browser-test',
  timeout: 60_000,
  use: { baseURL, channel: process.env.PLAYWRIGHT_CHANNEL || undefined },
  webServer: {
    command: `node node_modules/wrangler/bin/wrangler.js dev --ip 127.0.0.1 --port ${port}`,
    url: baseURL,
  },
});
