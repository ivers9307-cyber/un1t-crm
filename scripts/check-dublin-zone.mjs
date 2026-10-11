#!/usr/bin/env node
// TZ.18a — the `no-hardcoded-dublin-zone` gate, with a baseline that only
// shrinks. Run by `npm run check:guardrails` (and alone as
// `npm run check:dublin-zone`).
//
// Why: a studio's clock is its `locations.timezone`. A bare 'Europe/Dublin'
// literal, or an import of `dublin-time`, is a per-tenant decision pinned to
// UN1T's zone. The timezone wave (docs/superpowers/plans/
// 2026-10-11-saas-timezone-wave.md) sweeps those files one area at a time;
// this gate tells each sweep exactly which files are left and stops the class
// regrowing while they run.
//
// What fails:
//   (a) a NEW offender: a file that trips the rule and is neither in the
//       baseline nor on the allowlist below. Fix the file: take the zone from
//       the location (@/lib/location-time: getLocationZone / zoneOfLocation),
//       or use PLATFORM_TZ for a platform-level decision.
//   (b) a STALE baseline line: a listed file that no longer trips the rule
//       (or no longer exists). Delete its line, in the same PR.
//   (c) GROWTH: a baseline line that is not in the frozen TZ.18a snapshot.
//       The baseline may only lose lines; a new offender is fixed, never listed.
//   (d) a baseline that is not sorted or holds a duplicate.
//
// Why a separate script and not a block in eslint.guardrails.config.mjs:
// flat config cannot fail on an ignore entry that has gone stale, which is
// (b), and that config ignores mobile/** globally, which this rule must see.
// `noInlineConfig` is on: an eslint-disable comment cannot hide an offender.
// The one way out is the allowlist, and every entry carries its reason.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import guardrails from '../eslint-rules/index.mjs'

export const RULE_ID = 'guardrails/no-hardcoded-dublin-zone'
export const BASELINE_PATH = 'eslint-rules/dublin-zone-baseline.txt'
export const FROZEN_PATH = 'eslint-rules/dublin-zone-baseline.tz18a-snapshot.txt'
export const LINT_GLOBS = Object.freeze(['src/**/*.{js,jsx}', 'shared/**/*.js', 'mobile/**/*.{js,jsx}'])

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

// The permanent allowlist. Each entry: a glob and the reason it may name the zone.
export const DUBLIN_ZONE_ALLOW = Object.freeze([
  { glob: 'shared/zoned-time.js', reason: "defines PLATFORM_TZ and DEFAULT_TZ: the ONE sanctioned 'Europe/Dublin' literal" },
  { glob: 'shared/dublin-time.js', reason: 'the legacy Dublin helpers themselves; champ-app mirrors this file (shared-pair sync). TZ.18b decides their end' },
  { glob: 'src/lib/dublin-time.js', reason: 'the web twin of shared/dublin-time.js, same reason' },
  { glob: '**/*.test.js', reason: 'tests: the byte-identity tests must name Europe/Dublin to pin UN1T' },
  { glob: '**/*.test.jsx', reason: 'component tests, same reason as *.test.js' },
  { glob: '**/*.test-helpers.js', reason: 'test helpers, incl. the frozen *.legacy-dublin.test-helpers.js copies (TZ.18b deletes those)' },
  { glob: '**/_test-*.js', reason: 'test fixtures: they model a Dublin studio on purpose' },
  { glob: '**/__tests__/**', reason: 'tests (jest-style folders under mobile/), same reason as *.test.js' },
  { glob: '**/__mocks__/**', reason: 'test mocks: they stand in for a Dublin studio on purpose' },
])

/** The flat config this gate lints with: the one rule, nothing else. */
export function dublinZoneConfig() {
  return [
    { ignores: [...ALWAYS_IGNORED, ...DUBLIN_ZONE_ALLOW.map((a) => a.glob)] },
    {
      files: ['src/**/*.{js,jsx}', 'shared/**/*.js', 'mobile/**/*.{js,jsx}'],
      plugins: { guardrails },
      linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      rules: { [RULE_ID]: 'error' },
    },
  ]
}

