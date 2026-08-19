// Scoped ESLint flat config — the ORDINARY-DEFECT lint for the mobile/ Expo app.
// Run via `npm run check:mobile-lint`, wired into Web CI as its own step.
//
// ─── Why this exists ────────────────────────────────────────────────────────
// Until MOBILE-LINT.1 no linter ran against mobile/** at all. The root
// eslint.config.mjs ignores mobile/ (see its `ignores` block) on the stated
// grounds that mobile is "its own Expo project with its own ESLint setup".
// That delegation never worked:
//   • there was no ESLint config anywhere in mobile/, and
//   • `npx expo lint` dies with "Cannot find module 'eslint'" — mobile/
//     package.json carries no eslint dependency at all (devDeps: @babel/core).
// So `npm run lint` — a CI job and one of the CI-mirror commands — reported
// clean on changes that had inspected none of the 259 files in mobile/.
// EMAIL-TICKET.6 and INBOX-SPLIT.1 both shipped that way and each needed a
// throwaway manual no-unused-vars / no-undef pass instead.
//
// ─── Why the root toolchain rather than fixing `expo lint` ──────────────────
// Web CI runs `npm ci` at the repo root only; mobile/node_modules does not
// exist there (or in a fresh worktree). Making `expo lint` the gate would mean
// installing the whole Expo 57 / RN 0.86 native dependency tree in CI just to
// run a linter, and re-syncing mobile/package-lock.json (which EAS `npm ci`
// validates) on every eslint bump. The root toolchain, meanwhile, ALREADY
// parses every mobile file: eslint.mobile-imports.config.mjs has been linting
// `mobile/**/*.{js,jsx}` from the root, in CI, since the 2026-06 schedule
// crash — including resolving the `shared` seam without mobile/node_modules.
// mobile/ is also 100% plain .js/.jsx (no TypeScript), so no extra parser is
// involved. This config follows that proven path.
//
// If TypeScript ever lands in mobile/: the npm script's glob is
// {js,jsx,mjs}, so a .ts/.tsx file would be silently UNLINTED — the precise
// failure mode this whole ticket is about. Widen the glob AND add
// typescript-eslint's parser in the same change; a widened glob alone turns
// silence into a parse error, which is louder but still not lint coverage.
//
// ─── Why a scoped config rather than un-ignoring mobile/** in the root ──────
// Two reasons:
//   1. `npm run lint` is `eslint .` with no --max-warnings, and the root sets
//      no-unused-vars to 'warn'. Un-ignoring mobile/ would file exactly the
//      defect class this ticket is about as a NON-FAILING warning. Here the
//      rules are ERRORs, so they block at PR time — the same posture as the
//      sibling scoped configs (check:guardrails, check:mobile-imports).
//   2. The root config spreads eslint-config-next/core-web-vitals, which
//      applies the @next/next rules to every file it lints. Those are
//      meaningless for React Native (no next/image, no pages/ router) and
//      would have to be switched back off for mobile/ anyway.
//
// ─── Relationship to the other mobile checks ────────────────────────────────
//   • check:mobile-imports  — does an imported NAME exist in the target module
//                             (the undefined-at-runtime crash class).
//   • check:mobile-parity   — does a WEB_PERMISSIONS key have a mobile answer.
//   • check:mobile-lint     — this one: ordinary defects inside a file.
// Deliberately disjoint; none of them subsumes another.

import js from '@eslint/js'
import globals from 'globals'
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import reactHooks from 'eslint-plugin-react-hooks'
import guardrails from './eslint-rules/index.mjs'

// eslint-plugin-react is not a direct dependency of this repo — it arrives as a
// transitive of eslint-config-next and currently sits at
// node_modules/eslint-config-next/node_modules/eslint-plugin-react, i.e. NOT
// hoisted. Importing it by bare specifier would work only by hoisting accident
// and break the moment npm flattens differently. eslint-config-next's flat
// config already holds a live instance of the plugin, so lift it from there:
// one declared dependency, no resolution guesswork.
const nextBase = nextCoreWebVitals.find((entry) => entry.plugins?.react)
const reactPlugin = nextBase?.plugins?.react
if (!reactPlugin) {
  throw new Error(
    'eslint.mobile.config.mjs: could not lift eslint-plugin-react out of ' +
      'eslint-config-next/core-web-vitals. Its config shape changed — re-check ' +
      'which entry carries plugins.react (was entry 0, name "next").',
  )
}

// React Native's bundle globals. RN runs neither in a browser nor in Node, but
// its global surface is mostly the browser one (fetch/console/URL/FormData/
// Blob/setTimeout/AbortController...), which is why globals.browser is the
// right base — the same choice the root config and eslint.guardrails.config.mjs
// make. These are the RN-specific additions on top:
//   • __DEV__  — injected by Metro; used for dev-only branches.
//   • process  — Babel inlines process.env.EXPO_PUBLIC_* at build time.
//   • require / module / __dirname — Metro implements CommonJS, and the app
//     uses require() for static asset handles (require('../assets/x.png')),
//     which is the documented RN idiom and cannot be an ESM import.
const reactNativeGlobals = {
  __DEV__: 'readonly',
  process: 'readonly',
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  __dirname: 'readonly',
  global: 'readonly',
}

