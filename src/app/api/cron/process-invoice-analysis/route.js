// INV-BULK.1 — background drainer for the bulk invoice-analysis queue.
//
// Operators bulk-upload invoices and hit "Send for analysis", which sets
// analysis_queued_at on the chosen rows (see bulk-queue-analysis). Claude
// Vision OCR is rate-limited and best run one invoice at a time, so we
// don't extract in-request — this cron drains the queue sequentially.
//
// Each tick:
//   1. Atomically claim up to BATCH queued rows (claim_invoice_analysis_batch,
//      FOR UPDATE SKIP LOCKED — overlapping ticks never grab the same row).
//   2. Extract each sequentially. On success → 'extracted' + fields +
//      confidence, and clear the queue flags. On failure → record the
//      error and DE-QUEUE (clear analysis_queued_at) so a bad file isn't
//      retried forever; the UI surfaces the error + a manual retry.
//
// BATCH is sized so a worst-case tick (10 × ~15s) stays well under the
// 300s function cap. 100 queued invoices drain in ~10 ticks (~10 min at
// the */2 schedule).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { extractInvoiceFieldsFromBytes, scoreExtractionConfidence } from '@/lib/invoice-extraction'
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
    const fail = async (msg) => {
      await db.from('invoices_queue').update({
        extraction_error: msg,
        extracted_at: new Date().toISOString(),
        analysis_queued_at: null,   // de-queue — surface the error, don't loop
        analysis_claimed_at: null,
      }).eq('id', row.id)
      failed++
    }

    if (!row.attachment_path || !row.attachment_bucket) {
      await fail('no_attachment')
      continue
    }

    const { data: blob, error: dlErr } = await db.storage
      .from(row.attachment_bucket)
      .download(row.attachment_path)
    if (dlErr || !blob) {
      await fail(`download: ${dlErr?.message || 'unknown'}`)
      continue
    }

    const bytes = Buffer.from(await blob.arrayBuffer())
    const result = await extractInvoiceFieldsFromBytes(bytes, row.attachment_mime_type)
    if (!result.ok) {
      await fail(result.error || 'extraction_failed')
      continue
    }

    // Only flip rows that are still 'quality_approved' (guards against a
    // racing manual /extract or reject between claim and write).
    const { error: updErr } = await db
      .from('invoices_queue')
      .update({
        status: 'extracted',
        extracted_at: new Date().toISOString(),
        extracted_fields: result.fields,
        extraction_confidence: scoreExtractionConfidence(result.fields),
        extraction_error: null,
        analysis_queued_at: null,
        analysis_claimed_at: null,
      })
      .eq('id', row.id)
      .eq('status', 'quality_approved')
    if (updErr) {
      await fail(updErr.message)
      continue
    }
    ok++
  }

  await stampHeartbeat('process-invoice-analysis').catch(() => {})

  return NextResponse.json({ success: true, claimed: rows.length, ok, failed })
}
