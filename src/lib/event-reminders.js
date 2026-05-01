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
    // the contact join (when present) so we have first_name / phone
    // for merge tags; falls back to customer_* on the booking row.
    const { data: bookings } = await db
      .from('bookings')
      .select(`
        id, contact_id, customer_name, customer_email, customer_phone,
        booking_date, start_time,
        contacts ( first_name, last_name, name, email, phone, wa_phone )
      `)
      .eq('event_type_id', ev.id)
      .eq('status', 'confirmed')
      .is('reminder_sent_at', null)
      .gte('booking_date', lo.toISOString().slice(0, 10))
      .lte('booking_date', hi.toISOString().slice(0, 10))

    for (const booking of (bookings || [])) {
      const bookingMs = new Date(`${booking.booking_date}T${booking.start_time}Z`).getTime()
      if (bookingMs < lo.getTime() || bookingMs > hi.getTime()) continue

      try {
        if (ev.reminder_channel === 'email') {
          await sendEmailReminder(db, booking, ev)
        } else if (ev.reminder_channel === 'whatsapp') {
          await sendWhatsappReminder(db, booking, ev)
        } else {
          stats.skipped++
          continue
        }
        await db
          .from('bookings')
          .update({ reminder_sent_at: new Date().toISOString() })
          .eq('id', booking.id)
        stats.sent++
      } catch (e) {
        console.warn(`[event-reminders] failed for booking ${booking.id}: ${e.message}`)
        stats.failed++
      }
    }
  }

  return stats
}

async function sendEmailReminder(db, booking, ev) {
  if (!ev.reminder_email_template_id) {
    throw new Error('Event has reminder_channel=email but no reminder_email_template_id set')
  }
  const { data: tpl } = await db
    .from('email_templates')
    .select('subject, html_content')
    .eq('id', ev.reminder_email_template_id)
    .single()
  if (!tpl) throw new Error('Email template not found')

  const to = booking.contacts?.email || booking.customer_email
  if (!to) throw new Error('No email address available for booking')

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
}

async function sendWhatsappReminder(db, booking, ev) {
  if (!ev.reminder_whatsapp_template_id) {
    throw new Error('Event has reminder_channel=whatsapp but no reminder_whatsapp_template_id set')
  }
  const { data: tpl } = await db
    .from('whatsapp_templates')
    .select('name, language, components, status, category')
    .eq('id', ev.reminder_whatsapp_template_id)
    .single()
  if (!tpl) throw new Error('WhatsApp template not found')
  if (tpl.status !== 'APPROVED') throw new Error(`WhatsApp template '${tpl.name}' is not approved (${tpl.status})`)

  const phone = booking.contacts?.wa_phone || booking.contacts?.phone || booking.customer_phone
  if (!phone) throw new Error('No phone number available for booking')

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
