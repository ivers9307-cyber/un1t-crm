import { describe, it, expect, vi } from 'vitest'
import {
  firstOfMonth,
  computeMembershipCounts,
  writeMembershipSnapshot,
  fetchMembershipTrend,
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

  it('derives the Dublin calendar day from now when not supplied', async () => {
    const upsert = vi.fn()
    const db = fakeCountDb(() => 0, upsert)
    await writeMembershipSnapshot(db, 'loc-1', { now: '2026-06-15T10:00:00Z' })
    expect(upsert.mock.calls[0][0].snapshot_date).toBe('2026-06-15')
  })

  it('buckets a late-UTC instant into the next Dublin day during BST', async () => {
    const upsert = vi.fn()
    const db = fakeCountDb(() => 0, upsert)
    await writeMembershipSnapshot(db, 'loc-1', { now: '2026-06-15T23:30:00Z' }) // 00:30 Dublin, 16th
    expect(upsert.mock.calls[0][0].snapshot_date).toBe('2026-06-16')
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


describe('fetchMembershipTrend', () => {
  function trendDb(rows, errorObj = null) {
    const calls = {}
    const b = {
      from: () => b,
      select: () => b,
      eq: (c, v) => { calls.eq = [c, v]; return b },
      gte: (c, v) => { calls.gte = [c, v]; return b },
      order: (c, o) => { calls.order = [c, o]; return b },
      limit: (n) => { calls.limit = n; return Promise.resolve({ data: rows, error: errorObj }) },
      _calls: calls,
    }
    return b
  }

  const rows = [
    { snapshot_date: '2026-06-01', monthly_recurring: 191, class_packs: 470, payg: 418, total_members: 1079, active_recurring: 165, dead_packs: 392 },
    { snapshot_date: '2026-07-01', monthly_recurring: 200, class_packs: 460, payg: 410, total_members: 1070, active_recurring: 170, dead_packs: 380 },
    { snapshot_date: '2026-07-29', monthly_recurring: 205, class_packs: 458, payg: 412, total_members: 1075, active_recurring: 173, dead_packs: 379 },
  ]

  it('defaults to monthly granularity: first-of-month rows only, month key', async () => {
    const out = await fetchMembershipTrend(trendDb(rows), 'loc-1')
    expect(out).toHaveLength(2) // the 07-29 daily row is filtered out
    expect(out[0].month).toBe('2026-06')
    expect(out[1].month).toBe('2026-07')
    expect(out[0].monthly_recurring).toBe(191)
    expect(out[1].class_packs).toBe(460)
  })

  it('daily granularity returns every snapshot with a date key', async () => {
    const out = await fetchMembershipTrend(trendDb(rows), 'loc-1', 12, { granularity: 'daily' })
    expect(out).toHaveLength(3)
    expect(out.map((r) => r.date)).toEqual(['2026-06-01', '2026-07-01', '2026-07-29'])
    expect(out[2].payg).toBe(412)
  })

  it('scopes to the location and windows by months, oldest first', async () => {
    const db = trendDb([])
    await fetchMembershipTrend(db, 'loc-9', 6)
    expect(db._calls.eq).toEqual(['location_id', 'loc-9'])
    expect(db._calls.gte[0]).toBe('snapshot_date')
    expect(db._calls.gte[1]).toMatch(/^\d{4}-\d{2}-01$/)
    expect(db._calls.order).toEqual(['snapshot_date', { ascending: true }])
    expect(db._calls.limit).toBe(800) // 12mo daily ≈ 370 rows — stays under the 1k select cap
  })

  it('returns an empty array when there are no snapshots yet', async () => {
    const db = trendDb(null)
    expect(await fetchMembershipTrend(db, 'loc-1')).toEqual([])
  })

  it('throws on a db error', async () => {
    const db = trendDb(null, { message: 'kaboom' })
    await expect(fetchMembershipTrend(db, 'loc-1')).rejects.toThrow(/kaboom/)
  })
})
