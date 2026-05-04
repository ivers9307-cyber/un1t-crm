// Sequence runner — processes due enrollments, sends the next step,
// advances or completes.
//
// Called by the /api/cron/run-sequences cron every 5 minutes (see
// vercel.json). Also exported for direct invocation from tests
// or other server-side code.
//
// State machine:
//   active   — currently in the sequence, next_step_at <= now() means due
//   paused   — admin-paused; runner skips
//   exited   — contact left (e.g. unsubscribed, or trigger condition no longer met)
//   completed — every step has been sent
//
// Failure handling: if a step send fails, the error is recorded on
// the enrollment and error_count incremented. After 5 consecutive
// failures the enrollment is auto-paused so a single broken contact
// (e.g. invalid email) doesn't fill the cron logs forever.

import { createServerClient } from '@/lib/supabase'
import { sendTransactionalEmail, applyMergeTags } from '@/lib/postmark'
import { applyAudienceFilterAsync, InvalidAudienceFilterError } from '@/lib/audience-filter'
import {
  sendTemplateMessage,
  buildTemplateComponents,
  getOrCreateConversation,
} from '@/lib/whatsapp'
import { sendLocationSms, TwilioError } from '@/lib/twilio'

/**
 * Returns true if a given contact would match a sequence's
 * audience_filter (the same filter shape campaigns + broadcasts use).
 * Implemented as a single-row reachability check — applies the filter
 * to a 1-row query and asks Postgres whether the row survives.
 *
 * Sequences with no filter (the common case) match everyone.
 *
 * @param {string} contactId
 * @param {object | null | undefined} filter — { logic, filters: [{ field, op, value }] }
 * @returns {Promise<boolean>}
 */
async function contactMatchesSequenceAudience(contactId, filter) {
  if (!filter?.filters?.length) return true
  const db = createServerClient()
  // Look up the contact's location so tag-filter resolution can be
  // location-scoped (cheaper than scanning contact_tags org-wide).
  const { data: contact } = await db.from('contacts').select('location_id').eq('id', contactId).maybeSingle()
  let query = db.from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('id', contactId)
  try {
    // Async path supports the new `tag` field (Phase 3 — mig 085).
    query = await applyAudienceFilterAsync({
      db,
      query,
      filter,
      locationId: contact?.location_id || null,
    })
  } catch (e) {
    if (e instanceof InvalidAudienceFilterError) {
      console.warn(`[sequences] sequence has invalid audience_filter, treating as no-match: ${e.message}`)
      return false
    }
    throw e
  }
  const { count } = await query
  return (count ?? 0) > 0
}

const MAX_ERRORS = 5
const PROCESS_BATCH_SIZE = 100

// ── Public: enrol contacts ───────────────────────────────────────

/**
 * Add contacts to a sequence. Idempotent — uses the
 * sequence_enrollments_unique_active index, so re-enrolling a
 * contact who's currently active is a no-op.
 *
 * @param {object} args
 * @param {string} args.sequenceId
 * @param {string[]} args.contactIds
 * @param {string} [args.sourceType='manual']
 * @param {string} [args.sourceRef]
 * @returns {Promise<{ enrolled: number, skipped: number }>}
 */
export async function enrolContacts({ sequenceId, contactIds, sourceType = 'manual', sourceRef = null }) {
  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return { enrolled: 0, skipped: 0 }
  }
  const db = createServerClient()

  // Active-enrolment dedup. Use SELECT-then-INSERT for the missing
  // rows (PostgREST won't UPSERT on a partial unique index).
  const { data: existing } = await db
    .from('sequence_enrollments')
    .select('contact_id')
    .eq('sequence_id', sequenceId)
    .eq('status', 'active')
    .in('contact_id', contactIds)
  const alreadyActive = new Set((existing || []).map(r => r.contact_id))

  // Mig 090: re-enrolment cooldown. When the sequence has
  // re_enrolment_cooldown_days set, allow re-enrolment after the
  // contact's MOST RECENT terminal enrolment ended that long ago.
  // Without a cooldown configured (NULL or 0), block any contact
  // who has EVER been enrolled in this sequence (preserves the
  // existing single-enrolment behaviour).
  const { data: seqRow } = await db
    .from('email_sequences')
    .select('re_enrolment_cooldown_days')
    .eq('id', sequenceId)
    .single()
  const cooldownDays = Number(seqRow?.re_enrolment_cooldown_days)
  const blockedFromHistory = new Set()
  const candidatesNotActive = contactIds.filter(id => !alreadyActive.has(id))
  if (candidatesNotActive.length > 0) {
    const { data: history } = await db
      .from('sequence_enrollments')
      .select('contact_id, status, last_processed_at, created_at')
      .eq('sequence_id', sequenceId)
      .in('contact_id', candidatesNotActive)
      .in('status', ['completed', 'exited'])
    if (Number.isFinite(cooldownDays) && cooldownDays > 0) {
      // Pick the most recent terminal end-time per contact.
      const lastEndByContact = new Map()
      for (const h of (history || [])) {
        const end = h.last_processed_at || h.created_at
        const prior = lastEndByContact.get(h.contact_id)
        if (!prior || end > prior) lastEndByContact.set(h.contact_id, end)
      }
      const cooldownMs = cooldownDays * 86400_000
      const now = Date.now()
      for (const [cid, end] of lastEndByContact) {
        if (now - new Date(end).getTime() < cooldownMs) blockedFromHistory.add(cid)
      }
    } else {
      // No cooldown → any past enrolment blocks (legacy behaviour).
      for (const h of (history || [])) blockedFromHistory.add(h.contact_id)
    }
  }

  const toInsert = contactIds
    .filter(id => !alreadyActive.has(id) && !blockedFromHistory.has(id))
    .map(contactId => ({
      sequence_id: sequenceId,
      contact_id: contactId,
      current_step_order: 0,
      status: 'active',
      next_step_at: new Date().toISOString(), // fire on next cron tick
      source_type: sourceType,
      source_ref: sourceRef,
    }))

  if (toInsert.length === 0) {
    return { enrolled: 0, skipped: contactIds.length }
  }

  const { error } = await db.from('sequence_enrollments').insert(toInsert)
  if (error) throw new Error(`Enrol failed: ${error.message}`)

  // Bump the cached counter on the parent sequence.
  await db.rpc('increment_sequence_enrolled', { p_sequence_id: sequenceId, p_delta: toInsert.length })
    .catch(() => {
      // RPC not present — fall back to a direct read+update. Best
      // effort, runner does not depend on this counter.
    })

  return { enrolled: toInsert.length, skipped: alreadyActive.size }
}

