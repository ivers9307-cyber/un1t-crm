// REGISTRYREAD.1a — a booking that exhausts its retries must reach a human.
//
// Two dead ends used to leave a class_booking_requests row in a bare
// 'needs_review' with no approvals card, which no screen shows:
//   • the queue's throw path at MAX_ATTEMPTS (class-booking-queue.js), and
//   • the cron reaper's past-the-cap flip of rows stuck in 'processing'.
// Both now run the REAL routeToReview here (only the decision tree is
// stubbed), against a small in-memory table pair, so what is pinned is the
// end state: exactly one card, a row that already names a pending card keeps
// it, and a card that cannot be filed still leaves a visible 'failed' row.
//
// Synthetic data only.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./class-booking-processor.js', async (importOriginal) => ({
  ...(await importOriginal()),
  processClassBookingRequest: vi.fn(),
}))
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(), missingGlofoxCredentialsForLocation: vi.fn(() => []),
  createBooking: vi.fn(), interpretBookingResult: vi.fn(), fetchUserCredits: vi.fn(), fetchUserCreditsResult: vi.fn(),
  fetchUserBookingsResult: vi.fn(), GLOFOX_BOOKING_MODEL: 'event',
}))
vi.mock('@/lib/glofox-sync', () => ({ computeCreditsRemaining: vi.fn() }))
vi.mock('@/lib/glofox-push', () => ({ findOrCreateGlofoxMember: vi.fn() }))
vi.mock('@/lib/automations/booking-whatsapp-confirm', () => ({ maybeSendBookingWhatsappConfirm: vi.fn(), CLASS_CONFIRM_TEMPLATE: 'booking_class_confirmed_' }))
vi.mock('@/lib/meta-capi', () => ({ sendCtwaConversion: vi.fn(), sendWebsiteConversion: vi.fn() }))
vi.mock('@/lib/agent/approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => ({})) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
let store
vi.mock('@/lib/supabase', () => ({ createServerClient: () => store.db }))

import { claimAndProcessBookingJob } from './class-booking-queue.js'
import { processClassBookingRequest, CreditReadError } from './class-booking-processor.js'
import { notifyAgentApprovalRequest } from '@/lib/agent/approval-notify'
import { logError } from '@/lib/log'
import { GET } from '@/app/api/cron/process-class-bookings/route.js'
import { whyFlagged } from '@/lib/approvals/agent-request-why'

// ── in-memory class_booking_requests + agent_membership_requests ─────────────
// Filters are applied for real (eq / lt / gte / in / contains), so a guard
// that matches no row really matches no row.
function makeStore({ cbr = [], amr = [], insertFails = false, linkedLookupFails = false } = {}) {
  const tables = { class_booking_requests: cbr.map((r) => ({ ...r })), agent_membership_requests: amr.map((r) => ({ ...r })) }
  const inserts = []
  let seq = 0
  function from(table) {
    const q = { op: 'select', patch: null, cols: null, filters: [], limit: null }
    const run = async () => {
      if (table === 'agent_membership_requests' && q.op === 'insert') {
        if (insertFails) return { data: null, error: { message: 'insert failed' } }
        const row = { id: `amr-new-${++seq}`, ...q.patch }
        tables.agent_membership_requests.push(row)
        inserts.push(row)
        return { data: [row], error: null }
      }
      if (table === 'agent_membership_requests' && linkedLookupFails && q.cols === 'id, status') {
        return { data: null, error: { message: 'fetch failed' } }
      }
      let rows = (tables[table] || []).filter((r) => q.filters.every((f) => f(r)))
      if (q.op === 'update') rows.forEach((r) => Object.assign(r, q.patch))
      if (q.limit != null) rows = rows.slice(0, q.limit)
      return { data: rows.map((r) => ({ ...r })), error: null }
    }
    const b = {
      select(cols) { q.cols = cols; return b },
      update(patch) { q.op = 'update'; q.patch = patch; return b },
      insert(patch) { q.op = 'insert'; q.patch = patch; return b },
      eq(c, v) { q.filters.push((r) => r[c] === v); return b },
      lt(c, v) { q.filters.push((r) => r[c] < v); return b },
      gte(c, v) { q.filters.push((r) => r[c] >= v); return b },
      in(c, vs) { q.filters.push((r) => vs.includes(r[c])); return b },
      contains(c, obj) { q.filters.push((r) => Object.entries(obj).every(([k, v]) => r[c]?.[k] === v)); return b },
      order() { return b },
      limit(n) { q.limit = n; return b },
      maybeSingle: async () => {
        const { data, error } = await run()
        return error ? { data: null, error } : { data: data[0] ?? null, error: null }
      },
      then(resolve, reject) { return run().then(resolve, reject) },
    }
    return b
  }
  return { db: { from }, tables, inserts, cbr: (id) => tables.class_booking_requests.find((r) => r.id === id) }
}

const BASE = {
  id: 'cbr-1', location_id: 'loc-1', contact_id: 'ct-1', glofox_event_id: 'ev-1',
  class_name: 'Strength', starts_at: '2030-01-08T18:30:00.000Z', customer_name: 'Test Person',
  approval_request_id: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'test-secret'
})

