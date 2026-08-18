// Pre-event attendee reminders for the standalone events platform (EVENTS-
// REMINDERS.1, mig 384). Keyed off race_events / race_registrations /
// event_reminder_sends — reminds CONFIRMED registrants (Hyrox sims, workshops,
// seminars, …) T-3 days and T-1 day before the event, with each attendee's
// check-in QR + the event time/location.
//
// NOTE: distinct from src/lib/event-reminders.js (the Calendly-style
// event_type_reminders + bookings runner) — they share only the word
// "reminder". Kept in its own module for that reason (mirrors the
// race-confirmations.js vs booking-confirmations.js split).
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

import { sendTransactionalEmail } from '@/lib/postmark'
import { logError } from '@/lib/log'
import { signCheckinToken } from '@/lib/event-checkin-tokens'
import { getAppUrl } from '@/lib/app-url'
import { sendCustomerPush } from '@/lib/customer-push'
import { addDaysISO, dublinTodayStr } from '@/lib/dublin-time'
import { formatWeekdayLongDateInTZ } from '@/lib/dates'
import { buildEventEmailShell, resolveEventEmail, escapeHtml } from '@/lib/event-email'
import { resolveEventCommsLocation } from '@/lib/event-comms-location'

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

/**
 * Compose the DEFAULT (unconfigured) shell slots for the reminder email. Each
 * *Html slot is the exact raw fragment the old inline template produced, so
 * buildEventEmailShell reproduces today's email byte-for-byte. resolveEventEmail
 * layers per-event config on top.
 *
 * @param {object} args
 * @param {string} args.eventName
 * @param {string} args.whenLabel      e.g. "Saturday, 11 July 2026 · 09:30"
 * @param {string} args.locationName
 * @param {Array<{name:string, qrSrc:string}>} args.members  one QR per attendee
 * @returns {{ heading:string, introHtml:string, infoRows:string,
 *   afterInfoHtml:string, memberQrs:Array, footerHtml:string, locationName:string }}
 */
export function buildReminderDefaults({ eventName, whenLabel, locationName, members } = {}) {
  const name = escapeHtml(eventName || 'Your event')
  const when = escapeHtml(whenLabel || '')
  const where = escapeHtml(locationName || '')

  const infoRows = `    ${when ? `<tr><td style="padding:8px 0;color:#666;width:120px">When</td><td style="padding:8px 0;font-weight:600">${when}</td></tr>` : ''}
    ${where ? `<tr><td style="padding:8px 0;color:#666">Where</td><td style="padding:8px 0;font-weight:600">${where}</td></tr>` : ''}`

  return {
    heading: 'See you soon.',
    introHtml: `A quick reminder for <strong>${name}</strong>.`,
    infoRows,
    afterInfoHtml: '',
    memberQrs: Array.isArray(members) ? members : [],
    footerHtml: `<strong>Before you arrive:</strong> get here 30 minutes early, and bring water + a towel. Can't make it? Just reply to let us know.`,
    locationName: locationName || '',
  }
}

/**
 * Branded transactional reminder email — the shared shell with no per-event
 * tint (the DEFAULT look). Mirrors the race-confirmation copy (black UN1T
 * header + check-in QR grid). Every interpolated value is HTML-escaped — a
 * member name or event name can carry arbitrary text. Characterization-tested
 * byte-for-byte (event-email.test.js).
 *
 * @param {object} args  see buildReminderDefaults
 * @returns {string} HTML body
 */
export function buildReminderEmailHtml(args = {}) {
  const d = buildReminderDefaults(args)
  return buildEventEmailShell({
    heading: d.heading,
    introHtml: d.introHtml,
    accentHex: null,
    headerImageUrl: null,
    infoRows: d.infoRows,
    memberQrs: d.memberQrs,
    afterInfoHtml: d.afterInfoHtml,
    footerHtml: d.footerHtml,
    locationName: d.locationName,
  })
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
// bounced/complained email states still suppress it.
async function sendReminderEmail({ db, ev, reg, offset, whenLabel, locationName, members, commsLocationId }) {
  const c = reg?.contact
  const to = c?.email
  if (!to) return { status: 'skipped', reason: 'no_email' }
  // LOCCOMMS.5 — see booking-confirmations.js: transactional mail follows the
  // transaction, not a marketing list.
  if (c?.email_status && ['bounced', 'complained'].includes(c.email_status)) {
    return { status: 'skipped', reason: `email_status=${c.email_status}` }
  }
  const prefs = c?.contact_preferences
  const adminConsent = Array.isArray(prefs) ? prefs[0]?.email_administrative : prefs?.email_administrative
  if (adminConsent === false) return { status: 'skipped', reason: 'opted_out_administrative_email' }

  const defaultSubject = offset === '3d'
    ? `Reminder: ${ev.name} is in 3 days`
    : `Reminder: ${ev.name} is tomorrow`
  const extras = {
    event_name: ev.name,
    team_name: reg?.teams?.name || '',
    when: whenLabel || '',
    location: locationName || '',
  }
  const { subject, htmlBody } = await resolveEventEmail({
    db,
    kind: 'reminder',
    race: ev,
    contact: c || {},
    extras,
    defaults: {
      subject: defaultSubject,
      ...buildReminderDefaults({ eventName: ev.name, whenLabel, locationName, members }),
    },
  })
  await sendTransactionalEmail({
    to,
    subject,
    htmlBody,
    contactId: reg.contact_id || null,
    locationId: commsLocationId || null,
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
    .select(`id, name, slug, race_date, start_time, location_id, host_id, sending_location_id, kind, active,
             venue_name, venue_address,
             accent_hex, hero_image_url,
             reminder_email_subject, reminder_email_intro, reminder_email_template_id,
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
    // Host events point at a hidden anchor location ("<host> (host events)");
    // the real venue is on ev.venue_name. Prefer it so the reminder shows the
    // actual venue. UN1T events have no venue_name → the location name stands.
    const locationName = ev.venue_name || ev.locations?.name || ''
    const commsLocation = await resolveEventCommsLocation(db, {
      location_id: ev.location_id, host_id: ev.host_id, sending_location_id: ev.sending_location_id,
    })
    const commsLocationId = commsLocation?.id || ev.location_id || null

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
          await sendReminderEmail({ db, ev, reg, offset, whenLabel, locationName, members, commsLocationId })
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
