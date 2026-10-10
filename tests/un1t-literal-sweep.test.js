// W1.S* — the UN1T literal sweep guard (SaaS Wave 1, Track S).
//
// A second gym's customers and staff must never read "UN1T". Every sweep PR
// appends the files it cleaned to SWEPT below; from then on a reintroduced
// literal in any of them fails here, so the sweep cannot rot one PR at a time.
//
// What counts: a `UN1T` outside comments. Rows the plan's appendix marks
// `keep` (UN1T-specific by design — legal pages, /offers, master-only toggles)
// are allow-listed per file in KEEP, as the exact literal, so a NEW literal
// in a kept file still fails.
//
// Created by W1.S4 (shared/ seam + its src/lib twins). W1.S1a–S3 and S5
// append their own rows; the list is the sweep's ledger.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './helpers/js-code.js'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

// Files swept so far. Keep the list sorted by task so a reviewer can see
// which PR owns a row.
const SWEPT = [
  // ── W1.S4: shared/ seam + src/lib twins ──────────────────────────────────
  'shared/challenge-wrapped.js',
  'shared/customer-notifications.js',
  'shared/goals.js',
  'shared/hr-analytics.js',
  'shared/permissions.js',
  'shared/session-history.js',
  'src/lib/customer-notifications.js',
  'src/lib/goals.js',
  'src/lib/hr-analytics.js',
]

// file → exact literals the appendix marks `keep`. None in W1.S4.
const KEEP = {}

describe('UN1T literal sweep (W1.S*)', () => {
  it.each(SWEPT)('%s carries no customer/staff-visible UN1T literal', (file) => {
    const src = stripComments(readFileSync(join(repo, file), 'utf8'), file)
    const allowed = KEEP[file] || []
    const stripped = allowed.reduce((s, lit) => s.split(lit).join(''), src)
    const hits = stripped
      .split('\n')
      .map((line, i) => (/UN1T/.test(line) ? `${file}:${i + 1}: ${line.trim()}` : null))
      .filter(Boolean)
    expect(hits, `reintroduced UN1T literal(s):\n${hits.join('\n')}`).toEqual([])
  })

  it('every KEEP entry names a swept file and a literal that still exists', () => {
    for (const [file, lits] of Object.entries(KEEP)) {
      expect(SWEPT, `${file} is in KEEP but not SWEPT`).toContain(file)
      const src = readFileSync(join(repo, file), 'utf8')
      for (const lit of lits) expect(src, `${file} no longer contains kept literal ${lit}`).toContain(lit)
    }
  })
})
