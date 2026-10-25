#!/usr/bin/env node
// TZ.18a/TZ.18b — the `no-hardcoded-dublin-zone` gate. Run by
// `npm run check:guardrails` (and alone as `npm run check:dublin-zone`).
//
// Why: a studio's clock is its `locations.timezone`. A bare 'Europe/Dublin'
// literal, or an import of `dublin-time`, is a per-tenant decision pinned to
// UN1T's zone. The timezone wave (docs/superpowers/plans/
// 2026-10-11-saas-timezone-wave.md) swept every file; TZ.18b deleted the
// shrinking baseline it ran against, so the ban is now outright.
//
// What fails:
//   (a) any non-test file under src/, shared/ or mobile/ that names
//       'Europe/Dublin' or imports dublin-time, unless the allowlist below
//       names it. Fix the file: take the zone from the location
//       (@/lib/location-time: getLocationZone / zoneOfLocation; phone and
//       shared: shared/zoned-time), or use PLATFORM_TZ for a platform-level
//       decision.
//   (b) any TEST file (and tests/**) that imports dublin-time, unless the
//       allowlist names it. Tests may still NAME the zone: the Europe/Dublin
//       pins are how UN1T's behaviour stays fixed.
//
// Why a separate script and not a block in eslint.guardrails.config.mjs:
// that config ignores mobile/** globally, which this rule must see.
// `noInlineConfig` is on: an eslint-disable comment cannot hide an offender.
// The one way out is the allowlist, and every entry carries its reason.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import guardrails from '../eslint-rules/index.mjs'

export const RULE_ID = 'guardrails/no-hardcoded-dublin-zone'
export const LINT_GLOBS = Object.freeze(['src/**/*.{js,jsx}', 'shared/**/*.js', 'mobile/**/*.{js,jsx}', 'tests/**/*.{js,jsx}'])

// Never source: dependencies and build output.
const ALWAYS_IGNORED = Object.freeze([
  '**/node_modules/**',
  '.next/**',
  'mobile/ios/**',
  'mobile/android/**',
  'mobile/dist/**',
  'mobile/web-build/**',
  'mobile/.expo/**',
])

// The permanent allowlist: files skipped entirely. Each entry: a glob and the
// reason it may name the zone AND import dublin-time.
export const DUBLIN_ZONE_ALLOW = Object.freeze([
  { glob: 'shared/zoned-time.js', reason: "defines PLATFORM_TZ and DEFAULT_TZ: the ONE sanctioned 'Europe/Dublin' literal" },
  { glob: 'shared/dublin-time.js', reason: 'the legacy Dublin helpers themselves; kept because champ-app mirrors this file (CLAUDE.md shared sync rule). Nothing in this repo imports it' },
  { glob: 'src/lib/dublin-time.js', reason: 'the web twin of shared/dublin-time.js, kept for the same mirror; nothing imports it' },
  { glob: 'shared/dublin-time.test.js', reason: "the legacy module's own tests (champ-app mirrors them)" },
  { glob: 'src/lib/dublin-time.test.js', reason: "the web twin's own tests" },
  { glob: 'shared/zoned-time.parity.test.js', reason: 'proves every zoned-time twin is byte-identical to its dublin-time original for Europe/Dublin' },
])

// Test files: linted with `{ literals: false }`. They may name Europe/Dublin
// (the byte-identity pins), but they may not import dublin-time.
export const TEST_GLOBS = Object.freeze([
  '**/*.test.js',
  '**/*.test.jsx',
  '**/*.test-helpers.js',
  '**/_test-*.js',
  '**/__tests__/**',
  '**/__mocks__/**',
  'tests/**',
])

/** The flat config this gate lints with: the one rule, nothing else. */
export function dublinZoneConfig() {
  return [
    { ignores: [...ALWAYS_IGNORED, ...DUBLIN_ZONE_ALLOW.map((a) => a.glob)] },
    {
      files: ['src/**/*.{js,jsx}', 'shared/**/*.js', 'mobile/**/*.{js,jsx}', 'tests/**/*.{js,jsx}'],
      plugins: { guardrails },
      linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      rules: { [RULE_ID]: 'error' },
    },
    { files: [...TEST_GLOBS], rules: { [RULE_ID]: ['error', { literals: false }] } },
  ]
}

export function createDublinZoneLinter(cwd) {
  return new ESLint({ cwd, overrideConfigFile: true, overrideConfig: dublinZoneConfig() })
}

const toPosix = (p) => p.split(path.sep).join('/')

/**
 * Pure verdict. `results` are ESLint results with filePath relative to the
 * repo root (posix). Returns the offenders and any file the parser could not
 * read; both empty = pass.
 */
export function checkDublinZone({ results }) {
  const offenders = []
  const fatal = []
  for (const r of results) {
    const messages = []
    for (const m of r.messages) {
      if (m.fatal) fatal.push({ file: r.filePath, line: m.line, column: m.column, message: m.message })
      else if (m.ruleId === RULE_ID) messages.push({ line: m.line, column: m.column, message: m.message })
    }
    if (messages.length) offenders.push({ file: r.filePath, messages })
  }
  offenders.sort((a, b) => (a.file < b.file ? -1 : 1))
  return { offenders, fatal }
}

export function formatReport(v) {
  const out = []
  if (v.fatal.length) {
    out.push('Could not parse (the gate cannot see these files):')
    for (const f of v.fatal) out.push(`  ${f.file}:${f.line}:${f.column}  ${f.message}`)
  }
  if (v.offenders.length) {
    out.push(
      "Hard-coded Europe/Dublin. Take the zone from the location (@/lib/location-time; phone and shared: shared/zoned-time) or use PLATFORM_TZ for a platform-level decision. Tests may name the zone but never import dublin-time:",
    )
    for (const o of v.offenders) for (const m of o.messages) out.push(`  ${o.file}:${m.line}:${m.column}  ${m.message}`)
  }
  return out.join('\n')
}

export const failed = (v) => v.fatal.length + v.offenders.length > 0

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const eslint = createDublinZoneLinter(root)
  const results = (await eslint.lintFiles([...LINT_GLOBS])).map((r) => ({
    filePath: toPosix(path.relative(root, r.filePath)),
    messages: r.messages,
  }))
  const verdict = checkDublinZone({ results })
  if (failed(verdict)) {
    console.error(formatReport(verdict))
    process.exit(1)
  }
  console.log(`check:dublin-zone OK: ${results.length} files linted, no hard-coded Europe/Dublin.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
