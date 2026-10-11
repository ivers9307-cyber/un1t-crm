// Per-event reminder runner. Mig 076 — multi-reminder.
//
// Each event_type can have N reminders configured (24h email,
// 2h email, day-of email, etc). Each reminder lives in
// event_type_reminders with its own channels[], offset and
// template/body. Per-(booking, reminder) sends are tracked in
// booking_reminder_sends so the runner doesn't re-fire the
// same reminder if a tick takes longer than 5 minutes.
//
// Channels: 'email' only. WhatsApp was retired in mig 074 and SMS
// with Twilio (TWILIO-RETIRE.1). The DB CHECK on
// event_type_reminders.channels still admits 'sms', so a legacy
// row's sms channel falls through to the unsupported_channel skip.
//
// Cron-driven: invoked from /api/cron/run-sequences alongside
// the sequence runner. Two queries per reminder per tick (the
// in-window bookings list, and the already-sent set against
// THIS reminder). Volume stays low — typical operator has
// <10 reminders × <100 in-window bookings per tick.
//
// Legacy bookings.reminder_sent_at is still stamped on the
// FIRST send for any booking, so old surfaces that read it
// (e.g. BookingSkipReminderToggle's hide rule) keep working.

import { createServerClient } from '@/lib/supabase'
import { sendTransactionalEmail, applyMergeTags } from '@/lib/postmark'
import { logTransactionalWalletState } from '@/lib/wallet-enforcement'
import { logWarn } from '@/lib/log'
import { fmtBookingTime, bookingLocationMergeExtras } from '@/lib/booking-confirmations'

// ±1h covers Dublin DST drift cleanly. Operators set reminder time in
// coarse units (24h, 2h) so a ±1h fire-time window is acceptable.
const TOLERANCE_MS = 60 * 60 * 1000

