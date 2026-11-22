// INV-BULK.1 — "Send for analysis" (bulk enqueue).
//
// Bookkeeper-gated. Takes an array of queue row ids and marks them for
// background analysis by the process-invoice-analysis cron. This is the
// instant, no-timeout counterpart to the synchronous bulk-analyse route:
// it just flags rows, so it scales to 100s.
//
// Per row:
//   • received          → quality_approved + analysis_queued_at (the
//                          operator's deliberate selection IS the quality
//                          decision for these — the 'received' gate exists
//                          to screen unsolicited supplier email, not files
//                          the operator chose to analyse).
//   • quality_approved  → analysis_queued_at (clear any prior error so the
//                          cron retries cleanly).
//   • extracted/data_approved/forwarded/rejected → skipped (already past
//                          analysis, or terminal).
//
// INVOICEPREP.3: the route still writes status, who vouched for quality and
// the cleared error itself (queueInvoicePreparation does none of those), and
// it stamps analysis_queued_at in the same update so a per-id outcome of
// 'queued' is exact. Publishing is the shared helper's job, so there is one
// publisher: it re-stamps and pushes each id to the QStash queue. A failure
// there never changes the response; the sweeper cron picks the rows up.
//
// Returns per-id outcomes + counts, same shape as the other bulk routes.

import { NextResponse } from 'next/server'
import {
  BulkIdsSchema,
  loadBookkeeper,
  loadAndScopeBulkRows,
} from '../_bulk-helpers'
import { validateBody } from '@/lib/validate'
import { queueInvoicePreparation } from '@/lib/invoices-queue/queue-preparation'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QUEUEABLE = new Set(['received', 'quality_approved'])

export async function POST(request) {
  const ctx = await loadBookkeeper()
  if (ctx.response) return ctx.response
  const { user, db } = ctx

  const validation = await validateBody(request, BulkIdsSchema)
  if (!validation.ok) return validation.response
  const { ids } = validation.data

  let scoped
  try {
    scoped = await loadAndScopeBulkRows({
      db, user, ids,
      select: 'id, location_id, status, attachment_path',
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
    if (!QUEUEABLE.has(row.status)) {
      results.push({ id, outcome: 'skipped', reason: `wrong_status:${row.status}` })
      continue
    }
    if (!row.attachment_path) {
      results.push({ id, outcome: 'skipped', reason: 'no_attachment' })
      continue
    }
    // received rows are auto-quality-approved (operator-vouched); already-
    // approved rows just get (re)queued with any stale error cleared.
    const { error: updErr } = await db
      .from('invoices_queue')
      .update({
        status: 'quality_approved',
        quality_reviewed_at: row.status === 'received' ? now : undefined,
        quality_reviewed_by: row.status === 'received' ? user.id : undefined,
        analysis_queued_at: now,
        analysis_claimed_at: null,
        extraction_error: null,
      })
      .eq('id', id)
      .in('status', ['received', 'quality_approved'])
    if (updErr) {
      results.push({ id, outcome: 'failed', error: updErr.message })
      continue
    }
    results.push({ id, outcome: 'queued' })
  }

  // The table write above is the delivery guarantee; the push is latency.
  const queuedIds = results.filter((r) => r.outcome === 'queued').map((r) => r.id)
  if (queuedIds.length > 0) {
    try {
      await queueInvoicePreparation(db, queuedIds)
    } catch (err) {
      logError('bulk-queue-analysis', 'preparation hand-off failed', { err })
    }
  }

  const counts = results.reduce((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] || 0) + 1
    return acc
  }, {})

  return NextResponse.json({ success: true, data: { results, counts } })
}
