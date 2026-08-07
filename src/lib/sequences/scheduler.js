// Sequence scheduler — the cron-driven runner that processes due
// enrollments, dispatches the next step, and advances the cursor.
//
// Called by /api/cron/run-sequences every 5 minutes (see vercel.json).
// Also exported for direct invocation from tests.
//
// State machine:
//   active    — currently in the sequence; next_step_at <= now() means due
//   paused    — admin-paused, or auto-paused after MAX_ERRORS consecutive failures
//   exited    — contact left (unsubscribe, goal met, or sequence/contact deleted)
//   completed — every step has been sent
//
// Failure handling: if a step send throws, the error is recorded on
// the enrolment and error_count incremented. After MAX_ERRORS
// consecutive failures the enrolment is auto-paused so a single
// broken contact (e.g. invalid email) can't fill the cron logs forever.

import { createServerClient } from '@/lib/supabase'
import { getLocationFrequencyCap, FrequencyCapDeferral } from '@/lib/frequency-cap'
import {
  sendEmailStep,
  sendWhatsappStep,
  sendSmsStep,
  applyTagStep,
  updateFieldStep,
  webhookStep,
  internalTaskStep,
  processBranchStep,
  movePipelineStageStep,
  glofoxProvisionStep,
} from './steps.js'

export const MAX_ERRORS = 5
export const PROCESS_BATCH_SIZE = 100
// How far forward a claimed enrolment's next_step_at is leased while the
// runner processes it. The runner has no SELECT … FOR UPDATE SKIP LOCKED,
// so each row is claimed with a CAS bump (see runSequences); the lease is
// long enough to cover a tick's processing and short enough that a crashed
// tick's enrolment is retried promptly.
export const CLAIM_LEASE_MS = 10 * 60_000

// ── Public: pause / resume / exit ────────────────────────────────

/**
 * Update the status of a single enrolment. Used by /api/sequences/...
 * pause / resume / exit endpoints.
 */
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

/**
 * Convert a step's three delay fields into a millisecond offset.
 * The schema carries days+hours+minutes (added across migrations);
 * we sum all three so however the row was written, we honour intent.
 */
