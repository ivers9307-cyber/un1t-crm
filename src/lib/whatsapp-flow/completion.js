// Turns a completed Flow (nfm_reply) into a booking. The chosen slot id encodes
// everything the booking needs (set by handler.js):
//   class:   `${glofox_event_id}|${starts_at}|${class_name}`
//   consult: `${event_id}|${date}|${start}|${end}`
// Class → class_booking_requests (the process-class-bookings cron finishes it).
// Consult → a confirmed `bookings` row via the shared createEventBooking.
import { parseFlowCompletion } from './handler.js'
import { applyFormMarketingConsent } from '@/lib/marketing-consent.js'
import { createEventBooking } from '@/lib/bookings-write.js'
import { publishQueuePush, CLASS_BOOKINGS_WORKER_PATH } from '@/lib/qstash.js'
import { sendCtwaConversion } from '@/lib/meta-capi'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'
import { readUn1tLegalDocs } from '@/lib/un1t-online-legal'
import { logWarn } from '@/lib/log'

// UN1TWRITE.19 — a tick on the Flow's terms OptIn, at a un1t.online studio
// with the funnel on, is recorded on the queue row: time, source and the
// documents' version (null when unread). Anything else records nothing; an
// unreadable settings row records nothing too (the processor then refuses to
// create an account without an acceptance, and an existing account books).
async function flowTermsRecord(db, locationId, accepted) {
  if (!accepted) return {}
  try {
    const s = await readUn1tWriteSettings(db, locationId)
    if (s.membershipSource !== 'un1t_online' || !s.settings.funnelEnabled) return {}
  } catch (e) {
    logWarn('whatsapp-flow', 'un1t.online settings unreadable; terms tick not recorded', { locationId, err: e })
    return {}
  }
  let version = null
  try { version = (await readUn1tLegalDocs(db, locationId)).version } catch { /* the tick still stands */ }
  return { terms_accepted_at: new Date().toISOString(), terms_source: 'whatsapp_flow', terms_version: version }
}

export async function handleFlowCompletion(db, { interactive, contact, locationId }) {
  const parsed = parseFlowCompletion(interactive)
  if (!parsed || !contact?.id) return { handled: false }
  const { path, selection, contactFields } = parsed

  if (contactFields.marketing_opt_in) {
    try { await applyFormMarketingConsent(db, { contactId: contact.id, consent: true, source: 'whatsapp_flow', locationId }) }
    catch (e) { console.warn('[wa-flow] consent record failed:', e.message) }
  }

  // Prefer the name/email the member just typed in the Flow over the stored contact.
  const person = { ...contact, name: contactFields.name || contact.name, email: contactFields.email || contact.email }

  if (path === 'class') {
    const [glofoxEventId, startsAt, ...nameParts] = String(selection.slot || '').split('|')
    const className = nameParts.join('|')
    const termsRecord = await flowTermsRecord(db, locationId, contactFields.terms_accepted)
    const { data: queuedRow, error } = await db.from('class_booking_requests').insert({
      ...termsRecord,
      location_id: locationId, contact_id: contact.id,
      glofox_event_id: glofoxEventId, class_name: className, starts_at: startsAt,
      customer_name: person.name, customer_email: person.email, customer_phone: person.phone,
      status: 'queued',
    }).select('id').maybeSingle()
    // 23505 = a concurrent request already queued this (contact, class) — a successful dedupe.
    if (error && error.code !== '23505') { console.error('[wa-flow] class enqueue failed:', error.message); return { handled: false } }
    // QSTASH.7 — push delivery. Fire-and-forget: env-gated (no QSTASH_TOKEN →
    // skipped), any failure leaves the row for the process-class-bookings cron
    // — the queue table is the delivery guarantee. Dedup id is DASH-ONLY
    // (QStash 400s on colons). The 23505 dedupe path has no id → no publish;
    // the original submit's publish / the cron covers that row.
    if (queuedRow?.id) {
      try {
        await publishQueuePush({
          path: CLASS_BOOKINGS_WORKER_PATH,
          body: { id: queuedRow.id },
          deduplicationId: `class-booking-${queuedRow.id}`,
        })
      } catch {
        // publishQueuePush swallows its own errors; belt-and-braces only.
      }
    }
    return { handled: true, kind: 'class' }
  }

  const [eventId, date, startTime, endTime] = String(selection.slot || '').split('|')
  const res = await createEventBooking(db, {
    event: { id: eventId, location_id: locationId }, date, startTime, endTime, contact: person, source: 'whatsapp_flow',
  })
  if (res.error) { console.error('[wa-flow] consult booking failed:', res.error.message); return { handled: false } }
  // CTWA attribution: consult booked in-chat is a conversion too (no-ops
  // without a stored ctwa_clid + configured dataset).
  try {
    await sendCtwaConversion(db, { locationId, contactId: contact.id, eventName: 'Schedule', contentName: 'Consultation' })
  } catch (e) { console.warn('[wa-flow] ctwa conversion failed:', e?.message) }
  // FLOWACK.1 — the slot (studio wall clock), for the webhook's one confirmation.
  return { handled: true, kind: 'consult', date, startTime }
}
