// QSTASH.6 — push-delivery worker for the invoices_queue bulk-analysis
// queue.
//
// QStash POSTs { id } here — published per row by
// /api/invoices-inbox/bulk-queue-analysis onto the `invoice-analysis`
// QStash QUEUE (parallelism 2, NOT plain publish: Claude Vision OCR is
// rate-limited, so a 50-invoice bulk queue must never become 50
// concurrent worker invocations) — signed with an Upstash-Signature
// JWT. We verify the signature, re-fetch the row, and run it through
// the SAME claim semantics the process-invoice-analysis cron uses
// (src/lib/invoice-analysis-queue.js) — the two consumers race safely;
// whoever claims first wins and the other sees `skipped`.
//
// Status-code contract with QStash retries:
//   200 — done. INCLUDING a deterministic extraction failure: the row
//         is already stamped with its extraction_error and DE-QUEUED
//         (the INV-BULK.1 design — bad files must not retry forever;
//         the operator retries manually from the UI). Returning 500
//         would make QStash hammer a rate-limited Claude Vision call
//         that fails deterministically.
//   401 — signature rejected (not retryable-by-us; QStash will retry,
//         and each retry re-verifies — a rotated key heals this)
//   500 — infrastructure error only (row fetch failed) — a QStash
//         retry genuinely helps there.
//
// The invoices_queue table stays the source of truth throughout —
// QStash going away entirely (env vars unset) reverts cleanly to
// cron-only processing, and rows QStash misses are swept by the cron's
// RPC batch claim (stale claims re-sweep after 10 minutes).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyQStashSignature, INVOICE_ANALYSIS_WORKER_PATH } from '@/lib/qstash'
import { claimAndProcessInvoiceAnalysisRow } from '@/lib/invoice-analysis-queue'
import { getAppUrl } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // same budget as the cron — OCR ~15s worst case, downloads can crawl

/**
 * missing_keys means WE are misconfigured (route reachable but signing keys
 * unset) — 503 flags it as a server problem. Every other reason is a bad
 * or forged delivery — 401.
 */
export function statusForVerifyFailure(reason) {
  return reason === 'missing_keys' ? 503 : 401
}

export function responseForOutcome(outcome) {
  if (outcome.status === 'processed') {
    return { status: 200, body: { success: true, processed: true } }
  }
  if (outcome.status === 'skipped') {
    return { status: 200, body: { success: true, skipped: true } }
  }
  return {
    status: 500,
    body: { success: false, error: outcome.error || 'processing_failed' },
  }
}

export async function POST(request) {
  // Raw body FIRST — the signature's body claim hashes the exact bytes
  // delivered, so any parse-then-restringify would break verification.
  const rawBody = await request.text()

  let expectedUrl = null
  try {
    expectedUrl = `${getAppUrl()}${INVOICE_ANALYSIS_WORKER_PATH}`
  } catch {
    // NEXT_PUBLIC_APP_URL unset — verify everything else but skip the
    // sub check rather than rejecting deliveries over our own config.
    console.error('[qstash invoice-analysis worker] NEXT_PUBLIC_APP_URL unset; skipping sub-claim check')
  }

  const verdict = verifyQStashSignature({
    signature: request.headers.get('upstash-signature'),
    rawBody,
    url: expectedUrl || undefined,
  })
  if (!verdict.ok) {
    console.warn(`[qstash invoice-analysis worker] delivery rejected: ${verdict.reason}`)
    return NextResponse.json(
      { success: false, error: verdict.reason },
      { status: statusForVerifyFailure(verdict.reason) }
    )
  }

  let id
  try {
    id = JSON.parse(rawBody)?.id
  } catch {
    return NextResponse.json({ success: false, error: 'invalid_json' }, { status: 400 })
  }
  if (!id) {
    return NextResponse.json({ success: false, error: 'missing_id' }, { status: 400 })
  }

  const db = createServerClient()

  // Same eligibility as the RPC's queue predicate: still queued only
  // (quality_approved + analysis_queued_at set). An already-extracted,
  // de-queued or rejected row is a clean 200 skip — QStash must not
  // redeliver it. Claimed-ness is deliberately NOT filtered here: that
  // is the claim CAS's job (fresh claim → skip; stale claim → crashed
  // consumer, re-claimable). Full row: the shared lib needs the
  // attachment columns.
  const { data: rows, error: fetchErr } = await db
    .from('invoices_queue')
    .select('*')
    .eq('id', id)
    .eq('status', 'quality_approved')
    .not('analysis_queued_at', 'is', null)
    .limit(1)

  if (fetchErr) {
    console.error('[qstash invoice-analysis worker] row fetch failed:', fetchErr.message)
    return NextResponse.json({ success: false, error: fetchErr.message }, { status: 500 })
  }

  const row = rows?.[0]
  if (!row) {
    return NextResponse.json({ success: true, skipped: true })
  }

  const outcome = await claimAndProcessInvoiceAnalysisRow(db, row)
  if (outcome.extractionError) {
    console.warn(`[qstash invoice-analysis worker] invoice ${row.id} extraction failed (recorded + de-queued): ${outcome.extractionError}`)
  }
  const { status, body } = responseForOutcome(outcome)
  return NextResponse.json(body, { status })
}
