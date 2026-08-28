// HOME.3 — the needs-attention queue assembler. Merges three sources
// (approvals, tickets, unified inbox) into one sorted, capped list plus
// TRUE (uncapped) per-source counts.
//
// Dependencies are mocked at the module boundary rather than re-modelled
// here: the approvals registry (src/lib/approvals/registry.js), the ticket
// visibility helpers (src/app/api/email/tickets/_helpers.js) and the
// permission gates each have their own test coverage already. These tests
// are about assembleHomeQueue's OWN job — gating, row shaping, merge/sort,
// per-source and global caps, TRUE counts, and the degraded-source path —
// not re-proving mailbox visibility or approvals scoping.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/approvals/registry', () => ({
  getPendingApprovals: vi.fn(),
  getPendingApprovalsCount: vi.fn(),
}))
vi.mock('@/lib/permissions', () => ({
  hasPermission: vi.fn(),
  hasPermissionForLocation: vi.fn(),
}))
vi.mock('@/app/api/email/tickets/_helpers', () => ({
  loadVisibleMailboxes: vi.fn(),
  scopeToVisibleMailboxes: vi.fn((q) => q),
  scopeToNeedsReply: vi.fn((q) => q),
  scopeToUnmerged: vi.fn((q) => q),
  // The surface vocabulary is mocked with its REAL values, not placeholders.
  // A factory mock replaces the whole module, so an export missing here is not
  // `undefined` — vitest THROWS on the import, the ticket source lands in
  // Promise.allSettled's rejected half, and the lane silently reads as an empty
  // queue instead of a failing test. That is how this file first reacted to
  // MAILBOX-SURFACE.1, and it is worth knowing: five assertions went red for a
  // reason that had nothing to do with what any of them were testing.
  SURFACE_TICKETS: 'tickets',
  SURFACE_INBOX: 'inbox',
  // The real implementation, not a stub: which surface a mailbox belongs to is
  // the thing these tests are about, and a mock that always answered the same
  // way would make every routing assertion below vacuous.
  mailboxesForSurface: (mailboxes, surface) =>
    (Array.isArray(mailboxes) ? mailboxes : []).filter(m => (m?.surface || 'tickets') === surface),
}))

import {
  assembleHomeQueue, getHomeQueueCount, SOURCE_PRE_CAP, GLOBAL_CAP,
  queueCountLabel, queueRowGroup, groupQueueRows,
} from './home-queue'
import { getPendingApprovals, getPendingApprovalsCount } from '@/lib/approvals/registry'
import { hasPermission, hasPermissionForLocation } from '@/lib/permissions'
import { loadVisibleMailboxes } from '@/app/api/email/tickets/_helpers'

const LOC = 'loc-1'
const userAt = (over = {}) => ({ id: 'u1', role: 'staff', activeLocation: { id: LOC }, ...over })

function approvalsResult(providers) {
  return { providers, total: providers.reduce((s, p) => s + p.count, 0) }
}

