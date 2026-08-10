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

// ── segment_added / segment_removed (SEG-TRIG.1) ─────────────────
//
// Called by syncSegmentMemberships() in segment-sync.js after a
// snapshot diff. Unlike the other handlers in this file, the caller
// is cron-driven (not a webhook), and the contact batch can be
// large — a one-off bulk import can move hundreds of contacts in
// and out of a segment in a single tick.
//
// trigger_config:
//   - segment_id (REQUIRED) — the segment whose transitions fire
//     this sequence. We don't support "fire on any segment" because
//     segment semantics are too varied to make that useful.
//
// audience_filter is still respected — the segment defines who can
// enter the sequence by segment-membership transition, the audience
// filter narrows that to who actually gets enrolled. Most operators
// won't set both, but layering is legal.
//
// Per-contact errors during audience-match propagate up to the
// caller (segment-sync.js), which swallows them per-segment. We
// don't try/catch inside the handler because the cron-driven
// caller already does so at the right granularity.

/**
 * Fire segment_added triggers for the given batch of contact IDs that
 * just entered the segment.
 *
 * @param {string} segmentId
 * @param {string[]} contactIds  Newly-added contact IDs (already deduped against the prior snapshot)
 */
export async function triggerSequencesForSegmentAdded(segmentId, contactIds) {
  if (!segmentId || !Array.isArray(contactIds) || contactIds.length === 0) return
  const db = createServerClient()

  // Sequences are location-scoped; the segment is too. Match via
  // segment.location_id rather than trusting trigger_config.
  const { data: segment } = await db
    .from('contact_segments')
    .select('id, location_id')
    .eq('id', segmentId)
    .single()
  if (!segment?.location_id) return

  const { data: sequences } = await db
    .from('email_sequences')
    .select('id, trigger_config, audience_filter')
    .eq('location_id', segment.location_id)
    .eq('trigger_type', 'segment_added')
    .eq('status', 'active')
  if (!sequences || sequences.length === 0) return

  for (const seq of sequences) {
    const cfg = seq.trigger_config || {}
    // segment_id is REQUIRED for segment_* triggers — a sequence
    // without it would otherwise fire on every segment's diff.
    if (!cfg.segment_id || cfg.segment_id !== segmentId) continue

    // Audience-filter per contact (some may match, others may not).
    // Bulk additions are common during a backfill — accept the
    // per-contact cost rather than try to build one composite query.
    const matched = []
    for (const cid of contactIds) {
      const ok = await contactMatchesSequenceAudience(db, cid, seq.audience_filter)
      if (ok) matched.push(cid)
    }
    if (matched.length === 0) continue

    await enrolContacts({
      sequenceId: seq.id,
      contactIds: matched,
      sourceType: 'segment_added',
      sourceRef: segmentId,
    })
  }
}

/**
 * Mirror of triggerSequencesForSegmentAdded for the removal direction.
 *
 * Note: removals fire when a contact's attributes change such that
 * they no longer satisfy the segment filter. Contact deletion does
 * NOT fire a removal — the ON DELETE CASCADE on
 * contact_segment_memberships drops the snapshot row directly, the
 * diff doesn't see it. "Customer churned out of 'active member'"
 * → fires. "Customer record purged" → doesn't.
 */
export async function triggerSequencesForSegmentRemoved(segmentId, contactIds) {
  if (!segmentId || !Array.isArray(contactIds) || contactIds.length === 0) return
  const db = createServerClient()

  const { data: segment } = await db
    .from('contact_segments')
    .select('id, location_id')
    .eq('id', segmentId)
    .single()
  if (!segment?.location_id) return

  const { data: sequences } = await db
    .from('email_sequences')
    .select('id, trigger_config, audience_filter')
    .eq('location_id', segment.location_id)
    .eq('trigger_type', 'segment_removed')
    .eq('status', 'active')
  if (!sequences || sequences.length === 0) return

  for (const seq of sequences) {
    const cfg = seq.trigger_config || {}
    if (!cfg.segment_id || cfg.segment_id !== segmentId) continue

    const matched = []
    for (const cid of contactIds) {
      const ok = await contactMatchesSequenceAudience(db, cid, seq.audience_filter)
      if (ok) matched.push(cid)
    }
    if (matched.length === 0) continue

    await enrolContacts({
      sequenceId: seq.id,
      contactIds: matched,
      sourceType: 'segment_removed',
      sourceRef: segmentId,
    })
  }
}

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
      .eq('status', 'active')
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

