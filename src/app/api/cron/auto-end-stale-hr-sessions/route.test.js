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

function makeBuilder() {
  // A thenable query-builder: every method records its name+args and returns
  // `this`; awaiting resolves the Phase-2 sweep rows (when this is the sweep
  // query) or an empty result so the route's other loops no-op.
  const calls = []
  const builder = {
    calls,
    then(resolve) {
      const isSweep = calls.some((c) => c.method === 'is' && c.args[0] === 'email_sent_at')
      return Promise.resolve({ data: isSweep ? sweepRows : [], error: null }).then(resolve)
    },
  }
  for (const method of ['select', 'eq', 'is', 'not', 'lt', 'order', 'limit', 'neq', 'gte']) {
    builder[method] = vi.fn((...args) => { calls.push({ method, args }); return builder })
  }
  return builder
}

const fakeDb = {
  from: vi.fn((table) => {
    const b = makeBuilder()
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

function req() {
  return { headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } }
}

beforeEach(() => {
  builders = []
  sweepRows = []
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'test-secret'
})

describe('auto-end-stale-hr-sessions — Phase 2 email-sweep query', () => {
  it("excludes BOTH participation and apple_health via .not('source','in', …)", async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)

    // The Phase-2 sweep is the heart_rate_sessions query that filters on
    // email_sent_at (Phase-1 queries filter on last_sample_at / started_at).
    const phase2 = builders.find(
      (b) => b.table === 'heart_rate_sessions' &&
        b.calls.some((c) => c.method === 'is' && c.args[0] === 'email_sent_at')
    )
    expect(phase2, 'Phase-2 email sweep query not found').toBeTruthy()

    const sourceNot = phase2.calls.find((c) => c.method === 'not' && c.args[0] === 'source')
    expect(sourceNot, "no .not('source', …) exclusion on the sweep").toBeTruthy()
    expect(sourceNot.args[1]).toBe('in')
    // PostgREST "not in" list — both sources must be present.
    expect(sourceNot.args[2]).toContain('participation')
    expect(sourceNot.args[2]).toContain('apple_health')
  })

  it('401s without the CRON_SECRET bearer', async () => {
    const res = await GET({ headers: { get: () => 'Bearer wrong' } })
    expect(res.status).toBe(401)
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
