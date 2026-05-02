// Per-event reminder runner. Sends a single reminder N minutes before
// each booking's start time, delivered as either an email or an SMS
// — whichever the event_type was configured with.
//
// WhatsApp was supported as a third channel earlier on but was retired
// in mig 074: WhatsApp templates are reserved for explicit campaigns,
// not transactional reminders. The DB now CHECKs reminder_channel ∈
// {'email', 'sms'} so the case is unreachable; the runner short-
// circuits anything else to a clean skip.
//
// Cron-driven: invoked from /api/cron/run-sequences alongside the
// sequence runner. Dedup is via bookings.reminder_sent_at — the partial
// index idx_bookings_reminder_pending (mig 044) keeps the working set
// small.
//
// This is the simple single-shot path. The sequence-based event_reminder
// trigger remains available for multi-step reminder flows (24h + 2h +
// day-of), but most events just need one message and shouldn't require
// an operator to author a sequence to get it.

import { createServerClient } from '@/lib/supabase'
import { sendTransactionalEmail, applyMergeTags } from '@/lib/postmark'
import { sendLocationSms, TwilioError } from '@/lib/twilio'

// ±1h covers Dublin DST drift cleanly. Operators set reminder time in
// coarse units (24h, 2h) so a ±1h fire-time window is acceptable.
const TOLERANCE_MS = 60 * 60 * 1000

/**
 * Render an event-time string for the reminder body. Always Dublin local.
 */
