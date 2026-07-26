// Minimal ESLint flat config that runs ONLY eslint-plugin-import's
// "does this named export actually exist" rules over the mobile/ Expo app.
//
// Why this exists, separate from the root eslint.config.mjs (which
// deliberately ignores mobile/ — that's `expo lint`'s job, and it isn't in
// CI): the 2026-06 production crash. `schedule.jsx` did
// `import { MANAGER_ROLES } from 'shared/permissions'`, but that file
// never exported MANAGER_ROLES — so the value was `undefined` and
// `.includes()` threw at runtime ("Cannot read property 'includes' of
// undefined"). Invisible to vitest, to eslint (mobile ignored), AND to
// `expo export` (Metro tolerates undefined imports). It only blew up on a real
// device, after shipping in an OTA.
//
// Scope is deliberately narrow: the import/named family as ERRORS, nothing
// else. `import/ignore: node_modules` means third-party imports
// (react-native, expo-*, nativewind, @supabase/*) are never analysed and so
// can't be false-flagged — only imports between mobile-local files and the
// shared/ seam are validated, which is exactly where the bug class lives.
// Since the Expo 57 upgrade that seam is the `shared` file: package
// (mobile/package.json "shared": "file:../shared" → npm symlinks
// mobile/node_modules/shared → ../../shared), imported as 'shared/<module>'
// rather than '../../shared/<module>' — the resolver settings below exist to
// keep those bare specifiers analysable. Run via
// `npm run check:mobile-imports`; wired into Web CI.

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import importPlugin from 'eslint-plugin-import'
import reactHooks from 'eslint-plugin-react-hooks'

// This config lives at the repo root, so the repo root is its own dirname.
const repoRoot = dirname(fileURLToPath(import.meta.url))

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
      // 'shared/<module>' must resolve to the REAL ../shared files or the
      // rules below silently skip the exact imports this guard exists for:
      // - preserveSymlinks: false — the resolver's default (true) returns the
      //   symlinked mobile/node_modules/shared/* path, which matches
      //   `import/ignore: node_modules` and exempts the file from analysis;
      //   realpathing it lands outside node_modules, so it gets analysed.
      // - paths: [repoRoot] — Web CI runs `npm ci` at the repo root only, so
      //   mobile/node_modules (and its shared symlink) never exists there and
      //   the node_modules walk finds nothing; this absolute fallback lets
      //   'shared/*' still resolve to <repoRoot>/shared/* in CI.
      'import/resolver': {
        node: { extensions: ['.js', '.jsx', '.json'], preserveSymlinks: false, paths: [repoRoot] },
      },
      // Anything that (really) lives in node_modules — third-party packages —
      // stays un-analysed; shared/* escapes this via the realpathing above.
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
