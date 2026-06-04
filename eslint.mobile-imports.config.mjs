// Minimal ESLint flat config that runs ONLY eslint-plugin-import's
// "does this named export actually exist" rules over the mobile/ Expo app.
//
// Why this exists, separate from the root eslint.config.mjs (which
// deliberately ignores mobile/ — that's `expo lint`'s job, and it isn't in
// CI): the 2026-06 production crash. `schedule.jsx` did
// `import { MANAGER_ROLES } from '../../../shared/permissions'`, but that file
// never exported MANAGER_ROLES — so the value was `undefined` and
// `.includes()` threw at runtime ("Cannot read property 'includes' of
// undefined"). Invisible to vitest, to eslint (mobile ignored), AND to
// `expo export` (Metro tolerates undefined imports). It only blew up on a real
// device, after shipping in an OTA.
//
// Scope is deliberately narrow: the import/named family as ERRORS, nothing
// else. `import/ignore: node_modules` means third-party imports
// (react-native, expo-*, nativewind, @supabase/*) are never analysed and so
// can't be false-flagged — only LOCAL relative imports between mobile/,
// shared/ and lib files are validated, which is exactly where the bug class
// lives. Run via `npm run check:mobile-imports`; wired into Web CI.

import importPlugin from 'eslint-plugin-import'
import reactHooks from 'eslint-plugin-react-hooks'

const config = [
  {
    files: ['mobile/**/*.{js,jsx}'],
    ignores: ['mobile/node_modules/**', 'mobile/dist/**', 'mobile/.expo/**'],
    // react-hooks is registered (rules left OFF) only so existing
    // `// eslint-disable react-hooks/exhaustive-deps` comments in the mobile
    // code don't trip "Definition for rule not found". We run none of its
    // rules — that's expo lint's job. reportUnusedDisableDirectives is off so
    // the now-unused directives (no-console, global-require, react-hooks/*)
    // stay silent; this guard is import-resolution only.
    plugins: { import: importPlugin, 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: {
      'import/resolver': { node: { extensions: ['.js', '.jsx', '.json'] } },
      'import/ignore': ['node_modules'],
    },
    rules: {
      'import/named': 'error',      // named import must exist in the target (the crash)
      'import/default': 'error',    // default import must exist
      'import/namespace': 'error',  // `import * as x` member access must exist
      'import/export': 'error',     // no duplicate / invalid exports in a module
    },
  },
]

export default config