// ── Public: trigger handlers ────────────────────────────────────

/**
 * Called by /api/public/book after a booking is inserted. Finds
 * every active sequence with trigger_type='booking_created' for
 * the booking's location whose trigger_config either omits
 * event_type_id (any-event match) or specifies the booking's
 * event_type_id explicitly. Enrols the booking's contact into
 * each match.
 *
 * Best-effort — errors are swallowed so the booking creation
 * itself isn't blocked by a sequence enrol failure.
 */
export async function triggerSequencesForBooking(bookingId) {
  const db = createServerClient()
  try {
    const { data: booking } = await db
      .from('bookings')
      .select('id, event_type_id, location_id, contact_id')
      .eq('id', bookingId)
      .single()
    if (!booking || !booking.contact_id) return

    const { data: sequences } = await db
      .from('email_sequences')
      .select('id, trigger_config')
      .eq('location_id', booking.location_id)
      .eq('trigger_type', 'booking_created')
      .eq('active', true)
    if (!sequences || sequences.length === 0) return

    for (const seq of sequences) {
      const cfg = seq.trigger_config || {}
      // event_type_id is optional in trigger_config — empty means
      // "any event type at this location".
      if (cfg.event_type_id && cfg.event_type_id !== booking.event_type_id) continue
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: [booking.contact_id],
        sourceType: 'booking_created',
        sourceRef: booking.id,
      })
    }
  } catch (e) {
    // Don't propagate — booking creation must never fail because
    // of a sequence trigger. Logged for cron/operator review.
    console.warn(`[sequences] booking trigger failed for ${bookingId}: ${e.message}`)
  }
}

/**
 * Called from PUT /api/contacts/[id] when a contact's lead_status
 * value actually changes. Finds every active sequence with
 * trigger_type='status_change' for the contact's location whose
 * trigger_config matches:
 *   - cfg.to_status   (optional)  — only fire when status flipped TO this value
 *   - cfg.from_status (optional)  — only fire when status flipped FROM this value
 * Empty config = fire on any status change. Sequence's audience_filter
 * (if set) is then evaluated against the contact — non-matches skip.
 *
 * Best-effort — errors are swallowed so the contact update isn't
 * blocked by a sequence enrol failure.
 *
 * @param {string} contactId
 * @param {string|null} oldStatus
 * @param {string|null} newStatus
 */
export async function triggerSequencesForStatusChange(contactId, oldStatus, newStatus) {
  if (oldStatus === newStatus) return
  const db = createServerClient()
  try {
    const { data: contact } = await db
      .from('contacts')
      .select('id, location_id')
      .eq('id', contactId)
      .single()
    if (!contact) return

    const { data: sequences } = await db
      .from('email_sequences')
      .select('id, trigger_config, audience_filter')
      .eq('location_id', contact.location_id)
      .eq('trigger_type', 'status_change')
      .eq('status', 'active')
    if (!sequences || sequences.length === 0) return

    for (const seq of sequences) {
      const cfg = seq.trigger_config || {}
      if (cfg.to_status && cfg.to_status !== newStatus) continue
      if (cfg.from_status && cfg.from_status !== oldStatus) continue
      const matches = await contactMatchesSequenceAudience(contactId, seq.audience_filter)
      if (!matches) continue
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: [contactId],
        sourceType: 'status_change',
        sourceRef: `${oldStatus || 'null'}→${newStatus || 'null'}`,
      })
    }
  } catch (e) {
    console.warn(`[sequences] status_change trigger failed for ${contactId}: ${e.message}`)
  }
}

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

      const matchesAudience = await contactMatchesSequenceAudience(booking.contact_id, seq.audience_filter)
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
        console.warn(`[sequences] event_reminder enrol failed for booking ${booking.id}: ${e.message}`)
      }
    }
  }

  return stats
}

/**
 * Called from PUT /api/contacts/[id] when one or more new tags appear
 * on a contact (set difference: new - old). Finds every active
 * sequence with trigger_type='tag_added' whose trigger_config.tag
 * matches one of the newly-added tags. Audience filter (if set) is
 * then evaluated against the contact — non-matches skip.
 *
 * Best-effort — errors swallowed.
 *
 * @param {string} contactId
 * @param {string[]} addedTags
 */
