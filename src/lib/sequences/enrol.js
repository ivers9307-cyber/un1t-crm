// Enrol contacts into a sequence — the entry point everywhere
// outside this module. Idempotent at two layers:
//
//   1. Active-enrolment dedup. If a contact is currently in
//      status='active' for this sequence, re-enrol is a no-op.
//      Implemented with the sequence_enrollments_unique_active
//      partial index in the schema.
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

  // Tier 1 dedup — active enrolments. SELECT-then-INSERT for the
  // missing rows; PostgREST won't UPSERT on a partial unique index.
  const { data: existing } = await db
    .from('sequence_enrollments')
    .select('contact_id')
    .eq('sequence_id', sequenceId)
    .eq('status', 'active')
    .in('contact_id', contactIds)
  const alreadyActive = new Set((existing || []).map(r => r.contact_id))

  // Tier 2 dedup — re-enrolment cooldown. Read the sequence's
  // configured cooldown + the contact's history, hand both to the
  // cooldown helper.
  const { data: seqRow } = await db
    .from('email_sequences')
    .select('re_enrolment_cooldown_days')
    .eq('id', sequenceId)
    .single()
  const cooldownDays = seqRow?.re_enrolment_cooldown_days

  const candidatesNotActive = contactIds.filter(id => !alreadyActive.has(id))
  let blockedFromHistory = new Set()
  if (candidatesNotActive.length > 0) {
    const { data: history } = await db
      .from('sequence_enrollments')
      .select('contact_id, status, last_processed_at, created_at')
      .eq('sequence_id', sequenceId)
      .in('contact_id', candidatesNotActive)
      .in('status', ['completed', 'exited'])
    blockedFromHistory = findBlockedByCooldown(history || [], cooldownDays)
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
      const { data: flags } = await db
        .from('contacts')
        .select('id')
        .in('id', candidateIds.slice(i, i + 500))
        .eq('automations_exempt', true)
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

  const { error } = await db.from('sequence_enrollments').insert(toInsert)
  if (error) throw new Error(`Enrol failed: ${error.message}`)

  // Bump the cached counter on the parent sequence. Best-effort —
  // the runner doesn't depend on this counter for correctness, it's
  // just for the admin dashboard.
  // NOTE: a supabase-js builder is a thenable, not a Promise — it has no
  // `.catch`, so `db.rpc(...).catch(...)` throws a synchronous TypeError and
  // the RPC never fires. Must be try/await/catch.
  try {
    await db.rpc('increment_sequence_enrolled', {
      p_sequence_id: sequenceId,
      p_delta: toInsert.length,
    })
  } catch { /* RPC not present / best-effort counter — no-op */ }

  return { enrolled: toInsert.length, skipped: alreadyActive.size + exemptSkipped }
}