function fmtBookingTime(dateStr, timeStr) {
  const dt = new Date(`${dateStr}T${timeStr}Z`)
  // Dublin display, falls back to UTC if Intl isn't available.
  try {
    return dt.toLocaleString('en-IE', {
      timeZone: 'Europe/Dublin',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return `${dateStr} ${timeStr}`
  }
}

/**
 * Find each booking that needs a reminder right now and send it via
 * the channel configured on its event_type. Returns a small stats
 * object the cron logs.
 *
 * @returns {Promise<{sent: number, skipped: number, failed: number}>}
 */
export async function runEventReminderSends() {
  const db = createServerClient()
  const stats = { sent: 0, skipped: 0, failed: 0 }

  // Pull every event_type with reminders enabled. Small table —
  // typically a handful of rows per location, no need to filter
  // further at this stage.
  const { data: events } = await db
    .from('event_types')
    .select(`
      id, name, location_id,
      reminder_minutes_before, reminder_channel,
      reminder_email_template_id, reminder_email_subject,
      reminder_sms_body
    `)
    .eq('reminder_enabled', true)
  if (!events?.length) return stats

  const now = Date.now()

  for (const ev of events) {
    if (!Number.isFinite(ev.reminder_minutes_before) || ev.reminder_minutes_before < 0) continue
    if (!ev.reminder_channel) continue

    const targetMs = now + ev.reminder_minutes_before * 60_000
    const lo = new Date(targetMs - TOLERANCE_MS)
    const hi = new Date(targetMs + TOLERANCE_MS)

    // Bookings needing a reminder for this event type. The partial
    // index idx_bookings_reminder_pending makes this cheap. We pull
    // the contact + their preferences for the consent / status checks
    // below; falls back to customer_* on the booking row when there's
    // no contact (booking captured before a contact row was created).
    const { data: bookings } = await db
      .from('bookings')
      .select(`
        id, contact_id, customer_name, customer_email, customer_phone,
        booking_date, start_time, skip_reminder,
        contacts (
          first_name, last_name, name, email, phone, wa_phone,
          email_status, wa_status, sms_status,
          contact_preferences ( email_administrative, whatsapp_administrative, sms_administrative )
        )
      `)
      .eq('event_type_id', ev.id)
      .eq('status', 'confirmed')
      .is('reminder_sent_at', null)
      .gte('booking_date', lo.toISOString().slice(0, 10))
      .lte('booking_date', hi.toISOString().slice(0, 10))

    for (const booking of (bookings || [])) {
      const bookingMs = new Date(`${booking.booking_date}T${booking.start_time}Z`).getTime()
      if (bookingMs < lo.getTime() || bookingMs > hi.getTime()) continue

      // mig 075: per-booking override. Operator flipped a flag on
      // this specific booking saying "don't remind this person".
      // Short-circuit before consent / channel checks. We still
      // stamp reminder_sent_at so the booking drops out of the
      // partial index — otherwise we'd revisit it every tick for
      // the rest of its life.
      if (booking.skip_reminder) {
        await db
          .from('bookings')
          .update({ reminder_sent_at: new Date().toISOString() })
          .eq('id', booking.id)
        stats.skipped++
        continue
      }

      let outcome
      try {
        if (ev.reminder_channel === 'email') {
          outcome = await sendEmailReminder(db, booking, ev)
        } else if (ev.reminder_channel === 'sms') {
          outcome = await sendSmsReminder(db, booking, ev)
        } else {
          // mig 074 retired WhatsApp; the DB CHECK now excludes it.
          // Any other value (incl. legacy 'whatsapp' that somehow
          // survives) lands here as a clean skip — no error, no
          // re-attempt, no half-sent message.
          outcome = { status: 'skipped', reason: `unsupported_channel:${ev.reminder_channel || 'none'}` }
        }
      } catch (e) {
        console.warn(`[event-reminders] failed for booking ${booking.id}: ${e.message}`)
        stats.failed++
        // Don't stamp — leave it for the next tick to retry. Hard
        // errors (provider down, template missing) usually recover.
        continue
      }

      // Always stamp on a final outcome (sent OR deliberately skipped).
      // Skips are intentional — opted out, hard-bounced, etc — and
      // should not be retried every 5 min for the rest of the
      // booking's life. The stamp removes them from the partial index.
      await db
        .from('bookings')
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq('id', booking.id)

      if (outcome.status === 'sent') stats.sent++
      else stats.skipped++
    }
  }

  return stats
}

async function sendEmailReminder(db, booking, ev) {
  if (!ev.reminder_email_template_id) {
    throw new Error('Event has reminder_channel=email but no reminder_email_template_id set')
  }

  // Consent + hard-signal checks. Reminders are administrative
  // (transactional) — the user's marketing opt-out doesn't block
  // them, but their administrative opt-out does, and we never send
  // to addresses Postmark has already marked bounced/complained.
  // For walk-up bookings with no contact row we have no preferences
  // to check; fall back to "send" since the booking itself is the
  // implicit consent for reminders about it.
  const c = booking.contacts
  if (c?.email_status && ['bounced', 'complained', 'unsubscribed'].includes(c.email_status)) {
    return { status: 'skipped', reason: `email_status=${c.email_status}` }
  }
  const prefs = c?.contact_preferences
  // contact_preferences is one-to-one but Supabase returns it as an
  // array via the embed. Tolerate both shapes.
  const adminConsent = Array.isArray(prefs)
    ? prefs[0]?.email_administrative
    : prefs?.email_administrative
  if (adminConsent === false) {
    return { status: 'skipped', reason: 'opted_out_administrative_email' }
  }

  const { data: tpl } = await db
    .from('email_templates')
    .select('subject, html_content')
    .eq('id', ev.reminder_email_template_id)
    .single()
  if (!tpl) throw new Error('Email template not found')

  const to = booking.contacts?.email || booking.customer_email
  if (!to) return { status: 'skipped', reason: 'no_email_address' }

  // Contact-shaped object so applyMergeTags works whether there's a
  // joined contact row or only the booking's customer_* fields.
  const mergeContact = booking.contacts || {
    name: booking.customer_name,
    first_name: booking.customer_name?.split(' ')[0],
    email: booking.customer_email,
    phone: booking.customer_phone,
  }

  const extras = {
    event_name: ev.name,
    event_time: fmtBookingTime(booking.booking_date, booking.start_time),
  }

  // Subject precedence: template subject > event-level fallback >
  // a sensible default. Apply merge tags to whichever wins.
  const rawSubject =
    (tpl.subject?.trim() || ev.reminder_email_subject?.trim() || `Reminder: ${ev.name}`)
  const subject = applyMergeTagsWithExtras(rawSubject, mergeContact, extras)
  const htmlBody = applyMergeTagsWithExtras(tpl.html_content || '', mergeContact, extras)

  await sendTransactionalEmail({
    to,
    subject,
    htmlBody,
    contactId: booking.contact_id || null,
    locationId: ev.location_id,
    tag: 'event-reminder',
  })
  return { status: 'sent' }
}

/**
 * SMS event-reminder send (mig 063). One of two surviving channels
 * after mig 074 retired WhatsApp. Same shape as the email path:
 *   1. Reject if reminder_sms_body is missing on the event_type.
 *   2. Skip if contact has sms_status = opted_out / invalid (not an
 *      error — leave reminder_sent_at unset and let the runner stamp
 *      it on the next tick to remove from the partial index).
 *   3. Skip if contact_preferences.sms_administrative === false.
 *   4. Apply merge tags (incl. event_name + event_time extras),
 *      send via sendLocationSms using the event_type's location's
 *      alpha sender ID.
 *   5. Write an activities row of type='sms_sent' so the contact
 *      timeline records it (same shape as broadcasts + ad-hoc).
 */
async function sendSmsReminder(db, booking, ev) {
  if (!ev.reminder_sms_body) {
    throw new Error('Event has reminder_channel=sms but no reminder_sms_body set')
  }

  const c = booking.contacts
  if (c?.sms_status && c.sms_status !== 'active') {
    return { status: 'skipped', reason: `sms_status=${c.sms_status}` }
  }
  const prefs = c?.contact_preferences
  const adminConsent = Array.isArray(prefs)
    ? prefs[0]?.sms_administrative
    : prefs?.sms_administrative
  if (adminConsent === false) {
    return { status: 'skipped', reason: 'opted_out_administrative_sms' }
  }

  const phone = booking.contacts?.phone || booking.customer_phone
  if (!phone) return { status: 'skipped', reason: 'no_phone_number' }

  // Resolve the event_type's location for the alpha sender ID
  // (mig 059). One round-trip per booking is fine — these crons are
  // low-volume by design (10s of bookings per tick at most).
  const { data: location } = await db
    .from('locations')
    .select('id, name, twilio_alpha_sender_id')
    .eq('id', ev.location_id)
    .single()
  if (!location) {
    throw new Error('Event location not found — cannot resolve SMS sender.')
  }

  // Contact-shaped object so applyMergeTagsWithExtras works whether
  // there's a joined contact row or only the booking's customer_*
  // fields. Mirrors the email reminder path.
  const mergeContact = booking.contacts || {
    name: booking.customer_name,
    first_name: booking.customer_name?.split(' ')[0],
    email: booking.customer_email,
    phone: booking.customer_phone,
  }

  const extras = {
    event_name: ev.name,
    event_time: fmtBookingTime(booking.booking_date, booking.start_time),
    location_name: location.name || '',
  }

  const renderedBody = applyMergeTagsWithExtras(ev.reminder_sms_body, mergeContact, extras)

  let twilioResult
  try {
    twilioResult = await sendLocationSms({
      location,
      to: phone,
      body: renderedBody,
    })
  } catch (e) {
    const msg = e instanceof TwilioError
      ? `Twilio ${e.code || e.status || ''}: ${e.message}`.trim()
      : (e?.message || 'SMS send failed')
    throw new Error(msg)
  }

  // Activity timeline entry. Same shape as broadcast + sequence-step
  // + ad-hoc sends so the contact page renders consistently.
  if (booking.contact_id) {
    await db.from('activities').insert({
      contact_id: booking.contact_id,
      location_id: ev.location_id,
      type: 'sms_sent',
      subject: `SMS reminder: ${ev.name}`,
      note: renderedBody,
    })
  }

  return { status: 'sent', sid: twilioResult?.sid || null }
}

/**
 * Standard merge-tag substitution + a few event-reminder-specific
 * extras the regular postmark.applyMergeTags doesn't know about.
 */
function applyMergeTagsWithExtras(html, contact, extras) {
  // Apply the standard tags first (handles {{first_name}} etc).
  // Pass extras.location_name through to applyMergeTags so the
  // standard {{location_name}} tag works for SMS reminders too.
  let out = applyMergeTags(html, contact, {
    location_name: extras.location_name || '',
  })
  out = out.replaceAll('{{event_name}}', extras.event_name || '')
  out = out.replaceAll('{{event_time}}', extras.event_time || '')
  return out
}

// fillReminderTemplate (the WhatsApp body-variable filler) was
// retired with the WhatsApp branch in mig 074. Email + SMS render
// merge tags via applyMergeTags() / mergeReminderBody() above and
// don't need the {{1}}/{{2}}/{{3}}/{{4}} positional convention.
