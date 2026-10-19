import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/marketing-consent.js', () => ({ applyFormMarketingConsent: vi.fn(async () => ({})) }))
vi.mock('@/lib/bookings-write.js', () => ({ createEventBooking: vi.fn(async () => ({ bookingId: 'bk1' })) }))
vi.mock('@/lib/qstash.js', () => ({
  publishQueuePush: vi.fn(async () => ({ ok: true, messageId: 'm1' })),
  CLASS_BOOKINGS_WORKER_PATH: '/api/webhooks/qstash/class-bookings',
}))

import { handleFlowCompletion, publishFlowClassBooking } from './completion.js'
import { applyFormMarketingConsent } from '@/lib/marketing-consent.js'
import { createEventBooking } from '@/lib/bookings-write.js'
import { publishQueuePush, CLASS_BOOKINGS_WORKER_PATH } from '@/lib/qstash.js'

function fakeDb(inserts, { insertResult = { data: { id: 'cbr1' }, error: null }, existing = { data: null, error: null }, reads = [] } = {}) {
  return {
    from: (t) => {
      // FLOWACK.1 review — the 23505 path reads the row that already holds the class.
      const read = { ops: [] }
      const b = {
        insert: (row) => {
          ;(inserts[t] ||= []).push(row)
          return { select: () => ({ maybeSingle: async () => insertResult }) }
        },
        select: (cols) => { read.ops.push(['select', cols]); return b },
        eq: (c, v) => { read.ops.push(['eq', c, v]); return b },
        in: (c, v) => { read.ops.push(['in', c, v]); return b },
        order: () => b,
        limit: () => b,
        maybeSingle: async () => { reads.push({ table: t, ops: read.ops }); return existing },
      }
      return b
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('handleFlowCompletion', () => {
  // Stored contact name/email deliberately differ from what the member types in the Flow.
  const contact = { id: 'ct1', name: 'Old Name', email: 'old@x.ie', phone: '+353871234567' }

  it('class path → queues a class_booking_requests row (Flow name wins) + records consent', async () => {
    const inserts = {}
    const interactive = { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify({
      path: 'class', slot: 'c1|2026-07-03T18:00:00Z|HIIT', name: 'Ann', email: 'ann@x.ie', marketing_opt_in: true }) } }

    const res = await handleFlowCompletion(fakeDb(inserts), { interactive, contact, locationId: 'loc1' })

    expect(res).toEqual({ handled: true, kind: 'class', requestId: 'cbr1' })
    expect(inserts.class_booking_requests[0]).toMatchObject({
      contact_id: 'ct1', location_id: 'loc1', glofox_event_id: 'c1', class_name: 'HIIT',
      starts_at: '2026-07-03T18:00:00Z', status: 'queued',
      customer_name: 'Ann', customer_email: 'ann@x.ie', customer_phone: '+353871234567',
    })
    expect(applyFormMarketingConsent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contactId: 'ct1', consent: true, source: 'whatsapp_flow' }))
  })

  // FLOWACK.1 review — the push is NOT sent from here any more: the webhook
  // publishes it after the acknowledgement, so a fast outcome ("the team is
  // confirming") can never reach the customer before "we're booking your spot".
  it('class path → no QStash push from the completion itself (the webhook publishes after the ack)', async () => {
    const interactive = { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify({
      path: 'class', slot: 'c1|2026-07-03T18:00:00Z|HIIT', name: 'Ann', email: 'ann@x.ie', marketing_opt_in: false }) } }
    await handleFlowCompletion(fakeDb({}), { interactive, contact, locationId: 'loc1' })
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('publishFlowClassBooking → fire-and-forget QStash push for the queued row (dash-only dedup id)', async () => {
    await publishFlowClassBooking('cbr1')

    expect(publishQueuePush).toHaveBeenCalledWith({
      path: CLASS_BOOKINGS_WORKER_PATH,
      body: { id: 'cbr1' },
      deduplicationId: 'class-booking-cbr1',
    })
  })

  // FLOWACK.1 review — a duplicate submission names itself and the row that
  // already holds the class, so the webhook answers it honestly.
  it('23505 dedupe → handled as a duplicate, with the existing row\'s status, and no id to publish', async () => {
    const reads = []
    const interactive = { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify({
      path: 'class', slot: 'c1|2026-07-03T18:00:00Z|HIIT', name: 'Ann', email: 'ann@x.ie', marketing_opt_in: false }) } }

    const res = await handleFlowCompletion(
      fakeDb({}, {
        insertResult: { data: null, error: { code: '23505', message: 'dup' } },
        existing: { data: { status: 'booked', class_name: 'HIIT', starts_at: '2026-07-03T18:00:00Z' }, error: null },
        reads,
      }),
      { interactive, contact, locationId: 'loc1' },
    )

    expect(res).toEqual({ handled: true, kind: 'class', duplicate: true, existingStatus: 'booked', className: 'HIIT', startsAt: '2026-07-03T18:00:00Z' })
    expect(reads[0].ops).toEqual(expect.arrayContaining([
      ['eq', 'contact_id', 'ct1'], ['eq', 'glofox_event_id', 'c1'], ['in', 'status', ['queued', 'processing', 'booked']],
    ]))
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('23505 dedupe with an unreadable existing row → still a duplicate, status unknown', async () => {
    const interactive = { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify({
      path: 'class', slot: 'c1|2026-07-03T18:00:00Z|HIIT', name: 'Ann', email: 'ann@x.ie', marketing_opt_in: false }) } }
    const res = await handleFlowCompletion(
      fakeDb({}, { insertResult: { data: null, error: { code: '23505', message: 'dup' } }, existing: { data: null, error: { message: 'boom' } } }),
      { interactive, contact, locationId: 'loc1' },
    )
    expect(res).toEqual({ handled: true, kind: 'class', duplicate: true, existingStatus: null, className: 'HIIT', startsAt: '2026-07-03T18:00:00Z' })
  })

  it('a publish rejection never throws (belt-and-braces)', async () => {
    publishQueuePush.mockRejectedValueOnce(new Error('qstash down'))
    await expect(publishFlowClassBooking('cbr1')).resolves.toBeUndefined()
    await expect(publishFlowClassBooking(null)).resolves.toBeUndefined()
  })

  it('consult path → creates a booking via createEventBooking', async () => {
    const inserts = {}
    const interactive = { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify({
      path: 'consult', slot: 'ev1|2026-07-03|18:00|18:30', name: 'Ann', email: 'ann@x.ie', marketing_opt_in: false }) } }

    const res = await handleFlowCompletion(fakeDb(inserts), { interactive, contact, locationId: 'loc1' })

    // FLOWACK.1 — the slot rides back for the webhook's confirmation.
    expect(res).toEqual({ handled: true, kind: 'consult', date: '2026-07-03', startTime: '18:00' })
    expect(createEventBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: { id: 'ev1', location_id: 'loc1' }, date: '2026-07-03', startTime: '18:00', endTime: '18:30', source: 'whatsapp_flow',
    }))
    // marketing_opt_in false → consent NOT recorded on this call
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('ignores a non-Flow interactive', async () => {
    const inserts = {}
    const res = await handleFlowCompletion(fakeDb(inserts), { interactive: { type: 'button_reply' }, contact, locationId: 'loc1' })
    expect(res).toEqual({ handled: false })
    expect(inserts.class_booking_requests).toBeUndefined()
    expect(publishQueuePush).not.toHaveBeenCalled()
  })
})
