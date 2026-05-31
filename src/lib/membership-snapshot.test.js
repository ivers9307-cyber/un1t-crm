import { describe, it, expect, vi } from 'vitest'
import {
  firstOfMonth,
  computeMembershipCounts,
  writeMembershipSnapshot,
} from './membership-snapshot.js'

describe('firstOfMonth', () => {
  it('returns the first of the month in UTC YYYY-MM-01', () => {
    expect(firstOfMonth(new Date('2026-06-15T09:30:00Z'))).toBe('2026-06-01')
    expect(firstOfMonth(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-01')
    expect(firstOfMonth(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01')
  })

  it('accepts a string date', () => {
    expect(firstOfMonth('2026-06-15')).toBe('2026-06-01')
  })
})

// Fake Supabase count-query builder. Each .from('contacts') returns a
// chainable thenable that records its filters and resolves to a count
// looked up from `countFor(state)`.
function fakeCountDb(countFor, upsertSpy) {
  return {
    from(table) {
      if (table === 'membership_snapshots') {
        return { upsert: (row, opts) => { upsertSpy(row, opts); return Promise.resolve({ error: null }) } }
      }
      const state = { eqs: {}, ins: {}, isNull: [] }
      const builder = {
        select: () => builder,
        eq: (c, v) => { state.eqs[c] = v; return builder },
        in: (c, v) => { state.ins[c] = v; return builder },
        is: (c, v) => { if (v === null) state.isNull.push(c); return builder },
        then: (resolve) => resolve({ count: countFor(state), error: null }),
      }
      return builder
    },
  }
}

describe('computeMembershipCounts', () => {
  it('counts each membership_type bucket + sub-metrics with the right filters', async () => {
    const countFor = (s) => {
      const type = s.eqs.glofox_membership_type
      const state = s.eqs.glofox_membership_state
      const interval = s.eqs.glofox_billing_interval
      const creditsNull = s.isNull.includes('trial_credits_remaining')
      if (interval) return { '1 month': 105, '3 months': 56, '6 months': 15, '12 months': 13 }[interval] || 0
      if (type === 'time' && state === 'active') return 165
      if (type === 'num_classes' && creditsNull) return 392
      if (type === 'time') return 191
      if (type === 'num_classes') return 470
      if (type === 'payg') return 418
      return 1079
    }
    const out = await computeMembershipCounts(fakeCountDb(countFor, () => {}), 'loc-1')
    expect(out.total_members).toBe(1079)
    expect(out.monthly_recurring).toBe(191)
    expect(out.class_packs).toBe(470)
    expect(out.payg).toBe(418)
    expect(out.active_recurring).toBe(165)
    expect(out.dead_packs).toBe(392)
    expect(out.detail.recurring_by_interval).toEqual({
      '1 month': 105, '3 months': 56, '6 months': 15, '12 months': 13,
    })
  })

  it('always filters to the member cohort (status in member/credit_member)', async () => {
    let sawCohort = false
    const countFor = (s) => {
      if (Array.isArray(s.ins.glofox_membership_status)
        && s.ins.glofox_membership_status.includes('member')
        && s.ins.glofox_membership_status.includes('credit_member')) sawCohort = true
      return 0
    }
    await computeMembershipCounts(fakeCountDb(countFor, () => {}), 'loc-1')
    expect(sawCohort).toBe(true)
  })
})

describe('writeMembershipSnapshot', () => {
  it('upserts a row keyed on location_id + snapshot_date with the counts', async () => {
    const upsert = vi.fn()
    const db = fakeCountDb(() => 0, upsert)
    const out = await writeMembershipSnapshot(db, 'loc-1', { snapshotDate: '2026-06-01' })
    expect(upsert).toHaveBeenCalledOnce()
    const [row, opts] = upsert.mock.calls[0]
    expect(row.location_id).toBe('loc-1')
    expect(row.snapshot_date).toBe('2026-06-01')
    expect(row).toHaveProperty('monthly_recurring')
    expect(row).toHaveProperty('class_packs')
    expect(opts).toEqual({ onConflict: 'location_id,snapshot_date' })
    expect(out.snapshot_date).toBe('2026-06-01')
  })

  it('derives snapshot_date from now when not supplied', async () => {
    const upsert = vi.fn()
    const db = fakeCountDb(() => 0, upsert)
    await writeMembershipSnapshot(db, 'loc-1', { now: '2026-06-15T10:00:00Z' })
    expect(upsert.mock.calls[0][0].snapshot_date).toBe('2026-06-01')
  })

  it('throws when the upsert fails', async () => {
    const erroring = {
      from(table) {
        if (table === 'membership_snapshots') {
          return { upsert: () => Promise.resolve({ error: { message: 'boom' } }) }
        }
        const b = { select: () => b, eq: () => b, in: () => b, is: () => b, then: (r) => r({ count: 0, error: null }) }
        return b
      },
    }
    await expect(writeMembershipSnapshot(erroring, 'loc-1', { snapshotDate: '2026-06-01' }))
      .rejects.toThrow(/boom/)
  })
})
