// ESLint flat config — Next.js 16 + ESLint 10.
//
// Migrated from .eslintrc.json by `next-lint-to-eslint-cli` codemod
// during the 14→16 upgrade. The codemod left this in a half-shape
// (extends: [...]) which ESLint 10 doesn't accept in flat config —
// flat config spreads other configs at the top level of the array
// instead. Rewritten by hand to the canonical flat-config shape.
//
// What's preserved from the old .eslintrc.json:
//   • next/core-web-vitals base (now flat-config-native, an array of
//     4 config objects — spread directly).
//   • Custom rules: no-undef as error, no-unused-vars warn with
//     `_`-prefix ignore convention, react/no-unescaped-entities off,
//     @next/next/no-img-element off.
//   • Globals: browser + node (the project mixes server + client
//     files; the next-core-web-vitals base sets the React jsx-runtime
//     parser etc., we just add the global namespaces).
//
// What's new under flat config:
//   • Ignores are no longer in a .eslintignore file — they live in
//     the `ignores` key on a top-level entry. `next lint` previously
//     skipped .next/, node_modules/, public/ by default; we replicate
//     that here. mobile/ is its own Expo project with its own ESLint
//     setup — exclude it from this root config.

import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import globals from 'globals'
import guardrails from './eslint-rules/index.mjs'

const config = [
  {
    // `next lint` used to ignore these by default. With flat-config
    // we declare them explicitly — must be the first entry in the
    // array per the ESLint docs.
    ignores: [
      '.next/**',
      'node_modules/**',
      'public/**',
      'mobile/**',
      'supabase/migrations/**',
      // Supabase Edge Functions are DENO, not Node/Next: `Deno.serve`,
      // `Deno.env` and TypeScript syntax all trip this config (no-undef, no
      // TS parser), and none of the Next rules mean anything there. Same
      // reasoning as supabase/migrations above — a different runtime with its
      // own toolchain. The wire contract they implement IS covered by vitest,
      // via src/lib/email-attachment-staging.contract.test.js, which reads the
      // .ts source off disk and pins the constants.
      'supabase/functions/**',
      'out/**',
      'dist/**',
      'build/**',
      // Claude Code session worktrees — each is a FULL repo checkout, so
      // without this `eslint .` in the primary repo lints the codebase once
      // per worktree (observed: 44 copies ≈ 15+ min, plus nondeterministic
      // results from agents' in-flight code). CI never has this dir.
      '.claude/**',
    ],
  },
  ...nextCoreWebVitals,
  {
    // Register the local `guardrails` plugin here with NO rules enabled.
    // The two guardrails rules run ONLY via the scoped
    // eslint.guardrails.config.mjs (`npm run check:guardrails`) — the main
    // lint posture is deliberately unchanged. But the deliberate-cap sites
    // carry inline `// eslint-disable(-next)-line guardrails/no-uncapped-
    // supabase-limit` comments; without the plugin registered, `eslint .`
    // errors "Definition for rule 'guardrails/…' was not found" on every
    // one. Registering the plugin (rules left off) makes those directives
    // resolve. Same trick the guardrails config uses for react-hooks/@next.
    // (The directives read as "unused" under THIS config since the rule is
    // off here — that's silenced for just those files in the entry below,
    // so the global unused-disable signal is preserved everywhere else.)
    plugins: { guardrails },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      'react/no-unescaped-entities': 'off',
      '@next/next/no-img-element': 'off',
      // ─── react-hooks plugin: post-Next-16 rule tuning ─────────────
      //
      // The react-hooks plugin shipped with eslint-config-next@16
      // adds several stricter rules that the codebase pre-dates.
      // CODEQUAL.1 walked every flagged site after the NEXT.16
      // upgrade landed (47 set-state-in-effect + 10 purity, plus
      // 1 refs + 1 immutability singleton). The two singletons got
      // per-line disables with documented justifications (see the
      // file headers in LocationSwitcher.jsx + LiveClassClient.jsx).
      //
      // The two volume rules are turned OFF here as a policy
      // decision, not silenced site-by-site:
      //
      //   • set-state-in-effect — flags `setState` inside
      //     `useEffect` bodies. Every flagged site in this codebase
      //     is either (a) the standard async-fetch-on-mount →
      //     setState-on-success pattern, or (b) a side-effect on
      //     navigation / prop change (e.g. close-drawer-on-route-
      //     change). Both are widely-accepted React conventions;
      //     the canonical "you might not need an effect" doc treats
      //     them as legitimate. Rewriting all 47 into useReducer /
      //     SWR is a multi-day refactor and would introduce real
      //     regression risk; we'd rather invest that time in
      //     adopting a data-fetching library (SWR / TanStack Query)
      //     end-to-end at a later date and revisit then.
      //
      //   • purity — every flagged site is reading `Date.now()` or
      //     `new Date()` during render to derive "is this expired
      //     now" / "minutes remaining" / "current time" displays.
      //     The render output legitimately depends on current time.
      //     The rule's recommended fix (move into state, tick via
      //     useEffect) is theoretically purer but adds unneeded
      //     state for every component that wants to show a clock —
      //     not worth the boilerplate for a non-bug.
      //
      // Other rules in the plugin stay enabled at the eslint-config-
      // next default (warn). exhaustive-deps in particular is
      // valuable — keep it as a warning, fix individually as new
      // ones appear.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity':              'off',
      'react-hooks/exhaustive-deps':     'warn',
    },
  },
  {
    // The deliberate-cap / deliberate-UTC-key / deliberate-zulu sites carry an
    // inline `guardrails/*` disable (no-uncapped-supabase-limit, no-utc-today,
    // no-zulu-template-date) that fires under the SCOPED guardrails config
    // (where the rules are on) but reads as "unused" under THIS main config
    // (where they're off). Silence the unused-directive report for exactly these
    // files so the cross-config directive isn't flagged here — without
    // disabling the report globally (the pre-existing unused-disable signal
    // elsewhere, e.g. src/lib/person-aggregate.js, stays intact). Keep this
    // list in sync with the eslint-disable comments for those rules.
    files: [
      'src/app/api/agent/analytics/route.js',
      // `[slug]` brackets are minimatch character-classes — escape them so the
      // pattern matches the literal directory name, not one of s/l/u/g.
      'src/app/api/public/events/\\[slug\\]/register/route.js',
      'src/app/api/public/events/\\[slug\\]/route.js',
      'src/lib/agent/event-tools.js',
      'src/lib/class-categories.js',
      'src/lib/contact-events.js',
      'src/lib/dashboard/business-rail.js',
      'src/lib/host-campaign-backfill.js',
      'src/lib/race-register-solo.js',
      // no-utc-today deliberate-UTC-key sites (CSV filename / storage path):
      'src/app/api/admin/audit-log/route.js',
      'src/app/api/cars/reports/export/route.js',
      'src/app/api/card-receipts/upload-sign/route.js',
      // no-zulu-template-date reminder window-match sites (#650 verification):
      'src/lib/event-reminders.js',
      'src/lib/sequences/cron-triggers.js',
    ],
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
]

export default config
