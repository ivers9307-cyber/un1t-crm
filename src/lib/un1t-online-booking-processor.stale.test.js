// UN1TBOOK.20 — a queued funnel booking for a class the latest un1t.online
// sync no longer sees (deleted upstream; the mirror never deletes, so its row
// lingers with an old synced_at) goes to staff with its own reason, and
// nothing is sent to un1t.online: no account step, no trial, no booking.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { processUn1tClassBookingRequest, Un1tFunnelRetry } from './un1t-online-booking-processor'
import { whyFlagged } from './approvals/agent-request-why'
import { UN1T_RECORD_ONLY_REASONS } from './un1t-online-approval'

const LOC = 'loc-hatch'
const EVENT = 'ev-1'
const HOUR = 3_600_000
const LATEST = '2026-10-19T10:00:00+00:00' // Postgres's own timestamptz rendering
const TWENTY_MIN_EARLIER = '2026-10-19T09:40:00+00:00'
let tables
let failFreshness
function makeDb() {
  return {
    from(table) {
      const q = { f: [], op: 'select', order: null, range: null }
      const rows = () => {
        let out = (tables[table] || []).filter((r) => q.f.every(([k, c, v]) => (k === 'eq' ? r[c] === v : k === 'in' ? v.includes(r[c]) : true)))
        if (q.order) out = [...out].sort((a, b) => (q.order.ascending ? 1 : -1) * String(a[q.order.col]).localeCompare(String(b[q.order.col])))
        if (q.range) out = out.slice(q.range[0], q.range[1] + 1)
        return out
      }
      const b = {
        select: () => b, limit: () => b,
        order: (col, o) => { q.order = { col, ascending: o?.ascending !== false }; return b },
        range: (a, z) => { q.range = [a, z]; return b },
        eq: (c, v) => { q.f.push(['eq', c, v]); return b },
        in: (c, v) => { q.f.push(['in', c, v]); return b },
        update: () => { q.op = 'update'; return b },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok, no) => {
          // The freshness read is the only ranged read of un1t_events.
          if (table === 'un1t_events' && q.range && failFreshness) return Promise.resolve({ data: null, error: { message: 'timeout' } }).then(ok, no)
          return Promise.resolve({ data: q.op === 'update' ? [{ id: 'q-1' }] : rows(), error: null }).then(ok, no)
        },
      }
      return b
    },
  }
}

const startsAt = () => new Date(Date.now() + 24 * HOUR).toISOString()
const request = () => ({
  id: 'q-1', location_id: LOC, contact_id: 'c-1', glofox_event_id: `un1t:${EVENT}`, class_name: 'RALLY',
  starts_at: startsAt(), attempts: 1, terms_accepted_at: '2026-10-18T09:00:00.000Z', terms_source: 'website', terms_version: 'v',
})
const ctx = { settings: { writesEnabled: true, funnelEnabled: true, sendsBookingConfirmation: false }, studioName: 'Hatch Street', organizationId: 'org-1' }
const ev = (over = {}) => ({ location_id: LOC, un1t_id: EVENT, title: 'RALLY', status: 'scheduled', starts_at: startsAt(), synced_at: LATEST, ...over })

