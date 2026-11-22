// Enrol contacts into a sequence — the entry point everywhere
// outside this module. Idempotent at two layers:
//
//   1. Active-enrolment dedup. If a contact is currently in
//      status='active' for this sequence, re-enrol is a no-op.
//      ENROLDEDUP.1 — this used to say the schema carried a
//      `sequence_enrollments_unique_active` PARTIAL index. It does not,
//      and never has. The live index is
//      `sequence_enrollments_sequence_id_contact_id_key` — a FULL unique
//      on (sequence_id, contact_id) with no WHERE clause. That is a
//      stronger guarantee (one enrolment per contact per sequence EVER,
//      not one active one), and the difference matters twice below: the
//      insert can use ON CONFLICT DO NOTHING, which the imagined partial
//      index would not have supported; and a re-entry after the cooldown
//      cannot be a second row (see the cooldown note in Tier 2).
//
//   2. Re-enrolment cooldown (mig 090). If a sequence has
//      re_enrolment_cooldown_days set, a contact who has a recent
//      terminal (completed/exited) row is blocked until that row
//      ages out. Without a cooldown set, ANY past terminal row
//      blocks (preserves the old single-enrolment guarantee).
//      COOLDOWN.1 — once the cooldown HAS passed, the contact re-enters:
//      their one row is re-activated in place for a fresh run, and the
//      run that ended is kept on metadata.previous_runs.
//
// The cooldown logic is in ./cooldown.js so the post-DB filter can
// be tested in isolation.

import { createServerClient } from '@/lib/supabase'
import { selectAllByKeys } from '@/lib/select-all'
import { logWarn } from '@/lib/log'
import { getLocationZone } from '@/lib/location-time'
import { clampToSendWindow, hasSendWindow, nextStepDelayMs } from './scheduler.js'
import { findBlockedByCooldown, planReenrolments } from './cooldown.js'

// Operator-initiated sourceTypes that bypass the automations_exempt gate.
// 'manual' = the sequences enrol route/UI; 'churn_radar' = a staff member's
// per-member "Send payment reminder" click (RADAR-PAY.1) — both are humans
// deliberately targeting a contact, which must include host leads
// (Richard's rule). Everything else (triggers, crons, segments, dunning
// auto-enrol, inbound webhook) is automatic and respects the flag.
const MANUAL_LIKE_SOURCE_TYPES = new Set(['manual', 'churn_radar'])

// COOLDOWN.1 — source types whose sourceRef names a KIND of event (the tag,
// the segment, the stage move, 'created'), so the same ref firing again after
// the cooldown is a genuinely new occurrence and may re-enter. Every other
// source type's ref names ONE event (a booking, a purchase, an order, an
// account, a webhook delivery, an anniversary year): the same ref again is
// that event offered again — the purchase sweeps re-offer each purchase for
// 48 hours — and never starts a second run. Unknown types land on the safe
// side: a repeat of the same ref is refused.
export const REPEATABLE_REF_SOURCE_TYPES = new Set([
  'manual', 'audience_match', 'tag_added', 'segment_added', 'segment_removed',
  'pipeline_stage_change', 'membership_state_change', 'contact_created',
])

