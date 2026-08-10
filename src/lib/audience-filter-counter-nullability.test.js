// FILTER-C.1 — "is this counter empty?" must have exactly one answer.
//
// Every date field in AUDIENCE_FIELDS carries is_null / is_not_null. The
// counter fields (total_emails_opened, total_emails_sent, …) carry neither, so
// an operator can express "opened = 0" but not "opened is empty". That is only
// safe if the column CANNOT be NULL — otherwise "never opened" splits into two
// cohorts, one of them unreachable and invisible, which is precisely the
// NULL-dropping class this programme has spent its time removing.
//
// The live check (2026-08-10, project iyvtbjjxdggiadzwwvdj, 8,572 contacts)
// found ZERO NULLs across all ten counters, every one of them already
// DEFAULT 0 — so the honest fix is to make that guarantee real in the schema
// (mig 519 SET NOT NULL) rather than to offer operators a filter that matches
// nobody and cannot tell them why. `notNull: true` on the field records the
// guarantee the migration enforces, and this test keeps the two in step: a new
// counter field must either offer the null operators or claim the guarantee.
//
// The two nullable numbers are the counter-exception proof: trial_credits_
// remaining (6,530 NULLs live) and glofox_membership_price_cents (4,886) are
// genuinely absent for most rows, and both already offer the null ops.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { AUDIENCE_FIELDS } from './audience-filter.js'

const numberFields = Object.entries(AUDIENCE_FIELDS).filter(([, cfg]) => cfg.type === 'number')

// Exactly the columns mig 519 pins NOT NULL. Spelled out so adding a counter
// to the registry without adding it to the migration fails here.
const NOT_NULL_COUNTERS = [
  'lifetime_transaction_count',
  'lifetime_value_cents',
  'total_attended_30d',
  'total_bookings_30d',
  'total_emails_clicked',
  'total_emails_opened',
  'total_emails_sent',
  'total_noshow_30d',
  'total_wa_received',
  'total_wa_sent',
]

describe('number audience fields answer "is it empty?" one way or the other', () => {
  it('every number field either offers the null operators or is declared NOT NULL', () => {
    for (const [field, cfg] of numberFields) {
      const offersNullOps = cfg.ops.includes('is_null') && cfg.ops.includes('is_not_null')
      expect(
        offersNullOps || cfg.notNull === true,
        `${field}: nullable-with-default and no is_null/is_not_null — "never" is unaskable`,
      ).toBe(true)
    }
  })

  it('a NOT NULL field never offers a null operator (it would match nobody, silently)', () => {
    for (const [field, cfg] of numberFields) {
      if (cfg.notNull !== true) continue
      for (const op of ['is_null', 'is_not_null', 'not_null']) {
        expect(cfg.ops, `${field} claims NOT NULL but still offers ${op}`).not.toContain(op)
      }
    }
  })

  it('marks exactly the ten counters mig 519 pins', () => {
    const marked = numberFields.filter(([, cfg]) => cfg.notNull === true).map(([f]) => f).sort()
    expect(marked).toEqual(NOT_NULL_COUNTERS)
  })

  it('mig 519 pins exactly the columns the registry claims', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/519_contacts_counters_not_null.sql'),
      'utf8',
    )
    for (const col of NOT_NULL_COUNTERS) {
      expect(sql, `mig 519 does not backfill ${col}`).toContain(`SET ${col} = 0`)
      expect(sql, `mig 519 does not pin ${col}`).toContain(`ALTER COLUMN ${col} SET NOT NULL`)
    }
    // Nothing else — a column pinned here but unmarked in the registry is the
    // same drift in the other direction.
    const pinned = [...sql.matchAll(/ALTER COLUMN (\w+) SET NOT NULL/g)].map(m => m[1]).sort()
    expect(pinned).toEqual(NOT_NULL_COUNTERS)
  })

  it('leaves the genuinely-nullable numbers offering the null operators', () => {
    for (const field of ['trial_credits_remaining', 'glofox_membership_price_cents']) {
      expect(AUDIENCE_FIELDS[field].notNull).toBeUndefined()
      expect(AUDIENCE_FIELDS[field].ops).toContain('is_null')
      expect(AUDIENCE_FIELDS[field].ops).toContain('is_not_null')
    }
  })
})
