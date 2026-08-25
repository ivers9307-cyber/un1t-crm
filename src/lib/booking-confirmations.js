// Booking confirmation send (mig 077).
//
// Fires once at booking creation time, not on a cron. Same
// channel gates as the reminder runner (email_administrative /
// sms_administrative opt-out, sms_status, no-phone, no-email),
// same merge-tag set, same per-location alpha sender ID.
//
// Best-effort: a Postmark / Twilio hiccup never breaks the
// customer's "Booking confirmed!" response. Errors land in the
// server logs and the customer sees the on-page confirmation;
// the operator can re-send manually or rely on the reminder
// runner if they spot the gap.
//
// Activity timeline rows go on the contact (kind='event' to
// match mig 074 semantics — these are things that happened,
// not tasks).

import { sendTransactionalEmail, applyMergeTags } from './postmark'
import { sendLocationSms, TwilioError } from './twilio'
import { logTransactionalWalletState } from './wallet-enforcement'
import { logWarn } from './log'
import { overlayConnections } from '@/lib/connection-registry'
import { transactionalEmailSuppression, transactionalSmsSuppression } from '@/lib/transactional-consent'

// BOOKING.2 — booking_date (YYYY-MM-DD) and start_time (HH:MM:SS) are
// stored as Dublin-local wall-clock values without timezone semantics.
// The old implementation did `new Date(\`${dateStr}T${timeStr}Z\`)` —
// the trailing `Z` parsed the time as UTC, then
// formatWeekdayShortDateTimeInTZ rendered it in Europe/Dublin which
// in BST (May→Oct) is UTC+1 — adding an hour. 17:00 booking → SMS
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
        confirmation_sms_body
      ),
      contacts (
        first_name, last_name, name, email, phone,
        email_status, sms_status,
        contact_preferences ( email_administrative, sms_administrative )
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
    smsBody: ev.confirmation_sms_body,
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
      else if (channel === 'sms') outcome = await sendSmsConfirmation(db, booking, ctx)
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

async function sendSmsConfirmation(db, booking, ctx) {
  if (!ctx.smsBody) {
    throw new Error('Confirmation channel=sms but no body configured on the event type')
  }

  const c = booking.contacts
  // EVENT-CONSENT.1 — shared definition (sms_status + sms_administrative).
  const suppression = transactionalSmsSuppression(c)
  if (suppression) return { status: 'skipped', reason: suppression }

  const phone = booking.contacts?.phone || booking.customer_phone
  if (!phone) return { status: 'skipped', reason: 'no_phone_number' }

  let { data: location } = await db
    .from('locations')
    .select('id, name, twilio_alpha_sender_id')
    .eq('id', ctx.locationId)
    .single()
  if (!location) {
    throw new Error('Event location not found — cannot resolve SMS sender.')
  }
  // INTEG-A2 dual-read: registry twilio_sender row first.
  location = await overlayConnections(db, location, ['twilio_sender'])

  const mergeContact = booking.contacts || {
    name: booking.customer_name,
    first_name: booking.customer_name?.split(' ')[0],
    email: booking.customer_email,
    phone: booking.customer_phone,
  }

  const extras = {
    event_name: ctx.eventName,
    event_time: fmtBookingTime(booking.booking_date, booking.start_time),
    location_name: location.name || '',
  }

  const renderedBody = applyMergeTagsWithExtras(ctx.smsBody, mergeContact, extras)

  try {
    await sendLocationSms({ location, to: phone, body: renderedBody })
  } catch (e) {
    const msg = e instanceof TwilioError
      ? `Twilio ${e.code || e.status || ''}: ${e.message}`.trim()
      : (e?.message || 'SMS send failed')
    throw new Error(msg)
  }

  // Activity timeline entry — mirrors the reminder pattern.
  if (booking.contact_id) {
    await db.from('activities').insert({
      contact_id: booking.contact_id,
      location_id: ctx.locationId,
      type: 'sms_sent',
      kind: 'event',
      subject: `Booking confirmation: ${ctx.eventName}`,
      note: renderedBody,
    })
  }

  return { status: 'sent' }
}