// ── pipeline_stage_change ────────────────────────────────────────

/**
 * Called from POST /api/contacts and (downstream of deal stage moves)
 * when a contact's pipeline_stage_slug value actually changes. Finds
 * every active sequence with trigger_type='pipeline_stage_change' for
 * the contact's location whose trigger_config matches:
 *   - cfg.to_status   (optional)  — only fire when stage flipped TO this slug
 *   - cfg.from_status (optional)  — only fire when stage flipped FROM this slug
 * Empty config = fire on any stage change. Sequence's audience_filter
 * (if set) is then evaluated against the contact — non-matches skip.
 *
 * CLASSIFY.2: renamed from triggerSequencesForStatusChange. Trigger
 * taxonomy keys (cfg.to_status, cfg.from_status) kept for back-compat
 * with existing sequence rows; semantics read pipeline_stage_slug.
 *
 * Best-effort — errors are swallowed so the upstream mutation isn't
 * blocked by a sequence enrol failure.
 *
 * @param {string} contactId
 * @param {string|null} oldStage  pipeline_stage_slug before the change
 * @param {string|null} newStage  pipeline_stage_slug after the change
 */
export async function triggerSequencesForPipelineStageChange(contactId, oldStage, newStage) {
  if (oldStage === newStage) return
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
      .eq('trigger_type', 'pipeline_stage_change')
      .eq('status', 'active')
    if (!sequences || sequences.length === 0) return

    for (const seq of sequences) {
      const cfg = seq.trigger_config || {}
      if (cfg.to_status && cfg.to_status !== newStage) continue
      if (cfg.from_status && cfg.from_status !== oldStage) continue
      const matches = await contactMatchesSequenceAudience(db, contactId, seq.audience_filter)
      if (!matches) continue
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: [contactId],
        sourceType: 'pipeline_stage_change',
        sourceRef: `${oldStage || 'null'}→${newStage || 'null'}`,
      })
    }
  } catch (e) {
    logWarn('sequences', `pipeline_stage_change trigger failed for ${contactId}`, { err: e })
  }
}

/**
 * STAGETRIG.1 — adapter from a deal-PLACEMENT result to the
 * pipeline_stage_change trigger.
 *
 * The trigger above was wired at exactly one call site: POST
 * /api/contacts, where oldStage is always null. Every actual stage MOVE
 * wrote deals.stage_id and let the mig-155 trigger re-derive
 * contacts.pipeline_stage_slug in the database, which the sequence
 * engine never hears about. Net effect: no pipeline_stage_change
 * sequence with a to_status other than the creation stage could fire at
 * all — including the shipped `lead_status_member_welcome` template
 * ({ to_status: 'converted' }), which has been inert since it shipped.
 *
 * `ensureDealForContact` (glofox-sync.js) already computes the diff and
 * returns it, so the callers that place deals pass their result straight
 * in rather than each re-deriving "was this a move?".
 *
 * Fires ONLY for action === 'move' with two genuinely different slugs:
 *   • 'leave'   — the classifier is idempotent, so an unchanged member
 *                 returns 'leave' on EVERY sync. Firing on those would
 *                 re-enrol the entire membership on every tick.
 *   • 'create'  — a first deal is contact creation, already covered by
 *                 POST /api/contacts (oldStage null); firing here as
 *                 well would double-enrol.
 *   • 'error' / 'skipped' — no write happened.
 *
 * Beyond that, enrolment keeps its own guards (active-enrolment dedup,
 * re-enrolment cooldown, automations_exempt, the sequence's audience
 * filter) — this adapter adds a gate, it doesn't bypass any.
 *
 * Best-effort and never throws: every caller has already committed its
 * primary write.
 *
 * @param {string} contactId
 * @param {{action: string, from_slug?: string|null, to_slug?: string|null}|null} dealResult
 *   the return value of ensureDealForContact.
 */
