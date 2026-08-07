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
    // shared/ is the web/mobile data seam — full of Supabase fetchers, so the
    // same defect classes (1k-row cap, Dublin-time parsing) apply there too.
    files: ['src/**/*.{js,jsx}', 'shared/**/*.js'],
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
      'guardrails/no-zulu-template-date': 'error',
      'guardrails/no-utc-today': 'error',
      'guardrails/no-low-contrast-chip': 'error',
      'guardrails/no-unescaped-ilike-pattern': 'error',
    },
  },
  {
    // Genuinely DARK surfaces — TV boards + the presentation screen render on
    // black; low text ramps are the correct idiom there, so the light-theme
    // chip-contrast rule does not apply. The public event booking flow
    // (register / checkout / confirmation / embed) was reskinned to the dark
    // UN1T brand (EVENTS-RESKIN.1), so it joins the same exemption. The host
    // self-serve portal (HOST-PORTAL.3) is a bg-black host surface too — its
    // layout, login, set-password and event form all render white-on-black.
    files: [
      'src/app/tv/**', 'src/app/present/**', 'src/components/RaceDisplayBoard.jsx',
      'src/app/event/**', 'src/app/event-pay/**', 'src/app/embed/event/**',
      'src/components/RaceSignupWidget.jsx',
      'src/components/RaceConfirmedPage.jsx',
      'src/components/RaceCheckoutPage.jsx',
      'src/app/host/**', 'src/components/host/**',
    ],
    plugins: { guardrails },
    rules: {
      'guardrails/no-low-contrast-chip': 'off',
    },
  },
]

export default config
