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
import { findBlockedByCooldown } from './cooldown.js'

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
 * @returns {Promise<{ enrolled: number, skipped: number }>}
 */
export async function enrolContacts({
  sequenceId, contactIds, sourceType = 'manual', sourceRef = null,
}) {
  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return { enrolled: 0, skipped: 0 }
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
  if (candidatesNotActive.length > 0) {
    // ENROLDEDUP.1 — same unchunked-plus-discarded-error shape as Tier 1.
    const history = await selectAllByKeys(
      candidatesNotActive,
      (keys, from, to) => db
        .from('sequence_enrollments')
        .select('contact_id, status, last_processed_at, created_at')
        .eq('sequence_id', sequenceId)
        .in('contact_id', keys)
        .in('status', ['completed', 'exited'])
        .order('contact_id')
        .range(from, to),
    )
    blockedFromHistory = findBlockedByCooldown(history, cooldownDays)
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

  if (toInsert.length === 0) {
    return { enrolled: 0, skipped: contactIds.length }
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

  // Bump the cached counter on the parent sequence. Best-effort —
  // the runner doesn't depend on this counter for correctness, it's
  // just for the admin dashboard.
  // NOTE: a supabase-js builder is a thenable, not a Promise — it has no
  // `.catch`, so `db.rpc(...).catch(...)` throws a synchronous TypeError and
  // the RPC never fires. Must be try/await/catch.
  try {
    await db.rpc('increment_sequence_enrolled', {
      p_sequence_id: sequenceId,
      p_delta: enrolledCount,
    })
  } catch { /* RPC not present / best-effort counter — no-op */ }

  // `skipped` counts everything we declined to enrol, including rows the
  // index rejected on conflict (toInsert.length - enrolledCount), which the
  // old return silently reported as enrolled.
  return {
    enrolled: enrolledCount,
    skipped: alreadyActive.size + exemptSkipped + (toInsert.length - enrolledCount),
  }
}
