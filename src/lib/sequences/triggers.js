// Webhook-driven sequence trigger handlers.
//
// Each function is called from an API route or webhook right after
// the upstream entity (booking, contact mutation, race registration,
// order status flip) is committed. Every handler:
//
//   1. Loads the entity + its location
//   2. Finds active sequences for that location matching trigger_type
//   3. Filters by trigger_config (event_type_id, race_event_id, etc.)
//   4. Filters by audience_filter (contactMatchesSequenceAudience)
//   5. Enrols matched contacts via enrolContacts()
//
// All seven are best-effort — errors are caught + logged but never
// propagate. The upstream mutation must never fail because of a
// sequence trigger.
//
// Cron-driven triggers (event_reminder, anniversary, inactivity) live
// in ./cron-triggers.js — they share the trigger_config / audience
// pattern but have different lifecycle semantics (return stats,
// don't swallow errors at the boundary).

import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'
import { contactMatchesSequenceAudience } from './audience.js'
import { enrolContacts } from './enrol.js'

// ── booking_created ──────────────────────────────────────────────

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
    logWarn('sequences', `booking trigger failed for ${bookingId}`, { err: e })
  }
}

// ── status_change ────────────────────────────────────────────────

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
      const matches = await contactMatchesSequenceAudience(db, contactId, seq.audience_filter)
      if (!matches) continue
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: [contactId],
        sourceType: 'status_change',
        sourceRef: `${oldStatus || 'null'}→${newStatus || 'null'}`,
      })
    }
  } catch (e) {
    logWarn('sequences', `status_change trigger failed for ${contactId}`, { err: e })
  }
}

// ── tag_added ────────────────────────────────────────────────────

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
      const matches = await contactMatchesSequenceAudience(db, contactId, seq.audience_filter)
      if (!matches) continue
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: [contactId],
        sourceType: 'tag_added',
        sourceRef: cfg.tag,
      })
    }
  } catch (e) {
    logWarn('sequences', `tag_added trigger failed for ${contactId}`, { err: e })
  }
}

// ── race_registered (Tier 1A) ────────────────────────────────────

/**
 * Race-registered trigger (Tier 1A).
 *
 * Called from /api/public/events/[slug]/register and from
 * /api/events/[id]/teams (manual operator add) right after a
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
        const ok = await contactMatchesSequenceAudience(db, cid, seq.audience_filter)
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
    logWarn('sequences', `race_registered trigger failed for ${registrationId}`, { err: e })
  }
}

// ── race_finished (Tier 1A) ──────────────────────────────────────

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
        const ok = await contactMatchesSequenceAudience(db, cid, seq.audience_filter)
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
    logWarn('sequences', `race_finished trigger failed for ${registrationId}`, { err: e })
  }
}

// ── order_status (Tier 1A) ───────────────────────────────────────

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
      const ok = await contactMatchesSequenceAudience(db, contactId, seq.audience_filter)
      if (!ok) continue
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: [contactId],
        sourceType: triggerType,
        sourceRef: orderId,
      })
    }
  } catch (e) {
    logWarn('sequences', `${triggerType} trigger failed for ${contactId}`, { err: e })
  }
}

// ── first_booking (Tier 1A) ──────────────────────────────────────

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
      const matches = await contactMatchesSequenceAudience(db, booking.contact_id, seq.audience_filter)
      if (!matches) continue
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: [booking.contact_id],
        sourceType: 'first_booking',
        sourceRef: booking.id,
      })
    }
  } catch (e) {
    logWarn('sequences', `first_booking trigger failed for ${bookingId}`, { err: e })
  }
}

// ── achievement_unlocked (Phase 4 Slice B) ───────────────────────

/**
 * Called from src/lib/achievements.js#runDetectionForSession after
 * inserting newly-unlocked rows. Each contact_achievement id passed
 * in is the trigger source.
 *
 * trigger_config (all optional, AND-combined):
 *   - rule_slug    — only fire for this specific badge (e.g. 'first_z5')
 *   - rule_family  — fire for any tier in this family (e.g. 'streak')
 *   - category     — fire for any rule in this category (e.g. 'milestone')
 *
 * Empty config means "any achievement". Useful for the
 * generic "we celebrate every badge you earn" newsletter.
 *
 * Best-effort.
 */
export async function triggerSequencesForAchievement(achievementId) {
  const db = createServerClient()
  try {
    const { data: ach } = await db
      .from('contact_achievements')
      .select('id, contact_id, rule_id, rule_slug, rule:achievement_rules(slug, family, category)')
      .eq('id', achievementId)
      .single()
    if (!ach || !ach.contact_id || !ach.rule) return

    // Resolve location via the contact (sessions don't carry it on
    // the achievement row).
    const { data: contact } = await db
      .from('contacts')
      .select('location_id')
      .eq('id', ach.contact_id)
      .single()
    if (!contact?.location_id) return

    const { data: sequences } = await db
      .from('email_sequences')
      .select('id, trigger_config, audience_filter')
      .eq('location_id', contact.location_id)
      .eq('trigger_type', 'achievement_unlocked')
      .eq('status', 'active')
    if (!sequences || sequences.length === 0) return

    for (const seq of sequences) {
      const cfg = seq.trigger_config || {}
      if (cfg.rule_slug   && cfg.rule_slug   !== ach.rule.slug)     continue
      if (cfg.rule_family && cfg.rule_family !== ach.rule.family)   continue
      if (cfg.category    && cfg.category    !== ach.rule.category) continue

      const matches = await contactMatchesSequenceAudience(db, ach.contact_id, seq.audience_filter)
      if (!matches) continue

      await enrolContacts({
        sequenceId: seq.id,
        contactIds: [ach.contact_id],
        sourceType: 'achievement_unlocked',
        sourceRef: ach.id,
      })
    }
  } catch (e) {
    logWarn('sequences', `achievement trigger failed for ${achievementId}`, { err: e })
  }
}