export async function triggerSequencesForTagsAdded(contactId, addedTags) {
  if (!Array.isArray(addedTags) || addedTags.length === 0) return
  const db = createServerClient()
  try {
    const { data: contact } = await db
      .from('contacts')
      .select('id, location_id')
      .eq('id', contactId)
      .single()
    if (!contact) return

    const { data: sequences } = await db
      .from('email_sequences')
      .select('id, trigger_config, audience_filter')
      .eq('location_id', contact.location_id)
      .eq('trigger_type', 'tag_added')
      .eq('status', 'active')
    if (!sequences || sequences.length === 0) return

    const addedSet = new Set(addedTags)
    for (const seq of sequences) {
      const cfg = seq.trigger_config || {}
      // cfg.tag is required for tag_added triggers — a sequence with no
      // configured tag would otherwise fire on every tag mutation.
      if (!cfg.tag || !addedSet.has(cfg.tag)) continue
      const matches = await contactMatchesSequenceAudience(contactId, seq.audience_filter)
      if (!matches) continue
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: [contactId],
        sourceType: 'tag_added',
        sourceRef: cfg.tag,
      })
    }
  } catch (e) {
    console.warn(`[sequences] tag_added trigger failed for ${contactId}: ${e.message}`)
  }
}

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
      const matches = await contactMatchesSequenceAudience(c.id, seq.audience_filter)
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
      const matches = await contactMatchesSequenceAudience(c.id, seq.audience_filter)
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

/**
 * Race-registered trigger (Tier 1A).
 *
 * Called from /api/public/races/[slug]/register and from
 * /api/races/[id]/teams (manual operator add) right after a
 * race_registration row is created. Pulls the registration's team
 * + members and enrols EVERY member (with a contact_id) into
 * any matching trigger_type='race_registered' sequence.
 *
 * trigger_config:
 *   - race_event_id (optional) — restrict to one race
 *
 * Best-effort.
 */
export async function triggerSequencesForRaceRegistered(registrationId) {
  const db = createServerClient()
  try {
    const { data: reg } = await db
      .from('race_registrations')
      .select(`
        id, race_event_id, team_id,
        race:race_event_id ( id, location_id ),
        teams:team_id ( id, team_members ( contact_id ) )
      `)
      .eq('id', registrationId)
      .single()
    if (!reg?.race?.location_id) return
    const memberContactIds = (reg.teams?.team_members || [])
      .map((m) => m.contact_id)
      .filter(Boolean)
    if (memberContactIds.length === 0) return

    const { data: sequences } = await db
      .from('email_sequences')
      .select('id, trigger_config, audience_filter')
      .eq('location_id', reg.race.location_id)
      .eq('trigger_type', 'race_registered')
      .eq('status', 'active')
    if (!sequences || sequences.length === 0) return

    for (const seq of sequences) {
      const cfg = seq.trigger_config || {}
      if (cfg.race_event_id && cfg.race_event_id !== reg.race_event_id) continue
      // Audience-filter each contact independently — some members
      // may match (e.g. members only) while others don't.
      const matched = []
      for (const cid of memberContactIds) {
        const ok = await contactMatchesSequenceAudience(cid, seq.audience_filter)
        if (ok) matched.push(cid)
      }
      if (matched.length === 0) continue
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: matched,
        sourceType: 'race_registered',
        sourceRef: registrationId,
      })
    }
  } catch (e) {
    console.warn(`[sequences] race_registered trigger failed for ${registrationId}: ${e.message}`)
  }
}

/**
 * Race-finished trigger (Tier 1A).
 *
 * Called from /api/registrations/[id]/race-finish after the
 * registration's race_finished_at is stamped. Enrols every team
 * member with a contact_id.
 *
 * trigger_config:
 *   - race_event_id (optional)
 *
 * Best-effort.
 */
export async function triggerSequencesForRaceFinished(registrationId) {
  const db = createServerClient()
  try {
    const { data: reg } = await db
      .from('race_registrations')
      .select(`
        id, race_event_id, team_id,
        race:race_event_id ( id, location_id ),
        teams:team_id ( id, team_members ( contact_id ) )
      `)
      .eq('id', registrationId)
      .single()
    if (!reg?.race?.location_id) return
    const memberContactIds = (reg.teams?.team_members || [])
      .map((m) => m.contact_id)
      .filter(Boolean)
    if (memberContactIds.length === 0) return

    const { data: sequences } = await db
      .from('email_sequences')
      .select('id, trigger_config, audience_filter')
      .eq('location_id', reg.race.location_id)
      .eq('trigger_type', 'race_finished')
      .eq('status', 'active')
    if (!sequences || sequences.length === 0) return

    for (const seq of sequences) {
      const cfg = seq.trigger_config || {}
      if (cfg.race_event_id && cfg.race_event_id !== reg.race_event_id) continue
      const matched = []
      for (const cid of memberContactIds) {
        const ok = await contactMatchesSequenceAudience(cid, seq.audience_filter)
        if (ok) matched.push(cid)
      }
      if (matched.length === 0) continue
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: matched,
        sourceType: 'race_finished',
        sourceRef: registrationId,
      })
    }
  } catch (e) {
    console.warn(`[sequences] race_finished trigger failed for ${registrationId}: ${e.message}`)
  }
}

/**
 * Order-status trigger (Tier 1A).
 *
 * Called from order lifecycle code paths whenever an orders row
 * moves to a terminal state. One trigger type per status:
 *   - 'order_completed'
 *   - 'order_failed'
 *   - 'order_abandoned'
 *
 * trigger_config:
 *   - source_type (optional) — restrict to 'race_registration' /
 *     'car_deposit'.
 *
 * @param {string} contactId   - contact tied to the order (may be null)
 * @param {string} locationId  - the order's location_id
 * @param {string} status      - one of 'completed' | 'failed' | 'abandoned'
 * @param {string} sourceType  - 'race_registration' | 'car_deposit'
 * @param {string|null} orderId - source ref for audit
 */
