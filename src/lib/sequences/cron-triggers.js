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
//   • They return { fired, skipped, errored } stats so the cron logs
//     can show "20 fired, 130 dedup-skipped, 1 errored" per tick
//     rather than just "ok".
//
// All three share an audience-filter step + a per-(sequence,
// contact, sourceRef) dedup before enrol.
//
// CRONISO.1 — BLAST RADIUS. Each runner walks EVERY active sequence of
// its trigger_type across EVERY location in one loop. selectAll throws
// on a query error, enrolContacts can throw, and the audience check
// hits the DB — so before this, any failure on ONE sequence propagated
// out of the runner and abandoned the rest of the sweep: every
// remaining sequence, at every other location, silently did nothing for
// that tick. The only symptom was a console.warn at the cron boundary,
// which is not something anyone reads. Each sequence now runs inside
// its own try/catch: a failure costs exactly one sequence, is logged
// with that sequence's id, and is counted in stats.errored so the cron
// response shows it without a log dive.
//
// `errored` also counts sequences rejected for a bad trigger_config
// (unknown signal/from_field, missing or non-numeric window). Those are
// active sequences doing nothing on every tick, forever — the same
// invisible failure, just a permanent one.

import { createServerClient } from '@/lib/supabase'
import { logWarn, logError } from '@/lib/log'
import { dayStrIn, todayStrIn, DAY_MS, DEFAULT_TZ, getLocationZones, LocationZoneReadError, zonedWallClockToInstant } from '@/lib/location-time'
import { selectAll, selectAllByKeys } from '@/lib/select-all'
import { contactMatchesSequenceAudience } from './audience.js'
import { enrolContacts } from './enrol.js'
import { buildEligibleAudienceQuery } from '@/lib/audience-eligibility'
import { clampToSendWindow, hasSendWindow } from './scheduler.js'
import { ANNIVERSARY_FROM_FIELDS, DEFAULT_ANNIVERSARY_FROM_FIELD } from './anniversary-fields.js'

// GAPS-P3.2 — re-exported so callers that already import the runner get
// the whitelist from the same place. The list itself lives in the
// import-free ./anniversary-fields.js because the settings dropdown is a
// client component and this module pulls the service-role client.
export { ANNIVERSARY_FROM_FIELDS }

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
 * Timezone (TZ.17): booking_date + start_time are the studio's wall
 * clock (CLAUDE.md), so they become an instant through
 * zonedWallClockToInstant in the sequence studio's zone, and the
 * booking_date pre-filter is that studio's calendar days. Until TZ.17
 * the pair was read as UTC, which in Irish summer time put every
 * booking an hour late (the ±1h tolerance hid it) and could miss a
 * 00:xx booking from the UTC-date pre-filter. Exactly-once is unchanged:
 * the dedup below is on (sequence, contact, booking) across every
 * enrolment status, so a booking the old window already enrolled is
 * skipped by the new one, whatever the overlap on the deploy day.
 *
 * @returns {Promise<{fired: number, skipped: number, errored: number}>}
 */