const config = [
  {
    ignores: [
      'mobile/node_modules/**',
      'mobile/.expo/**',
      'mobile/dist/**',
      'mobile/android/**',
      'mobile/ios/**',
    ],
  },

  // ─── The app itself: ESM + JSX, React Native runtime ──────────────────────
  {
    files: ['mobile/**/*.{js,jsx,mjs}'],
    plugins: { react: reactPlugin, 'react-hooks': reactHooks, guardrails },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...reactNativeGlobals },
    },
    // Pinned, not 'detect'. This config lints MOBILE code, but `detect`
    // resolves whatever react the CWD walk finds — the root's ^19.2.8 in CI
    // (where mobile/node_modules does not exist), and mobile's own 19.2.3
    // locally where it does. None of the four react rules below are
    // version-sensitive, so the mismatch is currently harmless, but a config
    // that reports a different React depending on where it runs is a trap
    // waiting for the first version-gated rule. Keep in step with
    // mobile/package.json's react pin.
    settings: { react: { version: '19.2.3' } },
    rules: {
      ...js.configs.recommended.rules,

      // `try { … } catch {}` is this repo's documented fire-and-forget idiom
      // ("side effects run in their own try/catch and never block the primary
      // response" — CLAUDE.md), used 35× in src/ and 4× in mobile/lib/
      // geofence.js, every one of them with a comment saying why the failure is
      // ignorable. Requiring a `/* noop */` filler there buys nothing. The rule
      // stays ON for every OTHER empty block (if/for/while), which are real
      // defects.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // The one guardrails rule that crosses the web/mobile seam. mobile/
      // carries its OWN tailwind.config.js, and MOB-UI.1 renamed its un1t
      // palette to match the web's UI-FOUND.1 names — so a stale `bg-un1t-dark`
      // is exactly as dead in a .jsx screen as in a web component, and fails
      // the same silent way (no css, element inherits). Three had survived
      // here. The other guardrails rules stay web-only: they police supabase-js
      // and next/form idioms that mobile does not use.
      'guardrails/no-dead-un1t-token': 'error',

      // The two headline classes from the ticket. Both ERROR: a warning would
      // not fail `eslint`, which is how mobile defects stayed invisible.
      'no-undef': 'error',
      'no-unused-vars': ['error', {
        // Same `_`-prefix escape hatch the root config uses, so the convention
        // is identical on both sides of the web/mobile seam.
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      // JSX bookkeeping. Without these two, no-unused-vars cannot see that
      // `import { View } from 'react-native'` is used by `<View />`, and would
      // report essentially every component import in the app as unused.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      // <Foo /> where Foo was never imported — no-undef does not cover JSX
      // element names on its own.
      'react/jsx-no-undef': 'error',
      // Missing keys in .map()ed lists: real, and everywhere in these screens.
      'react/jsx-key': 'error',

      // Hooks. rules-of-hooks is non-negotiable — a conditional hook corrupts
      // React's hook ordering and fails at runtime, not build time.
      'react-hooks/rules-of-hooks': 'error',
      // exhaustive-deps is the highest-value rule in this config: the mobile
      // screens poll on an interval and refetch on focus, which is precisely
      // where a stale closure captures an old token/location and silently
      // serves the wrong data. Kept ERROR here (the root runs it at 'warn' for
      // web); the pre-existing per-line disables in mobile/ are honoured.
      'react-hooks/exhaustive-deps': 'error',

      // ── react-hooks rules deliberately OFF ──────────────────────────────
      // These are React Compiler rules that ship enabled-by-default in
      // eslint-plugin-react-hooks 7. The root config already turned both off
      // for web after CODEQUAL.1 walked every flagged site; the same reasoning
      // applies verbatim to mobile, and having them differ across the seam
      // would be worse than either setting. See eslint.config.mjs for the full
      // rationale (async-fetch-on-mount is a legitimate pattern; reading the
      // clock during render is legitimate for "expires in N min" displays).
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
    },
  },

  // ─── Build-time config files: CommonJS, Node runtime ──────────────────────
  // babel/metro/tailwind configs are `module.exports = ...` and run in Node
  // (Metro's config loader), not in the RN bundle — so they need the Node
  // global set and CommonJS parsing, not the app block's ESM+browser setup.
  {
    files: ['mobile/babel.config.js', 'mobile/metro.config.js', 'mobile/tailwind.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  // ─── Node scripts ─────────────────────────────────────────────────────────
  // mobile/scripts/*.mjs run under Node (version bumping), never in the bundle.
  {
    files: ['mobile/scripts/**/*.{js,mjs}', 'mobile/app.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // ─── Cross-config disable directives ──────────────────────────────────────
  // These five files carry `eslint-disable` comments for rules this config does
  // not enable, so ESLint reports each as an unused directive. They are not
  // dead — they document deliberate decisions, and they would go live again the
  // moment anyone adds eslint-config-expo alongside this:
  //   • no-console (api.js, supabase.js) — both are console.ERROR on missing
  //     required env, the "fail loud, no silent fallbacks" rule from CLAUDE.md.
  //     We do not enable no-console here; that would be a policy change on a
  //     lint-infrastructure ticket, and console.error is explicitly the
  //     sanctioned form.
  //   • global-require (build-info.js, foreground-ota.jsx, RootErrorBoundary
  //     .jsx) — all three lazily `require('expo-updates')` inside a try/catch
  //     so a bare Expo Go run (where the native module is absent) degrades
  //     instead of crashing at import time. No registered plugin defines that
  //     rule.
  // Scoping the exemption to these exact files — rather than switching the
  // report off wholesale — keeps the signal everywhere else, so a stale
  // `// eslint-disable-next-line react-hooks/exhaustive-deps` left behind after
  // a real fix still gets flagged. Same approach, and same reasoning, as the
  // per-file block at the end of the root eslint.config.mjs.
  {
    files: [
      'mobile/lib/api.js',
      'mobile/lib/supabase.js',
      'mobile/lib/build-info.js',
      'mobile/lib/foreground-ota.jsx',
      'mobile/components/RootErrorBoundary.jsx',
    ],
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
]

export default config
