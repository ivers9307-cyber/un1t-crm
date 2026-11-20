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
//   - IMPORTROLLBACK.1 (audit A09) — stamps each per-row outcome
//     action='rolled_back' ONLY when that row's delete / restore
//     succeeded; a row that failed keeps its created/updated action.
//   - Only when every row succeeded (failed === 0) stamps the batch
//     status='rolled_back' + actor + timestamp.
//
// State machine:
//   completed --claim--> rolling_back --all rows done--> rolled_back
//                                     --some failed-----> completed
//   A partial rollback returns the batch to 'completed' (with its finished
//   rows already stamped rolled_back), so the Rollback button shows again
//   and a second POST claims it normally. That second run redoes only the
//   unfinished work: created contacts already deleted are no longer found,
//   and 'updated' rows already stamped rolled_back are not selected.
//   The answer is 200 with success:true, data.partial:true and the counts —
//   the same "the reversal that happened is real" contract as C9 below.
//   A batch stranded at 'rolling_back' (crash, or a failed closing stamp)
//   stays re-runnable: the claim accepts it.
//
// IMPORTLEDGER.1 (audit A08) — a batch whose rollback history was not fully
// saved (isLedgerIncomplete) is still rolled back as far as it can be, but
// the answer carries data.ledger_incomplete:true so the UI says plainly that
// some updated contacts could not be restored.
//
// C9 — the closing stamps report failure as `data.stamp_failed`
// (a list of 'rows' / 'batch') rather than being discarded. Re-running the
// rollback is the recovery, and it is safe to do.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { redactWhatsAppForContact } from '@/lib/contact-merge'
import { pickRestorableSnapshot } from '@/lib/contact-import'
import { logWarn, logError } from '@/lib/log'
import { selectAll } from '@/lib/select-all'
import { isLedgerIncomplete } from '@/lib/contact-import-runner'

