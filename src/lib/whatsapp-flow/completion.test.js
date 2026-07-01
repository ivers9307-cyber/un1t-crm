import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/marketing-consent.js', () => ({ applyFormMarketingConsent: vi.fn(async () => ({})) }))
vi.mock('@/lib/bookings-write.js', () => ({ createEventBooking: vi.fn(async () => ({ bookingId: 'bk1' })) }))

import { handleFlowCompletion } from './completion.js'
import { applyFormMarketingConsent } from '@/lib/marketing-consent.js'
import { createEventBooking } from '@/lib/bookings-write.js'

function fakeDb(inserts) {
  return { from: (t) => ({ insert: (row) => { (inserts[t] ||= []).push(row); return { error: null } } }) }
}

describe('handleFlowCompletion', () => {
  // Stored contact name/email deliberately differ from what the member types in the Flow.
  const contact = { id: 'ct1', name: 'Old Name', email: 'old@x.ie', phone: '+353871234567' }

  it('class path → queues a class_booking_requests row (Flow name wins) + records consent', async () => {
    const inserts = {}
    const interactive = { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify({
      path: 'class', slot: 'c1|2026-07-03T18:00:00Z|HIIT', name: 'Ann', email: 'ann@x.ie', marketing_opt_in: true }) } }

    const res = await handleFlowCompletion(fakeDb(inserts), { interactive, contact, locationId: 'loc1' })

    expect(res).toEqual({ handled: true, kind: 'class' })
    expect(inserts.class_booking_requests[0]).toMatchObject({
      contact_id: 'ct1', location_id: 'loc1', glofox_event_id: 'c1', class_name: 'HIIT',
      starts_at: '2026-07-03T18:00:00Z', status: 'queued',
      customer_name: 'Ann', customer_email: 'ann@x.ie', customer_phone: '+353871234567',
    })
    expect(applyFormMarketingConsent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contactId: 'ct1', consent: true, source: 'whatsapp_flow' }))
  })

  it('consult path → creates a booking via createEventBooking', async () => {
    const inserts = {}
    const interactive = { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify({
      path: 'consult', slot: 'ev1|2026-07-03|18:00|18:30', name: 'Ann', email: 'ann@x.ie', marketing_opt_in: false }) } }

    const res = await handleFlowCompletion(fakeDb(inserts), { interactive, contact, locationId: 'loc1' })

    expect(res).toEqual({ handled: true, kind: 'consult' })
    expect(createEventBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: { id: 'ev1', location_id: 'loc1' }, date: '2026-07-03', startTime: '18:00', endTime: '18:30', source: 'whatsapp_flow',
    }))
    // marketing_opt_in false → consent NOT recorded on this call
  })

  it('ignores a non-Flow interactive', async () => {
    const inserts = {}
    const res = await handleFlowCompletion(fakeDb(inserts), { interactive: { type: 'button_reply' }, contact, locationId: 'loc1' })
    expect(res).toEqual({ handled: false })
    expect(inserts.class_booking_requests).toBeUndefined()
  })
})
