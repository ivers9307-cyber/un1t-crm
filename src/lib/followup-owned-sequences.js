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