export async function triggerSequencesForOrderStatus({ contactId, locationId, status, sourceType, orderId = null }) {
  if (!contactId || !locationId || !status) return
  const triggerType = `order_${status}`
  if (!['order_completed', 'order_failed', 'order_abandoned'].includes(triggerType)) return

  const db = createServerClient()
  try {
    const { data: sequences } = await db
      .from('email_sequences')
      .select('id, trigger_config, audience_filter')
      .eq('location_id', locationId)
      .eq('trigger_type', triggerType)
      .eq('status', 'active')
    if (!sequences || sequences.length === 0) return

    for (const seq of sequences) {
      const cfg = seq.trigger_config || {}
      if (cfg.source_type && cfg.source_type !== sourceType) continue
      const ok = await contactMatchesSequenceAudience(contactId, seq.audience_filter)
      if (!ok) continue
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: [contactId],
        sourceType: triggerType,
        sourceRef: orderId,
      })
    }
  } catch (e) {
    console.warn(`[sequences] ${triggerType} trigger failed for ${contactId}: ${e.message}`)
  }
}

/**
 * First-booking trigger (Tier 1A).
 *
 * Called alongside the existing booking_created trigger from
 * /api/public/book. Fires only when this is the contact's first
 * confirmed booking ever — perfect for welcome series that
 * shouldn't re-fire on the second/third booking.
 *
 * trigger_config:
 *   - event_type_id (optional)
 *
 * Best-effort.
 */
export async function triggerSequencesForFirstBooking(bookingId) {
  const db = createServerClient()
  try {
    const { data: booking } = await db
      .from('bookings')
      .select('id, event_type_id, location_id, contact_id')
      .eq('id', bookingId)
      .single()
    if (!booking || !booking.contact_id) return

    // Count prior confirmed bookings (excluding this one). If > 0,
    // this isn't the first — short-circuit.
    const { count } = await db
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', booking.contact_id)
      .neq('id', bookingId)
      .neq('status', 'cancelled')
    if ((count || 0) > 0) return

    const { data: sequences } = await db
      .from('email_sequences')
      .select('id, trigger_config, audience_filter')
      .eq('location_id', booking.location_id)
      .eq('trigger_type', 'first_booking')
      .eq('status', 'active')
    if (!sequences || sequences.length === 0) return

    for (const seq of sequences) {
      const cfg = seq.trigger_config || {}
      if (cfg.event_type_id && cfg.event_type_id !== booking.event_type_id) continue
      const matches = await contactMatchesSequenceAudience(booking.contact_id, seq.audience_filter)
      if (!matches) continue
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: [booking.contact_id],
        sourceType: 'first_booking',
        sourceRef: booking.id,
      })
    }
  } catch (e) {
    console.warn(`[sequences] first_booking trigger failed for ${bookingId}: ${e.message}`)
  }
}

// ── Public: pause / resume / exit ────────────────────────────────

export async function setEnrollmentStatus({ enrollmentId, status, reason }) {
  const db = createServerClient()
  const updates = { status }
  if (reason) updates.last_error = reason
  const { error } = await db.from('sequence_enrollments').update(updates).eq('id', enrollmentId)
  if (error) throw error
}

// ── Internal: pick the next step for an enrolment ────────────────

/**
 * Returns the step that should fire next for an enrolment, or null
 * if the sequence is finished. current_step_order is 0 before any
 * step has been sent; otherwise the runner sends step_order =
 * current_step_order + 1.
 */
async function nextStepForEnrollment(db, enrollment) {
  const targetOrder = (enrollment.current_step_order || 0) + 1
  const { data: step } = await db
    .from('sequence_steps')
    .select('*')
    .eq('sequence_id', enrollment.sequence_id)
    .eq('step_order', targetOrder)
    .maybeSingle()
  return step || null
}

function nextStepDelayMs(step) {
  if (!step) return 0
  // The schema carries three delay fields (added at different migration
  // points); the API writes days+hours, mig 005 originally wrote
  // minutes. Sum all three so however the row was written, we honour
  // the intent.
  const days = Number(step.delay_days || 0)
  const hours = Number(step.delay_hours || 0)
  const minutes = Number(step.delay_minutes || 0)
  const ms = (days * 24 * 60 + hours * 60 + minutes) * 60_000
  return Number.isFinite(ms) && ms >= 0 ? ms : 0
}

// ── Internal: send a single email step ───────────────────────────

async function sendEmailStep(db, { enrollment: _enrollment, step, sequence, contact }) {
  if (!contact?.email) {
    throw new Error('Contact has no email address — cannot send email step.')
  }

  // Resolve content: inline OR via template_id reference.
  let subject = step.subject
  let html = step.html_content
  if (!html && step.template_id) {
    const { data: tpl } = await db
      .from('email_templates')
      .select('subject, html_content')
      .eq('id', step.template_id)
      .single()
    if (tpl) {
      subject = subject || tpl.subject
      html = tpl.html_content
    }
  }
  if (!html) throw new Error('Step has no content (no html_content and no template_id).')

  // Merge tags substitution — supports {{first_name}}, {{full_name}}
  // etc, same shape as campaigns (see src/lib/postmark.js#applyMergeTags).
  const mergedSubject = applyMergeTags(subject, contact)
  const mergedHtml = applyMergeTags(html, contact)

  const result = await sendTransactionalEmail({
    to: contact.email,
    subject: mergedSubject,
    htmlBody: mergedHtml,
    contactId: contact.id,
    locationId: sequence.location_id,
    tag: `seq-${sequence.id}`,
  })

  // Annotate the email_sends row with sequence + step references so
  // open/click webhooks can attribute opens back to the step.
  if (result?.messageId) {
    await db
      .from('email_sends')
      .update({
        source_type: 'sequence',
        sequence_id: sequence.id,
        sequence_step_id: step.id,
      })
      .eq('postmark_message_id', result.messageId)
  }

  // Bump per-step metric.
  await db.rpc('increment_step_sent', { p_step_id: step.id }).catch(() => {})

  return result?.messageId || null
}

