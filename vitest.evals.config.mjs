// AGENT-EVALS.1 — separate vitest config for the LIVE agent evals.
// Not part of `npm test` / CI (real API calls, costs money, needs
// ANTHROPIC_API_KEY). Invoke via: npm run eval:agent
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
  test: {
    environment: 'node',
    include: ['evals/**/*.eval.js'],
    setupFiles: ['evals/setup-env.js'],
    // Live model calls: run scenarios one at a time, generous timeout.
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
})