/**
 * @param {object} args
 * @param {string} args.sequenceId
 * @param {string[]} args.contactIds
 * @param {string} [args.sourceType='manual']  How they got enrolled
 *   ('manual', 'trigger:status_change', 'trigger:race_finished', etc.)
 * @param {string} [args.sourceRef]            Free-form ref to whatever
 *   caused the enrolment (booking id, race-registration id, etc.)
 * @param {number} [args.startStepOrder=0]  UN1TWELCOME.2 — the `current_step_order`
 *   a FRESH insert starts at (a non-negative integer, else it throws), so a
 *   caller can skip step 1. The DUNNING re-activation path always restarts at 0.
 * @param {boolean} [args.allowReenrol=false]  DUNNING.2 — the dunning
 *   paths' stricter re-entry: a TERMINAL row is re-activated only when the
 *   cooldown has passed AND the sourceRef differs from the last run's
 *   (Glofox re-sends PAST_DUE on every retry of ONE invoice). COOLDOWN.1 —
 *   every other caller re-enters on the cooldown: once
 *   re_enrolment_cooldown_days have passed since the last run ended, the row
 *   is re-activated for a fresh run, as the setting promises — unless the
 *   sourceRef names one event that already had a run (see
 *   REPEATABLE_REF_SOURCE_TYPES). With no cooldown set (null/0) nobody ever
 *   re-enters, on either path.
 * @param {object} [args.metadata=null]  PAYLINK.3 — per-run metadata written
 *   onto the enrolment row (e.g. the overdue reminder's `payment` object:
 *   `{ invoice_id, link, link_suffix, amount, ... }`). Written on a fresh
 *   insert only when given (no `metadata` key on the row otherwise); on a
 *   DUNNING.2 re-activation it is merged OVER the old run's metadata, and
 *   `previous_runs` is always kept regardless (the caller cannot forge it —
 *   the real history always wins that key). PAYLINK.3b — `metadata` is
 *   per-contact (it exists to carry ONE member's payment link): passing it
 *   with more than one `contactIds` entry THROWS rather than fan it out
 *   across a batch. A non-plain-object value (string/number/array) is not
 *   silently dropped — it is logged via `logWarn` and then ignored, same as
 *   no metadata was given. `metadata` must be JSON-serialisable (it lands on
 *   a jsonb column): an `undefined` value is dropped and a `Date` is stored
 *   as its `toISOString()` string, exactly as `JSON.stringify` would.
 * @returns {Promise<{ enrolled: number, skipped: number, reactivated: number }>}
 */
