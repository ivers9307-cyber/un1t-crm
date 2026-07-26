import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
      // mobile/lib tests import the shared seam the way the app does —
      // bare 'shared/<module>' (the mobile file: package). Alias it so
      // vitest resolves those imports without needing mobile/node_modules
      // (its symlink) to exist, e.g. in CI jobs that only install root deps.
      shared: path.resolve(__dirname, './shared'),
    },
  },
  test: {
    environment: 'node',
    // Match co-located *.test.js files alongside the lib code, plus a
    // top-level tests/ directory if we ever add one. shared/ holds the
    // cross-platform helpers used by web + mobile (e.g. dashboard-data.js).
    // mobile/lib/ holds the mobile-specific permission resolvers
    // (canMobile, canDashboard, hasAnyMobileFeature) — pure JS that
    // doesn't import any React-Native runtime, safe to run under
    // vitest's Node environment. Anything in mobile/lib that DOES
    // pull in RN modules must not have a test in this glob.
    // src also matches *.test.jsx so co-located React component tests
    // (rendered to static markup via react-dom/server under this Node
    // environment — no jsdom/testing-library) are collected, e.g.
    // landing-page/InstagramStrip.test.jsx (EVENTS-IG.1).
    include: [
      'src/**/*.{test,spec}.{js,jsx}',
      'shared/**/*.{test,spec}.js',
      'tests/**/*.{test,spec}.js',
      'mobile/lib/**/*.{test,spec}.js',
    ],
    // Don't run the Next.js build output if it ever appears.
    exclude: ['node_modules', '.next', 'dist'],
    // Hide noisy [security] warnings the lib helpers emit during fail-open
    // paths in tests where we deliberately exercise those paths.
    silent: false,
  },
})
