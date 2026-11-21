// INVOICES-QUEUE.1 PR 2 — bulk reject.
//
// Bookkeeper-gated. Marks N rows as rejected in one call with the
// same reason string applied to each. Rejection is legal from any
// non-terminal state (received / quality_approved / extracted /
// data_approved); 'forwarded' is terminal (can't un-send from
// Xero this way) and 'rejected' is the absorbing state.
//
// rejected_stage is set to 'quality' if the row was at 'received',
// otherwise 'data' (the same convention the single-row reject
// routes use).
//
// withAuth signs the caller in (the same 401) and asks for the bookkeeper
// flag with loadBookkeeper's 403 text, then the body (400), as before.

import { NextResponse } from 'next/server'
import {
  BulkRejectSchema,
  loadAndScopeBulkRows,
} from '../_bulk-helpers'
import { withAuth } from '@/lib/with-auth'
import { hasPermission } from '@/lib/permissions'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const REJECTABLE_STATUSES = ['received', 'quality_approved', 'extracted', 'data_approved']

export const POST = withAuth({
  permission: null,
  location: false,
  allow: (user) => hasPermission(user, 'bookkeeper'),
  forbiddenMessage: 'Bookkeeper permission required — ask a master to grant the bookkeeper flag.',
  schema: BulkRejectSchema,
}, async ({ user, db, input }) => {
  const { ids, reason } = input

  let scoped
  try {
    scoped = await loadAndScopeBulkRows({
      db, user, ids,
      select: 'id, location_id, status, source_type',
    })
  } catch (e) {
    logError('invoices-inbox', 'bulk reject: row lookup failed', { count: ids.length, err: e })
    return NextResponse.json({ success: false, error: 'Could not load the invoices. Try again.' }, { status: 500 })
  }
  const { rowsById, missingIds, forbiddenIds } = scoped

  const results = []
  for (const id of missingIds) results.push({ id, outcome: 'skipped', reason: 'not_found' })
  for (const id of forbiddenIds) results.push({ id, outcome: 'skipped', reason: 'forbidden' })

  const now = new Date().toISOString()

  for (const id of ids) {
    const row = rowsById[id]
    if (!row) continue
    if (!REJECTABLE_STATUSES.includes(row.status)) {
      results.push({ id, outcome: 'skipped', reason: `wrong_status:${row.status}` })
      continue
    }

    const stage = row.status === 'received' ? 'quality' : 'data'
    const stampField = stage === 'quality' ? 'quality_reviewed_at' : 'data_reviewed_at'
    const byField = stage === 'quality' ? 'quality_reviewed_by' : 'data_reviewed_by'

    const { error: updErr } = await db
      .from('invoices_queue')
      .update({
        status: 'rejected',
        rejected_stage: stage,
        rejected_at: now,
        reject_reason: reason,
        [stampField]: now,
        [byField]: user.id,
      })
      .eq('id', id)
      .in('status', REJECTABLE_STATUSES) // belt + braces against a race

    if (updErr) {
      logError('invoices-inbox', 'bulk reject: update failed', { invoiceId: id, err: updErr })
      results.push({ id, outcome: 'failed', error: 'Could not reject this invoice.' })
      continue
    }
    results.push({ id, outcome: 'ok', stage })
  }

  const counts = results.reduce((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] || 0) + 1
    return acc
  }, {})

  return NextResponse.json({ success: true, data: { results, counts } })
})