describe('queue: retries exhausted on a THROW → staff card', () => {
  const atCap = { ...BASE, status: 'queued', attempts: 2 } // post-claim 3 = MAX_ATTEMPTS

  it('files exactly one card and links it; the approvers are pushed', async () => {
    store = makeStore({ cbr: [atCap] })
    processClassBookingRequest.mockRejectedValue(new Error('glofox_settings_unreadable'))

    const res = await claimAndProcessBookingJob(store.db, atCap)

    expect(res).toEqual({ status: 'failed', error: 'glofox_settings_unreadable', requeued: false })
    expect(store.inserts).toHaveLength(1)
    const card = store.inserts[0]
    expect(card).toMatchObject({ kind: 'class_booking', status: 'pending', contact_id: 'ct-1', location_id: 'loc-1' })
    expect(card.details).toMatchObject({ event_id: 'ev-1', reason: 'processing_error', source: 'start_funnel' })
    expect(store.cbr('cbr-1')).toMatchObject({ status: 'needs_review', approval_request_id: card.id, last_error: 'processing_error' })
    expect(notifyAgentApprovalRequest).toHaveBeenCalledTimes(1)
    // The card explains itself to staff in plain words.
    expect(whyFlagged({ kind: 'class_booking', details: card.details })).toMatch(/failed 3 times/)
  })

  // CBPCREDITREAD.1 — three failed credits reads end on a card that says the
  // balance is UNKNOWN. Never needs_credit_grant: approving that card buys a
  // trial membership, and never "no class credits left".
  it('a credits read that failed every attempt files credit_check_failed, with copy that says unknown', async () => {
    store = makeStore({ cbr: [atCap] })
    processClassBookingRequest.mockRejectedValue(new CreditReadError())

    const res = await claimAndProcessBookingJob(store.db, atCap)

    expect(res).toEqual({ status: 'failed', error: 'credit_check_failed', requeued: false })
    expect(store.inserts).toHaveLength(1)
    const card = store.inserts[0]
    expect(card.details).toMatchObject({ event_id: 'ev-1', reason: 'credit_check_failed', source: 'start_funnel' })
    expect(store.cbr('cbr-1')).toMatchObject({ status: 'needs_review', approval_request_id: card.id, last_error: 'credit_check_failed' })
    const why = whyFlagged({ kind: 'class_booking', details: card.details })
    expect(why).toMatch(/could not be read/i)
    expect(why).toMatch(/does not mean they have no credits/i)
    expect(why).not.toMatch(/no class credits left/i)
  })

  it('a plain throw still files processing_error (unchanged)', async () => {
    store = makeStore({ cbr: [atCap] })
    processClassBookingRequest.mockRejectedValue(new Error('glofox_settings_unreadable'))

    await claimAndProcessBookingJob(store.db, atCap)

    expect(store.inserts[0].details.reason).toBe('processing_error')
  })

  it('a row that already names a PENDING card keeps it: no second card', async () => {
    const carded = { ...atCap, approval_request_id: 'amr-old' }
    store = makeStore({
      cbr: [carded],
      // Filed against a sibling contact, so the (contact, event) lookup alone would miss it.
      amr: [{ id: 'amr-old', contact_id: 'ct-sibling', kind: 'class_booking', status: 'pending', details: { event_id: 'ev-1' } }],
    })
    processClassBookingRequest.mockRejectedValue(new Error('boom'))

    await claimAndProcessBookingJob(store.db, carded)

    expect(store.inserts).toHaveLength(0)
    expect(store.cbr('cbr-1')).toMatchObject({ status: 'needs_review', approval_request_id: 'amr-old' })
  })

  it('a row naming a card staff already DECIDED gets a fresh card (never re-linked to a closed one)', async () => {
    const carded = { ...atCap, approval_request_id: 'amr-done' }
    store = makeStore({
      cbr: [carded],
      amr: [{ id: 'amr-done', contact_id: 'ct-1', kind: 'class_booking', status: 'rejected', details: { event_id: 'ev-1' } }],
    })
    processClassBookingRequest.mockRejectedValue(new Error('boom'))

    await claimAndProcessBookingJob(store.db, carded)

    expect(store.inserts).toHaveLength(1)
    expect(store.cbr('cbr-1')).toMatchObject({ status: 'needs_review', approval_request_id: store.inserts[0].id })
  })

  it('a row naming a card that cannot be read keeps it rather than risk a second card', async () => {
    const carded = { ...atCap, approval_request_id: 'amr-old' }
    store = makeStore({ cbr: [carded], linkedLookupFails: true })
    processClassBookingRequest.mockRejectedValue(new Error('boom'))

    await claimAndProcessBookingJob(store.db, carded)

    expect(store.inserts).toHaveLength(0)
    expect(store.cbr('cbr-1')).toMatchObject({ status: 'needs_review', approval_request_id: 'amr-old' })
  })

  it('a pending card for the same person and class is reused (no second card)', async () => {
    store = makeStore({
      cbr: [atCap],
      amr: [{ id: 'amr-open', contact_id: 'ct-1', kind: 'class_booking', status: 'pending', details: { event_id: 'ev-1' } }],
    })
    processClassBookingRequest.mockRejectedValue(new Error('boom'))

    await claimAndProcessBookingJob(store.db, atCap)

    expect(store.inserts).toHaveLength(0)
    expect(store.cbr('cbr-1')).toMatchObject({ status: 'needs_review', approval_request_id: 'amr-open' })
  })

  it('a card that cannot be filed still leaves a visible state: failed, review_unavailable, logged', async () => {
    store = makeStore({ cbr: [atCap], insertFails: true })
    processClassBookingRequest.mockRejectedValue(new Error('boom'))

    await claimAndProcessBookingJob(store.db, atCap)

    expect(store.cbr('cbr-1')).toMatchObject({ status: 'failed', last_error: 'review_unavailable:processing_error' })
    expect(logError).toHaveBeenCalledWith('class-booking-queue', 'retries exhausted and no staff card could be filed', expect.objectContaining({ requestId: 'cbr-1' }))
  })

  it('a row the processor already stamped terminal is never carded', async () => {
    store = makeStore({ cbr: [atCap] })
    processClassBookingRequest.mockImplementation(async (db) => {
      await db.from('class_booking_requests').update({ status: 'booked' }).eq('id', 'cbr-1')
      throw new Error('late throw')
    })

    await claimAndProcessBookingJob(store.db, atCap)

    expect(store.inserts).toHaveLength(0)
    expect(store.cbr('cbr-1').status).toBe('booked')
  })

  it('under the cap it re-queues and files no card', async () => {
    const early = { ...BASE, status: 'queued', attempts: 0 }
    store = makeStore({ cbr: [early] })
    processClassBookingRequest.mockRejectedValue(new Error('blip'))

    await claimAndProcessBookingJob(store.db, early)

    expect(store.inserts).toHaveLength(0)
    expect(store.cbr('cbr-1')).toMatchObject({ status: 'queued', last_error: 'blip' })
  })
})