// A minimal chainable query double. `wantsCount` flips when .select() is
// called with { count }, matching supabase-js's head-count shape; otherwise
// the terminal `then` resolves with the row list. Good enough for
// home-queue's own fixed, known query shapes — the filters themselves
// (mailbox scoping, needs_reply, unmerged) are proven elsewhere and are
// identity-mocked here.
function makeDb(tables = {}) {
  return {
    from(table) {
      const t = tables[table] || { rows: [], count: 0 }
      let wantsCount = false
      // MAILBOX-SURFACE.1 — the tickets lane now issues TWO count queries, one
      // per surface, and a double that answered both with the same number would
      // make the split untestable AND silently double `total`. They are told
      // apart by the only thing that differs: the mail count scopes itself with
      // `.in('mailbox_id', …)`, while the ticket count's scoping is the mocked
      // identity helper. `mailCount` is the fixture's answer for that one.
      let scopedToMailboxIds = false
      const b = {
        select(_cols, opts) { if (opts?.count) wantsCount = true; return b },
        eq() { return b },
        is() { return b },
        in(column) { if (column === 'mailbox_id') scopedToMailboxIds = true; return b },
        order() { return b },
        limit() { return b },
        then(resolve, reject) {
          const count = scopedToMailboxIds ? (t.mailCount ?? 0) : (t.count ?? 0)
          const out = wantsCount
            ? { data: null, count, error: t.error || null }
            : { data: t.rows ?? [], error: t.error || null }
          return Promise.resolve(out).then(resolve, reject)
        },
      }
      return b
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  getPendingApprovals.mockResolvedValue(approvalsResult([]))
  getPendingApprovalsCount.mockResolvedValue(0)
  hasPermission.mockReturnValue(false)
  hasPermissionForLocation.mockReturnValue(false)
  loadVisibleMailboxes.mockResolvedValue({ elevated: false, mailboxes: [] })
})

describe('assembleHomeQueue — no active location', () => {
  it('returns an all-empty result without touching any source', async () => {
    const result = await assembleHomeQueue(makeDb(), { id: 'u1', activeLocation: null })
    expect(result).toEqual({ rows: [], counts: { approvals: 0, tickets: 0, mail: 0, inbox: 0 }, total: 0 })
    expect(getPendingApprovals).not.toHaveBeenCalled()
  })
})

describe('assembleHomeQueue — approvals source', () => {
  it('maps provider items into QueueRow shape', async () => {
    getPendingApprovals.mockResolvedValue(approvalsResult([
      {
        key: 'issues', label: 'Issues', reviewBase: '/issues', count: 1,
        items: [{
          id: 'i1', title: 'Ada', subtitle: 'desc',
          submittedAt: '2026-08-10T10:00:00Z', reviewUrl: '/issues?focus=i1',
        }],
      },
    ]))
    getPendingApprovalsCount.mockResolvedValue(1)

    const result = await assembleHomeQueue(makeDb(), userAt())

    expect(result.rows).toContainEqual({
      source: 'issues', sourceLabel: 'Issues', id: 'i1', title: 'Ada', subtitle: 'desc',
      occurredAt: '2026-08-10T10:00:00Z', href: '/issues?focus=i1',
    })
    expect(result.counts.approvals).toBe(1)
  })

  it('flags host_events rows as orgWide (the one org-scoped approval provider)', async () => {
    getPendingApprovals.mockResolvedValue(approvalsResult([
      {
        key: 'host_events', label: 'Host events', reviewBase: '/settings/hosts', count: 1,
        items: [{
          id: 'e1', title: 'Pride', subtitle: null,
          submittedAt: '2026-08-10T10:00:00Z', reviewUrl: '/settings/hosts',
        }],
      },
    ]))
    const result = await assembleHomeQueue(makeDb(), userAt())
    expect(result.rows.find((r) => r.id === 'e1').orgWide).toBe(true)
  })

  it('does not flag ordinary (location-scoped) providers as orgWide', async () => {
    getPendingApprovals.mockResolvedValue(approvalsResult([
      {
        key: 'issues', label: 'Issues', reviewBase: '/issues', count: 1,
        items: [{ id: 'i1', title: 'Ada', subtitle: null, submittedAt: '2026-08-10T10:00:00Z', reviewUrl: '/issues?focus=i1' }],
      },
    ]))
    const result = await assembleHomeQueue(makeDb(), userAt())
    expect(result.rows.find((r) => r.id === 'i1').orgWide).toBeUndefined()
  })

  it('true count comes from getPendingApprovalsCount, not summed item lists', async () => {
    // A provider's fetchPending items can be internally capped (e.g. issues'
    // own .limit(50)); the assembler's approvals count must be the TRUE
    // uncapped number, which is what getPendingApprovalsCount answers.
    getPendingApprovals.mockResolvedValue(approvalsResult([
      { key: 'issues', label: 'Issues', reviewBase: '/issues', count: 2, items: [] },
    ]))
    getPendingApprovalsCount.mockResolvedValue(57)
    const result = await assembleHomeQueue(makeDb(), userAt())
    expect(result.counts.approvals).toBe(57)
  })
})

describe('assembleHomeQueue — tickets source', () => {
  it('gates on email_inbox at the active location before touching the db', async () => {
    hasPermissionForLocation.mockReturnValue(false)
    const result = await assembleHomeQueue(makeDb(), userAt())
    expect(result.rows.filter((r) => r.source === 'tickets')).toEqual([])
    expect(result.counts.tickets).toBe(0)
    expect(loadVisibleMailboxes).not.toHaveBeenCalled()
  })

  it('is empty when the caller has no visible mailboxes', async () => {
    hasPermissionForLocation.mockReturnValue(true)
    loadVisibleMailboxes.mockResolvedValue({ elevated: false, mailboxes: [] })
    const db = makeDb({ email_tickets: { rows: [{ id: 't1' }], count: 1 } })
    const result = await assembleHomeQueue(db, userAt())
    expect(result.counts.tickets).toBe(0)
  })

  it('builds rows from needs-reply unmerged tickets', async () => {
    hasPermissionForLocation.mockReturnValue(true)
    loadVisibleMailboxes.mockResolvedValue({ elevated: true, mailboxes: [{ id: 'mb1' }] })
    const db = makeDb({
      email_tickets: {
        rows: [{
          id: 't1', subject: 'Billing', requester_name: 'Bob',
          requester_email: 'bob@x.com', last_message_at: '2026-08-10T09:00:00Z',
        }],
        count: 1,
      },
    })
    const result = await assembleHomeQueue(db, userAt())
    expect(result.rows).toContainEqual({
      source: 'tickets', sourceLabel: 'Tickets', id: 't1', title: 'Billing', subtitle: 'Bob',
      occurredAt: '2026-08-10T09:00:00Z', href: '/communications/tickets',
    })
    expect(result.counts.tickets).toBe(1)
  })

  it('falls back to requester email when the ticket has no subject or name', async () => {
    hasPermissionForLocation.mockReturnValue(true)
    loadVisibleMailboxes.mockResolvedValue({ elevated: true, mailboxes: [{ id: 'mb1' }] })
    const db = makeDb({
      email_tickets: {
        rows: [{
          id: 't2', subject: null, requester_name: null,
          requester_email: 'payer@example.com', last_message_at: '2026-08-10T09:00:00Z',
        }],
        count: 1,
      },
    })
    const result = await assembleHomeQueue(db, userAt())
    const row = result.rows.find((r) => r.id === 't2')
    expect(row.title).toBe('payer@example.com')
  })
})

describe('assembleHomeQueue — inbox source', () => {
  it('gates on the whatsapp permission for both WhatsApp and Instagram', async () => {
    hasPermission.mockReturnValue(false)
    const db = makeDb({
      whatsapp_conversations: { rows: [{ id: 'w1', resolved_at: null, last_message_at: '2026-08-10T08:00:00Z', last_message_direction: 'inbound' }] },
    })
    const result = await assembleHomeQueue(db, userAt())
    expect(result.rows.filter((r) => r.source === 'inbox')).toEqual([])
    expect(result.counts.inbox).toBe(0)
  })

  it('filters by needsAction and builds rows for wa + ig with the right deep links', async () => {
    hasPermission.mockReturnValue(true)
    const db = makeDb({
      whatsapp_conversations: {
        rows: [
          // needs action: unresolved, inbound last message
          {
            id: 'w1', wa_phone: '+353871234567', resolved_at: null,
            last_message_at: '2026-08-10T08:00:00Z', last_message_direction: 'inbound',
            agent_handed_off_at: null, contacts: { name: 'Alice' },
          },
          // does NOT need action: resolved
          {
            id: 'w2', wa_phone: '+353870000000', resolved_at: '2026-08-09T00:00:00Z',
            last_message_at: '2026-08-09T08:00:00Z', last_message_direction: 'inbound',
            agent_handed_off_at: null, contacts: null,
          },
        ],
      },
      instagram_conversations: {
        rows: [
          {
            id: 'g1', ig_username: 'ig_user', resolved_at: null,
            last_message_at: '2026-08-10T07:00:00Z', last_message_direction: 'outbound',
            agent_handed_off_at: '2026-08-10T07:00:00Z', contacts: null,
          },
        ],
      },
    })
    const result = await assembleHomeQueue(db, userAt())
    const inboxRows = result.rows.filter((r) => r.source === 'inbox')
    expect(inboxRows).toHaveLength(2)
    expect(inboxRows.find((r) => r.id === 'w1')).toMatchObject({
      title: 'Alice', href: '/communications/inbox?c=w1',
    })
    expect(inboxRows.find((r) => r.id === 'g1')).toMatchObject({
      title: 'ig_user', href: '/communications/inbox?c=g1&ch=ig',
    })
    expect(result.counts.inbox).toBe(2)
  })

  it('falls back to phone/username when there is no linked contact', async () => {
    hasPermission.mockReturnValue(true)
    const db = makeDb({
      whatsapp_conversations: {
        rows: [{
          id: 'w3', wa_phone: '+353871111111', resolved_at: null,
          last_message_at: '2026-08-10T08:00:00Z', last_message_direction: 'inbound',
          agent_handed_off_at: null, contacts: null,
        }],
      },
    })
    const result = await assembleHomeQueue(db, userAt())
    expect(result.rows.find((r) => r.id === 'w3').title).toBe('+353871111111')
  })
})

describe('assembleHomeQueue — merge, sort and caps', () => {
  beforeEach(() => {
    hasPermissionForLocation.mockReturnValue(true)
    hasPermission.mockReturnValue(true)
    loadVisibleMailboxes.mockResolvedValue({ elevated: true, mailboxes: [{ id: 'mb1' }] })
  })

  it('merge-sorts rows across sources by occurredAt descending', async () => {
    getPendingApprovals.mockResolvedValue(approvalsResult([
      {
        key: 'issues', label: 'Issues', reviewBase: '/issues', count: 1,
        items: [{ id: 'a1', title: 'A', subtitle: null, submittedAt: '2026-08-10T06:00:00Z', reviewUrl: '/issues?focus=a1' }],
      },
    ]))
    const db = makeDb({
      email_tickets: {
        rows: [{ id: 't1', subject: 'T', requester_name: null, requester_email: 'x@x.com', last_message_at: '2026-08-10T12:00:00Z' }],
        count: 1,
      },
      whatsapp_conversations: {
        rows: [{
          id: 'w1', wa_phone: '+353', resolved_at: null, last_message_at: '2026-08-10T09:00:00Z',
          last_message_direction: 'inbound', agent_handed_off_at: null, contacts: null,
        }],
      },
    })
    const result = await assembleHomeQueue(db, userAt())
    expect(result.rows.map((r) => r.id)).toEqual(['t1', 'w1', 'a1'])
  })

  it('pre-caps a single source to SOURCE_PRE_CAP rows before the global cap', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: `t${i}`, subject: `S${i}`, requester_name: 'Bob', requester_email: 'bob@x.com',
      last_message_at: new Date(Date.UTC(2026, 7, 1 + i)).toISOString(),
    }))
    const db = makeDb({ email_tickets: { rows, count: 25 } })
    const result = await assembleHomeQueue(db, userAt())
    expect(result.rows.filter((r) => r.source === 'tickets')).toHaveLength(SOURCE_PRE_CAP)
    // TRUE count is uncapped even though the row list was pre-capped.
    expect(result.counts.tickets).toBe(25)
  })

  it('caps the merged total at GLOBAL_CAP, keeping the most recent rows', async () => {
    const ticketRows = Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`, subject: `T${i}`, requester_name: null, requester_email: 'x@x.com',
      // Older half of the timeline.
      last_message_at: new Date(Date.UTC(2026, 7, 1 + i)).toISOString(),
    }))
    const waRows = Array.from({ length: 20 }, (_, i) => ({
      id: `w${i}`, wa_phone: '+353', resolved_at: null,
      // Newer half of the timeline — these must win the cap.
      last_message_at: new Date(Date.UTC(2026, 7, 21 + i)).toISOString(),
      last_message_direction: 'inbound', agent_handed_off_at: null, contacts: null,
    }))
    const db = makeDb({
      email_tickets: { rows: ticketRows, count: 20 },
      whatsapp_conversations: { rows: waRows },
    })
    const result = await assembleHomeQueue(db, userAt())
    expect(result.rows).toHaveLength(GLOBAL_CAP)
    // All 20 WA rows are newer than every ticket row, so the 30-cap should
    // keep all 20 WA rows plus the 10 most recent tickets.
    expect(result.rows.filter((r) => r.source === 'inbox')).toHaveLength(20)
    expect(result.rows.filter((r) => r.source === 'tickets')).toHaveLength(10)
    // TRUE counts are unaffected by the global cap.
    expect(result.counts.tickets).toBe(20)
  })
})

describe('assembleHomeQueue — degraded source path', () => {
  beforeEach(() => {
    hasPermission.mockReturnValue(true)
  })

  it('degrades a failed source to an empty bucket without failing the others', async () => {
    getPendingApprovals.mockRejectedValue(new Error('registry boom'))
    const db = makeDb({
      whatsapp_conversations: {
        rows: [{
          id: 'w1', wa_phone: '+353', resolved_at: null, last_message_at: '2026-08-10T08:00:00Z',
          last_message_direction: 'inbound', agent_handed_off_at: null, contacts: null,
        }],
      },
    })
    const result = await assembleHomeQueue(db, userAt())
    expect(result.counts.approvals).toBe(0)
    expect(result.degraded).toEqual(['approvals'])
    expect(result.counts.inbox).toBe(1)
    expect(result.rows.some((r) => r.source === 'inbox')).toBe(true)
  })

  it('omits the degraded field entirely when nothing failed', async () => {
    const result = await assembleHomeQueue(makeDb(), userAt())
    expect(result.degraded).toBeUndefined()
  })
})

describe('getHomeQueueCount', () => {
  it('is 0 with no active location', async () => {
    const count = await getHomeQueueCount(makeDb(), { id: 'u1', activeLocation: null })
    expect(count).toBe(0)
  })

  it('sums true counts across all three sources without assembling rows', async () => {
    getPendingApprovalsCount.mockResolvedValue(3)
    hasPermissionForLocation.mockReturnValue(true)
    hasPermission.mockReturnValue(true)
    loadVisibleMailboxes.mockResolvedValue({ elevated: true, mailboxes: [{ id: 'mb1' }] })
    const db = makeDb({
      email_tickets: { rows: [], count: 5 },
      whatsapp_conversations: {
        rows: [{
          id: 'w1', resolved_at: null, last_message_at: '2026-08-10T08:00:00Z',
          last_message_direction: 'inbound', agent_handed_off_at: null,
        }],
      },
    })
    const count = await getHomeQueueCount(db, userAt())
    expect(count).toBe(3 + 5 + 1)
    // Cheap: getPendingApprovals (the item-materialising call) is never made.
    expect(getPendingApprovals).not.toHaveBeenCalled()
  })
})

// EMAIL-TICKET-CLEANUP.2 — a FAILED mailbox-visibility lookup is not "no
// mailboxes": collapsing the two into the same 0 is exactly the silent
// wrong-answer shape that invariant exists to prevent (src/app/api/email/
// tickets/_helpers.js's loadVisibleMailboxes / mailboxesUnavailable). The
// generic degraded-source path (any other tickets failure — a query error,
// say) still folds to counts.tickets = 0, proven below alongside it so the
// distinction is pinned, not assumed.
describe('assembleHomeQueue — tickets visibility-lookup failure (EMAIL-TICKET-CLEANUP.2)', () => {
  beforeEach(() => {
    hasPermissionForLocation.mockReturnValue(true)
  })

  it('sets counts.tickets to null, not 0, and keeps tickets in degraded', async () => {
    // The real shape from loadVisibleMailboxes on a FAILED lookup —
    // { response: <NextResponse> } — as opposed to a successful empty set
    // ({ elevated, mailboxes: [] }).
    loadVisibleMailboxes.mockResolvedValue({ response: 'mailboxes-unavailable' })
    const result = await assembleHomeQueue(makeDb(), userAt())
    expect(result.counts.tickets).toBeNull()
    expect(result.degraded).toEqual(['tickets'])
  })

  it('does not poison the other two sources or turn total into NaN', async () => {
    loadVisibleMailboxes.mockResolvedValue({ response: 'mailboxes-unavailable' })
    getPendingApprovalsCount.mockResolvedValue(2)
    hasPermission.mockReturnValue(true)
    const db = makeDb({
      whatsapp_conversations: {
        rows: [{
          id: 'w1', wa_phone: '+353', resolved_at: null, last_message_at: '2026-08-10T08:00:00Z',
          last_message_direction: 'inbound', agent_handed_off_at: null, contacts: null,
        }],
      },
    })
    const result = await assembleHomeQueue(db, userAt())
    // `mail` degrades to null alongside `tickets`: both read through the SAME
    // visibility lookup, so when it fails neither number is known, and an
    // unknown must never render as a confident 0.
    expect(result.counts).toEqual({ approvals: 2, tickets: null, mail: null, inbox: 1 })
    expect(Number.isNaN(result.total)).toBe(false)
    expect(result.total).toBe(3) // 2 + 1, the unknown tickets count excluded rather than treated as 0
  })

  it('a genuinely empty visible-mailbox set (not a failure) still reads as a confident 0', async () => {
    loadVisibleMailboxes.mockResolvedValue({ elevated: false, mailboxes: [] })
    const result = await assembleHomeQueue(makeDb(), userAt())
    expect(result.counts.tickets).toBe(0)
    expect(result.degraded).toBeUndefined()
  })

  it('a non-visibility tickets failure (e.g. the row/count query erroring) still folds to counts.tickets = 0', async () => {
    loadVisibleMailboxes.mockResolvedValue({ elevated: true, mailboxes: [{ id: 'mb1' }] })
    const db = makeDb({ email_tickets: { rows: [], count: 0, error: { message: 'boom' } } })
    const result = await assembleHomeQueue(db, userAt())
    expect(result.counts.tickets).toBe(0)
    expect(result.degraded).toEqual(['tickets'])
  })
})

describe('queueCountLabel', () => {
  it('returns null when there is nothing to count', () => {
    expect(queueCountLabel(0, 0)).toBeNull()
  })

  it('returns the plain total as a string when nothing was capped', () => {
    expect(queueCountLabel(5, 5)).toBe('5')
    expect(queueCountLabel(5, 30)).toBe('5') // rows can exceed total in no real case, but never crash
  })

  it('appends a "+" when GLOBAL_CAP trimmed the row list below the true total', () => {
    expect(queueCountLabel(42, 30)).toBe('42+')
  })

  // FU-COSMETICS (c) — registry-internal degradation: a source's count
  // came from a query path independent of the one that materialised rows
  // (e.g. getPendingApprovalsCount succeeding via a provider's own
  // .countPending() while that SAME provider's .fetchPending() — the rows
  // path — threw and degraded to an empty bucket, src/lib/approvals/
  // registry.js). total > 0 with rows.length === 0 is not "more items
  // exist below a page cap" (what "+" means everywhere else this label is
  // used) — it is possibly-stale count with literally nothing to show for
  // it, and appending "+" over an empty list read as a broken header
  // rather than a degraded one.
  it('drops the "+" when rowsCount is 0 but total is not — a capped list has SOME rows to show for it, this has none', () => {
    expect(queueCountLabel(5, 0)).toBe('5')
    expect(queueCountLabel(1, 0)).toBe('1')
  })
})

describe('queueRowGroup', () => {
  it('groups tickets and inbox rows by their literal source', () => {
    expect(queueRowGroup({ source: 'tickets' })).toBe('tickets')
    expect(queueRowGroup({ source: 'inbox' })).toBe('inbox')
  })

  it('folds every approvals provider key into "approvals"', () => {
    expect(queueRowGroup({ source: 'issues' })).toBe('approvals')
    expect(queueRowGroup({ source: 'invoices_queue' })).toBe('approvals')
    expect(queueRowGroup({ source: 'host_events' })).toBe('approvals')
  })
})

describe('groupQueueRows', () => {
  const row = (source, id) => ({ source, id, occurredAt: '2026-08-10T10:00:00Z' })

  it('returns null (flat list) when only 1 group is present', () => {
    const rows = [row('issues', 'a1'), row('invoices_queue', 'a2')]
    expect(groupQueueRows(rows, { approvals: 2 })).toBeNull()
  })

  it('returns null (flat list) when only 2 groups are present', () => {
    const rows = [row('issues', 'a1'), row('tickets', 't1')]
    expect(groupQueueRows(rows, { approvals: 1, tickets: 1 })).toBeNull()
  })

  it('splits into 3 sections, ordered by first appearance, when all 3 groups are present', () => {
    const rows = [row('tickets', 't1'), row('issues', 'a1'), row('inbox', 'i1'), row('tickets', 't2')]
    const groups = groupQueueRows(rows, { approvals: 1, tickets: 2, inbox: 1 })
    expect(groups.map((g) => g.key)).toEqual(['tickets', 'approvals', 'inbox'])
    expect(groups.find((g) => g.key === 'tickets').rows).toHaveLength(2)
    expect(groups.find((g) => g.key === 'tickets').href).toBe('/communications/tickets')
    expect(groups.find((g) => g.key === 'approvals').href).toBe('/approvals')
    expect(groups.find((g) => g.key === 'inbox').href).toBe('/communications/inbox')
  })

  it('uses the TRUE count from `counts`, not the visible row count, for each section badge', () => {
    const rows = [row('tickets', 't1'), row('issues', 'a1'), row('inbox', 'i1')]
    const groups = groupQueueRows(rows, { approvals: 57, tickets: 1, inbox: 1 })
    expect(groups.find((g) => g.key === 'approvals').count).toBe(57)
  })

  it('falls back to the visible row count when `counts` is missing a key', () => {
    const rows = [row('tickets', 't1'), row('issues', 'a1'), row('inbox', 'i1')]
    const groups = groupQueueRows(rows, {})
    expect(groups.find((g) => g.key === 'approvals').count).toBe(1)
  })

  it('handles an empty row list', () => {
    expect(groupQueueRows([], {})).toBeNull()
  })
})

describe('getHomeQueueCount — tickets visibility-lookup failure (EMAIL-TICKET-CLEANUP.2)', () => {
  it('rejects (mirrors /api/email/tickets/count returning 500) rather than answering a confident number', async () => {
    hasPermissionForLocation.mockReturnValue(true)
    loadVisibleMailboxes.mockResolvedValue({ response: 'mailboxes-unavailable' })
    getPendingApprovalsCount.mockResolvedValue(2)
    hasPermission.mockReturnValue(true)
    await expect(getHomeQueueCount(makeDb(), userAt())).rejects.toThrow()
  })

  it('still answers a plain number when tickets is genuinely empty (not a failure)', async () => {
    hasPermissionForLocation.mockReturnValue(true)
    loadVisibleMailboxes.mockResolvedValue({ elevated: false, mailboxes: [] })
    getPendingApprovalsCount.mockResolvedValue(2)
    hasPermission.mockReturnValue(false)
    await expect(getHomeQueueCount(makeDb(), userAt())).resolves.toBe(2)
  })
})

// MAILBOX-SURFACE.1 — a needs-reply row must link to the surface that LISTS
// its mail. Both surfaces share this lane (the needs-reply predicate is the
// same on each), so the routing is the only thing keeping a moved account's
// row from dead-ending on a queue that no longer shows it.
describe('assembleHomeQueue — tickets routed by mailbox surface', () => {
  const ticket = (over = {}) => ({
    id: 't1', subject: 'Billing', requester_name: 'Bob', requester_email: 'bob@x.com',
    last_message_at: '2026-08-10T09:00:00Z', mailbox_id: 'mb1', ...over,
  })

  async function rowFor({ mailboxes, row }) {
    hasPermissionForLocation.mockReturnValue(true)
    loadVisibleMailboxes.mockResolvedValue({ elevated: true, mailboxes })
    const db = makeDb({ email_tickets: { rows: [row], count: 1 } })
    const result = await assembleHomeQueue(db, userAt())
    return result.rows.find(r => r.id === row.id)
  }

  // MAIL-DEEPLINK.1 — the Mail surface reads `?c=<id>` on mount and selects
  // that conversation, even off page 1 (MailSurface.jsx). A mail row must
  // carry it, or the operator lands on the top of the list rather than on the
  // conversation this row named — the exact "where did my mail go" failure
  // MAILBOX-SURFACE.1 already fixed for which SURFACE the link goes to.
  it('links a ticket on an inbox-surface mailbox to Mail WITH a deep link to it, and labels it Mail', async () => {
    const r = await rowFor({
      mailboxes: [{ id: 'mb1', surface: 'inbox' }],
      row: ticket(),
    })
    expect(r.href).toBe('/communications/mail?c=t1')
    expect(r.source).toBe('mail')
    expect(r.sourceLabel).toBe('Mail')
  })

  it('leaves a ticket on a ticketing mailbox pointed at Tickets, with NO deep link (TicketInbox has none)', async () => {
    const r = await rowFor({
      mailboxes: [{ id: 'mb1', surface: 'tickets' }],
      row: ticket(),
    })
    expect(r.href).toBe('/communications/tickets')
    expect(r.source).toBe('tickets')
  })

  // The `?c=` value must be THIS ticket's own id, not a fixed string — a
  // second fixture with a different id catches a hard-coded '?c=t1'.
  it('carries the SPECIFIC ticket id in the deep link, not a fixed value', async () => {
    const r = await rowFor({
      mailboxes: [{ id: 'mb1', surface: 'inbox' }],
      row: ticket({ id: 't-other' }),
    })
    expect(r.href).toBe('/communications/mail?c=t-other')
  })

  // The two "nobody said otherwise" cases. Both must land somewhere REAL —
  // a row that routes nowhere is worse than one that routes to the default.
  it('routes a ticket with no mailbox to Tickets', async () => {
    const r = await rowFor({
      mailboxes: [{ id: 'mb1', surface: 'inbox' }],
      row: ticket({ mailbox_id: null }),
    })
    expect(r.href).toBe('/communications/tickets')
    expect(r.source).toBe('tickets')
  })

  it('routes a ticket whose mailbox is not in the visible set to Tickets', async () => {
    const r = await rowFor({
      mailboxes: [{ id: 'mb1', surface: 'inbox' }],
      row: ticket({ mailbox_id: 'mb-unknown' }),
    })
    expect(r.href).toBe('/communications/tickets')
  })

  // A mailbox row that predates mig 575 (or a select that forgot the column)
  // has no `surface` at all. It must read as ticketing — the migration's own
  // default — never as the surface the operator has not opted into.
  it('treats a mailbox with no surface value as ticketing', async () => {
    const r = await rowFor({
      mailboxes: [{ id: 'mb1' }],
      row: ticket(),
    })
    expect(r.href).toBe('/communications/tickets')
  })

  // 🔴 A HEADING MUST NOT PROMISE MORE THAN THE LIST UNDER IT HOLDS. The lane
  // spans both surfaces, so one combined count put the mail rows' total on the
  // Tickets heading — a badge an operator clicks, finds nothing behind, and
  // afterwards stops trusting.
  it('counts each surface separately, so neither heading borrows the other\'s rows', async () => {
    hasPermissionForLocation.mockReturnValue(true)
    loadVisibleMailboxes.mockResolvedValue({
      elevated: true,
      mailboxes: [{ id: 'mb1', surface: 'tickets' }, { id: 'mb2', surface: 'inbox' }],
    })
    const db = makeDb({ email_tickets: { rows: [], count: 4, mailCount: 3 } })

    const result = await assembleHomeQueue(db, userAt())

    expect(result.counts.tickets).toBe(4)
    expect(result.counts.mail).toBe(3)
    // Both contribute to the queue total — the split is about attribution, not
    // about hiding work.
    expect(result.total).toBe(7)
  })

  it('groups a mail row under its own group, NOT the unified inbox', () => {
    expect(queueRowGroup({ source: 'mail' })).toBe('mail')
    expect(queueRowGroup({ source: 'inbox' })).toBe('inbox')
    const groups = groupQueueRows([
      { source: 'mail', id: 'm1', occurredAt: '2026-08-10T09:00:00Z' },
      { source: 'inbox', id: 'i1', occurredAt: '2026-08-10T08:00:00Z' },
      { source: 'tickets', id: 't1', occurredAt: '2026-08-10T07:00:00Z' },
    ])
    const mail = groups.find(g => g.key === 'mail')
    expect(mail.label).toBe('Mail')
    expect(mail.href).toBe('/communications/mail')
  })
})
