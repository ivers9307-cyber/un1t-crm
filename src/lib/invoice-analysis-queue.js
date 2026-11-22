// Shared invoices_queue preparation queue (QSTASH.6, INVOICEPREP.3).
//
// The queue prepares rows (read, check, code) for `received` and
// `quality_approved` rows via prepareInvoiceRow. The QStash worker route
// and the process-invoice-analysis cron share this module, so the two
// consumers can run concurrently against the same table through the same
// claim semantics.
//
// Claim semantics: the cron batch-claims via the
// `claim_invoice_analysis_batch` RPC (FOR UPDATE SKIP LOCKED). The worker
// claims ONE row by id with a plain conditional UPDATE mirroring the RPC's
// predicate: status received or quality_approved, analysis_queued_at still
// set, analysis_claimed_at NULL or staler than the RPC's 10-minute window,
// stamping a fresh analysis_claimed_at. Under READ COMMITTED the loser of a
// concurrent claim re-evaluates the predicate against the winner's committed
// row (fresh claim, 0 rows, skip). A consumer that CRASHES mid-run leaves
// the row claimed; the RPC's stale-claim arm re-sweeps it after 10 minutes.
//
// Failure semantics: an unreadable file is recorded on the row by
// prepareInvoiceRow and de-queued, so a bad file is never retried forever.
// That is a *processed* outcome carrying extractionError 'unreadable', NOT
// a retryable failure: the worker must 200 it so QStash does not re-deliver.
// An unexpected throw leaves the claim and the row as they are, so the
// sweeper retries it only once the claim goes stale (10 minutes).

import { prepareInvoiceRow } from '@/lib/invoices-queue/prepare'
import { logError } from '@/lib/log'

// Mirrors the RPC's stale-claim window (analysis_claimed_at < now() -
// interval '10 minutes'). A claim older than this is a crashed consumer.
// Safe for the worker too: maxDuration 300s means no invocation can still
// be running at 10 min, so a stale re-claim can never double-process.
export const CLAIM_STALE_MINUTES = 10

const PREPARABLE = ['received', 'quality_approved']

/**
 * Prepare one ALREADY-CLAIMED row and map the outcome to the shape the
 * worker and cron report.
 *
 * @param {any} db service-role client
 * @param {any} row a full invoices_queue row
 * @returns {Promise<{status: 'processed'|'skipped', extractionError?: string}>}
 */
export async function processInvoiceAnalysisRow(db, row) {
  try {
    const { outcome } = await prepareInvoiceRow(db, row)
    if (outcome === 'unreadable') return { status: 'processed', extractionError: 'unreadable' }
    if (outcome === 'skipped') return { status: 'skipped' }
    return { status: 'processed' }
  } catch (err) {
    logError('invoice-analysis-queue', 'prepareInvoiceRow threw; claim kept, row retried after the stale window', { id: row?.id, err })
    // The row is left untouched on purpose: a throw can come after the
    // paid read, so the claim stays fresh and the row waits out
    // CLAIM_STALE_MINUTES. Clearing it would retry (and pay) every sweep.
    return { status: 'processed', extractionError: 'prepare_threw' }
  }
}

/**
 * Claim one queued row by id (CAS mirroring the RPC predicate), then
 * prepare it. The QStash worker's entry point.
 *
 * @param {any} db service-role client
 * @param {any} row a full invoices_queue row (still-queued, per the
 *   worker's eligibility fetch)
 * @returns {Promise<{status: 'processed'|'skipped', extractionError?: string}>}
 */
export async function claimAndProcessInvoiceAnalysisRow(db, row) {
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MINUTES * 60_000).toISOString()
  const { data: claimed, error } = await db
    .from('invoices_queue')
    .update({ analysis_claimed_at: new Date().toISOString() })
    .eq('id', row.id)
    .in('status', PREPARABLE)
    .not('analysis_queued_at', 'is', null)
    .or(`analysis_claimed_at.is.null,analysis_claimed_at.lt.${staleBefore}`)
    .select('id')
  if (error) {
    logError('invoice-analysis-queue', 'claim failed', { id: row?.id, err: error })
    return { status: 'skipped' }
  }
  if (!claimed || claimed.length === 0) return { status: 'skipped' }

  return processInvoiceAnalysisRow(db, row)
}
