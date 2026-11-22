// INVOICES-QUEUE.1 PR 2 + INVOICEPREP.3 — bulk "Extract selected", now.
//
// Bookkeeper-gated. The web inbox and the phone app send the first few
// selected rows here (the rest go to bulk-queue-analysis). Each row runs the
// same preparation as the background queue, one at a time:
//   • Only received and quality_approved rows are read; an extracted row is
//     read again only through the single-row /extract route.
//   • A row with no file is skipped.
//   • Claim the row exactly as /extract does: a guarded update stamping
//     analysis_claimed_at (and analysis_queued_at, so the sweeper can find
//     it), refused while a fresh claim says the queue is reading it now. A
//     claim older than CLAIM_STALE_MINUTES is a crashed reader, taken over.
//   • prepareInvoiceRow (no force: a copy of another row's file is flagged,
//     not read) records its own outcome and clears the claim.
//   • If preparation throws, the claim is kept: the read may already have been
//     paid for, and the sweeper retries the row once the claim goes stale.
//
// Sequential rather than parallel: the reader is rate-limited, and a 10-row
// batch fits the 300 s budget.
//
// Response: { success, data: { results: [{ id, outcome, reason?, error? }], counts } }
// with outcome ok | skipped | failed (the web inbox and mobile read counts.ok,
// counts.failed and counts.skipped).

import { NextResponse } from 'next/server'
import {
  BulkIdsSchema,
  loadBookkeeper,
  loadAndScopeBulkRows,
} from '../_bulk-helpers'
import { validateBody } from '@/lib/validate'
import { prepareInvoiceRow } from '@/lib/invoices-queue/prepare'
import { CLAIM_STALE_MINUTES } from '@/lib/invoice-analysis-queue'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PREPARABLE = ['received', 'quality_approved']

/**
 * The per-row answer for each preparation outcome.
 * @param {string} outcome
 */
function resultFor(outcome) {
  if (outcome === 'prepared') return { outcome: 'ok' }
  if (outcome === 'not_invoice') return { outcome: 'skipped', reason: 'not_invoice' }
  if (outcome === 'duplicate') return { outcome: 'skipped', reason: 'duplicate_file' }
  if (outcome === 'unreadable') return { outcome: 'failed', error: 'unreadable' }
  return { outcome: 'skipped', reason: 'concurrent_change' }
}

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

  for (const id of ids) {
    const row = rowsById[id]
    if (!row) continue
    if (!PREPARABLE.includes(row.status)) {
      results.push({ id, outcome: 'skipped', reason: `wrong_status:${row.status}` })
      continue
    }
    if (!row.attachment_path) {
      results.push({ id, outcome: 'skipped', reason: 'no_attachment' })
      continue
    }

    const nowIso = new Date().toISOString()
    const staleBefore = new Date(Date.now() - CLAIM_STALE_MINUTES * 60_000).toISOString()
    const { data: claimed, error: claimErr } = await db
      .from('invoices_queue')
      .update({ analysis_claimed_at: nowIso, analysis_queued_at: nowIso })
      .eq('id', id)
      .eq('location_id', row.location_id)
      .in('status', PREPARABLE)
      .or(`analysis_claimed_at.is.null,analysis_claimed_at.lt.${staleBefore}`)
      .select('*')
    if (claimErr) {
      logError('bulk-analyse', 'claim failed', { invoiceId: id, err: claimErr })
      results.push({ id, outcome: 'failed', error: 'claim_failed' })
      continue
    }
    if (!claimed || claimed.length === 0) {
      // A fresh claim (the queue is reading it now) or a row that moved on.
      results.push({ id, outcome: 'skipped', reason: 'being_read' })
      continue
    }

    try {
      const { outcome } = await prepareInvoiceRow(db, claimed[0])
      results.push({ id, ...resultFor(outcome) })
    } catch (err) {
      // The claim is kept on purpose (see the header).
      logError('bulk-analyse', 'preparation threw; claim kept for the sweeper', { invoiceId: id, err })
      results.push({ id, outcome: 'failed', error: 'prepare_failed' })
    }
  }

  const counts = results.reduce((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] || 0) + 1
    return acc
  }, {})

  return NextResponse.json({ success: true, data: { results, counts } })
}
