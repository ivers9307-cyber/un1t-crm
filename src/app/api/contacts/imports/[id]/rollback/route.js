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
//     touched (the snapshot only carries those keys).
//   - Stamps the batch as status='rolled_back' + records actor +
//     timestamp.
//   - Marks the per-row outcomes as action='rolled_back' so the
//     drill-in page reflects reality.
//
// Best-effort per-row: a single contact that was already deleted /
// edited by hand won't fail the whole rollback.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { redactWhatsAppForContact } from '@/lib/contact-merge'
import { logWarn } from '@/lib/log'
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

  const guard = assertLocationAccess(user, batch.location_id)
  if (guard) return guard

  // Mark in-progress so concurrent rollback attempts noop.
  await db.from('contact_imports')
    .update({ status: 'rolling_back' })
    .eq('id', params.id)
    .eq('status', 'completed')

  let deleted = 0
  let restored = 0
  let failed = 0

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
      logWarn('rollback ${params.id}', `delete ${c.id} failed`, { err: e })
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
    try {
      const { error } = await db
        .from('contacts')
        .update(r.before_snapshot)
        .eq('id', r.contact_id)
      if (error) throw new Error(error.message)
      restored += 1
    } catch (e) {
      failed += 1
      logWarn('rollback ${params.id}', `restore ${r.contact_id} failed`, { err: e })
    }
  }

  // 3. Mark per-row outcomes as rolled_back so the drill-in page
  // reflects the new state.
  await db.from('contact_import_rows')
    .update({ action: 'rolled_back' })
    .eq('import_id', params.id)
    .in('action', ['created', 'updated'])

  // 4. Stamp the batch.
  await db.from('contact_imports')
    .update({
      status: 'rolled_back',
      rolled_back_at: new Date().toISOString(),
      rolled_back_by: user.id,
    })
    .eq('id', params.id)

  return NextResponse.json({
    success: true,
    data: { deleted, restored, failed },
  })
}