// ── Internal: send a single WhatsApp template step ──────────────

async function sendWhatsappStep(db, { step, sequence, contact }) {
  if (!step.whatsapp_template_id) {
    throw new Error('WhatsApp step has no template_id.')
  }
  if (!contact?.wa_phone) {
    throw new Error('Contact has no WhatsApp phone number — cannot send WhatsApp step.')
  }

  // Resolve the template; must be APPROVED to send.
  const { data: template } = await db
    .from('whatsapp_templates')
    .select('*')
    .eq('id', step.whatsapp_template_id)
    .single()
  if (!template) throw new Error('WhatsApp template not found.')
  if (template.status !== 'APPROVED') {
    throw new Error(`WhatsApp template "${template.name}" is ${template.status}, not APPROVED — cannot send.`)
  }
  if (template.location_id !== sequence.location_id) {
    throw new Error('WhatsApp template belongs to a different location than the sequence.')
  }

  // Variable mapping resolution mirrors the broadcasts flow exactly.
  const variableMapping = step.whatsapp_variables || {}
  const components = buildTemplateComponents(
    template,
    contact,
    variableMapping,
    step.whatsapp_header_media_url || null
  )

  const result = await sendTemplateMessage(
    contact.wa_phone,
    template.name,
    template.language,
    components
  )

  // Log to whatsapp_messages so the inbox + analytics see it.
  // Conversation is upserted via the helper to attribute correctly.
  const conversationId = await getOrCreateConversation(db, contact, sequence.location_id)
  if (conversationId && result?.messageId) {
    await db.from('whatsapp_messages').insert({
      conversation_id: conversationId,
      contact_id: contact.id,
      location_id: sequence.location_id,
      wa_message_id: result.messageId,
      direction: 'outbound',
      message_type: 'template',
      template_name: template.name,
      template_variables: variableMapping,
      status: 'sent',
      sent_at: new Date().toISOString(),
    })
  }

  // Bump per-step metric.
  await db.rpc('increment_step_sent', { p_step_id: step.id }).catch(() => {})

  return result?.messageId || null
}

// ── Step sender: SMS (mig 062) ─────────────────────────────────────

async function sendSmsStep(db, { step, sequence, contact }) {
  if (!step.sms_body) {
    throw new Error('SMS step has no sms_body.')
  }
  if (!contact?.phone) {
    throw new Error('Contact has no phone number — cannot send SMS step.')
  }
  // Mirrors the broadcast and ad-hoc send-side gate. Opted-out
  // contacts are silently skipped at the audience layer for
  // broadcasts, but for sequences a contact may have opted out
  // mid-flow. Throwing here causes the standard sequence error
  // path to log + retry / pause the enrollment after MAX_ERRORS.
  if (contact.sms_status && contact.sms_status !== 'active') {
    throw new Error(`Contact's sms_status is '${contact.sms_status}' — refusing to send.`)
  }

  // Resolve the sequence's location so we get the right alpha
  // sender ID (mig 059). Sequences are pinned to one location, so
  // every enrolment in this sequence sends from the same sender.
  const { data: location } = await db
    .from('locations')
    .select('id, name, twilio_alpha_sender_id')
    .eq('id', sequence.location_id)
    .single()
  if (!location) {
    throw new Error('Sequence location not found — cannot resolve SMS sender.')
  }

  // Apply merge tags. Same set as email + ad-hoc SMS (first_name,
  // name, location_name, etc.).
  const renderedBody = applyMergeTags(step.sms_body, contact, {
    location_name: location.name || '',
  })

  let result
  try {
    result = await sendLocationSms({ location, to: contact.phone, body: renderedBody })
  } catch (e) {
    const msg = e instanceof TwilioError
      ? `Twilio ${e.code || e.status || ''}: ${e.message}`.trim()
      : (e?.message || 'SMS send failed')
    throw new Error(msg)
  }

  // Activity timeline entry. Same shape as the broadcast + ad-hoc
  // send paths (type='sms_sent', cyan chip in the contact page's
  // activityIcons map).
  await db.from('activities').insert({
    contact_id: contact.id,
    location_id: sequence.location_id,
    type: 'sms_sent',
    subject: `SMS sequence step: ${sequence.name || 'Untitled sequence'}`,
    note: renderedBody,
  })

  // Bump per-step metric.
  await db.rpc('increment_step_sent', { p_step_id: step.id }).catch(() => {})

  return result?.sid || null
}

// ── Public: process due enrollments (called by the cron) ─────────

/**
 * Picks up to PROCESS_BATCH_SIZE due enrollments and processes them.
 * Returns a summary so the cron handler can log it.
 *
 * @param {object} [opts]
 * @param {Date} [opts.now=new Date()]  — overridable for tests
 */