// Ids per `.in()` stamp — keeps the PostgREST URL short (see selectAllByKeys).
const STAMP_CHUNK = 300

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

  // Claim the batch: completed → rolling_back. IMPORTROLLBACK.1 — the claim
  // must actually claim something. A concurrent rollback (or a batch that is
  // pending / processing / failed) matches nothing and is refused, except a
  // batch already stranded at 'rolling_back', which stays re-runnable.
  const { data: claimed, error: claimError } = await db.from('contact_imports')
    .update({ status: 'rolling_back' })
    .eq('id', params.id)
    .eq('status', 'completed')
    .select('id')
  if (claimError) {
    logError('contact-import', 'rollback claim failed', { importId: params.id, code: claimError.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not start the rollback. Try again.' }, { status: 500 })
  }
  if ((!claimed || claimed.length === 0) && batch.status !== 'rolling_back') {
    return NextResponse.json({
      success: false,
      error: 'This import cannot be rolled back right now: it is not a completed import, or another rollback has just started.',
    }, { status: 409 })
  }

  let deleted = 0
  let restored = 0
  let failed = 0
  // ROLLBACK-ALLOW.1 — snapshot keys this rollback refused to write back.
  // Surfaced to the operator rather than dropped silently: a non-zero
  // count means a snapshot writer and the allowlist have drifted apart,
  // and someone should look. Expected to be 0 forever.
  let unrestorableKeys = 0
  // A row with nothing to restore (no snapshot, or nothing writable in it):
  // permanent, so it is finished and counted, never retried for ever.
  let unrestorable = 0

  // Reads first, all PAGED: an un-paginated select caps at 1000, so a
  // rollback of a >1000-row import would reverse only the first 1000 rows yet
  // still report success. The 'created' ledger rows are read before any
  // delete: contact_import_rows.contact_id is ON DELETE SET NULL, so after
  // the delete they no longer name the contact they belonged to.
  let createdLedger, createdContacts, updatedRows
  try {
    createdLedger = await selectAll((from, to) => db
      .from('contact_import_rows')
      .select('id, contact_id')
      .eq('import_id', params.id)
      .eq('action', 'created')
      .order('id', { ascending: true })
      .range(from, to))
    createdContacts = await selectAll((from, to) => db
      .from('contacts')
      .select('id')
      .eq('created_via_import_id', params.id)
      .order('id', { ascending: true })
      .range(from, to))
    updatedRows = await selectAll((from, to) => db
      .from('contact_import_rows')
      .select('id, contact_id, before_snapshot')
      .eq('import_id', params.id)
      .eq('action', 'updated')
      .order('id', { ascending: true })
      .range(from, to))
  } catch (e) {
    // Nothing has been reversed yet: hand the batch back so the button shows
    // again, and answer with a fixed string (the detail goes to the log).
    logError('contact-import', 'rollback read failed — nothing reversed', { importId: params.id, err: e })
    const { error: releaseError } = await db.from('contact_imports')
      .update({ status: 'completed' }).eq('id', params.id).eq('status', 'rolling_back')
    if (releaseError) {
      logError('contact-import', 'rollback release failed — batch is stranded at rolling_back', {
        importId: params.id, code: releaseError.code ?? null,
      })
    }
    return NextResponse.json({ success: false, error: 'Could not read this import to roll it back. Nothing was changed. Try again.' }, { status: 500 })
  }
  // 1. Delete created contacts (with the existing GDPR scrub). Driven by
  //    contacts.created_via_import_id, not the ledger, so it still finds
  //    contacts whose ledger rows were lost (IMPORTLEDGER.1).
  const stillPresent = new Set(createdContacts.map(c => c.id))
  const deletedIds = new Set()
  for (const c of createdContacts) {
    try {
      await redactWhatsAppForContact(db, c.id)
      const { error } = await db.from('contacts').delete().eq('id', c.id)
      if (error) throw new Error(error.message)
      deleted += 1
      deletedIds.add(c.id)
    } catch (e) {
      failed += 1
      logWarn(`rollback ${params.id}`, `delete ${c.id} failed`, { err: e })
    }
  }
  // A 'created' row is finished when its contact is gone: deleted just now,
  // or already gone (contact_id nulled, or no longer present) from an earlier
  // run or by hand. Its contact failing to delete keeps it 'created'.
  const doneRowIds = []
  for (const r of createdLedger) {
    if (!r.contact_id || deletedIds.has(r.contact_id) || !stillPresent.has(r.contact_id)) {
      doneRowIds.push(r.id)
    }
  }

  // 2. Restore updated contacts from before_snapshot (read, paged, above:
  //    same 1000-row cap — a large import's updated rows past 1000 would
  //    never be restored). Only rows still 'updated' are read, so a re-run
  //    skips rows an earlier run already finished.
  for (const r of updatedRows) {
    // The contact has since been deleted: there is nothing left to restore,
    // so the row is finished.
    if (!r.contact_id) { doneRowIds.push(r.id); continue }
    if (!r.before_snapshot) {
      unrestorable += 1
      doneRowIds.push(r.id)
      logWarn(`rollback ${params.id}`, `restore ${r.contact_id} skipped — no snapshot`, { rowId: r.id })
      continue
    }

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
      // did not happen, so say so (unrestorable) rather than counting it as
      // restored. A retry could not do better, so the row is finished.
      unrestorable += 1
      doneRowIds.push(r.id)
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
      doneRowIds.push(r.id)
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

  // 3. Stamp ONLY the finished rows rolled_back, in id chunks. A failed row
  // keeps its created/updated action, which is what lets a second run find
  // exactly the unfinished work.
  for (let i = 0; i < doneRowIds.length; i += STAMP_CHUNK) {
    const ids = doneRowIds.slice(i, i + STAMP_CHUNK)
    const { error: rowStampError } = await db.from('contact_import_rows')
      .update({ action: 'rolled_back' })
      .eq('import_id', params.id)
      .in('id', ids)
    if (rowStampError) {
      if (!stampFailed.includes('rows')) stampFailed.push('rows')
      logError('contact-import', 'rollback row stamp failed — drill-in rows still read created/updated', {
        importId: params.id, chunkStart: i, rows: ids.length, code: rowStampError.code ?? null,
      })
    }
  }

  // 4. Stamp the batch. Complete only when every row was reversed AND every
  // row stamp landed; otherwise hand it back to 'completed' so the operator
  // can run the rollback again (a row whose stamp failed is simply redone:
  // its contact is already gone, or its snapshot is restored a second time).
  const partial = failed > 0 || stampFailed.includes('rows')
  const batchStamp = partial
    ? { status: 'completed' }
    : { status: 'rolled_back', rolled_back_at: new Date().toISOString(), rolled_back_by: user.id }
  const { error: batchStampError } = await db.from('contact_imports')
    .update(batchStamp)
    .eq('id', params.id)
  if (batchStampError) {
    stampFailed.push('batch')
    logError('contact-import', 'rollback batch stamp failed — batch is stranded at rolling_back', {
      importId: params.id, partial, code: batchStampError.code ?? null,
    })
  }
  if (partial) {
    logError('contact-import', 'rollback incomplete — failed rows left for a retry', {
      importId: params.id, deleted, restored, failed,
    })
  }

  const ledgerIncomplete = isLedgerIncomplete(batch)

  // Deliberately still a 200 with `success: true`. By this point the deletes
  // and restores have genuinely happened, so a 500 would tell the operator
  // nothing was reversed — the opposite of the truth, and it would hide the
  // counts that say what WAS. The honest answer is the real counts, `partial`
  // when some rows are still to do, and a named list of which stamps did not
  // land; the UI turns those into "run it again". Re-running redoes only the
  // unfinished rows (see the state machine at the top).
  return NextResponse.json({
    success: true,
    data: {
      deleted,
      restored,
      failed,
      partial,
      ledger_incomplete: ledgerIncomplete,
      unrestorable,
      unrestorable_keys: unrestorableKeys,
      stamp_failed: stampFailed,
    },
  })
}
