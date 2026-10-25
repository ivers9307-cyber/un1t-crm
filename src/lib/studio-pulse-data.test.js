// UN1TRADAR.2 — the briefing pulse reads counts through the membership seam,
// and its "vs" comparator stays hidden until a location has 30 days of rows.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/membership/reads/index', () => ({ radarReadsFor: vi.fn() }))
vi.mock('@/lib/churn-radar-data', () => ({ loadRadar: vi.fn() }))

import { radarReadsFor } from '@/lib/membership/reads/index'
import { loadRadar } from '@/lib/churn-radar-data'
import { pickComparator, fetchStudioPulse } from './studio-pulse-data'

const L = 'loc-1'
const DAY = 86_400_000

// A table fake answering eq / lt / order / limit / maybeSingle over its rows.
function tableDb(tables) {
  function builder(table) {
    const s = { filters: [], order: null, asc: true, limit: null }
    const run = () => {
      let rows = (tables[table] || []).filter((r) => s.filters.every(([k, c, v]) => (k === 'eq' ? r[c] === v : String(r[c]) < String(v))))
      if (s.order) rows = [...rows].sort((a, b) => (s.asc ? 1 : -1) * String(a[s.order]).localeCompare(String(b[s.order])))
      if (s.limit != null) rows = rows.slice(0, s.limit)
      return rows
    }
    const api = {
      select: () => api,
      eq(c, v) { s.filters.push(['eq', c, v]); return api },
      lt(c, v) { s.filters.push(['lt', c, v]); return api },
      order(c, o) { s.order = c; s.asc = o?.ascending !== false; return api },
      limit(n) { s.limit = n; return api },
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    }
    return api
  }
  return { from: (t) => builder(t) }
}
const snap = (date) => ({ location_id: L, snapshot_date: date, monthly_recurring: 1, class_packs: 0, payg: 0, total_members: 1 })
const COLS = 'snapshot_date, monthly_recurring, class_packs, payg, total_members'
const pick = (rows, nowIso, monthStart) => pickComparator(tableDb({ membership_snapshots: rows }), 'membership_snapshots', 'snapshot_date', COLS, L, monthStart, Date.parse(nowIso))

describe('pickComparator', () => {
  it('comparator null while the oldest row is under 30 days old', async () => {
    const rows = [snap('2026-10-18'), snap('2026-11-15')]
    expect(await pick(rows, '2026-11-16T07:00:00Z', '2026-11-01')).toBeNull()
  })
  it('comparator returns the last row before the month at 30 days', async () => {
    const rows = [snap('2026-10-18'), snap('2026-10-31'), snap('2026-11-15')]
    expect((await pick(rows, '2026-11-17T07:00:00Z', '2026-11-01')).snapshot_date).toBe('2026-10-31')
  })
  it('unchanged with June history (Stillorgan)', async () => {
    const rows = [snap('2026-06-02'), snap('2026-09-30'), snap('2026-10-01'), snap('2026-10-17')]
    expect((await pick(rows, '2026-10-18T07:00:00Z', '2026-10-01')).snapshot_date).toBe('2026-09-30')
    // nothing before the month: today's rule falls back to the oldest
    expect((await pick([snap('2026-06-02'), snap('2026-10-02')], '2026-10-18T07:00:00Z', '2026-06-01')).snapshot_date).toBe('2026-06-02')
  })
  it('no rows at all → null', async () => {
    expect(await pick([], '2026-10-18T07:00:00Z', '2026-10-01')).toBeNull()
  })
})

describe('fetchStudioPulse', () => {
  beforeEach(() => vi.clearAllMocks())
  const NOW = Date.parse('2026-10-19T06:00:00Z')

  it("counts come from the resolved adapter's membershipCounts", async () => {
    const membershipCounts = vi.fn(async () => ({ monthly_recurring: 26, total_members: 30 }))
    radarReadsFor.mockResolvedValue({ source: 'un1t_online', reads: { membershipCounts }, providesMemberships: true })
    loadRadar.mockResolvedValue({ summary: { paused: 0, overdue: 2, overdueValueCents: 16500, overdueValueEstimated: true, unpaidCharges: null } })
    const db = tableDb({})
    const out = await fetchStudioPulse(db, L, NOW)
    expect(membershipCounts).toHaveBeenCalledWith(db, L)
    expect(out.counts).toEqual({ monthly_recurring: 26, total_members: 30 })
    expect(out.radar).toEqual({ paused: 0, overdue: 2, overdueValueCents: 16500, overdueValueEstimated: true, arrearsUnavailable: true })
    expect(out.prevMembership).toBeNull()
  })

  it('a Glofox radar slice has both flags false', async () => {
    radarReadsFor.mockResolvedValue({ source: 'glofox', reads: { membershipCounts: async () => ({ total_members: 1 }) }, providesMemberships: true })
    loadRadar.mockResolvedValue({ summary: { paused: 1, overdue: 1, overdueValueCents: 100, unpaidCharges: 2 } })
    const out = await fetchStudioPulse(tableDb({}), L, NOW)
    expect(out.radar).toEqual({ paused: 1, overdue: 1, overdueValueCents: 100, overdueValueEstimated: false, arrearsUnavailable: false })
  })

  it('returns null when the seam throws', async () => {
    radarReadsFor.mockRejectedValue(new Error('unreadable'))
    loadRadar.mockResolvedValue({ summary: {} })
    expect(await fetchStudioPulse(tableDb({}), L, NOW)).toBeNull()
  })

  it('returns null when the source has no membershipCounts', async () => {
    radarReadsFor.mockResolvedValue({ source: 'none', reads: {}, providesMemberships: false })
    loadRadar.mockResolvedValue({ summary: {} })
    expect(await fetchStudioPulse(tableDb({}), L, NOW)).toBeNull()
  })
})
