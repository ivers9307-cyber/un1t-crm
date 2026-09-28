// WEBHOOKAUDIT.1 — every processed Glofox delivery leaves one attempt row, and
// the attempt write can never change what Glofox is told.
//
// The event row is keyed by Glofox's ENTITY id, so a booking's later events
// reuse it (the upsert answers status 'received' every time, which is why the
// dedup branch never fires). These tests pin that behaviour as UNCHANGED and
// add the attempt row beside it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  readGlofoxCredentialsByBranchId: vi.fn(),
  verifyGlofoxSignature: vi.fn(() => true),
  glofoxFetch: vi.fn(),
}))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/sequences/triggers', () => ({
  triggerSequencesForTagsAdded: vi.fn(),
  triggerSequencesForContactCreated: vi.fn(),
  triggerSequencesForMembershipStateChange: vi.fn(),
}))
vi.mock('@/lib/glofox-invoices', () => ({ applyInvoiceWebhook: vi.fn() }))
vi.mock('@/lib/glofox-services', () => ({ applyServiceWebhook: vi.fn() }))
vi.mock('@/lib/glofox-membership', () => ({ applyMembershipPauseWindow: vi.fn() }))
vi.mock('@/lib/dunning', () => ({ maybeEnrolDunning: vi.fn(), exitDunningForContact: vi.fn(), dunningActionFor: vi.fn() }))
vi.mock('@/lib/glofox-sync', () => ({ applyMemberSync: vi.fn() }))
vi.mock('@/lib/webhook-dead-letter', () => ({ deadLetterWebhook: vi.fn() }))
// The real module, with the row builder wrapped so a test can make it throw.
vi.mock('@/lib/glofox-webhook-attempts', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, buildGlofoxWebhookAttempt: vi.fn(actual.buildGlofoxWebhookAttempt) }
})

import { POST } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { readGlofoxCredentialsByBranchId, glofoxFetch } from '@/lib/glofox'
import { applyMemberSync } from '@/lib/glofox-sync'
import { deadLetterWebhook } from '@/lib/webhook-dead-letter'
import { logWarn } from '@/lib/log'
import { buildGlofoxWebhookAttempt } from '@/lib/glofox-webhook-attempts'

const { buildGlofoxWebhookAttempt: realBuildAttempt } = await vi.importActual('@/lib/glofox-webhook-attempts')

// Synthetic values only.
const PII_EMAIL = 'person@example.test'

/**
 * A chainable fake of the few PostgREST shapes this route uses. Writes are
 * recorded on `calls`; a chain resolves when awaited, per (table, op).
 */
function makeFakeDb(opts = {}) {
  const calls = []
  const answer = (q) => {
    if (q.table === 'glofox_webhook_events' && q.op === 'upsert') return { data: { id: 'row-1', status: 'received' }, error: null }
    if (q.table === 'glofox_webhook_events' && q.op === 'update') return { data: null, error: opts.eventUpdateError || null }
    if (q.table === 'glofox_webhook_attempts' && q.op === 'insert') {
      if (opts.attemptThrows) throw new Error('socket hang up')
      return { data: null, error: opts.attemptError || null }
    }
    if (q.table === 'contacts') {
      if (opts.contactsThrow) throw new Error('contacts read exploded')
      return { data: opts.contacts || [], error: null }
    }
    if (q.table === 'contact_tags' && q.op === 'select') return { data: [], error: null }
    return { data: null, error: null }
  }
  const from = (table) => {
    const q = { table, op: 'select', payload: null, filters: [] }
    const chain = {}
    for (const m of ['select', 'order', 'limit', 'single', 'maybeSingle']) chain[m] = () => chain
    chain.eq = (col, val) => { q.filters.push([col, val]); return chain }
    for (const op of ['insert', 'update', 'upsert', 'delete']) {
      chain[op] = (payload) => { q.op = op; q.payload = payload; calls.push(q); return chain }
    }
    chain.then = (resolve, reject) => {
      let out
      try { out = answer(q) } catch (e) { return Promise.reject(e).then(resolve, reject) }
      return Promise.resolve(out).then(resolve, reject)
    }
    return chain
  }
  return { from, calls }
}

