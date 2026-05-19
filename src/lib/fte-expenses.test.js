// FTE-EXPENSES.1 — helper coverage.
//
// The helpers are pure functions, so tests pin shape + edge cases
// rather than wiring against a DB. Two areas worth pinning carefully:
//   - periodForMonth: leap-Feb, December (year carry), bad input
//   - computeClaimTotals: float-precision rounding, VAT clamping
//   - canTransition: terminal states are absorbing

import { describe, it, expect } from 'vitest'
import {
  EXPENSE_CATEGORIES,
  EXPENSE_STATUSES,
  canTransition,
  periodForMonth,
  periodLabel,
  computeClaimTotals,
  buildReceiptPath,
} from './fte-expenses.js'

describe('EXPENSE_CATEGORIES', () => {
  it('matches the DB enum exactly', () => {
    // If this fails, the migration's CHECK constraint will reject
    // writes — keep them in lockstep.
    expect(EXPENSE_CATEGORIES).toEqual([
      'travel', 'meals', 'supplies', 'mileage', 'training', 'other',
    ])
  })
})

describe('canTransition', () => {
  it('allows draft → submitted', () => {
    expect(canTransition('draft', 'submitted')).toBe(true)
  })

  it('allows submitted → approved/declined/revoked', () => {
    expect(canTransition('submitted', 'approved')).toBe(true)
    expect(canTransition('submitted', 'declined')).toBe(true)
    expect(canTransition('submitted', 'revoked')).toBe(true)
  })

  it('rejects identity transitions', () => {
    for (const s of EXPENSE_STATUSES) {
      expect(canTransition(s, s)).toBe(false)
    }
  })

  it('treats approved/declined/revoked as terminal', () => {
    for (const terminal of ['approved', 'declined', 'revoked']) {
      for (const target of EXPENSE_STATUSES) {
        expect(canTransition(terminal, target)).toBe(false)
      }
    }
  })

  it('rejects draft → terminal directly (must submit first)', () => {
    expect(canTransition('draft', 'approved')).toBe(false)
    expect(canTransition('draft', 'declined')).toBe(false)
    expect(canTransition('draft', 'revoked')).toBe(false)
  })

  it('rejects unknown statuses', () => {
    expect(canTransition('paid', 'approved')).toBe(false)
    expect(canTransition('submitted', 'paid')).toBe(false)
  })
})

describe('periodForMonth', () => {
  it('returns the canonical shape for a standard month', () => {
    const p = periodForMonth('2026-05')
    expect(p).toEqual({
      period_start: '2026-05-01',
      period_end: '2026-05-31',
      label: 'May 2026',
    })
  })

  it('handles February in a leap year', () => {
    const p = periodForMonth('2024-02')
    expect(p.period_end).toBe('2024-02-29')
  })

  it('handles February in a non-leap year', () => {
    const p = periodForMonth('2025-02')
    expect(p.period_end).toBe('2025-02-28')
  })

  it('handles December (no year carry bug)', () => {
    const p = periodForMonth('2026-12')
    expect(p.period_start).toBe('2026-12-01')
    expect(p.period_end).toBe('2026-12-31')
  })

  it('rejects malformed input', () => {
    expect(periodForMonth('')).toBeNull()
    expect(periodForMonth('2026-5')).toBeNull()   // single-digit month
    expect(periodForMonth('2026-13')).toBeNull()  // out of range
    expect(periodForMonth('2026-00')).toBeNull()
    expect(periodForMonth('not-a-month')).toBeNull()
    expect(periodForMonth(202605)).toBeNull()
    expect(periodForMonth(null)).toBeNull()
    expect(periodForMonth(undefined)).toBeNull()
  })
})

describe('periodLabel', () => {
  it('formats as Month Year', () => {
    expect(periodLabel('2026-05-01')).toBe('May 2026')
    expect(periodLabel('2026-12-01')).toBe('December 2026')
  })

  it('returns the input verbatim for unparseable dates', () => {
    expect(periodLabel('not-a-date')).toBe('not-a-date')
  })
})

describe('computeClaimTotals', () => {
  it('sums amount and vat across items', () => {
    const items = [
      { amount: 10.00, vat_amount: 1.50 },
      { amount: 20.50, vat_amount: 3.00 },
      { amount: 5.00,  vat_amount: 0 },
    ]
    expect(computeClaimTotals(items)).toEqual({
      total_amount: 35.50,
      total_vat_amount: 4.50,
      item_count: 3,
      total_net_amount: 31.00,
    })
  })

  it('rounds to 2 dp (no float drift)', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in IEEE 754
    const items = [
      { amount: 0.1, vat_amount: 0 },
      { amount: 0.2, vat_amount: 0 },
    ]
    expect(computeClaimTotals(items).total_amount).toBe(0.3)
  })

  it('clamps VAT to amount (defensive)', () => {
    // If the UI somehow sends vat > amount, the DB CHECK would
    // reject it. Helper clamps defensively so the preview totals
    // don't show a misleading net of zero / negative.
    const items = [{ amount: 100, vat_amount: 150 }]
    const t = computeClaimTotals(items)
    expect(t.total_amount).toBe(100)
    expect(t.total_vat_amount).toBe(100)
    expect(t.total_net_amount).toBe(0)
  })

  it('skips negative or non-numeric entries', () => {
    const items = [
      { amount: 10, vat_amount: 1 },
      { amount: -5, vat_amount: 0 },
      { amount: 'bad', vat_amount: 0 },
      { amount: 20, vat_amount: 2 },
    ]
    expect(computeClaimTotals(items).total_amount).toBe(30)
  })

  it('returns zeros for empty or non-array input', () => {
    expect(computeClaimTotals([])).toEqual({
      total_amount: 0, total_vat_amount: 0, item_count: 0, total_net_amount: 0,
    })
    expect(computeClaimTotals(null).total_amount).toBe(0)
    expect(computeClaimTotals(undefined).total_amount).toBe(0)
  })
})

describe('buildReceiptPath', () => {
  it('produces a 3-segment path with a random suffix', () => {
    const p = buildReceiptPath({
      profileId: 'user-1',
      claimId: 'claim-1',
      itemId: 'item-1',
      filename: 'Train ticket.pdf',
    })
    expect(p).toMatch(/^user-1\/claim-1\/item-1-[a-z0-9]{6}-Train_ticket\.pdf$/)
  })

  it('sanitises filename separators so storage paths stay safe', () => {
    const p = buildReceiptPath({
      profileId: 'u', claimId: 'c', itemId: 'i',
      filename: '../../etc/passwd',
    })
    // Slashes are replaced with underscores so the filename can't
    // escape the {profile}/{claim}/{item}- prefix. Dots are
    // preserved (legitimate filenames have extensions) — Supabase
    // Storage treats keys as opaque strings, not paths, so '..' is
    // not interpreted as traversal at the Storage layer.
    expect(p).toMatch(/^u\/c\/i-[a-z0-9]{6}-\.\._\.\._etc_passwd$/)
  })

  it('falls back to "receipt" when filename is empty', () => {
    const p = buildReceiptPath({ profileId: 'u', claimId: 'c', itemId: 'i', filename: '' })
    expect(p).toMatch(/^u\/c\/i-[a-z0-9]{6}-receipt$/)
  })
})