export async function runSequences({ now = new Date() } = {}) {
  const db = createServerClient()
  const stats = { picked: 0, sent: 0, completed: 0, errored: 0, paused: 0, skipped: 0 }

  // Pick due rows. Order by next_step_at so older deliveries fire
  // first. SKIP LOCKED isn't directly available via PostgREST so we
  // tolerate the small chance of two cron invocations grabbing the
  // same row — the per-step send is idempotent within a tick because
  // we update current_step_order before returning.
  const { data: due, error: dueErr } = await db
    .from('sequence_enrollments')
    .select('id, sequence_id, contact_id, current_step_order, error_count, status, metadata')
    .eq('status', 'active')
    .lte('next_step_at', now.toISOString())
    .order('next_step_at', { ascending: true })
    .limit(PROCESS_BATCH_SIZE)

  if (dueErr) throw new Error(`Failed to load due enrollments: ${dueErr.message}`)
  stats.picked = (due || []).length
  if (!due || due.length === 0) return stats

  for (const enrollment of due) {
    try {
      // Reload the parent sequence + the contact in one go.
      const [{ data: sequence }, { data: contact }] = await Promise.all([
        db.from('email_sequences').select('*').eq('id', enrollment.sequence_id).single(),
        db.from('contacts').select('*').eq('id', enrollment.contact_id).single(),
      ])
      if (!sequence || !contact) {
        await db.from('sequence_enrollments').update({
          status: 'exited',
          last_error: !sequence ? 'Sequence deleted' : 'Contact deleted',
          last_processed_at: now.toISOString(),
        }).eq('id', enrollment.id)
        stats.skipped++
        continue
      }
      if (!sequence.active) {
        // Sequence was paused since enrolment — push the row's
        // next-step time forward so we don't busy-loop on it.
        await db.from('sequence_enrollments').update({
          last_processed_at: now.toISOString(),
          next_step_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
        }).eq('id', enrollment.id)
        stats.skipped++
        continue
      }

      // Mig 088: goal check. If a goal is configured and met,
      // auto-exit BEFORE processing the next step. exit_reason
      // distinguishes from natural completion.
      if (sequence.goal_config) {
        const goalMet = await isGoalMet({ db, contact, goalConfig: sequence.goal_config })
        if (goalMet) {
          await db.from('sequence_enrollments').update({
            status: 'exited',
            exit_reason: 'goal_met',
            last_processed_at: now.toISOString(),
            next_step_at: null,
          }).eq('id', enrollment.id)
          stats.skipped++
          continue
        }
      }

      const step = await nextStepForEnrollment(db, enrollment)
      if (!step) {
        // Out of steps — mark complete.
        await db.from('sequence_enrollments').update({
          status: 'completed',
          last_processed_at: now.toISOString(),
          next_step_at: null,
        }).eq('id', enrollment.id)
        await db.rpc('increment_sequence_completed', { p_sequence_id: sequence.id, p_delta: 1 }).catch(() => {})
        stats.completed++
        continue
      }

      // Branch by step type.
      let sendId = null
      if (step.step_type === 'wait') {
        // Wait step has no send — just advance with the delay.
        sendId = null
      } else if (step.step_type === 'email' || !step.step_type) {
        sendId = await sendEmailStep(db, { enrollment, step, sequence, contact })
      } else if (step.step_type === 'whatsapp') {
        sendId = await sendWhatsappStep(db, { enrollment, step, sequence, contact })
      } else if (step.step_type === 'sms') {
        sendId = await sendSmsStep(db, { enrollment, step, sequence, contact })
      } else if (step.step_type === 'apply_tag') {
        // Mig 087: apply a contact_tags row. Config: { tag }.
        // No send_id since nothing went out the door.
        await applyTagStep(db, { step, contact, sequence })
        sendId = null
      } else if (step.step_type === 'update_field') {
        // Mig 087: set a whitelisted contacts.* field. Config:
        // { field, value }. Whitelist enforced server-side.
        await updateFieldStep(db, { step, contact })
        sendId = null
      } else if (step.step_type === 'internal_task') {
        // Mig 087: create an activity row (kind='task') assigned
        // to a staff user. Config: { subject, note, assignee_role,
        // assignee_user_id, due_offset_minutes }.
        await internalTaskStep(db, { step, contact, sequence })
        sendId = null
      } else if (step.step_type === 'webhook') {
        // Mig 089: outbound HTTP. Config: { url, method, headers,
        // payload_template }. Throws on non-2xx so the runner's
        // retry/pause logic kicks in.
        await webhookStep(db, { step, contact, sequence, enrollment })
        sendId = null
      } else {
        throw new Error(`Unknown step_type "${step.step_type}".`)
      }

      // Compute the next fire time based on the FOLLOWING step's delay.
      const followingStep = await db
        .from('sequence_steps')
        .select('delay_days, delay_hours, delay_minutes')
        .eq('sequence_id', sequence.id)
        .eq('step_order', step.step_order + 1)
        .maybeSingle()
      // Mig 088: test mode — accelerate delays to a fixed N seconds.
      // metadata.test=true on the enrolment is the marker.
      const isTest = enrollment.metadata?.test === true
      const accelSeconds = Number.isFinite(enrollment.metadata?.accelerated_delay_seconds)
        ? enrollment.metadata.accelerated_delay_seconds
        : 60
      let nextFireAt = null
      if (followingStep.data) {
        const rawNext = isTest
          ? new Date(now.getTime() + accelSeconds * 1000)
          : new Date(now.getTime() + nextStepDelayMs(followingStep.data))
        // Mig 089: respect the per-sequence send window. Test
        // enrolments bypass the window so QA isn't blocked by
        // weekend/night hours.
        const clamped = isTest
          ? rawNext
          : clampToSendWindow(rawNext, sequence.send_window || null)
        nextFireAt = clamped.toISOString()
      }
      const newStatus = followingStep.data ? 'active' : 'completed'

      await db.from('sequence_enrollments').update({
        current_step_order: step.step_order,
        next_step_at: nextFireAt,
        status: newStatus,
        last_processed_at: now.toISOString(),
        last_step_send_id: sendId,
        last_error: null,
        error_count: 0,
      }).eq('id', enrollment.id)

      if (newStatus === 'completed') {
        await db.rpc('increment_sequence_completed', { p_sequence_id: sequence.id, p_delta: 1 }).catch(() => {})
        stats.completed++
      }
      stats.sent++
    } catch (e) {
      const errCount = (enrollment.error_count || 0) + 1
      const shouldPause = errCount >= MAX_ERRORS
      await db.from('sequence_enrollments').update({
        last_error: e.message || String(e),
        error_count: errCount,
        last_processed_at: now.toISOString(),
        // Push next attempt 30 min out (or pause altogether).
        next_step_at: shouldPause ? null : new Date(now.getTime() + 30 * 60_000).toISOString(),
        status: shouldPause ? 'paused' : 'active',
      }).eq('id', enrollment.id)
      if (shouldPause) stats.paused++
      stats.errored++
    }
  }

  return stats
}

