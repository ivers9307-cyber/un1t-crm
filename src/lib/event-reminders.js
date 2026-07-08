// Per-event reminder runner. Mig 076 — multi-reminder.
//
// Each event_type can have N reminders configured (24h email,
// 2h SMS, day-of email + SMS, etc). Each reminder lives in
// event_type_reminders with its own channels[], offset and
// template/body. Per-(booking, reminder) sends are tracked in
// booking_reminder_sends so the runner doesn't re-fire the
// same reminder if a tick takes longer than 5 minutes.
//
// Channels: 'email' and 'sms' only. WhatsApp was retired in
// mig 074; the DB CHECK on event_type_reminders.channels
// rejects anything outside {email, sms}.
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
import { sendLocationSms, TwilioError } from '@/lib/twilio'
import { logWarn, logError } from '@/lib/log'
import { fmtBookingTime } from '@/lib/booking-confirmations'
// EVENTS-REMINDERS.1 — pre-event reminders for the standalone events platform.
// (See the clearly-delimited section at the bottom of this file.)
import { signCheckinToken } from '@/lib/event-checkin-tokens'
import { getAppUrl } from '@/lib/app-url'
import { sendCustomerPush } from '@/lib/customer-push'
import { addDaysISO, dublinTodayStr } from '@/lib/dublin-time'
import { formatWeekdayLongDateInTZ } from '@/lib/dates'

// ±1h covers Dublin DST drift cleanly. Operators set reminder time in
// coarse units (24h, 2h) so a ±1h fire-time window is acceptable.
const TOLERANCE_MS = 60 * 60 * 1000