export async function runEventReminderTriggers() {
  const db = createServerClient()
  const stats = { fired: 0, skipped: 0, errored: 0 }

  const { data: sequences } = await db
    .from('email_sequences')
    .select('id, location_id, trigger_config, audience_filter')
    .eq('trigger_type', 'event_reminder')
    .eq('status', 'active')
  if (!sequences?.length) return stats

  const now = Date.now()
  const TOLERANCE_MS = 60 * 60 * 1000  // ±1h — the cron's tick slack, not a zone fudge

  // TZ.17 — every sequence's studio zone, read once (an unreadable zone skips
  // the tick: a reminder on a guessed clock fires at the wrong hour).
  const zones = await sequenceZones(db, sequences, 'event_reminder')
  if (!zones) { stats.errored += sequences.length; return stats }

  for (const seq of sequences) {
    // CRONISO.1 — per-sequence isolation. See the module header.
    try {
      const cfg = seq.trigger_config || {}
      const hoursBefore = Number(cfg.hours_before)
      if (!Number.isFinite(hoursBefore) || hoursBefore < 0) {
        stats.errored++
        logError('sequences', `event_reminder sequence ${seq.id}: hours_before is missing or invalid ('${cfg.hours_before}') — sequence skipped until its trigger_config is fixed`, { sequenceId: seq.id, hoursBefore: cfg.hours_before })
        continue
      }

      const zone = zoneOfSequence(zones, seq)
      const { loMs, hiMs, loDay, hiDay } = eventReminderWindow(now, hoursBefore, zone, TOLERANCE_MS)

      // Wide date filter then exact in-window check below — the date
      // filter is just to avoid pulling the entire bookings table.
      const { data: bookings, error: bookingsErr } = await db
        .from('bookings')
        .select('id, contact_id, booking_date, start_time, event_type_id')
        .eq('location_id', seq.location_id)
        .eq('status', 'confirmed')
        .gte('booking_date', loDay)
        .lte('booking_date', hiDay)
      // This read used to drop its error on the floor: a failed lookup
      // produced `undefined` bookings and read as "nothing due", so a
      // broken reminder sweep looked identical to a quiet one.
      if (bookingsErr) throw new Error(bookingsErr.message || String(bookingsErr))

      for (const booking of (bookings || [])) {
        if (!booking.contact_id) continue
        const bookingMs = zonedWallClockToInstant(booking.booking_date, booking.start_time, zone)
        if (bookingMs === null || bookingMs < loMs || bookingMs > hiMs) continue

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

        const matchesAudience = await contactMatchesSequenceAudience(db, booking.contact_id, seq.audience_filter, { locationId: seq.location_id })
        if (!matchesAudience) continue

        // Kept narrower than the per-sequence catch: one contact's enrol
        // failing shouldn't abandon the rest of THIS sequence's bookings.
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
    } catch (e) {
      stats.errored++
      logError('sequences', `event_reminder sequence ${seq.id} failed — skipped for this tick, other sequences unaffected`, { sequenceId: seq.id, locationId: seq.location_id, err: e })
    }
  }

  return stats
}

/**
 * TZ.17 — the event_reminder match window: instants [loMs, hiMs] around
 * now + hoursBefore, and the studio-calendar days that bound the
 * booking_date pre-filter. Pure.
 * @returns {{ loMs: number, hiMs: number, loDay: string, hiDay: string }}
 */
export function eventReminderWindow(nowMs, hoursBefore, zone, toleranceMs = 60 * 60 * 1000) {
  const targetMs = nowMs + hoursBefore * 3600_000
  const loMs = targetMs - toleranceMs
  const hiMs = targetMs + toleranceMs
  return { loMs, hiMs, loDay: dayStrIn(loMs, zone), hiDay: dayStrIn(hiMs, zone) }
}

// ── TZ.4: each sequence's studio zone ───────────────────────────

/**
 * The zone of every sequence's location, read ONCE per run (one batched
 * query, cached 60 s by location-time). Returns null when the read FAILED:
 * the caller then skips every sequence this tick (counted in
 * stats.errored and logged), because acting for a non-Dublin studio on a
 * guessed Dublin clock would enrol the wrong day's contacts or open a send
 * window at the wrong hour. Any other error propagates, as before.
 *
 * @param {object} db
 * @param {Array<{location_id: string|null}>} sequences
 * @param {string} runner  for the log line
 * @returns {Promise<Map<string,string>|null>}
 */
async function sequenceZones(db, sequences, runner) {
  try {
    return await getLocationZones(db, sequences.map((s) => s.location_id))
  } catch (e) {
    if (!(e instanceof LocationZoneReadError)) throw e
    logError('sequences', `${runner}: studio timezones unreadable — every sequence skipped this tick, nothing enrolled`, {
      locationIds: e.locationIds, err: e,
    })
    return null
  }
}

/** A sequence's zone from sequenceZones' map (DEFAULT_TZ for a sequence with no location). */
function zoneOfSequence(zones, seq) {
  return (seq.location_id && zones.get(seq.location_id)) || DEFAULT_TZ
}

/**
 * Anniversary dedup year: the year of TODAY in the sequence's studio zone.
 * @param {number} nowMs
 * @param {string} zone
 */
export function anniversaryOccurrenceYear(nowMs, zone) {
  return todayStrIn(zone, nowMs).slice(0, 4)
}

/**
 * The 'MM-DD' a `dob` anniversary matches: the studio-local day `daysAfter`
 * days before now. Kept as "the local day of now minus N×24h", the exact
 * pre-TZ.4 arithmetic, so Europe/Dublin is byte-identical (src/lib/tz-4.tz.test.js).
 * (Within N days after a DST change that instant is an hour off a calendar
 * day, so during one local hour the target is the neighbouring day; a
 * birthday still fires once a year, on the right day, give or take that hour.)
 * @param {number} nowMs
 * @param {number} daysAfter
 * @param {string} zone
 */
export function birthdayTargetMonthDay(nowMs, daysAfter, zone) {
  return dayStrIn(nowMs - daysAfter * DAY_MS, zone).slice(5)
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
 *   - from_field: 'lead_created_at' | 'last_emailed_at' | 'joined_at' | 'dob'
 *     (default lead_created_at; an UNKNOWN field is a config error — the
 *     sequence is skipped with a logged error, never silently remapped.
 *     COMMSFIX.E.3: the old silent fallback to lead_created_at is how the
 *     birthday template greeted every freshly-created lead instead.)
 *   - days_after: number (required)
 *
 * 'dob' is special-cased: it matches on month+day in the sequence
 * location's calendar (TZ.4; year-modulo — any birth year), so birthdays
 * actually fire on birthdays. Feb-29 birthdays match only in leap years.
 *
 * Dedup: source_ref is `${from_field}:${days_after}:${occurrenceYear}`
 * so a contact isn't re-enrolled for the SAME occurrence, but next
 * year's occurrence is a fresh ref and re-fires — still subject to
 * re_enrolment_cooldown_days (enforced inside enrolContacts).
 * Different anniversaries (different sequences or different
 * days_after) are independent enrolments.
 *
 * Tolerance ±12 hours so a daily cron fires per contact, not 24×.
 */
export async function runAnniversaryTriggers() {
  const db = createServerClient()
  const stats = { fired: 0, skipped: 0, errored: 0 }

  const { data: sequences } = await db
    .from('email_sequences')
    .select('id, location_id, trigger_config, audience_filter')
    .eq('trigger_type', 'anniversary')
    .eq('status', 'active')
  if (!sequences?.length) return stats

  const TOLERANCE_MS = 12 * 60 * 60 * 1000  // ±12h
  const now = Date.now()
  // TZ.4 — every studio's zone, once per run; null = the read failed.
  const zones = await sequenceZones(db, sequences, 'anniversary')
  if (!zones) { stats.errored += sequences.length; return stats }

  for (const seq of sequences) {
    // CRONISO.1 — per-sequence isolation. See the module header.
    try {
      const cfg = seq.trigger_config || {}
      const fromField = cfg.from_field || DEFAULT_ANNIVERSARY_FROM_FIELD
      // COMMSFIX.E.3 — an unknown field is a CONFIG ERROR, not a hint. The
      // old silent fallback to lead_created_at made the birthday template
      // ({ from_field: 'dob' }) greet every lead created that day instead
      // of anyone on their birthday. Reject loudly; the operator must fix
      // the trigger config.
      // GAPS-P3.2 — one shared whitelist (./anniversary-fields.js), so the
      // dropdown that offers a field and the packaged templates that drive
      // one are testable against the list this guard enforces.
      if (!ANNIVERSARY_FROM_FIELDS.includes(fromField)) {
        stats.errored++
        logError('sequences', `anniversary sequence ${seq.id}: unknown from_field '${fromField}' — sequence skipped until its trigger_config is fixed`, { sequenceId: seq.id, fromField })
        continue
      }
      const daysAfter = Number(cfg.days_after)
      if (!Number.isFinite(daysAfter) || daysAfter < 0) {
        stats.errored++
        logError('sequences', `anniversary sequence ${seq.id}: days_after is missing or invalid ('${cfg.days_after}') — sequence skipped until its trigger_config is fixed`, { sequenceId: seq.id, daysAfter: cfg.days_after })
        continue
      }

      // Occurrence year (the studio's wall clock, TZ.4) — part of the dedup
      // ref so the same anniversary re-fires next year (COMMSFIX.E.3).
      const zone = zoneOfSequence(zones, seq)
      const occurrenceYear = anniversaryOccurrenceYear(now, zone)
      const sourceRef = `${fromField}:${daysAfter}:${occurrenceYear}`

      let contacts
      if (fromField === 'dob') {
        // Birthdays match on month+day in the studio's calendar, any birth
        // year — a gte/lte window on the raw date can never express that.
        // The target day is `days_after` days before today (days_after: 0
        // = the birthday itself). dob is a DATE column ('YYYY-MM-DD'), so
        // compare string month-day slices; no Date parsing, no TZ drift.
        const targetMonthDay = birthdayTargetMonthDay(now, daysAfter, zone) // 'MM-DD'
        const withDob = await selectAll((from, to) => db
          .from('contacts')
          .select('id, dob')
          .eq('location_id', seq.location_id)
          .not('dob', 'is', null)
          .order('id')
          .range(from, to))
        contacts = withDob.filter((c) => typeof c.dob === 'string' && c.dob.slice(5, 10) === targetMonthDay)
      } else {
        const targetMs = now - daysAfter * 24 * 3600_000
        const lo = new Date(targetMs - TOLERANCE_MS)
        const hi = new Date(targetMs + TOLERANCE_MS)

        // COMMSFIX.E.2 — page the FULL matching set (.order('id') + .range(),
        // the selectAll/CAMPAIGN.14 recipe). The old unordered .limit(500)
        // returned the DB's arbitrary first 500 rows every tick; contacts
        // beyond row 500 were never swept.
        contacts = await selectAll((from, to) => db
          .from('contacts')
          .select(`id, ${fromField}`)
          .eq('location_id', seq.location_id)
          .gte(fromField, lo.toISOString())
          .lte(fromField, hi.toISOString())
          .order('id')
          .range(from, to))
      }

      for (const c of (contacts || [])) {
        if (!c.id) continue
        // Audience filter check (per-contact).
        const matches = await contactMatchesSequenceAudience(db, c.id, seq.audience_filter, { locationId: seq.location_id })
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
    } catch (e) {
      stats.errored++
      logError('sequences', `anniversary sequence ${seq.id} failed — skipped for this tick, other sequences unaffected`, { sequenceId: seq.id, locationId: seq.location_id, err: e })
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
 * a stored column. The signals in INACTIVITY_SIGNAL_FIELDS are
 * stored columns on contacts and queried directly.
 *
 * GAPS-P1 — that last sentence used to be asserted of
 * last_email_open_at and was FALSE: no such column existed on
 * public.contacts (live information_schema, 2026-08-09) while this
 * whitelist, the SequenceSettings dropdown and both packaged
 * win-back templates all drove it. mig 511 makes it real and
 * backfills it; the whitelist is exported so a test can hold every
 * stored signal against the AUDIENCE_FIELDS registry of real
 * contacts columns rather than against a comment.
 */

/**
 * Stored inactivity signals: config value → contacts column.
 *
 * Mirrored by INACT_SIGNALS in SequenceSettings.jsx (plus the
 * derived 'last_booking_at'). An entry here MUST be a real column —
 * selectAll throws on query error. Since CRONISO.1 that costs only the
 * sequences configured with the bad signal (they log + count as
 * errored) rather than the whole sweep, but a name in this list that
 * isn't a column still means those sequences never fire.
 */
export const INACTIVITY_SIGNAL_FIELDS = Object.freeze({
  last_emailed_at: 'last_emailed_at',
  last_email_open_at: 'last_email_open_at',
})

export async function runInactivityTriggers() {
  const db = createServerClient()
  const stats = { fired: 0, skipped: 0, errored: 0 }
  const SIGNAL_FIELDS = INACTIVITY_SIGNAL_FIELDS

  const { data: sequences } = await db
    .from('email_sequences')
    .select('id, location_id, trigger_config, audience_filter')
    .eq('trigger_type', 'inactivity')
    .eq('status', 'active')
  if (!sequences?.length) return stats

  const now = Date.now()
  for (const seq of sequences) {
    // CRONISO.1 — per-sequence isolation. See the module header.
    try {
      const cfg = seq.trigger_config || {}
      const signal = cfg.signal || 'last_emailed_at'
      const days = Number(cfg.days_inactive)
      if (!Number.isFinite(days) || days <= 0) {
        stats.errored++
        logError('sequences', `inactivity sequence ${seq.id}: days_inactive is missing or invalid ('${cfg.days_inactive}') — sequence skipped until its trigger_config is fixed`, { sequenceId: seq.id, daysInactive: cfg.days_inactive })
        continue
      }
      const cutoff = new Date(now - days * 24 * 3600_000).toISOString()
      const sourceRef = `${signal}:${days}`

      let candidates = []
      if (SIGNAL_FIELDS[signal]) {
        // Stored signal — direct query on contacts. COMMSFIX.E.2: page the
        // FULL matching set (.order('id') + .range(), the selectAll recipe) —
        // the old unordered .limit(500) returned the same arbitrary 500 rows
        // every tick, so contacts beyond row 500 were never swept.
        const field = SIGNAL_FIELDS[signal]
        candidates = await selectAll((from, to) => db
          .from('contacts')
          .select('id')
          .eq('location_id', seq.location_id)
          .lt(field, cutoff)
          .order('id')
          .range(from, to))
      } else if (signal === 'last_booking_at') {
        // Derived signal — find contacts at the location whose most
        // recent booking is older than the cutoff. Pull recent
        // bookings and find which contacts DON'T appear → they're
        // the inactive ones. COMMSFIX.E.2: scan ALL location contacts
        // (paginated), and chunk the bookings .in() lookup via
        // selectAllByKeys — a bare .in() with thousands of ids both
        // overflows the request URL and caps its match set at 1000.
        const contacts = await selectAll((from, to) => db
          .from('contacts')
          .select('id')
          .eq('location_id', seq.location_id)
          .order('id')
          .range(from, to))
        const ids = contacts.map((c) => c.id)
        if (ids.length === 0) continue
        const recent = await selectAllByKeys(ids, (keys, from, to) => db
          .from('bookings')
          .select('contact_id')
          .in('contact_id', keys)
          .gte('booking_date', cutoff.slice(0, 10))
          .order('id')
          .range(from, to))
        const recentSet = new Set(recent.map((b) => b.contact_id))
        candidates = ids.filter((id) => !recentSet.has(id)).map((id) => ({ id }))
      } else {
        // Unknown signal — a config error, and until CRONISO.1 not even
        // logged: an active sequence quietly did nothing on every tick.
        stats.errored++
        logError('sequences', `inactivity sequence ${seq.id}: unknown signal '${signal}' — sequence skipped until its trigger_config is fixed`, { sequenceId: seq.id, signal })
        continue
      }

      for (const c of candidates) {
        const matches = await contactMatchesSequenceAudience(db, c.id, seq.audience_filter, { locationId: seq.location_id })
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
    } catch (e) {
      stats.errored++
      logError('sequences', `inactivity sequence ${seq.id} failed — skipped for this tick, other sequences unaffected`, { sequenceId: seq.id, locationId: seq.location_id, err: e })
    }
  }
  return stats
}

// ─── AUDIENCEMATCH.1: audience_match — "everyone matching, now and ongoing" ───

// Enrolment WRITES per sweep tick, per sequence. Deliberately HALF
// PROCESS_BATCH_SIZE (scheduler.js), which is the runner's global FIFO budget
// across every sequence and every location. The irreversible artifact here is
// the enrolment row, not the send — a row cannot be un-enrolled and re-run —
// so the write rate IS the abort window. Capping at half leaves 50 slots per
// tick for real-time triggers, so a 2,000-person backfill can never starve the
// new-lead nudge behind it. 50/tick = 600/hour.
export const AUDIENCE_SWEEP_ENROL_CAP = 50

/**
 * Sweep every active `audience_match` sequence and enrol everyone who matches
 * its audience but has no enrolment row yet.
 *
 * Gated on THREE things, all of which must hold:
 *   1. `audience_seeded_at` is set — a human confirmed the headcount (mig 556).
 *   2. `now` is inside the sequence's sending window.
 *   3. the audience filter is non-empty.
 *
 * On (2): the runner only clamps the FOLLOWING step's fire time
 * (scheduler.js), and enrolContacts hardcodes `next_step_at = now()`. So a
 * sequence's FIRST step fires whenever enrolment happened — a sweep at 03:00
 * would mail everyone at 03:05, outside the sequence's own window and inside
 * the location's quiet hours. Rather than stagger per-row fire times, the
 * sweep simply does not run outside the window. One rule, no arithmetic, and
 * it is impossible to mail anyone at 3am.
 *
 * On (3): an empty filter matches EVERY contact at the location. Refusing it
 * is not defensive tidiness — `{logic:'and',filters:[]}` is the builder's
 * DEFAULT state (audience-filter.js), so it is what a half-configured sequence
 * looks like, not what "everyone" looks like when someone means it.
 */
export async function runAudienceMatchTriggers({ now = new Date() } = {}) {
  const db = createServerClient()
  const stats = { fired: 0, skipped: 0, awaiting_seed: 0, out_of_window: 0, errored: 0 }

  const { data: sequences, error } = await db
    .from('email_sequences')
    .select('id, location_id, audience_filter, audience_seeded_at, send_window')
    .eq('trigger_type', 'audience_match')
    .eq('status', 'active')
  if (error) throw new Error(`audience_match: sequence lookup failed: ${error.message}`)
  if (!sequences?.length) return stats
  // TZ.4 — every studio's zone, once per run; null = the read failed, and
  // then no sequence may open its window on a guessed clock.
  const zones = await sequenceZones(db, sequences, 'audience_match')
  if (!zones) { stats.errored += sequences.length; return stats }

  for (const seq of sequences) {
    // CRONISO.1 — per-sequence isolation. See the module header.
    try {
      // 1. Not confirmed → enrol nobody, forever. This is the guard.
      if (!seq.audience_seeded_at) { stats.awaiting_seed++; continue }

      // 2. Outside the sending window → the first email would land out of hours.
      if (!isInsideSendWindow(now, seq.send_window, zoneOfSequence(zones, seq))) { stats.out_of_window++; continue }

      // 3. An empty filter is a half-built sequence, not "everyone".
      const filters = seq.audience_filter?.filters
      if (!Array.isArray(filters) || filters.length === 0) {
        stats.errored++
        logError('sequences', `audience_match sequence ${seq.id}: audience_filter is empty — refusing to enrol every contact at the location`, { sequenceId: seq.id })
        continue
      }

      // Candidates come from the SAME builder the preview and the send path
      // use (audience-eligibility.js), so the number an operator confirmed and
      // the set this enrols cannot drift apart.
      const { query } = await buildEligibleAudienceQuery({
        db, channel: null, filter: seq.audience_filter, locationId: seq.location_id, columns: 'id',
      })
      const matching = await selectAll((from, to) => query.order('id').range(from, to))
      if (matching.length === 0) { continue }

      // "Already handled" is the enrolment table itself — one permanent row per
      // (sequence, contact), surviving every status transition. No snapshot needed.
      const enrolled = await selectAll((from, to) => db
        .from('sequence_enrollments')
        .select('contact_id')
        .eq('sequence_id', seq.id)
        .order('contact_id')
        .range(from, to))
      const seen = new Set(enrolled.map(r => r.contact_id))

      const fresh = matching.map(c => c.id).filter(id => !seen.has(id))
      if (fresh.length === 0) { continue }

      // Cap the WRITES, not the sends. Whatever is left is picked up next tick;
      // "matches and has no enrolment row" resumes correctly with no cursor.
      const batch = fresh.slice(0, AUDIENCE_SWEEP_ENROL_CAP)
      const { enrolled: n } = await enrolContacts({
        sequenceId: seq.id,
        contactIds: batch,
        // NOT a MANUAL_LIKE source type — this is automatic, so
        // contacts.automations_exempt still excludes host master-profile leads.
        sourceType: 'audience_match',
        sourceRef: null,
      })
      stats.fired += n
      stats.skipped += batch.length - n
      if (fresh.length > batch.length) {
        logWarn('sequences', `audience_match sequence ${seq.id}: enrolled ${n} of ${fresh.length} matching, remainder next tick`, {
          sequenceId: seq.id, enrolled: n, remaining: fresh.length - batch.length,
        })
      }
    } catch (e) {
      stats.errored++
      logError('sequences', `audience_match sequence ${seq.id} failed: ${e.message || e}`, { sequenceId: seq.id })
    }
  }
  return stats
}

/**
 * True when `now` is inside the sequence's own send window. A sequence with no
 * window configured is unconstrained here — the runner's quiet-hours fallback
 * still applies to every step AFTER the first, and refusing to sweep at all
 * without a window would make the feature unusable for anyone who has not set
 * one.
 *
 * Reuses the runner's own clamp so the two can never disagree about what
 * "inside the window" means: if clamping `now` returns `now`, we are inside it.
 * TZ.4: `zone` is the sequence location's zone (default Europe/Dublin).
 */
export function isInsideSendWindow(now, sendWindow, zone = DEFAULT_TZ) {
  if (!hasSendWindow(sendWindow)) return true
  return clampToSendWindow(now, sendWindow, zone).getTime() === now.getTime()
}