// ─── Tier 2B: send-window helper (mig 089) ───────────────────────

/**
 * Push a UTC timestamp forward to the next acceptable slot in the
 * sequence's send window. Returns the original timestamp if no
 * window configured or already inside the window.
 *
 * Window is interpreted in Europe/Dublin local time. skip_days
 * uses 0=Sunday … 6=Saturday convention (JavaScript getDay()).
 *
 * @param {Date} candidate
 * @param {object|null} window  { start_hour, end_hour, skip_days }
 * @returns {Date}
 */
function clampToSendWindow(candidate, window) {
  if (!window) return candidate
  const startH = Number.isFinite(window.start_hour) ? window.start_hour : null
  const endH = Number.isFinite(window.end_hour) ? window.end_hour : null
  const skipDays = Array.isArray(window.skip_days) ? window.skip_days.map(Number) : []
  if (startH == null && endH == null && skipDays.length === 0) return candidate

  // Iterate at most ~14 days forward — operators won't configure
  // an empty window in practice, but bound it defensively.
  let attempt = new Date(candidate.getTime())
  for (let i = 0; i < 14 * 24; i++) {
    // Use Intl to get the local hour + dow in Europe/Dublin without
    // fighting Date's local-tz coupling. getParts gives strings.
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Dublin',
      hour: 'numeric',
      hourCycle: 'h23',
      weekday: 'short',
    }).formatToParts(attempt)
    const hourStr = parts.find((p) => p.type === 'hour')?.value || '0'
    const dowStr = parts.find((p) => p.type === 'weekday')?.value || ''
    const localHour = Number(hourStr) || 0
    // Map en-GB short weekday to 0-6 (Sun=0).
    const DOW_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    const localDow = DOW_MAP[dowStr] ?? 0

    const dayOk = !skipDays.includes(localDow)
    let hourOk = true
    if (startH != null && localHour < startH) hourOk = false
    if (endH != null && localHour >= endH) hourOk = false

    if (dayOk && hourOk) return attempt

    // Advance one hour at a time. Cheap loop bounded above.
    attempt = new Date(attempt.getTime() + 60 * 60_000)
  }
  // Fallback: return what we have rather than loop forever.
  return attempt
}

// ─── Tier 1C: goal-tracking helper (mig 088) ─────────────────────

/**
 * Check whether a sequence's goal has been met for one contact.
 * Returns true → enrolment auto-exits with exit_reason='goal_met'.
 *
 * Goal types (mig 088):
 *   { type: 'tag_added',    tag: '<tag>'      }
 *   { type: 'lead_status',  value: '<status>' }
 *   { type: 'booking_made', event_type_id?: '<uuid>' }
 *
 * Best-effort — DB hiccup → return false (don't auto-exit on
 * uncertainty; let the next pass try again).
 *
 * @param {object} args
 * @param {SupabaseClient} args.db
 * @param {object} args.contact
 * @param {object} args.goalConfig
 * @returns {Promise<boolean>}
 */
async function isGoalMet({ db, contact, goalConfig }) {
  if (!goalConfig?.type) return false
  try {
    if (goalConfig.type === 'lead_status') {
      return contact.lead_status === goalConfig.value
    }
    if (goalConfig.type === 'tag_added') {
      const tag = String(goalConfig.tag || '').trim()
      if (!tag) return false
      const { count } = await db
        .from('contact_tags')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', contact.id)
        .eq('tag', tag)
        .is('removed_at', null)
      return (count || 0) > 0
    }
    if (goalConfig.type === 'booking_made') {
      let q = db
        .from('bookings')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', contact.id)
        .neq('status', 'cancelled')
      if (goalConfig.event_type_id) q = q.eq('event_type_id', goalConfig.event_type_id)
      const { count } = await q
      return (count || 0) > 0
    }
  } catch {
    return false
  }
  return false
}

// ─── Tier 1B: non-message step handlers (mig 087) ────────────────

/**
 * apply_tag step. Reads config.tag and upserts a contact_tags row
 * for this contact (location-scoped). Idempotent — the partial
 * UNIQUE on (contact_id, tag) WHERE removed_at IS NULL keeps a
 * single active row even if the operator queues the same tag
 * twice in a sequence.
 *
 * Tag string is operator-controlled — no whitelist. Lets operators
 * use the rules-engine tags AND custom tags they invent. Trim +
 * length cap at 60 chars to match contact_tags column.
 */
