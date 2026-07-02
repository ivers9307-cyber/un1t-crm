// Route test for the auto-end-stale-hr-sessions cron.
//
// Focus: the Phase-2 "pending post-class email" sweep query must EXCLUDE both
// source='participation' AND source='apple_health'. Both kinds are finalised
// once out-of-band and never stamp email_sent_at, so without the exclusion they
// match the sweep forever and re-fire the "session ready" push every 5 minutes
// (the bug class originally fixed for participation, extended to imports in IB3).
//
// We record every call made on each Supabase query-builder so we can assert the
// exact .not('source','in', …) clause the route applies — without standing up a
// real DB. The route's other phases are stubbed to no-ops.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture the query chains the route builds, per from()-call.
let builders = []
// Rows the Phase-2 email sweep resolves. The sweep is the only query that
// filters on email_sent_at, so we key off that to feed it (default empty).
let sweepRows = []
// Phase-1 silent-candidate rows (the query that filters on last_sample_at).
let silentRows = []
// Phase-1 never-sampled rows (item 4a: last_sample_at IS NULL, open past stale).
let neverSampledRows = []
// item 4c stale-ended un-emailed rows to retire (ended_at < 48h cutoff).
let staleRetireRows = []
// class_occurrences rows the ends_at lookup resolves (matched on glofox_event_id).
let occRows = []

function makeBuilder(table) {
  // A thenable query-builder: every method records its name+args and returns
  // `this`; awaiting resolves the right rows for whichever query this is
  // (Phase-2 email sweep, Phase-1 silent candidates, the class_occurrences
  // ends_at lookup) or an empty result so the route's other loops no-op.
  const calls = []
  const builder = {
    calls,
    then(resolve) {
      let data = []
      const has = (method, arg0) => calls.some((c) => c.method === method && c.args[0] === arg0)
      if (table === 'class_occurrences') data = occRows
      // The Phase-2 SEND sweep and the item-4c STALE-RETIRE query both filter
      // on email_sent_at; the send sweep bounds ended_at with .gte, the retire
      // query with .lt. Only feed rows to the send sweep (retire resolves empty).
      else if (has('is', 'email_sent_at') && has('gte', 'ended_at')) data = sweepRows
      else if (has('is', 'email_sent_at') && has('lt', 'ended_at')) data = staleRetireRows
      else if (has('lt', 'last_sample_at')) data = silentRows
      else if (has('is', 'last_sample_at')) data = neverSampledRows
      return Promise.resolve({ data, error: null }).then(resolve)
    },
  }
  for (const method of ['select', 'eq', 'is', 'not', 'lt', 'order', 'limit', 'neq', 'gte', 'in', 'or', 'update']) {
    builder[method] = vi.fn((...args) => { calls.push({ method, args }); return builder })
  }
  return builder
}

const fakeDb = {
  from: vi.fn((table) => {
    const b = makeBuilder(table)
    b.table = table
    builders.push(b)
    return b
  }),
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/live-class', () => ({ endSession: vi.fn(() => Promise.resolve({ ok: true })) }))
vi.mock('@/lib/hr-post-class-email', () => ({ sendPostClassEmail: vi.fn(() => Promise.resolve({ ok: true, sent: false })) }))
vi.mock('@/lib/customer-push', () => ({ sendCustomerPush: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }))

import { GET } from './route.js'
import { sendPostClassEmail } from '@/lib/hr-post-class-email'
import { sendCustomerPush } from '@/lib/customer-push'
import { endSession } from '@/lib/live-class'

function req() {
  return { headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } }
}

beforeEach(() => {
  builders = []
  sweepRows = []
  silentRows = []
  neverSampledRows = []
  staleRetireRows = []
  occRows = []
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'test-secret'
})

