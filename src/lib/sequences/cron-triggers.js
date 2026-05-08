// Cron-driven sequence trigger runners.
//
// Each function is invoked by /api/cron/run-sequences on its own
// schedule and walks every active sequence of a specific
// trigger_type, finding candidates that match the time-window /
// signal-field criteria and enrolling them.
//
// Differences from webhook-driven triggers (./triggers.js):
//   • These don't take an entity ID — they sweep candidates from
//     scratch on each tick.
//   • They return { fired, skipped } stats so the cron logs can
//     show "20 fired, 130 dedup-skipped" per tick rather than
//     just "ok".
//   • Errors here propagate (cron handles them) instead of being
//     swallowed; webhook triggers swallow because the upstream
//     mutation must never fail because of a sequence trigger.
//
// All three share an audience-filter step + a per-(sequence,
// contact, sourceRef) dedup before enrol.

import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'
import { contactMatchesSequenceAudience } from './audience.js'
import { enrolContacts } from './enrol.js'

// ── event_reminder ──────────────────────────────────────────────

/**
 * Cron-driven trigger for event_reminder sequences. Called from
 * /api/cron/run-sequences alongside runSequences(). For each active
 * sequence with trigger_type='event_reminder', finds bookings whose
 * start time is approximately N hours away (where N comes from
 * trigger_config.hours_before) and enrols the booking's contact.
 *
 * Dedup: source_ref = booking.id, checked across ALL statuses (not
 * just active) so a contact who's already in this sequence for this
 * booking — even if it's already completed or exited — won't be
 * re-enrolled. Different bookings get separate enrolments.
 *
 * Timezone note: booking_date + start_time are stored as a naïve
 * date + time pair. We compose them and treat the result as UTC.
 * The studio is in Dublin (UTC in winter, UTC+1 in summer), so
 * around DST transitions the comparison can drift by up to an
 * hour — the 1-hour tolerance window absorbs that. operators
 * configure hours_before in coarse units (24h, 2h, etc.) so a
 * ±1h fire-time error is acceptable for "send roughly N hours
 * before the event".
 *
 * @returns {Promise<{fired: number, skipped: number}>}
 */
export async function runEventReminderTriggers() {
  const db = createServerClient()
  const stats = { fired: 0, skipped: 0 }

  const { data: sequences } = await db
    .from('email_sequences')
    .select('id, location_id, trigger_config, audience_filter')
    .eq('trigger_type', 'event_reminder')
    .eq('status', 'active')
  if (!sequences?.length) return stats

  const now = Date.now()
  const TOLERANCE_MS = 60 * 60 * 1000  // ±1h — see TZ note above

  for (const seq of sequences) {
    const cfg = seq.trigger_config || {}
    const hoursBefore = Number(cfg.hours_before)
    if (!Number.isFinite(hoursBefore) || hoursBefore < 0) continue

    const targetMs = now + hoursBefore * 3600_000
    const lo = new Date(targetMs - TOLERANCE_MS)
    const hi = new Date(targetMs + TOLERANCE_MS)

    // Wide date filter then exact in-window check below — the date
    // filter is just to avoid pulling the entire bookings table.
    const { data: bookings } = await db
      .from('bookings')
      .select('id, contact_id, booking_date, start_time, event_type_id')
      .eq('location_id', seq.location_id)
      .eq('status', 'confirmed')
      .gte('booking_date', lo.toISOString().slice(0, 10))
      .lte('booking_date', hi.toISOString().slice(0, 10))

    for (const booking of (bookings || [])) {
      if (!booking.contact_id) continue
      const bookingMs = new Date(`${booking.booking_date}T${booking.start_time}Z`).getTime()
      if (bookingMs < lo.getTime() || bookingMs > hi.getTime()) continue

      // Optional event_type_id scope — empty means "any event type".
      if (cfg.event_type_id && cfg.event_type_id !== booking.event_type_id) continue

      // Dedup across ALL enrollment statuses on (sequence, contact, booking).
      // Don't re-enrol the same person for the same booking even if
      // they've already completed or exited from this sequence.
      const { data: existing } = await db
        .from('sequence_enrollments')
        .select('id')
        .eq('sequence_id', seq.id)
        .eq('contact_id', booking.contact_id)
        .eq('source_ref', booking.id)
        .limit(1)
        .maybeSingle()
      if (existing) { stats.skipped++; continue }

      const matchesAudience = await contactMatchesSequenceAudience(db, booking.contact_id, seq.audience_filter)
      if (!matchesAudience) continue

      try {
        await enrolContacts({
          sequenceId: seq.id,
          contactIds: [booking.contact_id],
          sourceType: 'event_reminder',
          sourceRef: booking.id,
        })
        stats.fired++
      } catch (e) {
        logWarn('sequences', `event_reminder enrol failed for booking ${booking.id}`, { err: e })
      }
    }
  }

  return stats
}

// ── anniversary (Tier 2A) ───────────────────────────────────────

/**
 * Anniversary trigger (Tier 2A).
 *
 * Cron-driven. For each active sequence with
 * trigger_type='anniversary', enrol contacts whose
 * trigger_config.from_field timestamp is approximately
 * trigger_config.days_after days ago.
 *
 * trigger_config:
 *   - from_field: 'lead_created_at' | 'last_emailed_at' (default lead_created_at)
 *   - days_after: number (required)
 *
 * Dedup: source_ref is `${from_field}:${days_after}` so a contact
 * isn't re-enrolled in the same sequence on the same anniversary.
 * Different anniversaries (different sequences or different
 * days_after) are independent enrolments.
 *
 * Tolerance ±12 hours so a daily cron fires per contact, not 24×.
 */