export async function enrolContacts({
  sequenceId, contactIds, sourceType = 'manual', sourceRef = null, allowReenrol = false,
  metadata = null, startStepOrder = 0,
}) {
  if (!Number.isInteger(startStepOrder) || startStepOrder < 0) {
    throw new Error(`enrolContacts: startStepOrder must be a non-negative integer, got ${startStepOrder}`)
  }
  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return { enrolled: 0, skipped: 0, reactivated: 0 }
  }

  // PAYLINK.3 — a plain object (not array/null) rides the row; anything
  // else (omitted, null) leaves the column untouched. PAYLINK.3b — a given
  // but non-object value (string/number/array) is a caller mistake, not a
  // silent no-op: warn so it surfaces, then treat it the same as omitted.
  let runMeta = null
  if (metadata != null) {
    if (typeof metadata === 'object' && !Array.isArray(metadata)) {
      runMeta = metadata
    } else {
      logWarn('enrol', 'metadata ignored: not a plain object', { sourceType })
    }
  }

  // PAYLINK.3b — metadata exists to carry ONE member's payment link; a
  // batch write sharing one object across N rows is never correct, so
  // refuse it outright rather than fan it out silently. Checked up front,
  // next to the contactIds guard, so a misuse fails before any DB read.
  if (runMeta && contactIds.length > 1) {
    throw new Error('enrol: metadata is per-contact; a batch enrolment cannot share it')
  }

  const db = createServerClient()

  // Tier 1 dedup — active enrolments.
  //
  // ENROLDEDUP.1 — this was a single unchunked `.in('contact_id', contactIds)`
  // with its `error` discarded. Both halves were live bugs, and both fail in
  // the same direction — toward enrolling someone twice:
  //   • The match SET is capped at db-max-rows, so against >1000 existing
  //     enrolments the lookup silently missed everyone past the cap. The
  //     key LIST is also encoded into the request URL, which PostgREST
  //     400s once it runs long — and a 400 landed in the discarded `error`,
  //     leaving `existing` null and EVERY contact looking un-enrolled.
  //   • That is the [[discarded-error-defect-class]] shape: "read failed"
  //     and "nobody matched" collapse into the same empty set.
  // selectAllByKeys chunks the keys, pages each chunk, and THROWS on error
  // (select-all.js) — so this now fails closed, matching the
  // automations_exempt gate below. Its own docstring describes precisely
  // this bug: a dedup lookup that misses past 1000 and then inserts dupes.
  const existing = await selectAllByKeys(
    contactIds,
    (keys, from, to) => db
      .from('sequence_enrollments')
      .select('contact_id')
      .eq('sequence_id', sequenceId)
      .eq('status', 'active')
      .in('contact_id', keys)
      .order('contact_id')
      .range(from, to),
  )
  const alreadyActive = new Set(existing.map(r => r.contact_id))

  // Tier 2 dedup — re-enrolment cooldown. Read the sequence's
  // configured cooldown + the contact's history, hand both to the
  // cooldown helper.
  //
  // COOLDOWN.1 — this tier used to be dead (ENROLDEDUP.1 recorded it): once a
  // cooldown elapsed findBlockedByCooldown released the contact, and the
  // insert below then hit the full unique index, so a positive cooldown never
  // granted re-entry. The owner decided (Nov 2026) that the setting means what
  // it says. Re-entry is NOT a second row: the contact's terminal row is
  // re-activated in place (the DUNNING.2 mechanism), so the full unique index
  // keeps guaranteeing at most one enrolment — and so at most one live one —
  // per person per sequence, and no reader has to choose between rows.
  // Sequences with no cooldown (null/0) are unchanged: one run per person.
  const { data: seqRow } = await db
    .from('email_sequences')
    .select('re_enrolment_cooldown_days, send_window, location_id')
    .eq('id', sequenceId)
    .single()
  const cooldownDays = seqRow?.re_enrolment_cooldown_days

  const candidatesNotActive = contactIds.filter(id => !alreadyActive.has(id))
  let blockedFromHistory = new Set()
  let reenrolPlan = new Map()
  if (candidatesNotActive.length > 0) {
    // ENROLDEDUP.1 — same unchunked-plus-discarded-error shape as Tier 1.
    // DUNNING.2 — the wider select carries what a re-activation needs to
    // record the previous run; the cooldown maths reads the same four
    // columns it always did.
    const history = await selectAllByKeys(
      candidatesNotActive,
      (keys, from, to) => db
        .from('sequence_enrollments')
        // ENROLFIX.1 — `sequence_enrollments` has no `created_at` (mig 005:
        // the row's timestamp is `enrolled_at`). Selecting it here was a
        // PostgREST 400 on EVERY enrolment; before ENROLDEDUP.1 that error
        // was discarded (no cooldown, but the insert went ahead), and from
        // 20 Aug it threw — zero enrolments estate-wide until 13 Sep.
        .select('id, contact_id, status, last_processed_at, source_type, source_ref, enrolled_at, completed_at, exited_at, exit_reason, metadata')
        .eq('sequence_id', sequenceId)
        .in('contact_id', keys)
        .in('status', ['completed', 'exited'])
        .order('contact_id')
        .range(from, to),
    )
    blockedFromHistory = findBlockedByCooldown(history, cooldownDays)
    // DUNNING.2 — with allowReenrol, a contact whose latest terminal row is
    // outside the cooldown AND carries a different source_ref is re-activated
    // in place below; a refused one counts as skipped.
    // COOLDOWN.1 — without it, the cooldown decides, plus one guard: a
    // sourceRef that names one event (REPEATABLE_REF_SOURCE_TYPES above) and
    // already had a run is never run again. Only the re-activations join the
    // plan, so a blocked contact keeps the old uncounted-skip quirk the tests
    // pin.
    // Everyone with history is removed from the INSERT path either way: an
    // insert for them can only hit the index.
    if (allowReenrol) {
      reenrolPlan = planReenrolments(history, cooldownDays, sourceRef)
    } else {
      const refGuard = REPEATABLE_REF_SOURCE_TYPES.has(sourceType) ? null : sourceRef
      for (const [cid, plan] of planReenrolments(history, cooldownDays, refGuard, Date.now(), { includePreviousRuns: true })) {
        if (plan.decision === 'reactivate') reenrolPlan.set(cid, plan)
      }
    }
    for (const cid of reenrolPlan.keys()) blockedFromHistory.add(cid)
  }

  let candidateIds = contactIds
    .filter(id => !alreadyActive.has(id) && !blockedFromHistory.has(id))

  // HOST-MASTER.3 — automations_exempt blocks AUTOMATIC enrolment only.
  // Every trigger/cron/segment/dunning/webhook caller passes a named
  // sourceType; the MANUAL_LIKE set is exclusively the operator-initiated
  // paths (and the default), which deliberately bypass this gate (manual
  // sends must include host leads — Richard's rule).
  //
  // COOLDOWN.1 — the gate covers re-activations too. A re-entry is an
  // automatic enrolment like any other; before this it was checked only on
  // the insert path, so a dunning re-run could reach an exempt contact.
  let exemptSkipped = 0
  const reactivateIds = [...reenrolPlan].filter(([, p]) => p.decision === 'reactivate').map(([cid]) => cid)
  const gateIds = [...candidateIds, ...reactivateIds]
  if (!MANUAL_LIKE_SOURCE_TYPES.has(sourceType) && gateIds.length > 0) {
    const exempt = new Set()
    // Chunked .in() by 500 guards the 1k-row cap.
    for (let i = 0; i < gateIds.length; i += 500) {
      const { data: flags, error } = await db
        .from('contacts')
        .select('id')
        .in('id', gateIds.slice(i, i + 500))
        .eq('automations_exempt', true)
      // FAIL CLOSED: a transient read failure must abort the enrolment,
      // not fall through to auto-enrolling exempt contacts (the exact
      // thing this gate forbids). Trigger/cron/dunning callers are all
      // best-effort try/catch, so the throw just skips that firing.
      if (error) throw new Error(`enrol: automations_exempt check failed: ${error.message}`)
      for (const r of flags || []) exempt.add(r.id)
    }
    if (exempt.size > 0) {
      exemptSkipped = exempt.size
      candidateIds = candidateIds.filter(id => !exempt.has(id))
      for (const id of exempt) reenrolPlan.delete(id)
    }
  }

  // UN1TWELCOME.7 — a fresh enrolment fires "on the next tick" (now) for every
  // other sequence in the estate, and they depend on that. The welcome
  // sequence alone also honours its send window and the start step's delay,
  // exactly as the scheduler does for the steps that follow: the delay of the
  // step the cursor lands on, then clamped to the window in the sequence
  // location's zone. Scoped to this source type on purpose: applying the
  // window to every windowed sequence's first step would change live behaviour
  // for triggers, dunning and campaigns that this feature does not own.
  let firstFireAt = new Date()
  if (sourceType === 'un1t_account_created' && (candidateIds.length > 0 || reenrolPlan.size > 0) && (startStepOrder > 0 || hasSendWindow(seqRow?.send_window))) {
    // Best-effort: a failed read must not lose the enrolment, so it falls back
    // to firing now (every other sequence's behaviour). Codes and names only.
    try {
      const { data: firstStep, error: stepErr } = await db
        .from('sequence_steps')
        .select('delay_days, delay_hours, delay_minutes')
        .eq('sequence_id', sequenceId)
        .eq('step_order', startStepOrder + 1)
        .maybeSingle()
      if (stepErr) {
        logWarn('enrol', 'first step unreadable; the enrolment fires now', { sequenceId, code: stepErr.code ?? null })
      } else if (firstStep) {
        const raw = new Date(firstFireAt.getTime() + nextStepDelayMs(firstStep))
        if (hasSendWindow(seqRow?.send_window)) {
          const zone = await getLocationZone(db, seqRow.location_id)
          firstFireAt = clampToSendWindow(raw, seqRow.send_window, zone)
        } else {
          firstFireAt = raw
        }
      }
    } catch (e) {
      firstFireAt = new Date()
      logWarn('enrol', 'first send time unreadable; the enrolment fires now', { sequenceId, errName: e?.name ?? null })
    }
  }

  const toInsert = candidateIds
    .map(contactId => ({
      sequence_id: sequenceId,
      contact_id: contactId,
      current_step_order: startStepOrder,
      status: 'active',
      next_step_at: firstFireAt.toISOString(), // fire on next cron tick (welcome: window + start-step delay, above)
      source_type: sourceType,
      source_ref: sourceRef,
      ...(runMeta ? { metadata: runMeta } : {}),
    }))

  // DUNNING.2 — re-activate in place. One UPDATE per contact, guarded by id +
  // the terminal status we read so a concurrent activation can never be
  // clobbered (the loser updates 0 rows and counts as skipped). The previous
  // run is kept on metadata.previous_runs so run history stays honest.
  // COOLDOWN.1 — every caller now reaches this (see Tier 2). The dunning path
  // keeps its old shape exactly (step 0, now, old metadata merged under the
  // new). The general path starts the run like a fresh insert would
  // (startStepOrder, firstFireAt) and does NOT carry the old run's metadata
  // forward — a stale template_wait or test flag belongs to the run that
  // ended — only previous_runs survives. The audience sweep caps how many
  // contacts it hands over per tick, so this loop stays small.
  let reactivated = 0
  let reenrolSkipped = 0
  if (reenrolPlan.size > 0) {
    const nowIso = new Date().toISOString()
    const runStartIso = allowReenrol ? nowIso : firstFireAt.toISOString()
    const runStartStep = allowReenrol ? 0 : startStepOrder
    for (const [, plan] of reenrolPlan) {
      if (plan.decision !== 'reactivate') { reenrolSkipped++; continue }
      const row = plan.row
      const prevMeta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {}
      const previousRuns = Array.isArray(prevMeta.previous_runs) ? prevMeta.previous_runs : []
      const carriedMeta = allowReenrol ? prevMeta : {}
      const { data: updated, error: updErr } = await db
        .from('sequence_enrollments')
        .update({
          status: 'active',
          current_step_order: runStartStep,
          next_step_at: runStartIso,
          enrolled_at: nowIso,
          exit_reason: null,
          completed_at: null,
          exited_at: null,
          last_error: null,
          error_count: 0,
          last_processed_at: null,
          source_type: sourceType,
          source_ref: sourceRef,
          metadata: {
            ...carriedMeta,
            ...(runMeta || {}),
            previous_runs: [
              ...previousRuns,
              {
                source_type: row.source_type ?? null,
                source_ref: row.source_ref ?? null,
                status: row.status,
                enrolled_at: row.enrolled_at ?? null,
                ended_at: row.completed_at || row.exited_at || row.last_processed_at || null,
                exit_reason: row.exit_reason ?? null,
              },
            ],
          },
        })
        .eq('id', row.id)
        .eq('status', row.status)
        .select('id')
      if (updErr) throw new Error(`Re-enrol failed: ${updErr.message}`)
      if ((updated || []).length > 0) reactivated++
      else reenrolSkipped++
    }
  }

  if (toInsert.length === 0) {
    // Pre-DUNNING.2 this path reported every contact as skipped; a
    // re-activated contact is enrolled, everyone else still counts.
    return { enrolled: reactivated, skipped: contactIds.length - reactivated, reactivated }
  }

  // ENROLDEDUP.1 — was a bare `.insert(toInsert)`. Against the FULL unique
  // index a single conflicting row aborts the ENTIRE batch with 23505, so
  // one contact who slipped between the dedup read and this write killed
  // the other 99 — and the throw is indistinguishable from a real failure.
  // The dedup above is a SELECT-then-INSERT and therefore never atomic;
  // the index is the only real guarantee, so let it do its job quietly.
  //
  // ON CONFLICT DO NOTHING makes this idempotent, which is what lets a
  // caller retry a partially-applied batch — and what will let the
  // audience sweep run on overlapping cron ticks without racing itself.
  // `.select('id')` returns only the rows actually inserted, so `enrolled`
  // stops over-reporting the skipped conflicts as enrolments.
  const { data: inserted, error } = await db
    .from('sequence_enrollments')
    .upsert(toInsert, { onConflict: 'sequence_id,contact_id', ignoreDuplicates: true })
    .select('id')
  if (error) throw new Error(`Enrol failed: ${error.message}`)
  const enrolledCount = (inserted || []).length

  // SEQCOUNTERS.1 — no counter bump: the enrolled-counter RPC this used to
  // call never existed. /automations counts sequence_enrollments rows instead.

  // `skipped` counts everything we declined to enrol, including rows the
  // index rejected on conflict (toInsert.length - enrolledCount), which the
  // old return silently reported as enrolled, plus (DUNNING.2) the contacts
  // considered for a re-run that were not re-activated. Cooldown-blocked
  // contacts on the default path are NOT counted here — a long-standing
  // quirk the tests pin; the split that introduced it must not change it.
  return {
    enrolled: enrolledCount + reactivated,
    skipped: alreadyActive.size + exemptSkipped + reenrolSkipped + (toInsert.length - enrolledCount),
    reactivated,
  }
}
