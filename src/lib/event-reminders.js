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

// BOOKINGSELF.1 — timing. booking_date/start_time are wall clock in the
// event type's studio zone (locations.timezone). The runner used to read
// them as UTC (a trailing-Z date parse) inside a ±1h tolerance, so a
// reminder fired up to an hour early or late (an hour off all summer in
// Dublin). Now each booking's start is an instant via
// zonedWallClockToInstant in its studio's zone (zones read ONCE per tick with
// getLocationZones), and a reminder is due when
//   now >= start - minutes_before   and   now < start.
// A studio whose zone cannot be read is skipped for that tick (logged),
// never guessed. A reminder whose time has passed for a booking made (or
// moved) inside its window still goes once, unless a CLOSER reminder of the
// same type is already due: then the stale one is recorded 'skipped'
// (superseded) instead, so nobody gets "24 hours to go" after "2 hours to
// go", or both at once. A reschedule clears the booking's send rows
// (booking-self-service.js), so the reminders run again for the new time.

import { createServerClient } from '@/lib/supabase'
import { sendTransactionalEmail } from '@/lib/postmark'
import { logTransactionalWalletState } from '@/lib/wallet-enforcement'
import { logWarn, logError } from '@/lib/log'
import {
  fmtBookingTime, bookingLocationMergeExtras, bookingManageMergeUrl, applyMergeTagsWithExtras,
} from '@/lib/booking-confirmations'
import {
  getLocationZones, getLocationZone, zonedWallClockToInstant, dayStrIn, addDaysISO, DEFAULT_TZ,
} from '@/lib/location-time'

// A 0-minute ("at the start") reminder still gets one cron tick (every 5
// minutes) to go out in: its window is the last 5 minutes before the start.
export const MIN_REMINDER_LEAD_MS = 5 * 60_000

/** How long before the start a reminder's window opens, in ms. */
export function reminderLeadMs(minutesBefore) {
  return Math.max(Number(minutesBefore) * 60_000, MIN_REMINDER_LEAD_MS)
}

/** Is a reminder due now for a booking starting at startMs (UTC ms)? Pure. */
export function reminderIsDue(startMs, minutesBefore, nowMs) {
  if (startMs == null || !Number.isFinite(startMs)) return false
  return nowMs >= startMs - reminderLeadMs(minutesBefore) && nowMs < startMs
}

/** The instant a booking starts, its wall clock read in the studio zone. */
export function bookingStartInstant(booking, zone) {
  return zonedWallClockToInstant(booking?.booking_date, String(booking?.start_time || '').slice(0, 8), zone)
}

/**
 * The booking_date range to pre-filter on for a reminder: every studio date
 * an instant in [now, now + lead] can fall on in `zone`, widened a day each
 * side (a DST day, a clock skew). The exact test is reminderIsDue.
 */
export function reminderDateRange(nowMs, minutesBefore, zone) {
  return {
    lo: addDaysISO(dayStrIn(new Date(nowMs), zone), -1),
    hi: addDaysISO(dayStrIn(new Date(nowMs + reminderLeadMs(minutesBefore)), zone), 1),
  }
}

/**
 * Find each booking that needs a reminder right now and send it via
 * the channel configured on its event_type. Returns a small stats
 * object the cron logs.
 *
 * @param {{ db?: object, nowMs?: number }} [opts]  injectable for tests
 * @returns {Promise<{sent: number, skipped: number, failed: number, zone_unreadable: number}>}
 */
