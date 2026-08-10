// GAPS-P6 — the consent_log action vocabulary, and the machine guard that
// keeps it a vocabulary of ONE.
//
// WHY THIS FILE SCANS THE REPO
// `consent_log.action` carried two spellings for the same two facts for
// months: 'opt_out' (14,214 rows) and 'opted_out' (83), 'opt_in' (84) and
// 'opted_in' (3). The origin is traceable — mig 005 created the table with
// the comment `action TEXT NOT NULL, -- opted_in, opted_out`, and
// `contacts.wa_status` legitimately takes the VALUE 'opted_out', so the word
// was copied into a column where it is the wrong vocabulary. The cost is that
// every report, filter and export written against `action = 'opt_out'`
// silently under-counts withdrawals of consent, including everyone who texted
// STOP on WhatsApp. That is the GDPR evidence trail.
//
// A unit test on the constants alone would not have caught it: the drift was
// in files that never imported a constant. So the guard below reads the
// source of every consent_log writer and asserts the value it writes comes
// from here. The DB-side twin is the CHECK constraint in mig 516 — belt
// (source scan, catches it in CI) and braces (constraint, catches anything
// that reaches Postgres by another route).

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import {
  CONSENT_ACTIONS,
  CONSENT_ACTION_VALUES,
  LEGACY_CONSENT_ACTIONS,
  consentActionFor,
  normaliseConsentAction,
  isConsentOptOut,
} from './consent-actions.js'

describe('the canonical vocabulary', () => {
  it('is exactly opt_in / opt_out', () => {
    expect(CONSENT_ACTIONS.OPT_IN).toBe('opt_in')
    expect(CONSENT_ACTIONS.OPT_OUT).toBe('opt_out')
    expect([...CONSENT_ACTION_VALUES].sort()).toEqual(['opt_in', 'opt_out'])
  })

  it('is frozen — a caller cannot mutate the vocabulary at runtime', () => {
    expect(Object.isFrozen(CONSENT_ACTIONS)).toBe(true)
    expect(Object.isFrozen(CONSENT_ACTION_VALUES)).toBe(true)
  })

  it('maps a boolean intent onto the action', () => {
    expect(consentActionFor(true)).toBe('opt_in')
    expect(consentActionFor(false)).toBe('opt_out')
  })
})

describe('normaliseConsentAction — reading rows written before mig 516', () => {
  it('folds the legacy spellings onto the canonical ones', () => {
    expect(normaliseConsentAction('opted_out')).toBe('opt_out')
    expect(normaliseConsentAction('opted_in')).toBe('opt_in')
    expect(LEGACY_CONSENT_ACTIONS).toEqual({ opted_in: 'opt_in', opted_out: 'opt_out' })
  })

  it('passes canonical values through unchanged', () => {
    expect(normaliseConsentAction('opt_in')).toBe('opt_in')
    expect(normaliseConsentAction('opt_out')).toBe('opt_out')
  })

  it('returns an unknown value verbatim rather than guessing', () => {
    // A value we have never seen must show up in the export AS ITSELF. A
    // consent export that quietly renders an unrecognised action as
    // "Opt-in" is worse than one that shows the raw string.
    expect(normaliseConsentAction('withdrawn')).toBe('withdrawn')
    expect(normaliseConsentAction(null)).toBe(null)
    expect(normaliseConsentAction(undefined)).toBe(undefined)
  })

  it('is not case-folding or trimming — near-misses stay visible', () => {
    expect(normaliseConsentAction('OPT_OUT')).toBe('OPT_OUT')
  })
})

describe('isConsentOptOut — the predicate reports SHOULD use', () => {
  it('is true for both spellings of an opt-out', () => {
    expect(isConsentOptOut('opt_out')).toBe(true)
    expect(isConsentOptOut('opted_out')).toBe(true)
  })

  it('is false for opt-ins and for anything unrecognised', () => {
    expect(isConsentOptOut('opt_in')).toBe(false)
    expect(isConsentOptOut('opted_in')).toBe(false)
    expect(isConsentOptOut('withdrawn')).toBe(false)
    expect(isConsentOptOut(null)).toBe(false)
  })
})

