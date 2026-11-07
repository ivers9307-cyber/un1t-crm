import { NextResponse } from 'next/server'
import { logError } from '@/lib/log'

// PIPEBUILD.5g — a sequence that a pipeline board's follow-up owns.
//
// The board's own code (pipeline-followup-packs / pipeline-board-followups /
// pipeline-followup-approval) creates, publishes and replaces these sequences
// through LIBRARY calls (publishSequence, direct db writes). A person editing
// or publishing one by hand in the sequence builder would drift it from the
// follow-up row, so:
//   - the HTTP routes refuse it (refuseIfFollowupOwned), and
//   - the Automations list hides it (followupOwnedSequenceIds).
//
// The guard lives in ROUTES ONLY. Never call it from publishSequence or any
// other lib: the board's own install, approval and replace go through those
// and must keep working (followup-owned-sequences.test.js pins that).

const PAGE = 1000
const MODULE = 'followup-owned-sequences'

export const FOLLOWUP_OWNED_MESSAGE =
  'This follow-up belongs to a pipeline board. Change it in Settings → Pipelines.'

/**
 * Every sequence id a follow-up row at this studio points at.
 * @returns {Promise<{ok: true, ids: Set<string>} | {ok: false, error: string}>}
 */
export async function followupOwnedSequenceIds(db, locationId) {
  const ids = new Set()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('pipeline_stage_followups')
      .select('id, sequence_id')
      .eq('location_id', locationId)
      .not('sequence_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return { ok: false, error: error.message || 'Could not read follow-ups' }
    const rows = data || []
    for (const r of rows) if (r.sequence_id) ids.add(r.sequence_id)
    if (rows.length < PAGE) break
  }
  return { ok: true, ids }
}

/**
 * Route guard: null when the sequence is free to edit, else the response to
 * return. Fails CLOSED: an unreadable ownership check is a 503, never "not
 * owned". Call it after auth and the location check, before any write.
 * @param {object} sequence  { id, location_id }
 */
export async function refuseIfFollowupOwned(db, sequence) {
  const { data, error } = await db
    .from('pipeline_stage_followups')
    .select('id')
    .eq('sequence_id', sequence.id)
    .eq('location_id', sequence.location_id)
    .limit(1)
  if (error) {
    logError(MODULE, 'follow-up ownership read failed', { sequenceId: sequence.id, code: error.code || null, err: error.message })
    return NextResponse.json(
      { success: false, error: 'Could not check whether this sequence belongs to a pipeline board. Try again.' },
      { status: 503 },
    )
  }
  if ((data || []).length > 0) {
    return NextResponse.json(
      { success: false, error: FOLLOWUP_OWNED_MESSAGE, code: 'followup_owned' },
      { status: 409 },
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// PIPEBUILD.5l — retired follow-up sequences
//
// Ownership is read from a follow-up row's CURRENT sequence_id only. When a
// replace or reinstall re-points the row at a new sequence, or a stage is
// removed (its follow-up rows cascade away), the old sequence is no longer
// owned, yet it still carries the stage trigger. Left paused, it reappeared in
// Automations, unlocked, and switching it back on would have run a second
// follow-up on that stage: everyone entering it messaged twice.
//
// So the board's code archives it (archiveSupersededSequence), and the
// sequence routes refuse to bring an archived one back (isRetiredFollowupSequence).
// The refusal is deliberately narrow: an archived sequence whose trigger is a
// pipeline stage change to an offer-board stage (an `o_` slug, the only stages
// a follow-up is ever installed on). Every other archived sequence keeps the
// builder's archive / unarchive exactly as before.
// ---------------------------------------------------------------------------

export const RETIRED_FOLLOWUP_MESSAGE = 'This sequence was retired. Build a new one instead.'

/** True for an archived sequence that fired on entering an offer-board stage. */
export function isRetiredFollowupSequence(sequence) {
  if (!sequence || sequence.status !== 'archived') return false
  if (sequence.trigger_type !== 'pipeline_stage_change') return false
  const cfg = sequence.trigger_config
  const toStatus = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg.to_status : null
  return typeof toStatus === 'string' && toStatus.startsWith('o_')
}

/** The 409 the sequence routes answer for a retired follow-up sequence. */
export function retiredFollowupResponse() {
  return NextResponse.json(
    { success: false, error: RETIRED_FOLLOWUP_MESSAGE, code: 'followup_retired' },
    { status: 409 },
  )
}

/**
 * Archive a follow-up's superseded sequence, at this studio, only while it is
 * paused or a draft (an active one is never touched here: the callers stop it
 * first). Best-effort: the sequence is already stopped, so a failure is
 * logged and reported, never thrown, and never fails the caller's action.
 * 0 rows is fine (already archived, deleted as a draft, or gone).
 * @returns {Promise<{ ok: boolean, archived: number }>}
 */
export async function archiveSupersededSequence(db, locationId, sequenceId, context = {}) {
  if (!locationId || !sequenceId) return { ok: true, archived: 0 }
  try {
    const { data, error } = await db.from('email_sequences')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('id', sequenceId)
      .eq('location_id', locationId)
      .in('status', ['paused', 'draft'])
      .select('id')
    if (error) {
      logError(MODULE, 'superseded follow-up sequence not archived', { locationId, sequenceId, ...context, code: error.code || null, err: error.message })
      return { ok: false, archived: 0 }
    }
    return { ok: true, archived: (data || []).length }
  } catch (err) {
    logError(MODULE, 'superseded follow-up sequence archive threw', { locationId, sequenceId, ...context, err: err?.message || String(err) })
    return { ok: false, archived: 0 }
  }
}