export async function runEventReminderSends({ db = createServerClient(), nowMs = Date.now() } = {}) {
  const stats = { sent: 0, skipped: 0, failed: 0, zone_unreadable: 0 }

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

  const now = nowMs

  // Every live reminder's lead per event type, for the superseded rule.
  const leadsByType = new Map()
  for (const r of reminders) {
    if (!Number.isFinite(r.minutes_before) || r.minutes_before < 0 || !r.event_types?.id) continue
    if (!Array.isArray(r.channels) || r.channels.length === 0) continue
    const list = leadsByType.get(r.event_types.id) || []
    list.push(r.minutes_before)
    leadsByType.set(r.event_types.id, list)
  }

  // Studio zones, once per tick. A failed batch read leaves the map empty
  // and each reminder tries its own location below (and is skipped if that
  // fails too), so one bad read never sends at a guessed hour.
  let zones = new Map()
  try {
    zones = await getLocationZones(db, reminders.map((r) => r.event_types?.location_id))
  } catch (err) {
    logWarn('event-reminders', 'studio zones unreadable in one read; trying per studio', { err })
  }
  const zoneFor = async (locationId) => {
    if (!locationId) return DEFAULT_TZ
    if (zones.has(locationId)) return zones.get(locationId)
    const zone = await getLocationZone(db, locationId)
    zones.set(locationId, zone)
    return zone
  }

  for (const reminder of reminders) {
    if (!Number.isFinite(reminder.minutes_before) || reminder.minutes_before < 0) continue
    const channels = Array.isArray(reminder.channels) ? reminder.channels : []
    if (channels.length === 0) continue

    const et = reminder.event_types
    if (!et) continue   // shouldn't happen — !inner join — but defensive

    let zone
    try {
      zone = await zoneFor(et.location_id)
    } catch (err) {
      logWarn('event-reminders', 'studio zone unreadable; reminder skipped this tick', { err, reminderId: reminder.id, locationId: et.location_id })
      stats.zone_unreadable++
      continue
    }

    const { lo, hi } = reminderDateRange(now, reminder.minutes_before, zone)
    const myLead = reminderLeadMs(reminder.minutes_before)
    const closerLeads = (leadsByType.get(et.id) || []).map(reminderLeadMs).filter((l) => l < myLead)

    // Eligible bookings — confirmed, in the date range. We don't
    // pre-filter on already-sent here because PostgREST doesn't
    // model "missing row in a sibling table" cleanly; instead
    // we pull the in-range set then look up sends for THIS
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
      .gte('booking_date', lo)
      .lte('booking_date', hi)

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
      const startMs = bookingStartInstant(booking, zone)
      if (!reminderIsDue(startMs, reminder.minutes_before, now)) continue
      if (sentBookingIds.has(booking.id)) continue

      // A closer reminder of the same type is already due: this one is
      // stale for this booking. Recorded so it is never reconsidered.
      if (closerLeads.some((lead) => now >= startMs - lead)) {
        await recordSend(db, { booking_id: booking.id, reminder_id: reminder.id, status: 'skipped', reason: 'superseded_by_closer_reminder' })
        stats.skipped++
        continue
      }

      // mig 075: per-booking override. Operator flipped a flag
      // on this specific booking. Short-circuit before any
      // channel logic.
      if (booking.skip_reminder) {
        await recordSend(db, {
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

      await recordSend(db, {
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

// The dedup row. A lost write means the reminder may go again next tick
// (a duplicate, never a loss): logged loud, never thrown through the runner.
async function recordSend(db, row) {
  try {
    const { error } = await db.from('booking_reminder_sends').insert(row)
    if (error) logError('event-reminders', 'reminder send row not written; it may repeat next tick', { err: error, bookingId: row.booking_id, reminderId: row.reminder_id, status: row.status })
  } catch (err) {
    logError('event-reminders', 'reminder send row write threw; it may repeat next tick', { err, bookingId: row.booking_id, reminderId: row.reminder_id })
  }
}

// A display hint only (the send rows are the dedup): a lost stamp is logged.
async function stampLegacyReminderSentAt(db, bookingId) {
  try {
    const { error } = await db.from('bookings')
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq('id', bookingId)
    if (error) logWarn('event-reminders', 'legacy reminder_sent_at not stamped', { err: error, bookingId })
  } catch (err) {
    logWarn('event-reminders', 'legacy reminder_sent_at stamp threw', { err, bookingId })
  }
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
    // BOOKINGSELF.1 — the customer's cancel / reschedule page.
    manage_url: await bookingManageMergeUrl(db, booking.id, ctx.locationId),
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

// applyMergeTagsWithExtras is booking-confirmations' (shared since
// BOOKINGSELF.1, which added {{manage_url}} to both).

// fillReminderTemplate (the WhatsApp body-variable filler) was
// retired with the WhatsApp branch in mig 074. Email renders
// merge tags via applyMergeTags() / mergeReminderBody() above and
// don't need the {{1}}/{{2}}/{{3}}/{{4}} positional convention.