describe('reaper: stuck in processing past the cap → staff card', () => {
  const OLD = '2020-01-01T00:00:00.000Z'
  const stuck = { ...BASE, status: 'processing', attempts: 3, updated_at: OLD }
  const req = { headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } }

  it('files exactly one card and links it', async () => {
    store = makeStore({ cbr: [stuck] })
    const body = await (await GET(req)).json()

    expect(store.inserts).toHaveLength(1)
    expect(store.inserts[0].details).toMatchObject({ reason: 'max_attempts_stuck_processing' })
    expect(store.cbr('cbr-1')).toMatchObject({ status: 'needs_review', approval_request_id: store.inserts[0].id })
    expect(body).toMatchObject({ success: true, reap_carded: 1, reap_failed: 0 })
    // A run that died mid-flight may already have booked it: staff are told to look first.
    expect(whyFlagged({ kind: 'class_booking', details: store.inserts[0].details })).toMatch(/Check Glofox/)
  })

  it('a stuck row that already names a pending card keeps it: no second card', async () => {
    store = makeStore({
      cbr: [{ ...stuck, approval_request_id: 'amr-old' }],
      amr: [{ id: 'amr-old', contact_id: 'ct-1', kind: 'class_booking', status: 'pending', details: { event_id: 'ev-1' } }],
    })
    await GET(req)

    expect(store.inserts).toHaveLength(0)
    expect(store.cbr('cbr-1')).toMatchObject({ status: 'needs_review', approval_request_id: 'amr-old' })
  })

  it('a card that cannot be filed still leaves a visible state: failed, review_unavailable, logged', async () => {
    store = makeStore({ cbr: [stuck], insertFails: true })
    const body = await (await GET(req)).json()

    expect(store.cbr('cbr-1')).toMatchObject({ status: 'failed', last_error: 'review_unavailable:max_attempts_stuck_processing' })
    expect(body).toMatchObject({ reap_carded: 0 })
    expect(logError).toHaveBeenCalledWith('process-class-bookings', 'stuck row flagged but no staff card could be filed', expect.objectContaining({ requestId: 'cbr-1' }))
  })

  it('a stuck row under the cap is re-queued, not carded', async () => {
    store = makeStore({ cbr: [{ ...stuck, attempts: 1 }] })
    await GET(req)
    // Re-queued, then claimed and processed on this same tick by the drain.
    expect(store.inserts.filter((c) => c.details.reason === 'max_attempts_stuck_processing')).toHaveLength(0)
  })
})