// BOOKING.2 — the reminder email body renders the event time via
// the shared fmtBookingTime (booking-confirmations). booking_date /
// start_time are Dublin wall-clock; the old local copy did
// `new Date(\`${date}T${time}Z\`)` then rendered in Europe/Dublin,
// adding the BST hour (17:00 reminder said 18:00). The shared helper
// anchors the day label on noon-UTC and uses the time string verbatim.
// NOTE: this is the human-facing body only — the window-matching math
// below (the bookingMs guard) is a SEPARATE concern and stays as-is.

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

  // Pull every active reminder + the parent event_type's
  // location + name. Small table.
  const { data: reminders } = await db
    .from('event_type_reminders')
    .select(`
      id, minutes_before, channels,
      email_template_id, email_subject,
      event_types!inner ( id, name, location_id )
    `)
    .eq('active', true)
  if (!reminders?.length) return stats

  const now = Date.now()

  for (const reminder of reminders) {
    if (!Number.isFinite(reminder.minutes_before) || reminder.minutes_before < 0) continue
    const channels = Array.isArray(reminder.channels) ? reminder.channels : []
    if (channels.length === 0) continue

    const et = reminder.event_types
    if (!et) continue   // shouldn't happen — !inner join — but defensive

    const targetMs = now + reminder.minutes_before * 60_000
    const lo = new Date(targetMs - TOLERANCE_MS)
    const hi = new Date(targetMs + TOLERANCE_MS)

    // Eligible bookings — confirmed, in the time window. We don't
    // pre-filter on already-sent here because PostgREST doesn't
    // model "missing row in a sibling table" cleanly; instead
    // we pull the in-window set then look up sends for THIS
    // reminder in a second query.
    const { data: bookings } = await db
      .from('bookings')
      .select(`
        id, contact_id, customer_name, customer_email, customer_phone,
        booking_date, start_time, skip_reminder,
        contacts (
          first_name, last_name, name, email, phone, wa_phone,
          email_status, wa_status,
          contact_preferences ( email_administrative, whatsapp_administrative )
        )
      `)
      .eq('event_type_id', et.id)
      .eq('status', 'confirmed')
      .gte('booking_date', lo.toISOString().slice(0, 10))
      .lte('booking_date', hi.toISOString().slice(0, 10))

    if (!bookings?.length) continue

    // Already-sent set for this specific reminder. UNIQUE
    // (booking_id, reminder_id) on booking_reminder_sends means
    // we can rely on this lookup for dedup.
    const bookingIds = bookings.map(b => b.id)
    const { data: alreadySent } = await db
      .from('booking_reminder_sends')
      .select('booking_id')
      .eq('reminder_id', reminder.id)
      .in('booking_id', bookingIds)
    const sentBookingIds = new Set((alreadySent || []).map(s => s.booking_id))

    // Build the per-reminder context once. Channel functions
    // accept this rather than the legacy event_type shape so
    // they're decoupled from the table layout.
    const ctx = {
      reminderId: reminder.id,
      eventName: et.name,
      locationId: et.location_id,
      emailTemplateId: reminder.email_template_id,
      emailSubject: reminder.email_subject,
    }

    // INTEG-C3 — reminders are TRANSACTIONAL: never blocked by billing,
    // log-only (loud at/below the −€10 grace floor). Once per reminder
    // batch, not per booking; fire-and-forget, never rejects, and the
    // enforcement lib's 30s state cache keeps repeat calls free.
    logTransactionalWalletState(db, et.location_id, 'email_send')

    for (const booking of bookings) {
      const bookingMs = new Date(`${booking.booking_date}T${booking.start_time}Z`).getTime() // eslint-disable-line guardrails/no-zulu-template-date -- reminder window-match against now-based bounds; left by the #650 verification, reminder-timing reviewed separately
      if (bookingMs < lo.getTime() || bookingMs > hi.getTime()) continue
      if (sentBookingIds.has(booking.id)) continue

      // mig 075: per-booking override. Operator flipped a flag
      // on this specific booking. Short-circuit before any
      // channel logic.
      if (booking.skip_reminder) {
        await db.from('booking_reminder_sends').insert({
          booking_id: booking.id,
          reminder_id: reminder.id,
          status: 'skipped',
          reason: 'operator_skip_reminder',
        })
        await stampLegacyReminderSentAt(db, booking.id)
        stats.skipped++
        continue
      }

      // Run each channel independently. A channel that opts out
      // (admin opt-out, no phone number, etc.) doesn't block
      // the other one — partial sends are normal here.
      const channelOutcomes = []
      let anyHardError = null
      for (const channel of channels) {
        try {
          if (channel === 'email') {
            channelOutcomes.push({ channel, ...await sendEmailReminder(db, booking, ctx) })
          } else {
            channelOutcomes.push({ channel, status: 'skipped', reason: `unsupported_channel:${channel}` })
          }
        } catch (e) {
          // Hard error on this channel — record but don't poison
          // any other channel.
          logWarn('event-reminders', `${channel} failed for booking ${booking.id} reminder ${reminder.id}`, { err: e })
          channelOutcomes.push({ channel, status: 'failed', reason: e.message })
          anyHardError = e.message
        }
      }

      const channelsSent = channelOutcomes.filter(o => o.status === 'sent').map(o => o.channel)
      const allSentOrSkipped = channelOutcomes.every(o => o.status !== 'failed')
      const anySent = channelsSent.length > 0

      // Outcome aggregation:
      //   any channel sent → 'sent' (partial sends count as sent)
      //   no channel sent + every channel skipped (consent / no
      //     contact info) → 'skipped'
      //   any channel had a hard error → 'failed'; we DON'T write
      //     the dedup row, so the runner retries on the next tick
      let aggregatedStatus, aggregatedReason
      if (anySent) {
        aggregatedStatus = 'sent'
      } else if (allSentOrSkipped) {
        aggregatedStatus = 'skipped'
        aggregatedReason = channelOutcomes.map(o => `${o.channel}:${o.reason || 'unknown'}`).join('; ')
      } else {
        aggregatedStatus = 'failed'
        aggregatedReason = anyHardError
      }

      if (aggregatedStatus === 'failed') {
        // Don't insert a send row → next tick will retry. This
        // matches the legacy runner's "don't stamp reminder_sent_at
        // on failure" semantic.
        stats.failed++
        continue
      }

      await db.from('booking_reminder_sends').insert({
        booking_id: booking.id,
        reminder_id: reminder.id,
        status: aggregatedStatus,
        channels_sent: channelsSent,
        reason: aggregatedReason || null,
      })

      // Legacy stamp on first send so old readers (the partial
      // index, the BookingSkipReminderToggle hide rule) see a
      // truthy "any reminder fired" signal. Idempotent — re-
      // stamping just overwrites the timestamp.
      if (aggregatedStatus === 'sent') {
        await stampLegacyReminderSentAt(db, booking.id)
      }

      if (aggregatedStatus === 'sent') stats.sent++
      else stats.skipped++
    }
  }

  return stats
}