export async function runAnniversaryTriggers() {
  const db = createServerClient()
  const stats = { fired: 0, skipped: 0 }
  const ALLOWED_FIELDS = new Set(['lead_created_at', 'last_emailed_at'])

  const { data: sequences } = await db
    .from('email_sequences')
    .select('id, location_id, trigger_config, audience_filter')
    .eq('trigger_type', 'anniversary')
    .eq('status', 'active')
  if (!sequences?.length) return stats

  const TOLERANCE_MS = 12 * 60 * 60 * 1000  // ±12h
  const now = Date.now()

  for (const seq of sequences) {
    const cfg = seq.trigger_config || {}
    const fromField = ALLOWED_FIELDS.has(cfg.from_field) ? cfg.from_field : 'lead_created_at'
    const daysAfter = Number(cfg.days_after)
    if (!Number.isFinite(daysAfter) || daysAfter < 0) continue

    const targetMs = now - daysAfter * 24 * 3600_000
    const lo = new Date(targetMs - TOLERANCE_MS)
    const hi = new Date(targetMs + TOLERANCE_MS)
    const sourceRef = `${fromField}:${daysAfter}`

    const { data: contacts } = await db
      .from('contacts')
      .select(`id, ${fromField}`)
      .eq('location_id', seq.location_id)
      .gte(fromField, lo.toISOString())
      .lte(fromField, hi.toISOString())
      .limit(500)

    for (const c of (contacts || [])) {
      if (!c.id) continue
      // Audience filter check (per-contact).
      const matches = await contactMatchesSequenceAudience(db, c.id, seq.audience_filter)
      if (!matches) continue
      // Dedup across all statuses on (sequence, contact, anniversary).
      const { data: existing } = await db
        .from('sequence_enrollments')
        .select('id')
        .eq('sequence_id', seq.id)
        .eq('contact_id', c.id)
        .eq('source_type', 'anniversary')
        .eq('source_ref', sourceRef)
        .limit(1)
      if (existing?.length) { stats.skipped++; continue }
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: [c.id],
        sourceType: 'anniversary',
        sourceRef,
      })
      stats.fired++
    }
  }
  return stats
}

// ── inactivity (Tier 2A) ────────────────────────────────────────

/**
 * Inactivity trigger (Tier 2A).
 *
 * Cron-driven. For each active sequence with
 * trigger_type='inactivity', enrol contacts who haven't been
 * "active" in trigger_config.days_inactive days.
 *
 * trigger_config:
 *   - signal: 'last_emailed_at' | 'last_email_open_at' | 'last_booking_at' (default last_emailed_at)
 *   - days_inactive: number (required)
 *
 * Dedup: source_ref = `${signal}:${days_inactive}`. Same as
 * anniversary — different signals or thresholds are independent.
 *
 * Implementation note: 'last_booking_at' is materialised on the
 * fly via the bookings table since contacts.last_booking_at isn't
 * a stored column today. last_emailed_at + last_email_open_at ARE
 * stored on contacts.
 */
export async function runInactivityTriggers() {
  const db = createServerClient()
  const stats = { fired: 0, skipped: 0 }
  const SIGNAL_FIELDS = {
    last_emailed_at: 'last_emailed_at',
    last_email_open_at: 'last_email_open_at',
  }

  const { data: sequences } = await db
    .from('email_sequences')
    .select('id, location_id, trigger_config, audience_filter')
    .eq('trigger_type', 'inactivity')
    .eq('status', 'active')
  if (!sequences?.length) return stats

  const now = Date.now()
  for (const seq of sequences) {
    const cfg = seq.trigger_config || {}
    const signal = cfg.signal || 'last_emailed_at'
    const days = Number(cfg.days_inactive)
    if (!Number.isFinite(days) || days <= 0) continue
    const cutoff = new Date(now - days * 24 * 3600_000).toISOString()
    const sourceRef = `${signal}:${days}`

    let candidates = []
    if (SIGNAL_FIELDS[signal]) {
      // Stored signal — direct query on contacts.
      const field = SIGNAL_FIELDS[signal]
      const { data } = await db
        .from('contacts')
        .select('id')
        .eq('location_id', seq.location_id)
        .lt(field, cutoff)
        .limit(500)
      candidates = data || []
    } else if (signal === 'last_booking_at') {
      // Derived signal — find contacts at the location whose most
      // recent booking is older than the cutoff. Pull recent
      // bookings and find which contacts DON'T appear → they're
      // the inactive ones. Capped at 500 contacts per location.
      const { data: contacts } = await db
        .from('contacts')
        .select('id')
        .eq('location_id', seq.location_id)
        .limit(500)
      const ids = (contacts || []).map((c) => c.id)
      if (ids.length === 0) continue
      const { data: recent } = await db
        .from('bookings')
        .select('contact_id')
        .in('contact_id', ids)
        .gte('booking_date', cutoff.slice(0, 10))
      const recentSet = new Set((recent || []).map((b) => b.contact_id))
      candidates = ids.filter((id) => !recentSet.has(id)).map((id) => ({ id }))
    } else {
      continue // unknown signal
    }

    for (const c of candidates) {
      const matches = await contactMatchesSequenceAudience(db, c.id, seq.audience_filter)
      if (!matches) continue
      const { data: existing } = await db
        .from('sequence_enrollments')
        .select('id')
        .eq('sequence_id', seq.id)
        .eq('contact_id', c.id)
        .eq('source_type', 'inactivity')
        .eq('source_ref', sourceRef)
        .limit(1)
      if (existing?.length) { stats.skipped++; continue }
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: [c.id],
        sourceType: 'inactivity',
        sourceRef,
      })
      stats.fired++
    }
  }
  return stats
}
