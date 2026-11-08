// HOSTSTATS.1 — one event's signup numbers: views, visitors, bookings,
// conversion, where they came from, and the waitlist's progress.
import { describe, it, expect } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'
import { loadEventStats } from './event-stats'

const VIEWS = [
  { session_id: 's1', source: 'instagram' }, { session_id: 's1', source: 'instagram' }, { session_id: 's2', source: 'host_email' },
]
const REGS = [
  { status: 'confirmed', attribution: { source: 'instagram' } },
  { status: 'pending_payment', attribution: null },
  { status: 'cancelled', attribution: { source: 'instagram' } },
]
const WAIT = [{ status: 'waiting' }, { status: 'waiting' }, { status: 'offered' }, { status: 'claimed' }, { status: 'expired' }]

const dbWith = ({ views = VIEWS, regs = REGS, wait = WAIT, fail = null } = {}) => fakeDb((q) => {
  if (fail === q.table) return { data: null, error: { message: 'boom' } }
  if (q.table === 'event_page_views') return { data: views, error: null }
  if (q.table === 'race_registrations') return { data: regs, error: null }
  if (q.table === 'event_waitlist') return { data: wait, error: null }
  return { data: null, error: null }
})

describe('loadEventStats', () => {
  it('aggregates views, visitors, bookings, conversion, sources and the waitlist', async () => {
    const db = dbWith()
    const r = await loadEventStats(db, 'e1')
    expect(r.ok).toBe(true)
    expect(r.stats).toEqual({
      views: 3, unique_visitors: 2, registrations: 2, confirmed: 1, conversion_pct: 50,
      // booked per source counts CONFIRMED entries only (the pending one under
      // 'unknown' adds nothing, and a bucket with no views and no bookings is dropped).
      by_source: [
        { source: 'instagram', label: 'Instagram', views: 2, booked: 1 },
        { source: 'host_email', label: 'Host email', views: 1, booked: 0 },
      ],
      waitlist: { waiting: 2, offered: 1, claimed: 1 },
      capped: false,
    })
    for (const t of ['event_page_views', 'race_registrations', 'event_waitlist']) {
      const q = db.queries.find((x) => x.table === t)
      expect(q.ops).toEqual(expect.arrayContaining([['eq', 'race_event_id', 'e1']]))
      expect(q.ops.some((o) => o[0] === 'order')).toBe(true)
      expect(q.ops.some((o) => o[0] === 'range')).toBe(true)
    }
  })
  it('no visitors → conversion null; visitors but no bookings → 0; 1 dp otherwise', async () => {
    expect((await loadEventStats(dbWith({ views: [], regs: REGS }), 'e1')).stats.conversion_pct).toBeNull()
    expect((await loadEventStats(dbWith({ views: VIEWS, regs: [] }), 'e1')).stats.conversion_pct).toBe(0)
    const three = [{ session_id: 'a', source: 'direct' }, { session_id: 'b', source: 'direct' }, { session_id: 'c', source: 'direct' }]
    expect((await loadEventStats(dbWith({ views: three, regs: [REGS[0]] }), 'e1')).stats.conversion_pct).toBe(33.3)
  })
  it('an empty event answers zeros, an empty source list and a zero waitlist', async () => {
    const r = await loadEventStats(dbWith({ views: [], regs: [], wait: [] }), 'e1')
    expect(r.stats).toMatchObject({ views: 0, unique_visitors: 0, registrations: 0, confirmed: 0, conversion_pct: null, by_source: [], waitlist: { waiting: 0, offered: 0, claimed: 0 } })
  })
  it('a confirmed booking with no attribution counts under Unknown', async () => {
    const r = await loadEventStats(dbWith({ views: [], regs: [{ status: 'confirmed', attribution: null }], wait: [] }), 'e1')
    expect(r.stats.by_source).toEqual([{ source: 'unknown', label: 'Unknown', views: 0, booked: 1 }])
  })
  it('folds everything past the top 8 sources into one Other line', async () => {
    const views = Array.from({ length: 12 }, (_, i) => Array.from({ length: 12 - i }, (__, j) => ({ session_id: `s${i}-${j}`, source: `src${i}` }))).flat()
    const r = await loadEventStats(dbWith({ views, regs: [{ status: 'confirmed', attribution: { source: 'src11' } }], wait: [] }), 'e1')
    expect(r.stats.by_source.length).toBe(9)
    expect(r.stats.by_source[0]).toMatchObject({ source: 'src0', views: 12 })
    expect(r.stats.by_source[8]).toEqual({ source: 'other', label: 'Other', views: 4 + 3 + 2 + 1, booked: 1 })
  })
  it('a read error on any table is { ok: false }', async () => {
    for (const t of ['event_page_views', 'race_registrations', 'event_waitlist']) {
      const r = await loadEventStats(dbWith({ fail: t }), 'e1')
      expect(r.ok).toBe(false)
      expect(r.error).toBeTruthy()
    }
  })
  it('pages past the 1,000-row cap and flags a capped read', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ session_id: `s${i}`, source: 'direct' }))
    let calls = 0
    const db = fakeDb((q) => {
      if (q.table === 'event_page_views') { calls += 1; return { data: calls <= 10 ? page : [], error: null } }
      return { data: [], error: null }
    })
    const r = await loadEventStats(db, 'e1')
    expect(calls).toBe(10)
    expect(r.stats.views).toBe(10_000)
    expect(r.stats.capped).toBe(true)
    const ranges = db.queries.filter((q) => q.table === 'event_page_views').map((q) => q.ops.find((o) => o[0] === 'range').slice(1))
    expect(ranges[0]).toEqual([0, 999])
    expect(ranges[1]).toEqual([1000, 1999])
  })
})
