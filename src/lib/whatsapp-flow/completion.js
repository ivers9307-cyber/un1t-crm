// Turns a completed Flow (nfm_reply) into a booking. The chosen slot id encodes
// everything the booking needs (set by handler.js):
//   class:   `${glofox_event_id}|${starts_at}|${class_name}`
//   consult: `${event_id}|${date}|${start}|${end}`
// Class → class_booking_requests (the process-class-bookings cron finishes it).
// Consult → a confirmed `bookings` row via the shared createEventBooking.
import { parseFlowCompletion } from './handler.js'
import { applyFormMarketingConsent } from '@/lib/marketing-consent.js'
import { createEventBooking } from '@/lib/bookings-write.js'

export async function handleFlowCompletion(db, { interactive, contact, locationId }) {
  const parsed = parseFlowCompletion(interactive)
  if (!parsed || !contact?.id) return { handled: false }
  const { path, selection, contactFields } = parsed

  if (contactFields.marketing_opt_in) {
    try { await applyFormMarketingConsent(db, { contactId: contact.id, consent: true, source: 'whatsapp_flow' }) }
    catch (e) { console.warn('[wa-flow] consent record failed:', e.message) }
  }

  if (path === 'class') {
    const [glofoxEventId, startsAt, ...nameParts] = String(selection.slot || '').split('|')
    const className = nameParts.join('|')
    const { error } = await db.from('class_booking_requests').insert({
      location_id: locationId, contact_id: contact.id,
      glofox_event_id: glofoxEventId, class_name: className, starts_at: startsAt,
      customer_name: contact.name, customer_email: contact.email, customer_phone: contact.phone,
      status: 'queued',
    })
    // 23505 = a concurrent request already queued this (contact, class) — a successful dedupe.
    if (error && error.code !== '23505') { console.error('[wa-flow] class enqueue failed:', error.message); return { handled: false } }
    return { handled: true, kind: 'class' }
  }

  const [eventId, date, startTime, endTime] = String(selection.slot || '').split('|')
  const res = await createEventBooking(db, {
    event: { id: eventId, location_id: locationId }, date, startTime, endTime, contact, source: 'whatsapp_flow',
  })
  if (res.error) { console.error('[wa-flow] consult booking failed:', res.error.message); return { handled: false } }
  return { handled: true, kind: 'consult' }
}