const envelope = ({ type, entityId = 'entity-1', trace = 'trace-1', ts = '2026-09-28T09:00:00.000Z', userId } = {}) => ({
  Type: type,
  Metadata: { location_id: 'branch-1', trace_id: trace, version: 'v1' },
  Payload: { id: entityId, ...(userId ? { user_id: userId } : {}) },
  Timestamp: ts,
})

const deliver = (body) => POST(new Request('http://localhost/api/webhooks/glofox', {
  method: 'POST',
  headers: { 'content-type': 'application/json', signature: 'sig' },
  body: JSON.stringify(body),
}))

const writes = (db, table, op) => db.calls.filter(c => c.table === table && c.op === op)

const syncResult = () => ({
  action: 'update',
  existing: { email: PII_EMAIL, glofox_membership_status: 'credit_member', trial_credits_remaining: 4 },
  mapped: { email: PII_EMAIL, glofox_membership_status: 'member', trial_credits_remaining: null },
  changes: { glofox_membership_status: { from: 'credit_member', to: 'member' }, email: { from: 'old@example.test', to: PII_EMAIL } },
})

let db
beforeEach(() => {
  vi.clearAllMocks()
  readGlofoxCredentialsByBranchId.mockResolvedValue({ creds: { locationId: 'loc-1', webhookSecret: 'secret' }, error: null })
  glofoxFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { _id: 'member-1' } }) })
  applyMemberSync.mockResolvedValue(syncResult())
  buildGlofoxWebhookAttempt.mockImplementation(realBuildAttempt)
})

const useDb = (opts) => { db = makeFakeDb(opts); createServerClient.mockReturnValue(db); return db }

