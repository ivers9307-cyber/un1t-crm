// HOSTPAGE.2 — the "How was <event>?" request, the morning after a HOST
// event. An ARM of the hourly /api/cron/event-reminders run on its own daily
// slot ('event-rating-requests', 09:00 on each studio's clock) and its own
// heartbeat row (cron-arm-health.js EVENT_RATING_REQUESTS_HEARTBEAT, mig 824).
//
// Sends like a reminder (Builder-check decision 7): identity from
// resolveEventCommsLocation (fail-open to the event's location), the
// transactional consent gate (hard bounce/complaint + the administrative
// opt-out), copy through resolveEventEmail({ kind: 'rating' }) so
// race_events.rating_email_subject/intro override the defaults. Claim-before-
// send on event_rating_requests (registration_id unique): a 23505 is "already
// asked"; any other claim error is the arm's own fault and nothing is sent.
// A failed send or an opt-out KEEPS the claim — one ask per entry, ever.
// Hosts' events only (host_id not null): a UN1T event never asks.

import { createServerClient } from '@/lib/supabase'
import { sendTransactionalEmail } from '@/lib/postmark'
import { logError, logWarn } from '@/lib/log'
import { getAppUrl } from '@/lib/app-url'
import { addDaysISO, dayStrIn } from '@/lib/location-time'
import { eventToday } from '@/lib/event-day'
import { resolveEventEmail } from '@/lib/event-email'
import { resolveEventCommsLocation } from '@/lib/event-comms-location'
import { transactionalEmailSuppression } from '@/lib/transactional-consent'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { ratingUrl, ratingRequestDefaults } from '@/lib/event-ratings'

const PAGE = 500

/**
 * @param {{ db?: object, nowMs?: number, isDue?: (locationId: string|null) => boolean }} args
 * @returns {Promise<{ events: number, sent: number, skipped: number, request_read_failed: number, claim_failed: number }>}
 */
export async function runRatingRequests({ db = createServerClient(), nowMs = Date.now(), isDue } = {}) {
  const out = { events: 0, sent: 0, skipped: 0, request_read_failed: 0, claim_failed: 0 }

  // "Yesterday" on some studio's clock is UTC day -2 … 0; each event is then
  // judged on its own studio's today below.
  const utcToday = dayStrIn(nowMs, 'UTC')
  const raceDates = [-2, -1, 0].map((n) => addDaysISO(utcToday, n))
  const { data: events, error: evErr } = await db
    .from('race_events')
    .select(`id, name, slug, race_date, location_id, host_id, sending_location_id, accent_hex, hero_image_url,
             rating_email_subject, rating_email_intro,
             host:event_hosts!host_id ( id, name, anchor_location_id ),
             locations:location_id ( id, name, is_host_anchor, timezone )`)
    .in('race_date', raceDates)
    .eq('active', true)
    .eq('status', 'published')
    .not('host_id', 'is', null)
    .neq('kind', 'lead_gen')
  if (evErr) {
    logError('event-rating-requests', 'event query failed', { err: evErr })
    out.request_read_failed += 1
    return out
  }

  for (const ev of events || []) {
    if (isDue && !isDue(ev.location_id || null)) continue
    if (ev.race_date !== addDaysISO(eventToday(ev, nowMs), -1)) continue
    out.events += 1

    let commsLocationId = ev.location_id || null
    try {
      const comms = await resolveEventCommsLocation(db, { location_id: ev.location_id, host_id: ev.host_id, sending_location_id: ev.sending_location_id })
      if (comms?.id) commsLocationId = comms.id
    } catch (e) {
      logError('event-rating-requests', 'comms location resolver threw; sending from the event location', { err: e, eventId: ev.id })
    }
    let baseUrl
    try { baseUrl = await resolveCustomerBaseUrl(db, ev.location_id || null) } catch { baseUrl = null }
    if (!baseUrl) { try { baseUrl = new URL(getAppUrl()).origin } catch { baseUrl = null } }

    const registrations = []
    let readFailed = false
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('race_registrations')
        .select(`id, contact_id, contact:contact_id ( id, email, first_name, name, email_status, contact_preferences ( email_administrative ) )`)
        .eq('race_event_id', ev.id)
        .eq('status', 'confirmed')
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) {
        logError('event-rating-requests', 'registration query failed', { err: error, eventId: ev.id })
        readFailed = true
        break
      }
      registrations.push(...(data || []))
      if (!data || data.length < PAGE) break
    }
    if (readFailed) { out.request_read_failed += 1; continue }
    if (!registrations.length) continue

    const already = new Set()
    const ids = registrations.map((r) => r.id)
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db.from('event_rating_requests').select('registration_id').in('registration_id', ids.slice(i, i + 200))
      if (error) { logError('event-rating-requests', 'requests lookup failed', { err: error, eventId: ev.id }); continue }
      for (const r of data || []) already.add(r.registration_id)
    }

    for (const reg of registrations) {
      try {
        if (already.has(reg.id)) { out.skipped += 1; continue }
        const { error: claimErr } = await db.from('event_rating_requests').insert({ registration_id: reg.id, race_event_id: ev.id })
        if (claimErr) {
          if (claimErr.code !== '23505') {
            logError('event-rating-requests', 'claim failed', { err: claimErr, registrationId: reg.id })
            out.claim_failed += 1
          }
          out.skipped += 1
          continue
        }
        const c = reg.contact
        if (!c?.email || transactionalEmailSuppression(c)) { out.skipped += 1; continue }
        const rateUrl = baseUrl ? ratingUrl({ registrationId: reg.id, eventId: ev.id, baseUrl, nowMs }) : null
        if (!rateUrl) {
          logWarn('event-rating-requests', 'no rate link (no signing secret or base url); request not sent', { registrationId: reg.id })
          out.skipped += 1
          continue
        }
        const hostName = ev.host?.name || ''
        const defaults = ratingRequestDefaults({ eventName: ev.name, hostName, rateUrl })
        const { subject, htmlBody } = await resolveEventEmail({
          db,
          kind: 'rating',
          race: ev,
          contact: c,
          extras: { event_name: ev.name, host_name: hostName, rate_url: rateUrl },
          defaults,
          brandLocationId: commsLocationId,
        })
        await sendTransactionalEmail({ to: c.email, subject, htmlBody, contactId: reg.contact_id || null, locationId: commsLocationId, tag: 'event-rating-request' })
        out.sent += 1
      } catch (e) {
        logError('event-rating-requests', 'registration handling failed', { err: e, registrationId: reg?.id })
        out.skipped += 1
      }
    }
  }
  return out
}
