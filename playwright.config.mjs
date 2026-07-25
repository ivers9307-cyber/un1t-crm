// E2E-SMOKE.1 — Playwright config for the browser smoke pack (e2e/).
//
// This is NOT part of the six-check CI mirror or the per-PR pipeline:
// the smoke pack drives a real deployment with a real login, so it
// needs credentials and a target URL (E2E_BASE_URL / E2E_EMAIL /
// E2E_PASSWORD). It runs from .github/workflows/e2e-smoke.yml on a
// schedule, or locally with:
//
//   E2E_BASE_URL=http://localhost:3000 E2E_EMAIL=… E2E_PASSWORD=… npm run test:e2e
//
// Without those env vars every spec self-skips (see e2e/smoke.spec.mjs),
// so a bare `npm run test:e2e` is always safe.

import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // Journeys share one logged-in storage state and build on each other —
  // run them in order, one worker.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
})