describe('POST /api/webhooks/glofox — one attempt row per processed delivery', () => {
  it('contact_not_found: marks the row as before AND writes one attempt for this emission', async () => {
    useDb({ contacts: [] })
    const res = await deliver(envelope({ type: 'EVENT_UPDATED' }))
    expect((await res.json()).status).toBe('contact_not_found')

    const [upd] = writes(db, 'glofox_webhook_events', 'update')
    expect(upd.payload).toMatchObject({ status: 'contact_not_found', result: null })
    expect(upd.filters).toEqual([['id', 'row-1']])

    const attempts = writes(db, 'glofox_webhook_attempts', 'insert')
    expect(attempts).toHaveLength(1)
    expect(attempts[0].payload).toMatchObject({
      event_row_id: 'row-1', location_id: 'loc-1', trace_id: 'trace-1', event_type: 'EVENT_UPDATED',
      emitted_at: '2026-09-28T09:00:00.000Z', status: 'contact_not_found', error_message: null, digest: null,
    })
    expect(Date.parse(attempts[0].payload.delivered_at)).not.toBeNaN()
    expect(attempts[0].payload.processed_at).toBe(upd.payload.processed_at)
  })

  it('applied: the attempt keeps the label flip and no personal data', async () => {
    useDb({ contacts: [{ id: 'contact-uuid-1', last_booked_at: '2026-09-01T10:00:00Z' }] })
    const res = await deliver(envelope({ type: 'BOOKING_UPDATED', userId: 'member-1' }))
    expect((await res.json()).status).toBe('applied')

    const [attempt] = writes(db, 'glofox_webhook_attempts', 'insert')
    expect(attempt.payload.status).toBe('applied')
    expect(attempt.payload.digest.contact_id).toBe('contact-uuid-1')
    expect(attempt.payload.digest.member_sync.tracked.glofox_membership_status).toEqual({ from: 'credit_member', to: 'member' })
    expect(JSON.stringify(attempt.payload)).not.toContain(PII_EMAIL)
    // The event row still stores the full result, exactly as before.
    const [upd] = writes(db, 'glofox_webhook_events', 'update')
    expect(upd.payload.result.member_sync).toEqual(syncResult())
  })

  it('a later event for the same booking is still processed (unchanged) and gets its OWN attempt', async () => {
    useDb({ contacts: [] })
    await deliver(envelope({ type: 'EVENT_CREATED', trace: 'trace-a', ts: '2026-09-28T09:00:00.000Z' }))
    await deliver(envelope({ type: 'EVENT_UPDATED', trace: 'trace-b', ts: '2026-09-28T17:00:00.000Z' }))
    expect(writes(db, 'glofox_webhook_events', 'upsert')).toHaveLength(2)
    expect(writes(db, 'glofox_webhook_events', 'update')).toHaveLength(2)
    const attempts = writes(db, 'glofox_webhook_attempts', 'insert').map(a => a.payload)
    expect(attempts.map(a => [a.event_row_id, a.trace_id, a.event_type, a.emitted_at])).toEqual([
      ['row-1', 'trace-a', 'EVENT_CREATED', '2026-09-28T09:00:00.000Z'],
      ['row-1', 'trace-b', 'EVENT_UPDATED', '2026-09-28T17:00:00.000Z'],
    ])
  })

  it('a refused attempt insert changes nothing Glofox sees, and is one warning', async () => {
    useDb({ contacts: [], attemptError: { code: '42P01', message: 'relation does not exist' } })
    const res = await deliver(envelope({ type: 'EVENT_UPDATED' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, status: 'contact_not_found', email: null, user_id: 'entity-1' })
    expect(writes(db, 'glofox_webhook_events', 'update')).toHaveLength(1)
    expect(logWarn).toHaveBeenCalledWith('glofox-webhook', 'attempt row insert failed', expect.objectContaining({ code: '42P01' }))
    expect(deadLetterWebhook).not.toHaveBeenCalled()
  })

  it('a thrown attempt insert changes nothing Glofox sees either', async () => {
    useDb({ contacts: [], attemptThrows: true })
    const res = await deliver(envelope({ type: 'EVENT_UPDATED' }))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('contact_not_found')
    expect(deadLetterWebhook).not.toHaveBeenCalled()
  })

  it("the event row update's error is logged now (it used to be discarded), and the attempt is still written", async () => {
    useDb({ contacts: [], eventUpdateError: { code: '57014', message: 'canceling statement due to statement timeout' } })
    const res = await deliver(envelope({ type: 'EVENT_UPDATED' }))
    expect((await res.json()).status).toBe('contact_not_found')
    expect(logWarn).toHaveBeenCalledWith('glofox-webhook', 'event row update failed', expect.objectContaining({ status: 'contact_not_found', code: '57014' }))
    expect(writes(db, 'glofox_webhook_attempts', 'insert')).toHaveLength(1)
  })

  it('a processing throw still dead-letters and 200s, and records a processing_failed attempt', async () => {
    useDb({ contactsThrow: true })
    const res = await deliver(envelope({ type: 'EVENT_UPDATED' }))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('processing_failed_dead_lettered')
    expect(deadLetterWebhook).toHaveBeenCalledTimes(1)
    const [attempt] = writes(db, 'glofox_webhook_attempts', 'insert')
    expect(attempt.payload).toMatchObject({ event_row_id: 'row-1', status: 'processing_failed', error_message: 'contacts read exploded', digest: null })
  })

  it('a row builder that throws (markEvent path) still 200s with the same answer, and is one warning', async () => {
    useDb({ contacts: [] })
    buildGlofoxWebhookAttempt.mockImplementation(() => { throw new Error('builder exploded') })
    const res = await deliver(envelope({ type: 'EVENT_UPDATED' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, status: 'contact_not_found', email: null, user_id: 'entity-1' })
    expect(writes(db, 'glofox_webhook_events', 'update')).toHaveLength(1)
    expect(writes(db, 'glofox_webhook_attempts', 'insert')).toHaveLength(0)
    expect(deadLetterWebhook).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('glofox-webhook', 'attempt row build threw', expect.objectContaining({ err: 'builder exploded' }))
  })

  it('a row builder that throws (processing-failed path) still dead-letters and 200s', async () => {
    useDb({ contactsThrow: true })
    buildGlofoxWebhookAttempt.mockImplementation(() => { throw new Error('builder exploded') })
    const res = await deliver(envelope({ type: 'EVENT_UPDATED' }))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('processing_failed_dead_lettered')
    expect(deadLetterWebhook).toHaveBeenCalledTimes(1)
    expect(writes(db, 'glofox_webhook_attempts', 'insert')).toHaveLength(0)
  })
})
