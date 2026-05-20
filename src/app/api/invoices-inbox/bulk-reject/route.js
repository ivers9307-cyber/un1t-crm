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

import { NextResponse } from 'next/server'
import {
  BulkRejectSchema,
  loadBookkeeper,
  loadAndScopeBulkRows,
} from '../_bulk-helpers'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const REJECTABLE_STATUSES = ['received', 'quality_approved', 'extracted', 'data_approved']

export async function POST(request) {
  const ctx = await loadBookkeeper()
  if (ctx.response) return ctx.response
  const { user, db } = ctx

  const validation = await validateBody(request, BulkRejectSchema)
  if (!validation.ok) return validation.response
  const { ids, reason } = validation.data

  let scoped
  try {
    scoped = await loadAndScopeBulkRows({
      db, user, ids,
      select: 'id, location_id, status, source_type',
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
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
      results.push({ id, outcome: 'failed', error: updErr.message })
      continue
    }
    results.push({ id, outcome: 'ok', stage })
  }

  const counts = results.reduce((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] || 0) + 1
    return acc
  }, {})

  return NextResponse.json({ success: true, data: { results, counts } })
}
