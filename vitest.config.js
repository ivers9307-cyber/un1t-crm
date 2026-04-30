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
    // Match co-located *.test.js files alongside the lib code, plus a
    // top-level tests/ directory if we ever add one.
    include: ['src/**/*.{test,spec}.js', 'tests/**/*.{test,spec}.js'],
    // Don't run the Next.js build output if it ever appears.
    exclude: ['node_modules', '.next', 'dist'],
    // Hide noisy [security] warnings the lib helpers emit during fail-open
    // paths in tests where we deliberately exercise those paths.
    silent: false,
  },
})