export function nextStepDelayMs(step) {
  if (!step) return 0
  const days = Number(step.delay_days || 0)
  const hours = Number(step.delay_hours || 0)
  const minutes = Number(step.delay_minutes || 0)
  const ms = (days * 24 * 60 + hours * 60 + minutes) * 60_000
  return Number.isFinite(ms) && ms >= 0 ? ms : 0
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
export function clampToSendWindow(candidate, window) {
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
 *   { type: 'tag_added',       tag: '<tag>'      }
 *   { type: 'pipeline_stage',  value: '<slug>'   }
 *   { type: 'booking_made',    event_type_id?: '<uuid>' }
 *
 * Deprecated goal-type alias (CLASSIFY.2):
 *   { type: 'lead_status', value: '<slug>' } — kept for back-compat
 *   with existing sequence rows. Reads pipeline_stage_slug. Emits a
 *   console.warn on first hit so operators can migrate the config.
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
export async function isGoalMet({ db, contact, goalConfig }) {
  if (!goalConfig?.type) return false
  try {
    if (goalConfig.type === 'pipeline_stage') {
      return contact.pipeline_stage_slug === goalConfig.value
    }
    if (goalConfig.type === 'lead_status') {
      // Deprecated alias — reads pipeline_stage_slug for back-compat.
      console.warn(
        '[sequences] goal type "lead_status" is deprecated; use "pipeline_stage" — reading pipeline_stage_slug'
      )
      return contact.pipeline_stage_slug === goalConfig.value
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
  const stats = { picked: 0, sent: 0, completed: 0, errored: 0, paused: 0, skipped: 0, deferred: 0 }

  // FREQ-CAP.1 — the marketing frequency-cap setting is per LOCATION;
  // resolve it once per location per tick (a 100-enrolment batch is
  // usually one or two locations).
  const capCache = new Map()
  const capSettingFor = async (locationId) => {
    if (!capCache.has(locationId)) {
      capCache.set(locationId, await getLocationFrequencyCap(db, locationId))
    }
    return capCache.get(locationId)
  }

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
      // Atomic claim — the runner has no SELECT … FOR UPDATE SKIP LOCKED, so
      // two overlapping cron ticks can both pick this due row. The step SENDS
      // below BEFORE the cursor advances, so re-processing the same row =
      // a DOUBLE send. CAS-bump next_step_at to a short lease: the predicate
      // `status='active' AND next_step_at <= now` still matches for exactly
      // one tick; the other re-evaluates it against the leased (future) value,
      // matches 0 rows, and skips. The real next_step_at is written when
      // processing finishes (or by the catch); a crashed tick re-leases after
      // CLAIM_LEASE_MS.
      const { data: claimed } = await db.from('sequence_enrollments')
        .update({ next_step_at: new Date(now.getTime() + CLAIM_LEASE_MS).toISOString() })
        .eq('id', enrollment.id)
        .eq('status', 'active')
        .lte('next_step_at', now.toISOString())
        .select('id')
      if (!claimed || claimed.length === 0) {
        stats.skipped++
        continue
      }

      // Reload the parent sequence + the contact in one go.
      const [{ data: sequence }, { data: contact }] = await Promise.all([
        db.from('email_sequences').select('*').eq('id', enrollment.sequence_id).single(),
        db.from('contacts').select('*, contact_preferences(unsubscribe_token)').eq('id', enrollment.contact_id).single(),
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
      if (sequence.status !== 'active') {
        // Sequence is not active (paused/draft/completed) — `status` is the live
        // column (`active` is a dead legacy boolean that stays false on new
        // sequences). Push the row's next-step time forward so we don't busy-loop.
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
        // supabase-js builders don't have .catch — try/catch around await.
        try { await db.rpc('increment_sequence_completed', { p_sequence_id: sequence.id, p_delta: 1 }) } catch {}
        stats.completed++
        continue
      }

      // SEQ-TERMINAL — graph-compiled steps carry their real successor in
      // config.next_step_order ('end' | integer step_order); legacy
      // linear-editor rows have no marker. Validate a corrupt self-pointer
      // BEFORE dispatching so it can never repeat a send: the compiler
      // can't emit one (the graph is validated acyclic), so honouring it
      // would re-run this step on every retry forever.
      const configuredNext = step.config?.next_step_order
      if (step.step_type !== 'branch' && configuredNext === step.step_order) {
        throw new Error(
          `Step ${step.step_order}: config.next_step_order points at itself — refusing to loop`,
        )
      }

      // Branch by step type.
      let sendId = null
      // Mig 091: a branch step jumps the cursor instead of advancing
      // to step_order + 1. branchTargetOrder, when non-null, replaces
      // the standard "+1" lookup below.
      let branchTargetOrder = null
      if (step.step_type === 'wait') {
        // Wait step has no send — just advance with the delay.
        sendId = null
      } else if (step.step_type === 'email' || !step.step_type) {
        // FREQ-CAP.1 — the handler checks the cap AFTER its consent gates
        // and throws FrequencyCapDeferral BEFORE sending; the catch below
        // defers the enrolment without touching error_count or the cursor.
        const frequencyCap = await capSettingFor(sequence.location_id)
        sendId = await sendEmailStep(db, { enrollment, step, sequence, contact, frequencyCap })
      } else if (step.step_type === 'whatsapp') {
        const frequencyCap = await capSettingFor(sequence.location_id)
        sendId = await sendWhatsappStep(db, { enrollment, step, sequence, contact, frequencyCap })
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
      } else if (step.step_type === 'branch') {
        // Mig 091 / Tier 3E. No send. Pick the target step_order
        // based on the predicate; the cursor jumps below.
        branchTargetOrder = await processBranchStep(db, { step, contact })
        sendId = null
      } else if (step.step_type === 'move_pipeline_stage') {
        // RETIRED (FUNNEL.1) — stage is classifier-derived; the
        // handler no-ops (logs a timeline entry, writes nothing) and
        // the enrolment advances normally. The branch stays so a
        // legacy step row never falls through to the unknown-step
        // throw below, which would wedge the enrolment on this step
        // forever (the SEQ-LOOP-FIX failed-advance incident class).
        await movePipelineStageStep(db, { step, contact, sequence })
        sendId = null
      } else if (step.step_type === 'glofox_provision') {
        // AUTOMATIONS Phase 1 — create the contact in Glofox + attach
        // the trial. No send_id. Idempotent + audited; per-contact
        // failures land in the Glofox Review queue, not as runner errors.
        await glofoxProvisionStep(db, { contact, sequence })
        sendId = null
      } else {
        throw new Error(`Unknown step_type "${step.step_type}".`)
      }

      // Compute the next fire time based on the FOLLOWING step's delay.
      // For a branch, "following" = the chosen branch target. For other
      // step types the next_step_order marker (validated above) decides:
      // 'end' completes the enrolment (a terminal branch arm must NOT
      // fall through into the other arm — SEQ-TERMINAL, the seq-21983d6c
      // already-booked-leads-got-the-nudge bug), an integer jumps (e.g. a
      // convergent arm skipping the other arm's rows). Markerless legacy
      // rows keep the historical step_order + 1 advance.
      let followingOrder
      if (branchTargetOrder != null) {
        followingOrder = branchTargetOrder
      } else if (configuredNext === 'end') {
        followingOrder = null
      } else if (Number.isInteger(configuredNext)) {
        followingOrder = configuredNext
      } else {
        followingOrder = step.step_order + 1
      }
      const followingStep = followingOrder == null
        ? { data: null }
        : await db
            .from('sequence_steps')
            .select('delay_days, delay_hours, delay_minutes')
            .eq('sequence_id', sequence.id)
            .eq('step_order', followingOrder)
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

      // Mig 091: cursor lands on (followingOrder - 1) so the next
      // tick picks up step at followingOrder. For markerless steps
      // followingOrder == step.step_order + 1, so this is identical
      // to the previous behaviour. For a branch (or an integer marker)
      // it implements the jump. A terminal step (followingOrder null)
      // parks the cursor on the step just executed — never past it, so
      // a stray reactivation can't land on another arm's row.
      const { error: advanceErr } = await db.from('sequence_enrollments').update({
        current_step_order: followingOrder != null ? followingOrder - 1 : step.step_order,
        next_step_at: nextFireAt,
        status: newStatus,
        last_processed_at: now.toISOString(),
        last_step_send_id: sendId,
        last_error: null,
        error_count: 0,
      }).eq('id', enrollment.id)
      // A rejected advance is the WORST failure mode: the step may already
      // have SENT, and swallowing the error leaves the cursor behind — the
      // claim lease expires and the send repeats every ~10 minutes, forever,
      // with nothing visible anywhere. Live 2026-07-02: the whatsapp step
      // returned Meta's wamid string as sendId, Postgres rejected it for the
      // uuid last_step_send_id column (22P02), and a lead got the same
      // template twice. Throwing routes to the catch below: visible
      // last_error + 30-min backoff + pause after MAX_ERRORS.
      if (advanceErr) {
        throw new Error(`Cursor advance failed after step ${step.step_order} (${step.step_type}): ${advanceErr.message}`)
      }

      if (newStatus === 'completed') {
        // supabase-js builders don't have .catch — try/catch around await.
        try { await db.rpc('increment_sequence_completed', { p_sequence_id: sequence.id, p_delta: 1 }) } catch {}
        stats.completed++
      }
      stats.sent++
    } catch (e) {
      // FREQ-CAP.1 — a frequency-cap deferral is control flow, not an
      // error: NOTHING was sent (the handler throws before the provider
      // call), so the cursor stays put and the step fires again once the
      // contact's window clears. next_step_at moves to deferUntil
      // (window remaining + jitter — replacing the claim lease written
      // above); error_count / last_error / status are untouched, so a
      // capped contact can never be auto-paused by deferrals. If THIS
      // update fails, next_step_at stays at the claim lease (~10 min out)
      // and the gate simply re-evaluates then — still nothing sent, so no
      // re-send loop is possible on any path.
      if (e instanceof FrequencyCapDeferral) {
        await db.from('sequence_enrollments').update({
          next_step_at: e.deferUntil,
          last_processed_at: now.toISOString(),
        }).eq('id', enrollment.id)
        stats.deferred++
        continue
      }
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
