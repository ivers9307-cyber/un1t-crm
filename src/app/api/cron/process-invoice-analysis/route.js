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

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { processInvoiceAnalysisRow } from '@/lib/invoice-analysis-queue'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const BATCH = 10

export async function GET(request) {
  // Fail-closed: no secret configured → reject (SEC-P0.3 pattern).
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()

  const { data: claimed, error: claimErr } = await db.rpc('claim_invoice_analysis_batch', { p_limit: BATCH })
  if (claimErr) {
    return NextResponse.json({ success: false, error: `claim: ${claimErr.message}` }, { status: 500 })
  }
  const rows = claimed || []

  let ok = 0
  let failed = 0

  for (const row of rows) {
    const outcome = await processInvoiceAnalysisRow(db, row)
    if (outcome.extractionError) failed++
    else ok++
  }

  await stampHeartbeat('process-invoice-analysis').catch(() => {})

  return NextResponse.json({ success: true, claimed: rows.length, ok, failed })
}
