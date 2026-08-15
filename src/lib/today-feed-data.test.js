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
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  fetchUpcomingEvents: vi.fn(),
}))

import { fetchTodayFeed, fetchLocationTodayFeed } from './today-feed-data'
import { hasPermission } from '@/lib/permissions'
import { countInboxIssues } from '@/lib/issues'
import { loadRadar } from '@/lib/churn-radar-data'
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

describe('fetchLocationTodayFeed (morning-briefing cron) — same predicate', () => {
  it('counts needs-reply and handoff threads, ignores raw unread_count on a resolved thread', async () => {
    const db = makeDb({
      whatsapp_conversations: tableStub([NEEDS_REPLY_BUT_READ, AGENT_HANDOFF, UNREAD_BUT_RESOLVED]),
    })
    const rows = await fetchLocationTodayFeed(db, LOC)
    expect(rows.find((r) => r.id === 'whatsapp')?.count).toBe(2)
  })
})