export async function triggerSequencesForDealPlacement(contactId, dealResult) {
  if (!contactId || dealResult?.action !== 'move') return
  const from = dealResult.from_slug ?? null
  const to = dealResult.to_slug ?? null
  if (from === to) return
  try {
    await triggerSequencesForPipelineStageChange(contactId, from, to)
  } catch (e) {
    // triggerSequencesForPipelineStageChange swallows its own errors;
    // this catches the createServerClient/import-level case so a sync
    // or route can never fail on account of a sequence.
    logWarn('sequences', `deal placement trigger failed for ${contactId}`, { err: e })
  }
}

// ── membership_state_change ──────────────────────────────────────

/**
 * Called from the Glofox member-sync (applyMemberSync) when a contact's
 * glofox_membership_state transitions — active / paused / locked, where
 * 'locked' = payment arrears (the churn radar's Overdue tab). Mirrors
 * pipeline_stage_change:
 *   - cfg.to_state   (optional)  — only fire when state flipped TO this value
 *   - cfg.from_state (optional)  — only fire when state flipped FROM this value
 * Empty config = fire on any state change. The sequence's audience_filter
 * (if set) is then evaluated against the contact — non-matches skip.
 *
 * The targeted use case is win-back / dunning: state → 'locked' starts a
 * dunning sequence. Best-effort — errors swallowed so the Glofox sync isn't
 * blocked by a sequence enrol failure.
 *
 * @param {string} contactId
 * @param {string|null} oldState  glofox_membership_state before the change
 * @param {string|null} newState  glofox_membership_state after the change
 */
export async function triggerSequencesForMembershipStateChange(contactId, oldState, newState) {
  if (oldState === newState) return
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
      .eq('trigger_type', 'membership_state_change')
      .eq('status', 'active')
    if (!sequences || sequences.length === 0) return

    for (const seq of sequences) {
      const cfg = seq.trigger_config || {}
      if (cfg.to_state && cfg.to_state !== newState) continue
      if (cfg.from_state && cfg.from_state !== oldState) continue
      const matches = await contactMatchesSequenceAudience(db, contactId, seq.audience_filter)
      if (!matches) continue
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: [contactId],
        sourceType: 'membership_state_change',
        sourceRef: `${oldState || 'null'}→${newState || 'null'}`,
      })
    }
  } catch (e) {
    logWarn('sequences', `membership_state_change trigger failed for ${contactId}`, { err: e })
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

// ── contact_created ──────────────────────────────────────────────

/**
 * Called from the interactive lead-creation sites (manual POST /api/contacts,
 * the website POST /api/public/leads form, and the assistant create_contact
 * tool) right after a NEW contact row is inserted. Enrols the contact into
 * every active sequence with trigger_type='contact_created' whose
 * audience_filter the contact matches.
 *
 * Also fired from the Glofox webhook (SEQ-GLOFOX.1) when MEMBER_CREATED
 * arrives for an unknown member and the real-time sync INSERTS the contact
 * — per-event single-member creation, so it sits outside the guard below.
 *
 * Deliberately NOT wired into bulk-import or the nightly Glofox bulk sync
 * (the mass-create guard) — same scoping as the curated
 * glofox_lead_provisioning hook.
 *
 * Best-effort — errors swallowed + logged so it can never fail the upstream
 * contact insert.
 *
 * @param {string} contactId
 */
export async function triggerSequencesForContactCreated(contactId) {
  if (!contactId) return
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
      .select('id, audience_filter')
      .eq('location_id', contact.location_id)
      .eq('trigger_type', 'contact_created')
      .eq('status', 'active')
    if (!sequences || sequences.length === 0) return

    for (const seq of sequences) {
      const matches = await contactMatchesSequenceAudience(db, contactId, seq.audience_filter)
      if (!matches) continue
      await enrolContacts({
        sequenceId: seq.id,
        contactIds: [contactId],
        sourceType: 'contact_created',
        sourceRef: 'created',
      })
    }
  } catch (e) {
    logWarn('sequences', `contact_created trigger failed for ${contactId}`, { err: e })
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
