// HOME.3 — unify the WA row on the shared needsAction predicate
// (src/lib/inbox-queues.js), the same one the Communications badge
// (/api/whatsapp/unread-count) and the new home queue use. This used to sum
// raw unread_count, which reads 0 the instant someone opens a thread without
// replying or resolving it — the exact bug SIDEBAR-BADGES.2 fixed for the
// nav badge — so the Today feed and the badge next to it could disagree
// about the same conversation. These tests pin both callers
// (fetchTodayFeed for the viewer-scoped page, fetchLocationTodayFeed for the
// morning-briefing cron) onto the one predicate.
//
// Everything except WhatsApp is neutralised (permission off for
// fetchTodayFeed; a mocked zero/empty result for every other source for
// fetchLocationTodayFeed, which has no permission gate) so a failing
// assertion here can only be about the WhatsApp row.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn() }))
vi.mock('@/lib/approvals/registry', () => ({ getPendingApprovalsCount: vi.fn() }))
vi.mock('@/lib/issues', () => ({ countInboxIssues: vi.fn() }))
vi.mock('@/lib/churn-radar-data', () => ({ loadRadar: vi.fn() }))
vi.mock('@/lib/radar-availability', () => ({ radarAvailability: vi.fn(async () => ({ available: true, source: 'glofox', dataAsOf: null })) }))
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  fetchUpcomingEvents: vi.fn(),
}))

import { fetchTodayFeed, fetchLocationTodayFeed } from './today-feed-data'
import { hasPermission } from '@/lib/permissions'
import { getPendingApprovalsCount } from '@/lib/approvals/registry'
import { countInboxIssues } from '@/lib/issues'
import { loadRadar } from '@/lib/churn-radar-data'
import { radarAvailability } from '@/lib/radar-availability'
import { glofoxCredentialsForLocation } from '@/lib/glofox'

const LOC = 'loc-1'

// A filter-respecting table double — eq/is are actually applied, so a test
// can hand back BOTH a matching and a non-matching row in one query and prove
// the implementation's own filter (or the needsAction predicate applied to
// what comes back) is what does the excluding, not the fixture.
function tableStub(rows = []) {
  const filters = []
  const b = {
    select: () => b,
    eq: (col, val) => { filters.push((r) => r[col] === val); return b },
    is: (col, val) => { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return b },
    gt: (col, val) => { filters.push((r) => (r[col] || 0) > val); return b },
    gte: () => b,
    lte: () => b,
    neq: () => b,
    in: () => b,
    or: () => b,
    order: () => b,
    limit: () => b,
    range: () => b,
    maybeSingle: async () => {
      const out = rows.filter((r) => filters.every((f) => f(r)))
      return { data: out[0] ?? null, error: null }
    },
    then: (resolve, reject) => {
      const out = rows.filter((r) => filters.every((f) => f(r)))
      return Promise.resolve({ data: out, error: null }).then(resolve, reject)
    },
  }
  return b
}

function makeDb(overrides = {}) {
  return {
    from: (table) => overrides[table] || tableStub([]),
  }
}

// resolved:null + inbound last message → needs a reply. Raw unread_count is
// 0 (already opened) — the case the old sum-of-unread implementation missed
// entirely and the whole reason SIDEBAR-BADGES.2 fixed the nav badge.
const NEEDS_REPLY_BUT_READ = {
  id: 'w1', location_id: LOC, resolved_at: null, last_message_at: '2026-08-14T09:00:00Z',
  last_message_direction: 'inbound', agent_handed_off_at: null, unread_count: 0,
}
// unread_count is high but the thread is already resolved — must NOT count,
// even though the old implementation's query never checked resolved_at.
const UNREAD_BUT_RESOLVED = {
  id: 'w2', location_id: LOC, resolved_at: '2026-08-13T00:00:00Z', last_message_at: '2026-08-13T09:00:00Z',
  last_message_direction: 'inbound', agent_handed_off_at: null, unread_count: 5,
}
// handed off to a human, unresolved, last message was the agent's own — the
// other case a raw-unread sum could never see.
const AGENT_HANDOFF = {
  id: 'w3', location_id: LOC, resolved_at: null, last_message_at: '2026-08-14T08:00:00Z',
  last_message_direction: 'outbound', agent_handed_off_at: '2026-08-14T08:00:00Z', unread_count: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  countInboxIssues.mockResolvedValue(0)
  loadRadar.mockResolvedValue({ radar: [], summary: { highRisk: 0 } })
  glofoxCredentialsForLocation.mockResolvedValue(null)
})

