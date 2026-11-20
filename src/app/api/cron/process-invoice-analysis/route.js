// INV-BULK.1 — SWEEPER for the bulk invoice-analysis queue (QSTASH.6:
// no longer the only consumer).
//
// Operators bulk-upload invoices and hit "Send for analysis", which sets
// analysis_queued_at on the chosen rows AND fire-and-forget publishes
// each id onto the QStash `invoice-analysis` queue (parallelism 2 —
// bounded OCR concurrency); the QStash worker
// (/api/webhooks/qstash/invoice-analysis) normally processes rows
// within seconds. This cron remains the delivery guarantee: it sweeps
// whatever QStash missed (publish failure, QSTASH_TOKEN unset, worker
// crash — stale claims re-sweep via the RPC's 10-minute arm).
//
// Each tick:
//   1. Atomically claim up to BATCH queued rows (claim_invoice_analysis_batch,
//      FOR UPDATE SKIP LOCKED — overlapping ticks never grab the same row,
//      and rows the QStash worker holds mid-claim are skipped).
//   2. Extract each sequentially via the shared per-row processor
//      (src/lib/invoice-analysis-queue.js — the SAME implementation the
//      QStash worker runs). On success → 'extracted' + fields +
//      confidence, and clear the queue flags. On failure → record the
//      error and DE-QUEUE (clear analysis_queued_at) so a bad file isn't
//      retried forever; the UI surfaces the error + a manual retry.
//
// BATCH is sized so a worst-case tick (10 × ~15s) stays well under the
// 300s function cap. 100 queued invoices drain in ~10 ticks (~10 min at
// the */2 schedule) even with QStash entirely absent.
//
// defineCron owns the CRON_SECRET check (fail-closed: no secret configured →
// 401), the error boundary and the heartbeat. Every tick stamps except one
// whose claim RPC failed: 500 with a fixed line, the detail logged.

import { defineCron } from '@/lib/define-cron'
import { processInvoiceAnalysisRow } from '@/lib/invoice-analysis-queue'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const BATCH = 10

export const GET = defineCron({ heartbeat: 'process-invoice-analysis' }, async ({ db }) => {
  const { data: claimed, error: claimErr } = await db.rpc('claim_invoice_analysis_batch', { p_limit: BATCH })
  if (claimErr) {
    logError('cron-process-invoice-analysis', 'claim_invoice_analysis_batch failed; nothing processed', { err: claimErr })
    return { ok: false, body: { error: 'Could not claim the invoice batch' } }
  }
  const rows = claimed || []

  let extracted = 0
  let failed = 0

  for (const row of rows) {
    const outcome = await processInvoiceAnalysisRow(db, row)
    if (outcome.extractionError) failed++
    else extracted++
  }

  return { body: { claimed: rows.length, ok: extracted, failed } }
})
