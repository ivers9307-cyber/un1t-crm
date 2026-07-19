// Shared invoices_queue bulk-analysis row processing (QSTASH.6).
//
// Extracted verbatim from the process-invoice-analysis cron's per-row
// loop so the QStash worker route and the cron share ONE
// OCR/success/failure implementation — the two consumers can run
// concurrently against the same table precisely because they go through
// the same claim semantics.
//
// Claim semantics: the cron batch-claims via the
// `claim_invoice_analysis_batch` RPC (mig 220 — FOR UPDATE SKIP LOCKED,
// which matters when SELECTING N rows without ticks blocking each
// other). The worker claims ONE row by id with a plain conditional
// UPDATE mirroring the RPC's predicate exactly: status still
// 'quality_approved', analysis_queued_at still set, analysis_claimed_at
// NULL or staler than the RPC's 10-minute window — stamping a fresh
// analysis_claimed_at. Under READ COMMITTED the loser of a concurrent
// claim re-evaluates the predicate against the winner's committed row
// (fresh analysis_claimed_at → 0 rows → skip), and the RPC's SKIP
// LOCKED skips a row the worker holds mid-claim — claim-exactly-once in
// both directions, no new SQL needed. A consumer that CRASHES mid-run
// leaves the row claimed; the RPC's stale-claim arm (>10 min) makes the
// cron re-sweep it, exactly as it always has.
//
// Failure semantics (INV-BULK.1, unchanged): an extraction failure
// records the error and DE-QUEUES the row (analysis_queued_at cleared)
// so a bad file is never retried forever — the UI surfaces the error +
// a manual retry. That is a *processed* outcome carrying an
// `extractionError`, NOT a retryable failure: Claude Vision OCR failing
// on a given file is deterministic, and the worker must 200 it so
// QStash doesn't burn rate limit re-delivering it.

import { extractInvoiceFieldsFromBytes, scoreExtractionConfidence } from './invoice-extraction.js'

// Mirrors the RPC's stale-claim window (mig 220: analysis_claimed_at <
// now() - interval '10 minutes'). A claim older than this is a crashed
// consumer — re-claimable. Safe for the worker too: maxDuration 300s
// means no invocation can still be running at 10 min, so a stale
// re-claim can never double-process.
export const CLAIM_STALE_MINUTES = 10

/**
 * Process one ALREADY-CLAIMED row: download → OCR → flip to 'extracted',
 * or record the error and de-queue. Verbatim from the cron's per-row
 * loop (the cron's RPC batch claim happens before this).
 *
 * @param {SupabaseClient} db — service-role client
 * @param {{id: string, attachment_bucket: string|null, attachment_path: string|null,
 *          attachment_mime_type: string|null}} row
 * @returns {Promise<{status: 'processed', extractionError?: string}>}
 */
export async function processInvoiceAnalysisRow(db, row) {
  const fail = async (msg) => {
    await db.from('invoices_queue').update({
      extraction_error: msg,
      extracted_at: new Date().toISOString(),
      analysis_queued_at: null,   // de-queue — surface the error, don't loop
      analysis_claimed_at: null,
    }).eq('id', row.id)
    return { status: 'processed', extractionError: msg }
  }

  if (!row.attachment_path || !row.attachment_bucket) {
    return fail('no_attachment')
  }

  const { data: blob, error: dlErr } = await db.storage
    .from(row.attachment_bucket)
    .download(row.attachment_path)
  if (dlErr || !blob) {
    return fail(`download: ${dlErr?.message || 'unknown'}`)
  }

  const bytes = Buffer.from(await blob.arrayBuffer())
  const result = await extractInvoiceFieldsFromBytes(bytes, row.attachment_mime_type)
  if (!result.ok) {
    return fail(result.error || 'extraction_failed')
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
    return fail(updErr.message)
  }
  return { status: 'processed' }
}

/**
 * Claim one queued row by id (CAS mirroring the RPC predicate), then
 * process it. The QStash worker's entry point.
 *
 * @param {SupabaseClient} db — service-role client
 * @param {object} row — a full invoices_queue row (still-queued, per the
 *   worker's eligibility fetch)
 * @returns {Promise<{status: 'processed'|'skipped', extractionError?: string}>}
 */
export async function claimAndProcessInvoiceAnalysisRow(db, row) {
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MINUTES * 60_000).toISOString()
  const { data: claimed } = await db
    .from('invoices_queue')
    .update({ analysis_claimed_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('status', 'quality_approved')
    .not('analysis_queued_at', 'is', null)
    .or(`analysis_claimed_at.is.null,analysis_claimed_at.lt.${staleBefore}`)
    .select('id')
  if (!claimed || claimed.length === 0) return { status: 'skipped' }

  return processInvoiceAnalysisRow(db, row)
}
