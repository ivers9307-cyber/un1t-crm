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

  // Use upsert with onConflict on the unique partial index. Doesn't
  // quite work in PostgREST because partial indexes can't be the
  // conflict target; instead, do a SELECT-then-INSERT for the
  // missing rows.
  const { data: existing } = await db
    .from('sequence_enrollments')
    .select('contact_id')
    .eq('sequence_id', sequenceId)
    .eq('status', 'active')
    .in('contact_id', contactIds)
  const alreadyActive = new Set((existing || []).map(r => r.contact_id))

  const toInsert = contactIds
    .filter(id => !alreadyActive.has(id))
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
    .select('id, sequence_id, contact_id, current_step_order, error_count, status')
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
      const nextFireAt = followingStep.data
        ? new Date(now.getTime() + nextStepDelayMs(followingStep.data)).toISOString()
        : null
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