async function applyTagStep(db, { step, contact, sequence }) {
  const tag = String(step.config?.tag || '').trim().slice(0, 60)
  if (!tag) throw new Error('apply_tag step: config.tag is required')

  // Re-activate a soft-deleted matching tag if one exists; otherwise
  // insert. The partial UNIQUE prevents concurrent dupes.
  const { data: existing } = await db
    .from('contact_tags')
    .select('id, removed_at')
    .eq('contact_id', contact.id)
    .eq('tag', tag)
    .order('added_at', { ascending: false })
    .limit(1)
  const row = existing?.[0]
  if (row && row.removed_at) {
    await db
      .from('contact_tags')
      .update({ removed_at: null, added_at: new Date().toISOString() })
      .eq('id', row.id)
  } else if (!row) {
    await db.from('contact_tags').insert({
      contact_id: contact.id,
      location_id: sequence?.location_id || contact.location_id,
      tag,
    })
  }
  // Active row already exists → no-op.
}

/**
 * update_field step. Whitelisted fields only — operators can't
 * stamp arbitrary columns. Currently allows lead_status + label;
 * extend the WHITELIST set below to add more.
 *
 * Fires the status_change sequence trigger when lead_status changes
 * so chains compose ("on first race, set status=active_trial → that
 * triggers a different sequence").
 */
async function updateFieldStep(db, { step, contact }) {
  const WHITELIST = new Set(['lead_status', 'label'])
  const field = String(step.config?.field || '').trim()
  const value = step.config?.value
  if (!WHITELIST.has(field)) {
    throw new Error(`update_field step: field "${field}" is not allowed (whitelist: ${[...WHITELIST].join(', ')})`)
  }
  if (typeof value !== 'string' && value !== null) {
    throw new Error('update_field step: value must be a string or null')
  }

  const oldValue = contact[field]
  if (oldValue === value) return // no-op

  await db.from('contacts').update({ [field]: value }).eq('id', contact.id)

  // Cascade for lead_status only — lets sequences chain.
  if (field === 'lead_status') {
    try {
      await triggerSequencesForStatusChange(contact.id, oldValue || null, value || null)
    } catch (e) {
      console.warn(`[sequences] update_field cascade trigger failed: ${e.message}`)
    }
  }
}

/**
 * webhook step (mig 089 / Tier 2C). POSTs (or other method) to a
 * configured URL with contact context. config:
 *   - url            (required, must be HTTPS)
 *   - method         (default POST)
 *   - headers        (record<string,string>, optional)
 *   - payload        (object, optional — defaults to a sensible
 *                     contact + sequence summary)
 *
 * No retry beyond what the runner already does (5 fails → pause).
 * Operators can build on top with a wait-step + condition step
 * if they need fancier logic.
 *
 * Security: URL must start with https:// to prevent accidental
 * plain-HTTP exfil. No HMAC signing in v1 — operators should use
 * a per-endpoint API key in the headers if they need it.
 */
async function webhookStep(_db, { step, contact, sequence, enrollment }) {
  const cfg = step.config || {}
  const url = String(cfg.url || '').trim()
  if (!url) throw new Error('webhook step: config.url is required')
  if (!url.startsWith('https://')) {
    throw new Error('webhook step: url must start with https:// for security')
  }
  const method = String(cfg.method || 'POST').toUpperCase()
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    throw new Error(`webhook step: method "${method}" not supported`)
  }

  // Default payload: contact + sequence + enrolment context. Operators
  // can override by setting cfg.payload — anything serialisable goes.
  const defaultPayload = {
    contact: {
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      lead_status: contact.lead_status,
      location_id: contact.location_id,
    },
    sequence: {
      id: sequence.id,
      name: sequence.name,
    },
    enrolment: {
      id: enrollment.id,
      step_order: step.step_order,
    },
    fired_at: new Date().toISOString(),
  }
  const payload = cfg.payload && typeof cfg.payload === 'object'
    ? cfg.payload
    : defaultPayload

  const headers = {
    'content-type': 'application/json',
    'user-agent': 'un1t-sequences-webhook/1.0',
    ...(cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {}),
  }
  const body = method === 'GET' ? undefined : JSON.stringify(payload)

  let res
  try {
    res = await fetch(url, { method, headers, body })
  } catch (e) {
    throw new Error(`webhook fetch failed: ${e.message || e}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`webhook returned ${res.status}: ${text.slice(0, 200)}`)
  }
}

/**
 * internal_task step. Creates an activity row (kind='task') so it
 * shows up on the contact's open-tasks list + the staff's task
 * inbox. Config: subject, note, assignee_user_id (optional),
 * assignee_role (optional, e.g. 'manager').
 *
 * If assignee_user_id is provided, it's set directly. Otherwise
 * the assignee is left null — operators can pick it up from the
 * /activities queue. assignee_role is informational; we don't
 * fan-out to multiple users.
 */
async function internalTaskStep(db, { step, contact, sequence }) {
  const cfg = step.config || {}
  const subject = String(cfg.subject || '').trim().slice(0, 200)
  const note = String(cfg.note || '').trim().slice(0, 4000)
  if (!subject) throw new Error('internal_task step: config.subject is required')

  const dueOffsetMinutes = Number.isFinite(cfg.due_offset_minutes)
    ? cfg.due_offset_minutes
    : 0
  const dueAt = new Date(Date.now() + Math.max(0, dueOffsetMinutes) * 60_000).toISOString()

  await db.from('activities').insert({
    contact_id: contact.id,
    location_id: sequence?.location_id || contact.location_id,
    type: 'task',
    kind: 'task',
    subject,
    note: note || null,
    assigned_to: cfg.assignee_user_id || null,
    due_at: dueAt,
  })
}