let deps
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test: real network call') }))
  failFreshness = false
  tables = {
    un1t_events: [ev(), ev({ un1t_id: 'ev-other', synced_at: LATEST })],
    contacts: [{ id: 'c-1', organization_id: 'org-1', first_name: 'Jane', last_name: 'Doe', name: 'Jane Doe', email: 'jane@example.test', phone: null, un1t_user_id: null, ctwa_clid: null }],
    un1t_subscriptions: [],
    landing_pages: [{ id: 'sp', organization_id: 'org-1', slug: 'hatch-street', kind: 'studio', scope: 'one', primary_location_id: LOC, offer_type: 'class_funnel', publish_state: 'live', chrome: {}, blocks: [] }],
    locations: [{ id: LOC, name: 'Hatch Street', address: '1 Hatch St', timezone: 'Europe/Dublin' }],
  }
  const writer = { locationId: LOC, studioId: 'studio-1', read: vi.fn(async () => ({ balance: 0, is_unlimited: false })) }
  deps = {
    writerFactory: vi.fn(async () => writer),
    ensureUn1tAccount: vi.fn(async () => ({ kind: 'created', un1tUserId: 'usr-1', executingContactId: 'c-1' })),
    readPaidTrialReply: vi.fn(async () => null),
    grantTrial: vi.fn(async () => ({ outcome: 'granted', method: 'charge', ledgerId: 'l-t' })),
    book: vi.fn(async () => ({ verdict: 'done', sent: true, id: 'bk-9', code: null, alreadyBooked: false, retryable: false })),
    runSetPasswordStep: vi.fn(async () => ({ explanation: 'sent', forgotPassword: 'done' })),
    sendManualBookingConfirmEmail: vi.fn(async () => ({ sent: true })),
    sendUn1tTrialUsedEmail: vi.fn(async () => ({ sent: true })),
    trialUsedHandoff: vi.fn(async () => ({ handled: false })),
    routeToReview: vi.fn(async (db, req, reason) => ({ outcome: 'needs_review', detail: reason })),
    sendCtwaConversion: vi.fn(async () => {}),
    sendWebsiteConversion: vi.fn(async () => {}),
  }
})
const run = () => processUn1tClassBookingRequest(makeDb(), request(), ctx, deps)
const nothingSentToUn1t = () => {
  expect(deps.writerFactory).not.toHaveBeenCalled()
  expect(deps.ensureUn1tAccount).not.toHaveBeenCalled()
  expect(deps.grantTrial).not.toHaveBeenCalled()
  expect(deps.book).not.toHaveBeenCalled()
}

describe('a queued un1t.online booking for a class the latest sync no longer sees (UN1TBOOK.20)', () => {
  it('a stale event (not in the latest pull) goes to staff as un1t_class_no_longer_available; no trial, no booking', async () => {
    tables.un1t_events[0].synced_at = TWENTY_MIN_EARLIER
    const out = await run()
    expect(out).toEqual({ outcome: 'needs_review', detail: 'un1t_class_no_longer_available' })
    expect(deps.routeToReview.mock.calls[0][2]).toBe('un1t_class_no_longer_available')
    expect(deps.routeToReview.mock.calls[0][3]).toMatchObject({ provider: 'un1t_online' })
    nothingSentToUn1t()
  })

  it('a cancelled or missing event in the mirror takes the same reason', async () => {
    tables.un1t_events[0].status = 'cancelled'
    await run()
    expect(deps.routeToReview.mock.calls[0][2]).toBe('un1t_class_no_longer_available')
    tables.un1t_events = [ev({ un1t_id: 'ev-other' })]
    await run()
    expect(deps.routeToReview.mock.calls[1][2]).toBe('un1t_class_no_longer_available')
    nothingSentToUn1t()
  })

  it('a fresh event books exactly as before (trial, then the booking)', async () => {
    tables.un1t_events[0].synced_at = '2026-10-19T09:55:00+00:00' // within the 10-minute window
    const out = await run()
    expect(out).toEqual({ outcome: 'booked', detail: 'un1t:bk-9' })
    expect(deps.grantTrial).toHaveBeenCalledOnce()
    expect(deps.book.mock.calls[0][1]).toMatchObject({ eventId: EVENT })
    expect(deps.routeToReview).not.toHaveBeenCalled()
  })

  it('a stalled sync (every row equally old) leaves the class bookable: the rule is relative', async () => {
    for (const e of tables.un1t_events) e.synced_at = '2026-10-12T10:00:00+00:00'
    const out = await run()
    expect(out.outcome).toBe('booked')
  })

  it('an unreadable freshness cutoff is the queue retry signal, before anything reaches un1t.online', async () => {
    failFreshness = true
    const err = await run().catch((e) => e)
    expect(err).toBeInstanceOf(Un1tFunnelRetry)
    expect(err.code).toBe('event_freshness_unreadable')
    expect(err.reviewOptions).toMatchObject({ provider: 'un1t_online' })
    nothingSentToUn1t()
  })

  it('the card tells staff what happened, and approving it books nothing', () => {
    expect(whyFlagged({ kind: 'class_booking', details: { reason: 'un1t_class_no_longer_available', event_id: `un1t:${EVENT}` } }))
      .toBe('This class was removed in un1t.online before it could be booked. Offer the customer another class.')
    expect(UN1T_RECORD_ONLY_REASONS.has('un1t_class_no_longer_available')).toBe(true)
  })
})
