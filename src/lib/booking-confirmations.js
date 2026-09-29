// Booking confirmation send (mig 077).
//
// Fires once at booking creation time, not on a cron. Same
// channel gates as the reminder runner (email_administrative
// opt-out, no-email) and the same merge-tag set. Channels: email
// and WhatsApp (EVENTCONFIRM-WA.1, mig 666 — an approved template
// chosen per event type). The SMS channel was retired with Twilio
// (TWILIO-RETIRE.1), so a legacy 'sms' entry is skipped.
//
// Best-effort: a Postmark / Meta hiccup never breaks the
// customer's "Booking confirmed!" response. Errors land in the
// server logs and the customer sees the on-page confirmation;
// the operator can re-send manually or rely on the reminder
// runner if they spot the gap.
//
// Activity timeline rows go on the contact (kind='event' to
// match mig 074 semantics — these are things that happened,
// not tasks).

import { sendTransactionalEmail, applyMergeTags } from './postmark'
import { logTransactionalWalletState } from './wallet-enforcement'
import { logWarn } from './log'
import { transactionalEmailSuppression, transactionalWhatsappSuppression } from '@/lib/transactional-consent'
import { maybeSendBookingWhatsappConfirm } from '@/lib/automations/booking-whatsapp-confirm'

// BOOKING.2 — booking_date (YYYY-MM-DD) and start_time (HH:MM:SS) are
// stored as Dublin-local wall-clock values without timezone semantics.
// The old implementation did `new Date(\`${dateStr}T${timeStr}Z\`)` —
// the trailing `Z` parsed the time as UTC, then
// formatWeekdayShortDateTimeInTZ rendered it in Europe/Dublin which
// in BST (May→Oct) is UTC+1 — adding an hour. 17:00 booking → message
// said 18:00. Don't go through Date at all for the clock time;
// derive only the weekday/date label from a Date and append the
// stored time string verbatim.
//
// Exported so the cancellation email (bookings/[id]/cancel) and the
// reminder runner (event-reminders) render Dublin wall-clock the same
// way instead of each re-deriving the (previously buggy) Date-Z parse.
export function fmtBookingTime(dateStr, timeStr) {
  if (!dateStr) return ''
  const timePart = String(timeStr || '').slice(0, 5)  // "17:00"
  // Use noon UTC on the booking date to derive the weekday label —
  // any same-day UTC instant is fine here since we're only rendering
  // the weekday + day + month in Europe/Dublin (no time involved).
  try {
    const dayLabel = new Intl.DateTimeFormat('en-IE', {
      timeZone: 'Europe/Dublin',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(new Date(`${dateStr}T12:00:00Z`))
    return timePart ? `${dayLabel}, ${timePart}` : dayLabel
  } catch {
    return `${dateStr} ${timePart}`
  }
}

function applyMergeTagsWithExtras(html, contact, extras) {
  let out = applyMergeTags(html, contact, {
    location_name: extras.location_name || '',
  })
  out = out.replaceAll('{{event_name}}', extras.event_name || '')
  out = out.replaceAll('{{event_time}}', extras.event_time || '')
  return out
}

/**
 * Send the booking-confirmation message(s) for a booking.
 * Returns { sent: string[], skipped: string[], failed: string[] }
 * — useful for the booking response so the operator (or the
 * UI in the future) can show "we emailed you a confirmation"
 * vs "couldn't email you, here's a screenshot of the booking".
 *
 * @param {SupabaseClient} db   service-role client
 * @param {string} bookingId
 */
export async function sendBookingConfirmation(db, bookingId) {
  const result = { sent: [], skipped: [], failed: [] }

  // Pull the booking + the event_type's confirmation config + the
  // contact's preferences in one round-trip.
  const { data: booking, error } = await db
    .from('bookings')
    .select(`
      id, contact_id, customer_name, customer_email, customer_phone,
      booking_date, start_time,
      event_types (
        id, name, location_id,
        confirmation_enabled, confirmation_channels,
        confirmation_email_template_id, confirmation_email_subject,
        confirmation_whatsapp_template_id
      ),
      contacts (
        id, first_name, last_name, name, email, phone, wa_phone,
        email_status, wa_status,
        contact_preferences ( email_administrative, whatsapp_administrative )
      )
    `)
    .eq('id', bookingId)
    .single()

  if (error || !booking) {
    result.failed.push(`load:${error?.message || 'booking_not_found'}`)
    return result
  }

  const ev = booking.event_types
  if (!ev?.confirmation_enabled) {
    result.skipped.push('confirmation_disabled')
    return result
  }
  const channels = Array.isArray(ev.confirmation_channels) ? ev.confirmation_channels : []
  if (channels.length === 0) {
    result.skipped.push('no_channels_configured')
    return result
  }

  const ctx = {
    eventName: ev.name,
    locationId: ev.location_id,
    emailTemplateId: ev.confirmation_email_template_id,
    emailSubject: ev.confirmation_email_subject,
    whatsappTemplateId: ev.confirmation_whatsapp_template_id,
  }

  // INTEG-C3 — transactional sends are NEVER blocked by billing: this
  // only logs (loudly at/below the −€10 grace floor) so ops can see a
  // tier-pinned location confirming bookings on credit. Fire-and-forget
  // — the helper swallows everything and the promise never rejects.
  logTransactionalWalletState(db, ev.location_id, 'email_send')

  for (const channel of channels) {
    try {
      let outcome
      if (channel === 'email') outcome = await sendEmailConfirmation(db, booking, ctx)
      else if (channel === 'whatsapp') outcome = await sendWhatsappConfirmation(db, booking, ctx)
      else outcome = { status: 'skipped', reason: `unsupported_channel:${channel}` }

      if (outcome.status === 'sent') result.sent.push(channel)
      else if (outcome.status === 'skipped') result.skipped.push(`${channel}:${outcome.reason}`)
    } catch (e) {
      logWarn('booking-confirmation', `${channel} failed`, { bookingId, err: e })
      result.failed.push(`${channel}:${e.message}`)
    }
  }

  return result
}

async function sendEmailConfirmation(db, booking, ctx) {
  if (!ctx.emailTemplateId) {
    throw new Error('Confirmation channel=email but no template configured on the event type')
  }

  const c = booking.contacts
  // LOCCOMMS.5 — 'unsubscribed' is deliberately NOT a suppressor here. This is
  // a TRANSACTIONAL send: someone who booked a class must get the confirmation
  // regardless of whether they left a marketing list. The email_administrative
  // flag is the correct control.
  //
  // EVENT-CONSENT.1 moved the rule into transactional-consent.js — this path
  // was one of three copies, and a fourth sender (race-confirmations) had no
  // copy at all. Behaviour here is unchanged, byte for byte in its reasons.
  const suppression = transactionalEmailSuppression(c)
  if (suppression) return { status: 'skipped', reason: suppression }

  const { data: tpl } = await db
    .from('email_templates')
    .select('subject, html_content')
    .eq('id', ctx.emailTemplateId)
    .single()
  if (!tpl) throw new Error('Email template not found')

  const to = booking.contacts?.email || booking.customer_email
  if (!to) return { status: 'skipped', reason: 'no_email_address' }

  const mergeContact = booking.contacts || {
    name: booking.customer_name,
    first_name: booking.customer_name?.split(' ')[0],
    email: booking.customer_email,
    phone: booking.customer_phone,
  }

  const extras = {
    event_name: ctx.eventName,
    event_time: fmtBookingTime(booking.booking_date, booking.start_time),
  }

  const rawSubject =
    (tpl.subject?.trim() || ctx.emailSubject?.trim() || `Booking confirmed: ${ctx.eventName}`)
  const subject = applyMergeTagsWithExtras(rawSubject, mergeContact, extras)
  const htmlBody = applyMergeTagsWithExtras(tpl.html_content || '', mergeContact, extras)

  await sendTransactionalEmail({
    to,
    subject,
    htmlBody,
    contactId: booking.contact_id || null,
    locationId: ctx.locationId,
    tag: 'booking-confirmation',
  })
  return { status: 'sent' }
}

// EVENTCONFIRM-WA.1 — the WhatsApp leg. A booking arrives from a web form,
// so there is no 24h window: it has to be an APPROVED template (UTILITY, since
// Meta refuses MARKETING on transactional paths). The operator picks it per
// event type; its body variables fill positionally — {{1}} first name,
// {{2}} day + time, {{3}} event name — and a template with fewer variables
// just takes the first N. The send itself (feature gate, phone
// normalisation, APPROVED check, wa_phone backfill, inbox log) is the /start
// funnel's helper, so the two paths cannot drift.
async function sendWhatsappConfirmation(db, booking, ctx) {
  if (!ctx.whatsappTemplateId) return { status: 'skipped', reason: 'no_template_configured' }

  const c = booking.contacts
  if (!c?.id) return { status: 'skipped', reason: 'no_contact' }
  const suppression = transactionalWhatsappSuppression(c)
  if (suppression) return { status: 'skipped', reason: suppression }

  const { data: tpl, error: tplErr } = await db
    .from('whatsapp_templates')
    .select('name, status, components')
    .eq('id', ctx.whatsappTemplateId)
    .eq('location_id', ctx.locationId)
    .maybeSingle()
  if (tplErr) throw new Error(`template read failed: ${tplErr.message}`)
  if (!tpl) return { status: 'skipped', reason: 'template_not_found' }

  const body = (tpl.components || []).find((x) => x?.type === 'BODY')
  const varCount = new Set(String(body?.text || '').match(/\{\{\d+\}\}/g) || []).size
  const firstName = c.first_name || (c.name ? c.name.split(' ')[0] : '') || booking.customer_name?.split(' ')[0] || 'there'
  const params = [firstName, fmtBookingTime(booking.booking_date, booking.start_time), ctx.eventName || '']
    .slice(0, varCount)

  const res = await maybeSendBookingWhatsappConfirm({
    db,
    locationId: ctx.locationId,
    contact: { id: c.id, first_name: c.first_name, name: c.name, phone: c.wa_phone || c.phone || booking.customer_phone, wa_phone: c.wa_phone },
    templateName: tpl.name,
    bodyParams: params,
  })
  if (res.sent) return { status: 'sent' }
  // The helper swallows its own send errors and reports them as a reason; a
  // failed SEND is a failure, every other reason is a skip (nothing to send).
  if (res.reason === 'send_failed') throw new Error('WhatsApp send failed')
  return { status: 'skipped', reason: res.reason }
}
