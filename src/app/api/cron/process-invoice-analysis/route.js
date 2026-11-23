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
//   2. Prepare each sequentially via the shared per-row processor
//      (src/lib/invoice-analysis-queue.js — the SAME implementation the
//      QStash worker runs; it calls prepareInvoiceRow). An unreadable
//      file is recorded and DE-QUEUED so it isn't retried forever; the
//      UI surfaces the error + a manual retry. Both received and
//      quality_approved rows are claimed.
//
//   3. SUPPLIERMATCH.1 — refresh one studio's stale Xero contact list and
//      re-check rows flagged "New supplier" (src/lib/invoices-queue/
//      supplier-refresh.js). No read is paid for.
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
import { refreshStaleSupplierList, rematchUnmatchedSuppliers } from '@/lib/invoices-queue/supplier-refresh'

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

  // SUPPLIERMATCH.1 — after the reads: keep one studio's Xero contact list
  // fresh, then look again for suppliers that can now be matched. Neither
  // throws, and neither costs a read.
  const { refreshed } = await refreshStaleSupplierList(db)
  const rematch = await rematchUnmatchedSuppliers(db)

  return {
    body: {
      claimed: rows.length, ok: extracted, failed,
      contacts_refreshed: refreshed ? 1 : 0, suppliers_checked: rematch.checked, suppliers_matched: rematch.matched,
    },
  }
})
