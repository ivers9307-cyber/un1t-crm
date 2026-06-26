// Scoped ESLint flat config — the "guardrails" custom rules against the audit's
// recurring defect classes (1k-row cap, supabase-js thenable misuse). Run via
// `npm run check:guardrails`, wired into Web CI as its own step (like
// eslint.mobile-imports.config.mjs). ERROR-level: the point is to block the bug
// at PR time. Kept OUT of the main eslint.config.mjs so the main lint posture is
// unchanged. Design: docs/superpowers/specs/2026-06-25-guardrails-lint-design.md.

import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import nextPlugin from '@next/eslint-plugin-next'
import guardrails from './eslint-rules/index.mjs'

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'public/**',
      'mobile/**',
      'out/**',
      'dist/**',
      'build/**',
      '**/*.test.js',
      '**/*.test.jsx',
    ],
  },
  {
    files: ['src/**/*.{js,jsx}'],
    // react-hooks + @next/next are registered with NO rules enabled, only so the
    // inline `// eslint-disable react-hooks/*` / `@next/next/*` comments in the
    // components don't trip "Definition for rule not found" under this standalone
    // config (same trick as eslint.mobile-imports.config.mjs). We run none of
    // their rules — just the two guardrails rules below.
    plugins: { guardrails, 'react-hooks': reactHooks, '@next/next': nextPlugin },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'guardrails/no-catch-on-supabase-builder': 'error',
      'guardrails/no-uncapped-supabase-limit': 'error',
    },
  },
]

export default config