export function createDublinZoneLinter(cwd) {
  return new ESLint({ cwd, overrideConfigFile: true, overrideConfig: dublinZoneConfig() })
}

/** Parse a one-path-per-line list: `#` comments and blank lines are skipped. */
export function parseList(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

const toPosix = (p) => p.split(path.sep).join('/')

/**
 * Pure verdict. `results` are ESLint results with filePath relative to the
 * repo root (posix). Returns the four failure lists; all empty = pass.
 */
export function checkDublinZone({ results, baseline, frozen }) {
  const offenders = new Map()
  const fatal = []
  for (const r of results) {
    for (const m of r.messages) {
      if (m.fatal) fatal.push({ file: r.filePath, line: m.line, column: m.column, message: m.message })
      else if (m.ruleId === RULE_ID) {
        if (!offenders.has(r.filePath)) offenders.set(r.filePath, [])
        offenders.get(r.filePath).push({ line: m.line, column: m.column, message: m.message })
      }
    }
  }
  const listed = new Set(baseline)
  const frozenSet = new Set(frozen)

  const newOffenders = [...offenders.entries()]
    .filter(([file]) => !listed.has(file))
    .map(([file, messages]) => ({ file, messages }))
    .sort((a, b) => (a.file < b.file ? -1 : 1))
  const stale = baseline.filter((file) => !offenders.has(file))
  const growth = baseline.filter((file) => !frozenSet.has(file))

  const order = []
  const seen = new Set()
  baseline.forEach((file, i) => {
    if (seen.has(file)) order.push(`duplicate entry: ${file}`)
    seen.add(file)
    if (i > 0 && baseline[i - 1] > file) order.push(`out of order: ${file} must come before ${baseline[i - 1]}`)
  })

  return { newOffenders, stale, growth, order, fatal }
}

export function formatReport(v) {
  const out = []
  if (v.fatal.length) {
    out.push('Could not parse (the gate cannot see these files):')
    for (const f of v.fatal) out.push(`  ${f.file}:${f.line}:${f.column}  ${f.message}`)
  }
  if (v.newOffenders.length) {
    out.push(
      "New hard-coded Europe/Dublin (not in the baseline). Take the zone from the location (@/lib/location-time) or use PLATFORM_TZ; never add the file to the baseline:",
    )
    for (const o of v.newOffenders) for (const m of o.messages) out.push(`  ${o.file}:${m.line}:${m.column}  ${m.message}`)
  }
  if (v.stale.length) {
    out.push(`These files no longer hard-code Europe/Dublin. Delete their lines from ${BASELINE_PATH}:`)
    for (const f of v.stale) out.push(`  ${f}`)
  }
  if (v.growth.length) {
    out.push(`${BASELINE_PATH} may only shrink. These lines are not in the TZ.18a snapshot (${FROZEN_PATH}); fix the file instead:`)
    for (const f of v.growth) out.push(`  ${f}`)
  }
  if (v.order.length) {
    out.push(`${BASELINE_PATH} must stay sorted and unique:`)
    for (const o of v.order) out.push(`  ${o}`)
  }
  return out.join('\n')
}

export const failed = (v) =>
  v.fatal.length + v.newOffenders.length + v.stale.length + v.growth.length + v.order.length > 0

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
  const eslint = createDublinZoneLinter(root)
  const results = (await eslint.lintFiles([...LINT_GLOBS])).map((r) => ({
    filePath: toPosix(path.relative(root, r.filePath)),
    messages: r.messages,
  }))
  const baseline = parseList(read(BASELINE_PATH))
  const verdict = checkDublinZone({ results, baseline, frozen: parseList(read(FROZEN_PATH)) })
  if (failed(verdict)) {
    console.error(formatReport(verdict))
    process.exit(1)
  }
  console.log(`check:dublin-zone OK: ${results.length} files linted, ${baseline.length} still in the baseline.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
