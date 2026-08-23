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
//      index would not have supported; and re_enrolment_cooldown_days
//      cannot actually work against it (see the cooldown note in Tier 2).
//
//   2. Re-enrolment cooldown (mig 090). If a sequence has
//      re_enrolment_cooldown_days set, a contact who has a recent
//      terminal (completed/exited) row is blocked until that row
//      ages out. Without a cooldown set, ANY past terminal row
//      blocks (preserves the old single-enrolment guarantee).
//
// The cooldown logic is in ./cooldown.js so the post-DB filter can
// be tested in isolation.

import { createServerClient } from '@/lib/supabase'
import { selectAllByKeys } from '@/lib/select-all'
import { findBlockedByCooldown, planReenrolments } from './cooldown.js'

// Operator-initiated sourceTypes that bypass the automations_exempt gate.
// 'manual' = the sequences enrol route/UI; 'churn_radar' = a staff member's
// per-member "Send payment reminder" click (RADAR-PAY.1) — both are humans
// deliberately targeting a contact, which must include host leads
// (Richard's rule). Everything else (triggers, crons, segments, dunning
// auto-enrol, inbound webhook) is automatic and respects the flag.
const MANUAL_LIKE_SOURCE_TYPES = new Set(['manual', 'churn_radar'])

/**
 * @param {object} args
 * @param {string} args.sequenceId
 * @param {string[]} args.contactIds
 * @param {string} [args.sourceType='manual']  How they got enrolled
 *   ('manual', 'trigger:status_change', 'trigger:race_finished', etc.)
 * @param {string} [args.sourceRef]            Free-form ref to whatever
 *   caused the enrolment (booking id, race-registration id, etc.)
 * @param {boolean} [args.allowReenrol=false]  DUNNING.2 — re-activate a
 *   contact's TERMINAL enrolment row (completed / exited) in place when the
 *   sequence's cooldown has passed and the sourceRef differs from the last
 *   run's. Only the dunning paths pass this: the full unique index on
 *   (sequence_id, contact_id) otherwise means one enrolment per contact EVER
 *   (ENROLDEDUP.1), and a member whose card fails again months later must be
 *   reminded again. Every other caller keeps the one-enrolment semantics —
 *   this is deliberately not a cohort-wide re-entry.
 * @returns {Promise<{ enrolled: number, skipped: number, reactivated: number }>}
 */
export async function enrolContacts({
  sequenceId, contactIds, sourceType = 'manual', sourceRef = null, allowReenrol = false,
}) {
  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return { enrolled: 0, skipped: 0, reactivated: 0 }
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
  // ENROLDEDUP.1 — KNOWN DEAD, LEFT AS-IS DELIBERATELY. Against the full
  // unique index this tier can only ever subtract: once a cooldown elapses
  // findBlockedByCooldown releases the contact, and the insert below then
  // hits the index anyway. So a POSITIVE cooldown never grants re-entry —
  // it only ever behaves like the no-cooldown case. Three live sequences
  // carry cooldowns (365, 365, 30) configured as though it works.
  // Not fixed here: the fix is swapping the index for a partial one, which
  // changes enrolment semantics for every sequence in the estate and would
  // let an unattended sweep re-mail a whole completed cohort the day a
  // cooldown expires. That is a deliberate product decision, not a bug fix,
  // and it does not belong in a PR about chunking and conflict handling.
  const { data: seqRow } = await db
    .from('email_sequences')
    .select('re_enrolment_cooldown_days')
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
        .select('id, contact_id, status, last_processed_at, created_at, source_type, source_ref, enrolled_at, completed_at, exited_at, exit_reason, metadata')
        .eq('sequence_id', sequenceId)
        .in('contact_id', keys)
        .in('status', ['completed', 'exited'])
        .order('contact_id')
        .range(from, to),
    )
    blockedFromHistory = findBlockedByCooldown(history, cooldownDays)
    // DUNNING.2 — with allowReenrol, a contact whose latest terminal row is
    // outside the cooldown AND carries a different source_ref is re-activated
    // in place below. Everyone with history is removed from the INSERT path
    // either way: an insert for them can only hit the index.
    if (allowReenrol) {
      reenrolPlan = planReenrolments(history, cooldownDays, sourceRef)
      for (const cid of reenrolPlan.keys()) blockedFromHistory.add(cid)
    }
  }

  let candidateIds = contactIds
    .filter(id => !alreadyActive.has(id) && !blockedFromHistory.has(id))

  // HOST-MASTER.3 — automations_exempt blocks AUTOMATIC enrolment only.
  // Every trigger/cron/segment/dunning/webhook caller passes a named
  // sourceType; the MANUAL_LIKE set is exclusively the operator-initiated
  // paths (and the default), which deliberately bypass this gate (manual
  // sends must include host leads — Richard's rule).
  let exemptSkipped = 0
  if (!MANUAL_LIKE_SOURCE_TYPES.has(sourceType) && candidateIds.length > 0) {
    const exempt = new Set()
    // Chunked .in() by 500 guards the 1k-row cap.
    for (let i = 0; i < candidateIds.length; i += 500) {
      const { data: flags, error } = await db
        .from('contacts')
        .select('id')
        .in('id', candidateIds.slice(i, i + 500))
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
    }
  }

  const toInsert = candidateIds
    .map(contactId => ({
      sequence_id: sequenceId,
      contact_id: contactId,
      current_step_order: 0,
      status: 'active',
      next_step_at: new Date().toISOString(), // fire on next cron tick
      source_type: sourceType,
      source_ref: sourceRef,
    }))

  // DUNNING.2 — re-activate in place. One UPDATE per contact (dunning is
  // per-member, never a fan-out), guarded by id + the terminal status we
  // read so a concurrent activation can never be clobbered. The previous
  // run is kept on metadata.previous_runs so run history stays honest.
  let reactivated = 0
  let reenrolSkipped = 0
  if (allowReenrol && reenrolPlan.size > 0) {
    const nowIso = new Date().toISOString()
    for (const [, plan] of reenrolPlan) {
      if (plan.decision !== 'reactivate') { reenrolSkipped++; continue }
      const row = plan.row
      const prevMeta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {}
      const previousRuns = Array.isArray(prevMeta.previous_runs) ? prevMeta.previous_runs : []
      const { data: updated, error: updErr } = await db
        .from('sequence_enrollments')
        .update({
          status: 'active',
          current_step_order: 0,
          next_step_at: nowIso,
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
            ...prevMeta,
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
    await bumpEnrolledCounter(db, sequenceId, reactivated)
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

  await bumpEnrolledCounter(db, sequenceId, enrolledCount + reactivated, { always: true })

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

// Bump the cached counter on the parent sequence. Best-effort — the runner
// doesn't depend on this counter for correctness, it's just for the admin
// dashboard. `always` keeps the pre-DUNNING.2 behaviour on the insert path
// (the RPC fired even for a zero delta); the re-activation-only path skips
// a zero bump.
// NOTE: a supabase-js builder is a thenable, not a Promise — it has no
// `.catch`, so `db.rpc(...).catch(...)` throws a synchronous TypeError and
// the RPC never fires. Must be try/await/catch.
async function bumpEnrolledCounter(db, sequenceId, delta, { always = false } = {}) {
  if (!delta && !always) return
  try {
    await db.rpc('increment_sequence_enrolled', {
      p_sequence_id: sequenceId,
      p_delta: delta,
    })
  } catch { /* RPC not present / best-effort counter — no-op */ }
}