// BOOKING.2 — the reminder email + SMS body render the event time via
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
      email_template_id, email_subject, sms_body,
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
          email_status, wa_status, sms_status,
          contact_preferences ( email_administrative, whatsapp_administrative, sms_administrative )
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
      smsBody: reminder.sms_body,
    }

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
          } else if (channel === 'sms') {
            channelOutcomes.push({ channel, ...await sendSmsReminder(db, booking, ctx) })
          } else {
            channelOutcomes.push({ channel, status: 'skipped', reason: `unsupported_channel:${channel}` })
          }
        } catch (e) {
          // Hard error on this channel — record but don't poison
          // the other one. Email-down doesn't have to take SMS
          // down too.
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

async function sendEmailReminder(db, booking, ctx) {
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
  if (c?.email_status && ['bounced', 'complained', 'unsubscribed'].includes(c.email_status)) {
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

  const extras = {
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
 * SMS event-reminder send. One of two channels (mig 074 retired
 * WhatsApp). Mig 076: reminder config now comes from a per-row
 * ctx object, not the legacy event_types columns.
 *
 *   1. Reject if smsBody is missing on the reminder.
 *   2. Skip if contact has sms_status != active.
 *   3. Skip if contact_preferences.sms_administrative === false.
 *   4. Apply merge tags, send via sendLocationSms using the
 *      event_type's location's alpha sender ID.
 *   5. Write an activities row of type='sms_sent' so the contact
 *      timeline records it.
 */
async function sendSmsReminder(db, booking, ctx) {
  if (!ctx.smsBody) {
    throw new Error('Reminder channel=sms but no sms_body set on the reminder')
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
  // low-volume by design.
  const { data: location } = await db
    .from('locations')
    .select('id, name, twilio_alpha_sender_id')
    .eq('id', ctx.locationId)
    .single()
  if (!location) {
    throw new Error('Event location not found — cannot resolve SMS sender.')
  }

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
      location_id: ctx.locationId,
      type: 'sms_sent',
      kind: 'event',
      subject: `SMS reminder: ${ctx.eventName}`,
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

// ═════════════════════════════════════════════════════════════════════════
// EVENTS-REMINDERS.1 — pre-event reminders for the STANDALONE events platform
// (race_events / race_registrations). Mig 384.
//
// ⚠️ DIFFERENT FEATURE from runEventReminderSends() above — they share only
// the word "reminder". That one keys off event_type_reminders + bookings
// (Calendly-style booking events); this one keys off race_events +
// race_registrations + event_reminder_sends and reminds confirmed *registrants*
// (Hyrox sims, workshops, seminars, …) T-3 days and T-1 day before the event,
// with each attendee's check-in QR + the event time/location.
//
// Reminders are TRANSACTIONAL (the registrant booked) so they are NOT gated on
// marketing consent — but a hard administrative opt-out
// (contact_preferences.email_administrative === false) IS respected.
//
// Idempotency: event_reminder_sends UNIQUE(registration_id, reminder_offset) is
// the guard. We CLAIM (insert) BEFORE sending; a unique-violation (23505) means
// a concurrent/previous run already handled it. Any non-unique claim error
// means we have no idempotency guard, so we do NOT send. Driven by a daily
// Vercel cron at /api/cron/event-reminders.
// ═════════════════════════════════════════════════════════════════════════

const EVENT_REMINDER_PAGE = 1000

/**
 * Which reminder offset (if any) a race date warrants relative to today.
 * Pure Europe/Dublin calendar arithmetic on YYYY-MM-DD strings — addDaysISO
 * does the math in UTC under the hood, so it never drifts across BST/GMT.
 *
 * @param {string} raceDateStr  YYYY-MM-DD (the event's race_date)
 * @param {string} todayStr     YYYY-MM-DD (Europe/Dublin "today")
 * @returns {'3d'|'1d'|null}    '3d' when raceDate===today+3, '1d' when ===today+1
 */
export function reminderOffsetForDate(raceDateStr, todayStr) {
  if (typeof raceDateStr !== 'string' || typeof todayStr !== 'string' || !raceDateStr || !todayStr) {
    return null
  }
  if (raceDateStr === addDaysISO(todayStr, 3)) return '3d'
  if (raceDateStr === addDaysISO(todayStr, 1)) return '1d'
  return null
}

function escapeReminderHtml(s) {
  if (s == null) return ''
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Branded transactional reminder email. Mirrors the race-confirmation copy
 * (black UN1T header + check-in QR grid). Every interpolated value is
 * HTML-escaped — a member name or event name can carry arbitrary text.
 *
 * @param {object} args
 * @param {string} args.eventName
 * @param {string} args.whenLabel      e.g. "Saturday, 11 July 2026 · 09:30"
 * @param {string} args.locationName
 * @param {Array<{name:string, qrSrc:string}>} args.members  one QR per attendee
 * @returns {string} HTML body
 */
export function buildReminderEmailHtml({ eventName, whenLabel, locationName, members } = {}) {
  const name = escapeReminderHtml(eventName || 'Your event')
  const when = escapeReminderHtml(whenLabel || '')
  const where = escapeReminderHtml(locationName || '')
  const list = Array.isArray(members) ? members : []
  const qrRows = list
    .filter((m) => m && m.qrSrc)
    .map((m) => `<tr>
      <td style="padding:10px 0;font-size:14px;vertical-align:middle">${escapeReminderHtml(m.name)}</td>
      <td style="padding:10px 0;text-align:right"><img src="${m.qrSrc}" alt="Check-in code" width="110" height="110" style="border:1px solid #eee;border-radius:8px"/></td>
    </tr>`)
    .join('')

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#fff;color:#111;max-width:560px;margin:0 auto;padding:24px">
  <div style="background:#000;color:#fff;padding:24px;text-align:center;letter-spacing:2px;font-weight:700;font-size:24px">UN1T</div>
  <h1 style="font-size:24px;margin:24px 0 8px">See you soon.</h1>
  <p style="margin:0 0 16px;color:#444;font-size:15px">A quick reminder for <strong>${name}</strong>.</p>

  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:24px 0;font-size:14px">
    ${when ? `<tr><td style="padding:8px 0;color:#666;width:120px">When</td><td style="padding:8px 0;font-weight:600">${when}</td></tr>` : ''}
    ${where ? `<tr><td style="padding:8px 0;color:#666">Where</td><td style="padding:8px 0;font-weight:600">${where}</td></tr>` : ''}
  </table>
${qrRows ? `
  <h3 style="font-size:16px;margin:24px 0 8px">Check-in codes</h3>
  <p style="margin:0 0 12px;color:#666;font-size:13px">Show your code to a team member at the door for a quick check-in.</p>
  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 24px">
    ${qrRows}
  </table>` : ''}
  <div style="background:#f5f5f5;padding:16px;border-radius:8px;font-size:13px;color:#333;line-height:1.5">
    <strong>Before you arrive:</strong> get here 30 minutes early, and bring water + a towel. Can't make it? Just reply to let us know.
  </div>

  <p style="color:#999;font-size:12px;margin-top:24px;text-align:center">UN1T${where ? ` · ${where}` : ''}</p>
</div>`.trim()
}

// Human "when" label for a registration — prefers the wave start time, falls
// back to the event's own start_time. The date renders in Europe/Dublin so a
// UTC-runtime cron still says the Dublin calendar day.
function reminderTimeLabel(reg, ev) {
  const t = reg?.wave?.start_time || ev?.start_time || null
  const hhmm = typeof t === 'string' ? t.slice(0, 5) : ''
  const dateLabel = formatWeekdayLongDateInTZ(ev?.race_date) || ev?.race_date || ''
  if (dateLabel && hhmm) return `${dateLabel} · ${hhmm}`
  return dateLabel || hhmm || ''
}

// One signed check-in QR per team member (captain first). Same URL shape as
// race-confirmations so the public /api/public/events/checkin-qr endpoint —
// which verifies against SUPABASE_SERVICE_ROLE_KEY — renders it.
function buildMemberQrs(reg, ev, appOrigin, secret) {
  const members = (reg?.teams?.team_members || []).slice().sort((a, b) =>
    (a.role === 'captain' ? 0 : 1) - (b.role === 'captain' ? 0 : 1) ||
    (a.name || '').localeCompare(b.name || '')
  )
  return members.map((m) => {
    if (!appOrigin || !secret || !ev?.id || !reg?.id || !m?.id) return { name: m.name, qrSrc: '' }
    const token = signCheckinToken({ eventId: ev.id, registrationId: reg.id, memberId: m.id }, secret)
    return { name: m.name, qrSrc: `${appOrigin}/api/public/events/checkin-qr?t=${encodeURIComponent(token)}` }
  })
}

function buildEventReminderPush({ ev, offset, whenLabel }) {
  const when = offset === '3d' ? 'in 3 days' : 'tomorrow'
  return {
    title: `${ev.name} is ${when}`,
    body: whenLabel ? `${whenLabel} — see you there 💪` : 'See you there 💪',
    data: { type: 'event_reminder', race_event_id: ev.id, reminder_offset: offset },
  }
}

// Send the reminder email to the registration's captain contact. Transactional,
// so marketing consent is irrelevant; the HARD administrative opt-out and
// bounced/complained/unsubscribed email states still suppress it.
async function sendReminderEmail({ ev, reg, offset, whenLabel, locationName, members }) {
  const c = reg?.contact
  const to = c?.email
  if (!to) return { status: 'skipped', reason: 'no_email' }
  if (c?.email_status && ['bounced', 'complained', 'unsubscribed'].includes(c.email_status)) {
    return { status: 'skipped', reason: `email_status=${c.email_status}` }
  }
  const prefs = c?.contact_preferences
  const adminConsent = Array.isArray(prefs) ? prefs[0]?.email_administrative : prefs?.email_administrative
  if (adminConsent === false) return { status: 'skipped', reason: 'opted_out_administrative_email' }

  const subject = offset === '3d'
    ? `Reminder: ${ev.name} is in 3 days`
    : `Reminder: ${ev.name} is tomorrow`
  const htmlBody = buildReminderEmailHtml({ eventName: ev.name, whenLabel, locationName, members })
  await sendTransactionalEmail({
    to,
    subject,
    htmlBody,
    contactId: reg.contact_id || null,
    locationId: ev.location_id || null,
    tag: 'event-reminder',
  })
  return { status: 'sent' }
}

/**
 * Daily orchestration. For every active, non-lead-gen race_event happening in
 * exactly 3 days or exactly 1 day (Europe/Dublin), send each CONFIRMED
 * registration one reminder (email + best-effort push) carrying the check-in
 * QRs + event time/location — claim-before-send against event_reminder_sends
 * so it never double-sends.
 *
 * @param {object} args
 * @param {import('@supabase/supabase-js').SupabaseClient} args.db  service-role client (injected for tests)
 * @param {string} [args.todayStr]  Europe/Dublin YYYY-MM-DD; defaults to dublinTodayStr()
 * @returns {Promise<{events:number, sent:number, skipped:number}>}
 */
export async function runEventReminders({ db, todayStr } = {}) {
  const result = { events: 0, sent: 0, skipped: 0 }
  if (!db) return result

  const today = todayStr || dublinTodayStr()
  const d3 = addDaysISO(today, 3)
  const d1 = addDaysISO(today, 1)

  // Candidate events — only the two target dates, active, and not lead_gen
  // (lead_gen events have no date/time and are pure capture forms). Small set.
  const { data: events, error: evErr } = await db
    .from('race_events')
    .select(`id, name, slug, race_date, start_time, location_id, kind, active,
             locations:location_id ( id, name )`)
    .in('race_date', [d3, d1])
    .eq('active', true)
    .neq('kind', 'lead_gen')
  if (evErr) {
    logError('event-reminders', 'event query failed', { err: evErr })
    return result
  }
  if (!events?.length) return result

  const appOrigin = (() => { try { return new URL(getAppUrl()).origin } catch { return '' } })()
  const checkinSecret = process.env.SUPABASE_SERVICE_ROLE_KEY || null

  for (const ev of events) {
    const offset = reminderOffsetForDate(ev.race_date, today)
    if (!offset) continue
    result.events++
    const locationName = ev.locations?.name || ''

    // Confirmed registrations for this event — paginate past the 1k-row cap.
    const registrations = []
    for (let from = 0; ; from += EVENT_REMINDER_PAGE) {
      const { data, error } = await db
        .from('race_registrations')
        .select(`
          id, race_event_id, contact_id, status,
          contact:contact_id ( id, email, name, first_name, email_status,
            contact_preferences ( email_administrative ) ),
          wave:wave_id ( id, start_time, label ),
          teams:team_id ( id, name, team_members ( id, name, role ) )
        `)
        .eq('race_event_id', ev.id)
        .eq('status', 'confirmed')
        .order('id', { ascending: true })
        .range(from, from + EVENT_REMINDER_PAGE - 1)
      if (error) {
        logError('event-reminders', 'registration query failed', { err: error, eventId: ev.id })
        break
      }
      registrations.push(...(data || []))
      if (!data || data.length < EVENT_REMINDER_PAGE) break
    }
    if (!registrations.length) continue

    // Cheap pre-skip of registrations already reminded for THIS offset. The
    // real guard is the UNIQUE claim below; this just avoids pointless inserts.
    const regIds = registrations.map((r) => r.id)
    const alreadySent = new Set()
    for (let i = 0; i < regIds.length; i += 200) {
      const chunk = regIds.slice(i, i + 200)
      const { data: sends, error: sErr } = await db
        .from('event_reminder_sends')
        .select('registration_id')
        .eq('reminder_offset', offset)
        .in('registration_id', chunk)
      if (sErr) { logError('event-reminders', 'sends lookup failed', { err: sErr }); continue }
      for (const s of sends || []) alreadySent.add(s.registration_id)
    }

    for (const reg of registrations) {
      // Each registration is isolated — one failure never blocks the rest.
      try {
        if (alreadySent.has(reg.id)) { result.skipped++; continue }

        // CLAIM FIRST. UNIQUE(registration_id, reminder_offset) is the
        // idempotency point: a 23505 means a concurrent/previous run already
        // owns this reminder. Any OTHER insert error means we have no guard,
        // so we must NOT send (skip rather than risk a double-send).
        const { error: claimErr } = await db
          .from('event_reminder_sends')
          .insert({ registration_id: reg.id, reminder_offset: offset })
        if (claimErr) {
          if (claimErr.code !== '23505') {
            logError('event-reminders', 'claim failed', { err: claimErr, registrationId: reg.id })
          }
          result.skipped++
          continue
        }

        const whenLabel = reminderTimeLabel(reg, ev)
        const members = buildMemberQrs(reg, ev, appOrigin, checkinSecret)

        // Email — respects the hard administrative opt-out. On an opt-out (or
        // any send failure) we KEEP the claim: an opted-out registrant must
        // not be re-attempted on tomorrow's tick for the same offset.
        try {
          await sendReminderEmail({ ev, reg, offset, whenLabel, locationName, members })
        } catch (e) {
          logError('event-reminders', 'email send failed', { err: e, registrationId: reg.id })
        }

        // Push — best-effort; sendCustomerPush handles token lookup + prefs.
        if (reg.contact_id) {
          try {
            await sendCustomerPush(db, reg.contact_id, buildEventReminderPush({ ev, offset, whenLabel }))
          } catch (e) {
            logError('event-reminders', 'push send failed', { err: e, registrationId: reg.id })
          }
        }

        result.sent++
      } catch (e) {
        logError('event-reminders', 'registration handling failed', { err: e, registrationId: reg?.id })
      }
    }
  }

  return result
}