// ─── the machine guard ────────────────────────────────────────────
//
// Walk src/, find every non-test file that touches consent_log, and assert
// that no `action:` in it is a bare string literal. The value must come from
// this module. This is what makes "define the vocabulary in ONE place"
// enforceable rather than aspirational.

const SRC = path.resolve(process.cwd(), 'src')
const SELF = path.join('lib', 'consent-actions')

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(js|jsx)$/.test(entry)) out.push(full)
  }
  return out
}

const ALL_FILES = walk(SRC)

const CONSENT_LOG_WRITERS = ALL_FILES.filter((f) => {
  if (/\.test\.(js|jsx)$/.test(f)) return false
  if (f.includes(SELF)) return false
  return /\.from\(\s*['"]consent_log['"]\s*\)[\s\S]{0,400}?\.(insert|upsert)\(/.test(readFileSync(f, 'utf8'))
})

describe('every consent_log writer in src/ uses the constants module', () => {
  it('finds the writers (the scan itself is not silently matching nothing)', () => {
    // If a refactor moves every writer behind a helper this number drops —
    // that is fine, but it must never drop to zero unnoticed, which would
    // turn the assertions below into a green no-op.
    expect(CONSENT_LOG_WRITERS.length).toBeGreaterThan(0)
  })

  it.each(CONSENT_LOG_WRITERS.map((f) => [path.relative(SRC, f), f]))(
    '%s writes no bare action string literal',
    (_rel, file) => {
      const src = readFileSync(file, 'utf8')
      const bareLiterals = [...src.matchAll(/\baction\s*:\s*[^,\n}]*['"]([a-z_]+)['"]/g)].map((m) => m[1])
      expect(bareLiterals).toEqual([])
    },
  )

  it.each(CONSENT_LOG_WRITERS.map((f) => [path.relative(SRC, f), f]))(
    '%s imports the vocabulary from @/lib/consent-actions',
    (_rel, file) => {
      const src = readFileSync(file, 'utf8')
      expect(src).toMatch(/from\s+['"](@\/lib\/consent-actions|\.\/consent-actions(\.js)?)['"]/)
    },
  )

  it.each(CONSENT_LOG_WRITERS.map((f) => [path.relative(SRC, f), f]))(
    '%s spells opted_in / opted_out only where it means contacts.wa_status',
    (_rel, file) => {
      // Catches the form the `action:` rule cannot see — a legacy literal
      // hoisted into a local (`const action = optingOut ? 'opted_out' : …`)
      // and then written in shorthand.
      //
      // Two exemptions, both real code in this repo:
      //   * `contacts.wa_status` genuinely takes the value 'opted_out'.
      //   * the CSV import route accepts 'opted_out' as an INBOUND column
      //     value (that is Mailchimp's vocabulary, arriving from outside) —
      //     those lines never name `action`, which is what we key on.
      const offending = readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => [i + 1, line.replace(/\/\/.*$/, '')])
        .filter(([, line]) =>
          /['"]opted_(in|out)['"]/.test(line) && /\baction\b/.test(line) && !/wa_status/.test(line))
        .map(([n, line]) => `${n}: ${line.trim()}`)
      expect(offending).toEqual([])
    },
  )
})

describe('the legacy spellings are gone from src/', () => {
  it('no non-test source file writes opted_in / opted_out as a consent action', () => {
    const offenders = []
    for (const file of ALL_FILES) {
      if (/\.test\.(js|jsx)$/.test(file)) continue
      if (file.includes(SELF)) continue
      const src = readFileSync(file, 'utf8')
      // `contacts.wa_status` legitimately takes the VALUE 'opted_out' — that
      // column is NOT in scope here and must not be touched. Only an
      // `action:` key carrying the legacy spelling is a defect.
      if (/\baction\s*:[^,\n}]*['"]opted_(in|out)['"]/.test(src)) offenders.push(path.relative(SRC, file))
    }
    expect(offenders).toEqual([])
  })
})
