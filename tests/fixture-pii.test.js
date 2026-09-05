// HYGIENE-PII.1 — this repository is PUBLIC, and the Mail audit found real
// people used as test fixtures: a staff member's name, a customer's name and
// work email, the owner's personal domain and mobile number. All of them were
// renamed to fictional stand-ins (Alex Example, Jordan Sample, example.test).
// This guard keeps them out.
//
// Deliberately NARROW: it lists the specific strings the audit identified,
// not "any name". A broad no-names rule would be noise (every fixture has a
// name) and would still miss the next real person. Add to BANNED only when a
// real person / real personal address is found in a fixture again.
//
// Scope is the test-and-fixture surface only — `*.test.{js,jsx,mjs}`,
// `*.fixture.*`, `__fixtures__/`, `tests/fixtures/` — across the whole tree
// (mobile/ included, which check:guardrails does not lint). Non-test source
// is out of scope on purpose: a real staff name in a seed migration or a
// sequence sender is a product fact, not a fixture. `mobile/eas.json`'s Apple
// ID is likewise operational config, not a fixture.
//
// Files come from `git ls-files`, so an untracked scratch file is not a
// finding and CI (a git checkout) sees the same set as a local run.

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// This file necessarily spells the banned strings; it is the one exemption.
const SELF = 'tests/fixture-pii.test.js'

export const BANNED = [
  { label: "owner's personal domain / address", re: /richardivers/i },
  { label: "owner's mobile number", re: /314\s?7675/ },
  { label: 'real staff first name', re: /\bdean\b/i },
  { label: 'real customer first name', re: /\bcaitlin\b/i },
  // Both the plain address and its regex-escaped form (`flogas\.ie`).
  { label: "real customer's work email domain", re: /@flogas\\?\.ie/i },
]

export const isFixturePath = (relPath) =>
  /\.test\.(js|jsx|mjs)$/.test(relPath) ||
  /\.fixture\./.test(relPath) ||
  /(^|\/)__fixtures__\//.test(relPath) ||
  /^tests\/fixtures\//.test(relPath)

export function scanText(relPath, text) {
  const findings = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const { label, re } of BANNED) {
      if (re.test(lines[i])) findings.push(`${relPath}:${i + 1}  [${label}]`)
    }
  }
  return findings
}

function trackedFixtureFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((p) => p && p !== SELF && isFixturePath(p))
}

describe('fixture-pii guard — no real people in test fixtures (public repo)', () => {
  it('scopes to the test-and-fixture surface only', () => {
    expect(isFixturePath('src/lib/foo.test.js')).toBe(true)
    expect(isFixturePath('mobile/lib/foo.test.js')).toBe(true)
    expect(isFixturePath('src/components/Foo.test.jsx')).toBe(true)
    expect(isFixturePath('shared/__fixtures__/session-report.fixture.json')).toBe(true)
    expect(isFixturePath('tests/fixtures/bundle-sql-migrations/001.sql')).toBe(true)
    expect(isFixturePath('src/lib/foo.js')).toBe(false)
    expect(isFixturePath('mobile/eas.json')).toBe(false)
    expect(isFixturePath('supabase/migrations/033_master_role.sql')).toBe(false)
  })

  it('fires on each banned string, in both prose and regex-escaped forms', () => {
    expect(scanText('x.test.js', "name: 'Dean Nolan'")).toHaveLength(1)
    expect(scanText('x.test.js', "requester_name: 'Caitlin Thornton'")).toHaveLength(1)
    expect(scanText('x.test.js', "email: 'richard@richardivers.com'")).toHaveLength(1)
    expect(scanText('x.test.js', 'a@flogas.ie')).toHaveLength(1)
    expect(scanText('x.test.js', '/from a\\.b@flogas\\.ie/')).toHaveLength(1)
    expect(scanText('x.test.js', "wa_phone: '353873147675'")).toHaveLength(1)
    expect(scanText('x.test.js', "normalise('+353 87 314 7675')")).toHaveLength(1)
  })

  it('stays quiet on the fictional stand-ins and on words that merely contain a banned name', () => {
    expect(scanText('x.test.js', "name: 'Alex Example', email: 'jordan.sample@example.test'")).toEqual([])
    expect(scanText('x.test.js', "subject: 'Flogas bill for Hatch Street'")).toEqual([]) // a company, not a person
    expect(scanText('x.test.js', 'the deanery; dean_of_faculty; Deane')).toEqual([])
    expect(scanText('x.test.js', 'caitlinesque')).toEqual([])
  })

  it('no tracked test or fixture file names a real person', () => {
    const findings = []
    for (const rel of trackedFixtureFiles()) {
      let text
      try { text = readFileSync(path.join(ROOT, rel), 'utf8') } catch { continue }
      if (text.includes('\0')) continue // binary fixture (e.g. heic-sample.heic)
      findings.push(...scanText(rel, text))
    }
    expect(findings, `Real people in test fixtures (rename to fictional stand-ins, see tests/fixture-pii.test.js):\n  ${findings.join('\n  ')}`).toEqual([])
  })
})
