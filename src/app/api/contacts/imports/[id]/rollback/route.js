// POST /api/contacts/imports/[id]/rollback
//
// Master-only. Reverses a completed import:
//   - For every contacts row whose `created_via_import_id` matches
//     this batch → DELETE (uses the existing GDPR-safe path that
//     also redacts WhatsApp PII, since some of these contacts may
//     have started WhatsApp conversations after import).
//   - For every contact_import_rows row with action='updated' AND
//     a non-null `before_snapshot` → UPDATE the contact back to the
//     snapshotted values. Limited to fields the import actually
//     touched (the snapshot only carries those keys) AND, since
//     ROLLBACK-ALLOW.1, filtered through pickRestorableSnapshot() so
//     only columns an import can legitimately own are written back.
//     Anything outside that allowlist is left alone, logged, and
//     counted into `unrestorable_keys` on the response.
//   - Stamps the batch as status='rolled_back' + records actor +
//     timestamp.
//   - Marks the per-row outcomes as action='rolled_back' so the
//     drill-in page reflects reality.
//
// Best-effort per-row: a single contact that was already deleted /
// edited by hand won't fail the whole rollback.
//
// C9 — the two closing stamps report failure as `data.stamp_failed`
// (a list of 'rows' / 'batch') rather than being discarded. A batch
// whose stamp failed stays at status='rolling_back'; re-running the
// rollback is the recovery, and it is safe to do.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { redactWhatsAppForContact } from '@/lib/contact-merge'
import { pickRestorableSnapshot } from '@/lib/contact-import'
import { logWarn, logError } from '@/lib/log'
import { selectAll } from '@/lib/select-all'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!user.isMaster && user.role !== 'master') {
    return NextResponse.json({
      success: false,
      error: 'Only a master account can roll back an import.',
    }, { status: 403 })
  }

  const db = createServerClient()
  const { data: batch } = await db
    .from('contact_imports')
    .select('*')
    .eq('id', params.id)
    .single()
  if (!batch) return NextResponse.json({ success: false, error: 'Import not found' }, { status: 404 })
  if (batch.status === 'rolled_back') {
    return NextResponse.json({ success: false, error: 'This import has already been rolled back.' }, { status: 400 })
  }

  const guard = assertLocationAccessOr404(user, batch.location_id)
  if (guard) return guard

  // Mark in-progress so concurrent rollback attempts noop.
  await db.from('contact_imports')
    .update({ status: 'rolling_back' })
    .eq('id', params.id)
    .eq('status', 'completed')

  let deleted = 0
  let restored = 0
  let failed = 0
  // ROLLBACK-ALLOW.1 — snapshot keys this rollback refused to write back.
  // Surfaced to the operator rather than dropped silently: a non-zero
  // count means a snapshot writer and the allowlist have drifted apart,
  // and someone should look. Expected to be 0 forever.
  let unrestorableKeys = 0

  // 1. Delete created contacts (with the existing GDPR scrub).
  //    PAGED: an un-paginated select caps at 1000, so a rollback of a
  //    >1000-row import would delete only the first 1000 created contacts yet
  //    still report success — leaving the rest orphaned. Page the full set.
  const createdContacts = await selectAll((from, to) => db
    .from('contacts')
    .select('id')
    .eq('created_via_import_id', params.id)
    .order('id', { ascending: true })
    .range(from, to))
  for (const c of createdContacts) {
    try {
      await redactWhatsAppForContact(db, c.id)
      const { error } = await db.from('contacts').delete().eq('id', c.id)
      if (error) throw new Error(error.message)
      deleted += 1
    } catch (e) {
      failed += 1
      logWarn(`rollback ${params.id}`, `delete ${c.id} failed`, { err: e })
    }
  }

  // 2. Restore updated contacts from before_snapshot.
  //    PAGED: same 1000-row cap — a large import's updated rows past 1000 would
  //    never be restored to their pre-import values yet the rollback returns
  //    success:true. Page the full set; the per-row restore loop is unchanged.
  const updatedRows = await selectAll((from, to) => db
    .from('contact_import_rows')
    .select('id, contact_id, before_snapshot')
    .eq('import_id', params.id)
    .eq('action', 'updated')
    .not('before_snapshot', 'is', null)
    .order('id', { ascending: true })
    .range(from, to))
  for (const r of updatedRows) {
    if (!r.contact_id || !r.before_snapshot) continue

    // ROLLBACK-ALLOW.1 — never write the snapshot verbatim. The allowlist
    // is derived from IMPORT_FIELD_KEYS (see pickRestorableSnapshot), i.e.
    // exactly the columns the import runner can put in a snapshot. Today
    // every live snapshot is inside it, so this changes no behaviour; it
    // removes the possibility that a future writer, or a snapshot taken
    // under an older schema, gets a column written back into `contacts`
    // unchecked. Notably `email_status` can never come through, which is
    // what keeps mig 528's BEFORE UPDATE OF email trigger effective.
    const { patch, unknownKeys } = pickRestorableSnapshot(r.before_snapshot)
    if (unknownKeys.length > 0) {
      unrestorableKeys += unknownKeys.length
      logWarn(`rollback ${params.id}`, 'snapshot keys outside the restorable allowlist — not written', {
        rowId: r.id, contactId: r.contact_id, keys: unknownKeys,
      })
    }
    if (Object.keys(patch).length === 0) {
      // Nothing writable at all — the operator asked for a restore that
      // did not happen, so say so rather than counting it as restored.
      failed += 1
      logWarn(`rollback ${params.id}`, `restore ${r.contact_id} skipped — nothing restorable in the snapshot`, {
        rowId: r.id, keys: unknownKeys,
      })
      continue
    }

    try {
      const { error } = await db
        .from('contacts')
        .update(patch)
        .eq('id', r.contact_id)
      if (error) throw new Error(error.message)
      restored += 1
    } catch (e) {
      failed += 1
      logWarn(`rollback ${params.id}`, `restore ${r.contact_id} failed`, { err: e })
    }
  }

  // C9 — the two closing stamps used to be bare `await`s with the error
  // discarded. supabase-js does not throw on a failed write, it resolves
  // with `{ error }`, so a failed stamp was invisible: the route returned
  // success while the batch sat at status='rolling_back' forever. Nothing
  // retries a stuck batch and no surface showed it was stuck.
  //
  // They are attempted independently — a failed row stamp must not skip the
  // batch stamp, or one fault strands the batch for two reasons.
  const stampFailed = []

  // 3. Mark per-row outcomes as rolled_back so the drill-in page
  // reflects the new state.
  const { error: rowStampError } = await db.from('contact_import_rows')
    .update({ action: 'rolled_back' })
    .eq('import_id', params.id)
    .in('action', ['created', 'updated'])
  if (rowStampError) {
    stampFailed.push('rows')
    logError('contact-import', 'rollback row stamp failed — drill-in rows still read created/updated', {
      importId: params.id, err: rowStampError,
    })
  }

  // 4. Stamp the batch.
  const { error: batchStampError } = await db.from('contact_imports')
    .update({
      status: 'rolled_back',
      rolled_back_at: new Date().toISOString(),
      rolled_back_by: user.id,
    })
    .eq('id', params.id)
  if (batchStampError) {
    stampFailed.push('batch')
    logError('contact-import', 'rollback batch stamp failed — batch is stranded at rolling_back', {
      importId: params.id, err: batchStampError,
    })
  }

  // Deliberately still a 200 with `success: true`. By this point the deletes
  // and restores have genuinely happened, so a 500 would tell the operator
  // nothing was reversed — the opposite of the truth, and it would hide the
  // counts that say what WAS. The honest answer is the real counts plus a
  // named list of which stamps did not land; the UI turns that into "run it
  // again". Re-running is safe: the deletes/restores find nothing left to do
  // (created contacts are gone, rows are either already stamped or still
  // 'updated' with the same snapshot) and both stamps are re-attempted. The
  // in-progress guard at the top only 400s on status='rolled_back', so a
  // batch stuck at 'rolling_back' can always be re-run.
  return NextResponse.json({
    success: true,
    data: { deleted, restored, failed, unrestorable_keys: unrestorableKeys, stamp_failed: stampFailed },
  })
}