describe('fetchTodayFeed — WhatsApp row uses needsAction, not raw unread_count', () => {
  beforeEach(() => {
    // Only the whatsapp permission is granted, so every other source is
    // gated off (safe(false, …) → null) without touching the db at all.
    hasPermission.mockImplementation((_user, key) => key === 'whatsapp')
  })

  it('counts a needs-reply thread even though its unread_count is 0', async () => {
    const db = makeDb({ whatsapp_conversations: tableStub([NEEDS_REPLY_BUT_READ]) })
    const rows = await fetchTodayFeed(db, { id: 'u1' }, LOC)
    expect(rows.find((r) => r.id === 'whatsapp')?.count).toBe(1)
  })

  it('does not count a resolved thread just because unread_count is high', async () => {
    const db = makeDb({
      whatsapp_conversations: tableStub([NEEDS_REPLY_BUT_READ, UNREAD_BUT_RESOLVED]),
    })
    const rows = await fetchTodayFeed(db, { id: 'u1' }, LOC)
    // Old behaviour summed unread_count and would have read 5 (from the
    // resolved thread alone) or 5 total; the fix counts only the one
    // genuinely-unresolved needs-reply thread.
    expect(rows.find((r) => r.id === 'whatsapp')?.count).toBe(1)
  })

  it("counts an agent handoff whose last message was the agent's own holding line", async () => {
    const db = makeDb({ whatsapp_conversations: tableStub([AGENT_HANDOFF]) })
    const rows = await fetchTodayFeed(db, { id: 'u1' }, LOC)
    expect(rows.find((r) => r.id === 'whatsapp')?.count).toBe(1)
  })
})

// HOME.3 review rider R1 — kill the double-computation. Before this, the
// web /dashboard/today page called fetchTodayFeed and got EVERY source
// computed (including approvals/issues/invoices/whatsapp), even though it
// only rendered the four that are not home-queue sources — the queue
// (assembleHomeQueue) computes approvals/issues/invoices/whatsapp itself,
// so getPendingApprovalsCount literally fired twice per page load. `skip`
// lets a caller opt specific sources out of computation entirely.
describe('fetchTodayFeed — `skip` opts sources out of computation entirely', () => {
  beforeEach(() => {
    // Every permission granted — proves a skipped source is never even
    // attempted, not merely permission-gated off.
    hasPermission.mockImplementation(() => true)
    getPendingApprovalsCount.mockResolvedValue(5)
  })

  it('does not call the approvals/issues/churn/glofox fetchers when they are in `skip`', async () => {
    const db = makeDb()
    await fetchTodayFeed(db, { id: 'u1' }, LOC, { skip: ['approvals', 'issues', 'churn', 'lowfill'] })
    expect(getPendingApprovalsCount).not.toHaveBeenCalled()
    expect(countInboxIssues).not.toHaveBeenCalled()
    expect(loadRadar).not.toHaveBeenCalled()
    expect(glofoxCredentialsForLocation).not.toHaveBeenCalled()
  })

  it('still computes and returns a row for a source NOT in `skip`', async () => {
    const db = makeDb()
    const rows = await fetchTodayFeed(db, { id: 'u1' }, LOC, { skip: ['issues', 'churn', 'lowfill'] })
    expect(getPendingApprovalsCount).toHaveBeenCalledTimes(1)
    expect(rows.find((r) => r.id === 'approvals')?.count).toBe(5)
  })

  it('with no `skip` (the mobile /api/mobile/today-feed call shape), every source still computes', async () => {
    const db = makeDb()
    await fetchTodayFeed(db, { id: 'u1' }, LOC)
    expect(getPendingApprovalsCount).toHaveBeenCalledTimes(1)
    expect(countInboxIssues).toHaveBeenCalledTimes(1)
    expect(loadRadar).toHaveBeenCalledTimes(1)
  })
})