async function stampLegacyReminderSentAt(db, bookingId) {
  await db.from('bookings')
    .update({ reminder_sent_at: new Date().toISOString() })
    .eq('id', bookingId)
}

// Exported for tests (W1.S1a); the runner above is its only caller.
export async function sendEmailReminder(db, booking, ctx) {
  if (!ctx.emailTemplateId) {
    throw new Error('Reminder channel=email but no email_template_id set on the reminder')
  }

  // Consent + hard-signal checks. Reminders are administrative
  // (transactional) — the user's marketing opt-out doesn't block
  // them, but their administrative opt-out does, and we never send
  // to addresses Postmark has already marked bounced/complained.
  // For walk-up bookings with no contact row we have no preferences
  // to check; fall back to "send" since the booking itself is the
  // implicit consent for reminders about it.
  const c = booking.contacts
  // LOCCOMMS.5 / mig 492 — 'unsubscribed' removed deliberately: this is a
  // TRANSACTIONAL send, and that retired value was a marketing opt-out. It
  // was blocking reminders cross-location; same fix as booking-confirmations.
  if (c?.email_status && ['bounced', 'complained'].includes(c.email_status)) {
    return { status: 'skipped', reason: `email_status=${c.email_status}` }
  }
  const prefs = c?.contact_preferences
  const adminConsent = Array.isArray(prefs)
    ? prefs[0]?.email_administrative
    : prefs?.email_administrative
  if (adminConsent === false) {
    return { status: 'skipped', reason: 'opted_out_administrative_email' }
  }

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

  // W1.S1a — {{location_name}} / {{company_name}} for the sending location.
  const extras = {
    ...(await bookingLocationMergeExtras(db, ctx.locationId)),
    event_name: ctx.eventName,
    event_time: fmtBookingTime(booking.booking_date, booking.start_time),
  }

  const rawSubject =
    (tpl.subject?.trim() || ctx.emailSubject?.trim() || `Reminder: ${ctx.eventName}`)
  const subject = applyMergeTagsWithExtras(rawSubject, mergeContact, extras)
  const htmlBody = applyMergeTagsWithExtras(tpl.html_content || '', mergeContact, extras)

  await sendTransactionalEmail({
    to,
    subject,
    htmlBody,
    contactId: booking.contact_id || null,
    locationId: ctx.locationId,
    tag: 'event-reminder',
  })
  return { status: 'sent' }
}

/**
 * Standard merge-tag substitution + a few event-reminder-specific
 * extras the regular postmark.applyMergeTags doesn't know about.
 */
function applyMergeTagsWithExtras(html, contact, extras) {
  // Apply the standard tags first (handles {{first_name}} etc).
  // Pass extras.location_name through to applyMergeTags so the
  // standard {{location_name}} tag works for reminders too.
  let out = applyMergeTags(html, contact, {
    location_name: extras.location_name || '',
    company_name: extras.company_name || '',
  })
  out = out.replaceAll('{{event_name}}', extras.event_name || '')
  out = out.replaceAll('{{event_time}}', extras.event_time || '')
  return out
}

// fillReminderTemplate (the WhatsApp body-variable filler) was
// retired with the WhatsApp branch in mig 074. Email renders
// merge tags via applyMergeTags() / mergeReminderBody() above and
// don't need the {{1}}/{{2}}/{{3}}/{{4}} positional convention.
