// Per-event reminder runner. Sends a single reminder N minutes before
// each booking's start time, delivered as either an email or a WhatsApp
// utility template — whichever the event_type was configured with.
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
import { sendTemplateMessage, getOrCreateConversation } from '@/lib/whatsapp'

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
      reminder_whatsapp_template_id
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
        booking_date, start_time,
        contacts (
          first_name, last_name, name, email, phone, wa_phone,
          email_status, wa_status,
          contact_preferences ( email_administrative, whatsapp_administrative )
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

      let outcome
      try {
        if (ev.reminder_channel === 'email') {
          outcome = await sendEmailReminder(db, booking, ev)
        } else if (ev.reminder_channel === 'whatsapp') {
          outcome = await sendWhatsappReminder(db, booking, ev)
        } else {
          outcome = { status: 'skipped', reason: 'no_channel' }
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

async function sendWhatsappReminder(db, booking, ev) {
  if (!ev.reminder_whatsapp_template_id) {
    throw new Error('Event has reminder_channel=whatsapp but no reminder_whatsapp_template_id set')
  }

  // Consent + hard-signal checks. Same logic as the email path:
  // marketing opt-out doesn't block utility messages, but
  // administrative opt-out does, and a blocked / opted-out wa_status
  // means Meta will reject anyway.
  const c = booking.contacts
  if (c?.wa_status && ['blocked', 'opted_out'].includes(c.wa_status)) {
    return { status: 'skipped', reason: `wa_status=${c.wa_status}` }
  }
  const prefs = c?.contact_preferences
  const adminConsent = Array.isArray(prefs)
    ? prefs[0]?.whatsapp_administrative
    : prefs?.whatsapp_administrative
  if (adminConsent === false) {
    return { status: 'skipped', reason: 'opted_out_administrative_whatsapp' }
  }

  const { data: tpl } = await db
    .from('whatsapp_templates')
    .select('name, language, components, status, category')
    .eq('id', ev.reminder_whatsapp_template_id)
    .single()
  if (!tpl) throw new Error('WhatsApp template not found')
  if (tpl.status !== 'APPROVED') throw new Error(`WhatsApp template '${tpl.name}' is not approved (${tpl.status})`)
  // Belt-and-braces: even though the picker filters to UTILITY/AUTHENTICATION,
  // a marketing template here would be a Meta policy violation (sending a
  // marketing message under a utility pretext). Refuse at runtime too.
  if (tpl.category === 'MARKETING') {
    throw new Error(`WhatsApp template '${tpl.name}' is MARKETING category — reminders must use UTILITY or AUTHENTICATION templates`)
  }

  const phone = booking.contacts?.wa_phone || booking.contacts?.phone || booking.customer_phone
  if (!phone) return { status: 'skipped', reason: 'no_phone_number' }

  const components = fillReminderTemplate(tpl, booking, ev)

  await sendTemplateMessage(phone, tpl.name, tpl.language || 'en', components)

  // Log the outbound message against the contact's conversation if
  // we have one. Best-effort — failure here doesn't block the send.
  try {
    if (booking.contact_id && booking.contacts) {
      await getOrCreateConversation(db, booking.contacts, ev.location_id)
    }
  } catch (e) {
    console.warn(`[event-reminders] WA conversation log skipped: ${e.message}`)
  }
  return { status: 'sent' }
}

/**
 * Standard merge-tag substitution + a few event-reminder-specific
 * extras the regular postmark.applyMergeTags doesn't know about.
 */
function applyMergeTagsWithExtras(html, contact, extras) {
  // Apply the standard tags first (handles {{first_name}} etc).
  let out = applyMergeTags(html, contact, {})
  out = out.replaceAll('{{event_name}}', extras.event_name || '')
  out = out.replaceAll('{{event_time}}', extras.event_time || '')
  return out
}

/**
 * Fill a WhatsApp template's BODY variables ({{1}}, {{2}}, ...) using
 * a fixed convention for event reminders:
 *   {{1}} = first_name        (or contact.name first word, or 'there')
 *   {{2}} = event name        (event_types.name)
 *   {{3}} = event time        (Dublin local "Mon 12 May 14:00")
 *   {{4}} = event date        (Dublin local "Mon 12 May")
 *
 * Templates with no variables are sent as-is. Templates with more than
 * 4 variables get the extras filled with a single space (Meta rejects
 * empty strings) — operators should redesign or use a richer flow if
 * they need more dynamic fields.
 */
function fillReminderTemplate(template, booking, ev) {
  const components = []
  const bodyComp = (template.components || []).find(c => c.type === 'BODY')
  if (!bodyComp?.text) return components

  const varMatches = bodyComp.text.match(/\{\{\d+\}\}/g) || []
  if (varMatches.length === 0) return components

  const dt = new Date(`${booking.booking_date}T${booking.start_time}Z`)
  let dateStr, timeStr
  try {
    dateStr = dt.toLocaleDateString('en-IE', {
      timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short',
    })
    timeStr = dt.toLocaleTimeString('en-IE', {
      timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit',
    })
  } catch {
    dateStr = booking.booking_date
    timeStr = booking.start_time
  }

  const firstName =
    booking.contacts?.first_name
    || booking.contacts?.name?.split(' ')[0]
    || booking.customer_name?.split(' ')[0]
    || 'there'

  const values = [firstName, ev.name, `${dateStr} ${timeStr}`, dateStr]
  const parameters = varMatches.map((_, i) => ({
    type: 'text',
    text: values[i] || ' ',
  }))
  components.push({ type: 'body', parameters })

  return components
}