describe('auto-end-stale-hr-sessions — Phase 2 email-sweep query', () => {
  it("excludes participation + apple_health via .or() that ALSO admits NULL source", async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)

    // The Phase-2 SEND sweep is the heart_rate_sessions query that filters on
    // email_sent_at AND bounds ended_at with .gte (the item-4c retire query uses
    // .lt). Phase-1 queries filter on last_sample_at / started_at.
    const phase2 = builders.find(
      (b) => b.table === 'heart_rate_sessions' &&
        b.calls.some((c) => c.method === 'is' && c.args[0] === 'email_sent_at') &&
        b.calls.some((c) => c.method === 'gte' && c.args[0] === 'ended_at')
    )
    expect(phase2, 'Phase-2 email sweep query not found').toBeTruthy()

    // Item 4b — a bare .not('source','in',…) is UNKNOWN (→ excluded) for a null
    // source, so the sweep must use an OR that explicitly admits null.
    const or = phase2.calls.find((c) => c.method === 'or')
    expect(or, 'no .or() source clause on the sweep').toBeTruthy()
    expect(or.args[0]).toContain('source.is.null')
    expect(or.args[0]).toContain('participation')
    expect(or.args[0]).toContain('apple_health')
  })

  it('closes a never-sampled session (item 4a: last_sample_at IS NULL, open past stale)', async () => {
    const now = Date.now()
    // A session whose strap never delivered a sample: last_sample_at null,
    // started 10 min ago (past the 5-min stale cutoff), no class link.
    neverSampledRows = [{
      id: 's-never', last_sample_at: null,
      started_at: new Date(now - 10 * 60 * 1000).toISOString(), glofox_event_id: null,
    }]
    const res = await GET(req())
    expect(res.status).toBe(200)
    const endedIds = endSession.mock.calls.map((c) => c[1])
    expect(endedIds).toContain('s-never')
  })

  it('retires a stale un-emailed session without sending (item 4c)', async () => {
    // A session ended 3 days ago that still has email_sent_at null — a data
    // artifact. It must be stamped processed, NOT emailed.
    staleRetireRows = [{ id: 's-old' }]
    const res = await GET(req())
    expect(res.status).toBe(200)
    // Never handed to the sender...
    const emailedIds = sendPostClassEmail.mock.calls.map((c) => c[1])
    expect(emailedIds).not.toContain('s-old')
    // ...but an update stamping email_sent_at was issued for it.
    const retireUpdate = builders.find(
      (b) => b.table === 'heart_rate_sessions' &&
        b.calls.some((c) => c.method === 'update') &&
        b.calls.some((c) => c.method === 'eq' && c.args[0] === 'id' && c.args[1] === 's-old')
    )
    expect(retireUpdate, 'no retire UPDATE for the stale row').toBeTruthy()
  })

  it('401s without the CRON_SECRET bearer', async () => {
    const res = await GET({ headers: { get: () => 'Bearer wrong' } })
    expect(res.status).toBe(401)
  })

  it('DEFERS closing a silent class-linked session whose class is still running', async () => {
    const now = Date.now()
    // A silent, class-linked candidate: last sample ~10 min ago (past the 5-min
    // stale cutoff), class started 25 min ago, mapped to event 'e8'.
    silentRows = [
      {
        id: 's-class',
        last_sample_at: new Date(now - 10 * 60 * 1000).toISOString(),
        started_at: new Date(now - 25 * 60 * 1000).toISOString(),
        glofox_event_id: 'e8',
      },
    ]
    // Its class has NOT yet ended (ends in 30 min) → session is rejoinable, so
    // the cron must defer the close.
    occRows = [{ glofox_event_id: 'e8', ends_at: new Date(now + 30 * 60 * 1000).toISOString() }]

    const res = await GET(req())
    expect(res.status).toBe(200)

    const endedIds = endSession.mock.calls.map((c) => c[1]) // endSession(db, sessionId, …)
    expect(endedIds).not.toContain('s-class') // class still running → not closed
  })

  it('pushes for a real session but NOT for a too-little-data junk skip', async () => {
    // Two contact-bearing rows hit the sweep this tick.
    sweepRows = [
      { id: 's-real', contact_id: 'c1', effort_points: 30, class_name: 'RIDE' },
      { id: 's-junk', contact_id: 'c2', effort_points: 0, class_name: 'TEMPO - STRENGTH' },
    ]
    sendPostClassEmail
      .mockResolvedValueOnce({ ok: true, sent: true })                  // s-real → emailed
      .mockResolvedValueOnce({ ok: true, skipped: 'too-little-data' })  // s-junk → no real report

    const res = await GET(req())
    expect(res.status).toBe(200)

    const pushedIds = sendCustomerPush.mock.calls.map((c) => c[2].data.session_id)
    expect(pushedIds).toContain('s-real')      // real session → push
    expect(pushedIds).not.toContain('s-junk')  // junk session → no push (the spam fix)
  })
})