describe('fetchLocationTodayFeed (morning-briefing cron) — same predicate', () => {
  it('counts needs-reply and handoff threads, ignores raw unread_count on a resolved thread', async () => {
    const db = makeDb({
      whatsapp_conversations: tableStub([NEEDS_REPLY_BUT_READ, AGENT_HANDOFF, UNREAD_BUT_RESOLVED]),
    })
    const rows = await fetchLocationTodayFeed(db, LOC)
    expect(rows.find((r) => r.id === 'whatsapp')?.count).toBe(2)
  })
})

// TZ.17 ⚠️ — "today" (bookings today, tasks due) is the studio's day. It was
// the host clock's (UTC on Vercel): from 00:00 to 01:00 Irish summer time the
// feed showed yesterday's bookings.
describe('TZ.17 the feed day is the studio day', () => {
  function bookingsDb() {
    const seen = []
    const bookings = { select: () => bookings, eq: (c, v) => { if (c === 'booking_date') seen.push(v); return bookings }, neq: () => bookings, order: () => Promise.resolve({ data: [], error: null }) }
    return { seen, db: makeDb({ bookings }) }
  }
  beforeEach(() => { hasPermission.mockImplementation((_u, key) => key === 'bookings') })

  it('Dublin at 00:30 IST on 2 Jul asks for 2 Jul (the UTC host said 1 Jul)', async () => {
    const { db, seen } = bookingsDb()
    await fetchTodayFeed(db, { id: 'u1' }, LOC, { nowMs: Date.parse('2026-07-01T23:30:00Z'), zone: 'Europe/Dublin' })
    expect(seen).toEqual(['2026-07-02'])
  })
  it('a New York studio at 23:30 EDT on 1 Jul asks for 1 Jul', async () => {
    const { db, seen } = bookingsDb()
    await fetchTodayFeed(db, { id: 'u1' }, LOC, { nowMs: Date.parse('2026-07-02T03:30:00Z'), zone: 'America/New_York' })
    expect(seen).toEqual(['2026-07-01'])
  })
  it('the briefing feed takes the slot zone, and an unreadable zone omits the day rows (never a guessed day)', async () => {
    const { db, seen } = bookingsDb()
    await fetchLocationTodayFeed(db, LOC, Date.parse('2026-07-01T23:30:00Z'), { zone: 'Europe/Dublin' })
    expect(seen).toEqual(['2026-07-02'])
    const b = bookingsDb()
    const broken = { from: (t) => (t === 'locations' ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }) }) } : b.db.from(t)) }
    await fetchLocationTodayFeed(broken, 'loc-unreadable', Date.parse('2026-07-01T23:30:00Z'))
    expect(b.seen).toEqual([]) // no bookings read on a guessed day
  })
})

// UN1TRADAR.1 — a source without the memberships capability gets no churn row.
describe('fetchChurn and the memberships capability', () => {
  it('today-feed churn is null at a source without memberships (no radar read)', async () => {
    radarAvailability.mockResolvedValueOnce({ available: false, source: 'un1t_online', dataAsOf: null })
    loadRadar.mockClear()
    const db = makeDb({})
    const rows = await fetchLocationTodayFeed(db, LOC)
    expect(loadRadar).not.toHaveBeenCalled()
    expect(rows.find((r) => r.id === 'churn')).toBeUndefined()
  })
})
