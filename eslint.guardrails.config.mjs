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
      // NOTE: test files are NOT ignored globally any more (HUBDOOR.3). A
      // flat-config object carrying only `ignores` drops the file from EVERY
      // block, which would have made `no-substring-redirect-assertion` — a
      // rule about test assertions — unrunnable. The product rules keep their
      // old scope via a per-block `ignores` instead; only the last block below
      // sees a test file, and only for that one rule.
    ],
  },
  {
    // shared/ is the web/mobile data seam — full of Supabase fetchers, so the
    // same defect classes (1k-row cap, Dublin-time parsing) apply there too.
    files: ['src/**/*.{js,jsx}', 'shared/**/*.js'],
    ignores: ['**/*.test.js', '**/*.test.jsx'],
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
      // Repo-wide, unlike its per-path sibling below: a dead token is dead on
      // every surface, light or dark, so there is no area to survey first.
      'guardrails/no-dead-un1t-token': 'error',
      'guardrails/no-unescaped-ilike-pattern': 'error',
      'guardrails/no-untyped-button-in-form': 'error',
      'guardrails/no-discarded-single-error': 'error',
    },
  },
  {
    // COMMSLAYOUT.6 — `guardrails/no-low-contrast-accent-text` is armed
    // PER-PATH, not repo-wide. The rule cannot see what surface a class renders
    // on (see its doc comment), so the only honest scope is "areas whose
    // surfaces have actually been surveyed and cleaned". Repo-wide it would
    // need ~500 sites audited, an unknown share of which are correct
    // dark-surface idiom — and an allowlist of individual violations would rot.
    //
    // This list is the Communications area: its route trees, the components
    // that only ever render inside them, and the ten root-level components its
    // pages import. Every one was scanned to zero at ERROR before this landed,
    // with the two genuine dark islands (the `bg-black` HTML-source textareas
    // in CampaignEditor/TemplateEditor) passing on the rule's same-string
    // escape rather than a disable comment.
    //
    // TO ARM ANOTHER AREA: clean it, then add its path here. One line.
    files: [
      'src/app/communications/**',
      'src/app/email/templates/**',
      'src/app/whatsapp/templates/**',
      'src/components/communications/**',
      'src/components/tickets/**',
      // Root-level components rendered by the Communications pages. Named
      // individually because src/components/ as a whole is the entire app.
      'src/components/CampaignDetail.jsx',
      'src/components/CampaignEditor.jsx',
      'src/components/SMSBroadcastEditor.jsx',
      'src/components/SavedSegmentsList.jsx',
      'src/components/SegmentsGrid.jsx',
      'src/components/TemplateEditor.jsx',
      'src/components/UnifiedInbox.jsx',
      'src/components/WABroadcastEditor.jsx',
      'src/components/WATemplateEditor.jsx',
      'src/components/WhatsappTemplatesList.jsx',
    ],
    ignores: ['**/*.test.js', '**/*.test.jsx'],
    plugins: { guardrails },
    rules: {
      'guardrails/no-low-contrast-accent-text': 'error',
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
  {
    // HUBDOOR.3 — the ONE block that lints test files, for the ONE rule that
    // is about a test assertion. `toThrow('NEXT_REDIRECT:/…')` is a substring
    // match against a namespace of prefix-shaped paths, so it goes green
    // against redirects it was never meant to accept — the Operations hub
    // fallback suite passed on '/admin/fleet' for weeks that way. Every
    // product rule above is scoped to exclude tests, so nothing else changes
    // shape by test files becoming visible to this config.
    files: ['**/*.test.js', '**/*.test.jsx'],
    plugins: { guardrails },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'guardrails/no-substring-redirect-assertion': 'error',
    },
  },
]

export default config
