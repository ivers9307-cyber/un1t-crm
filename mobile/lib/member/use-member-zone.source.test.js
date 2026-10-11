// TZ.14 — SOURCE-level guard for the member-zone wiring (D7 = A).
//
// TZ.13 gave every member-facing shared/ helper an OPTIONAL trailing zone that
// defaults to Europe/Dublin, so a phone call site that forgets it compiles,
// passes every test and silently keeps a New York member on Dublin's clock.
// There is no RN renderer in this suite (memory: phone-mail-reader), so the
// property is asserted where it lives: every call of a zone-taking helper in a
// member screen passes the member's zone (`tz`), and the hook reads it from the
// member's studio brand.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mobile = join(here, '..', '..')

// The TZ.13 exports whose LAST parameter is the member zone.
const ZONED = [
  'sessionDate', 'computeProgress', 'weeklyStreak', 'currentStreak', 'kudosRelativeTime',
  'weekDigestModel', 'groupSessionsByMonth', 'activityCalendar', 'personalRecords',
  'lifetimeMilestones', 'monthWrappedModel', 'monthWrappedKey', 'challengeWindowMs',
  'endedRecentlyFlagship', 'ownWindowStats', 'challengeWrappedModel', 'windowIso',
]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.jsx?$/.test(name) && !/\.test\.|test-helpers/.test(name)) out.push(p)
  }
  return out
}

// The argument text of every call `fn(` in `src` (balanced parentheses).
function callArgs(src, fn) {
  const out = []
  const re = new RegExp(`(?<![\\w.])${fn}\\(`, 'g')
  let m
  while ((m = re.exec(src))) {
    // Skip the import line and the definition, if any.
    const lineStart = src.lastIndexOf('\n', m.index) + 1
    const line = src.slice(lineStart, src.indexOf('\n', m.index))
    if (/^\s*import\b|function\s/.test(line)) continue
    let depth = 1
    let i = m.index + m[0].length
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') depth--
    }
    out.push(src.slice(m.index + m[0].length, i - 1))
  }
  return out
}

const files = [...walk(join(mobile, 'app')), ...walk(join(mobile, 'components'))]

describe('TZ.14 member screens pass the member zone to every zone-taking helper', () => {
  const sites = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const fn of ZONED) for (const args of callArgs(src, fn)) sites.push({ file: relative(mobile, f), fn, args })
  }

  it('finds the call sites (the scan is not vacuous)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(20)
  })

  // `loadZone` is Home's load-time snapshot of `tz` (home.jsx).
  it.each(ZONED)('%s(…) always carries tz', (fn) => {
    const bare = sites.filter((s) => s.fn === fn && !/\b(tz|loadZone)\b/.test(s.args))
    expect(bare.map((s) => `${s.file}: ${fn}(${s.args})`)).toEqual([])
  })
})

describe('TZ.14 useMemberZone reads the member\'s studio brand', () => {
  it('composes useMemberBrand with memberZoneFromBrand', () => {
    const src = readFileSync(join(here, 'use-member-zone.js'), 'utf8')
    expect(src).toMatch(/useMemberBrand\(\)/)
    expect(src).toMatch(/memberZoneFromBrand\(brand\)/)
  })
})
