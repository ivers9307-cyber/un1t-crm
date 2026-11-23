// @ts-check
// The one way an arrival path puts invoice rows on the preparation queue:
// stamp analysis_queued_at (the table is the delivery guarantee: the
// sweeper cron claims any stamped row) and push each id to the QStash
// `invoice-analysis` queue (the latency optimisation). Never throws.

import {
  publishQueuePush,
  INVOICE_ANALYSIS_WORKER_PATH,
  INVOICE_ANALYSIS_QUEUE_NAME,
  INVOICE_ANALYSIS_QUEUE_PARALLELISM,
} from '@/lib/qstash'
import { logError, logWarn } from '@/lib/log'

const MODULE = 'queue-invoice-preparation'

/**
 * @param {import('@/lib/supabase').Db} db
 * @param {string[]} ids
 * @param {{ publish?: typeof publishQueuePush }} [opts]
 * @returns {Promise<{ queued: string[] }>}
 */
export async function queueInvoicePreparation(db, ids, { publish = publishQueuePush } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) return { queued: [] }

  try {
    // analysis_claimed_at is deliberately left alone: a live claim means a
    // read is in flight, a stale one is already re-claimable, and a finished
    // preparation clears its own claim.
    // Rows without a file are included: preparation is what moves them to
    // not_invoice.
    const { data, error } = await db
      .from('invoices_queue')
      .update({ analysis_queued_at: new Date().toISOString() })
      .in('id', ids)
      .in('status', ['received', 'quality_approved'])
      .select('id')
    if (error) {
      logError(MODULE, 'could not stamp rows for preparation', { err: error })
      return { queued: [] }
    }
    const queued = (data || []).map((r) => r.id)

    const settled = await Promise.allSettled(queued.map((id) => publish({
      path: INVOICE_ANALYSIS_WORKER_PATH,
      body: { id },
      // Dash-separated: QStash rejects colons in the dedup id.
      deduplicationId: `invoice-analysis-${id}`,
      queueName: INVOICE_ANALYSIS_QUEUE_NAME,
      queueParallelism: INVOICE_ANALYSIS_QUEUE_PARALLELISM,
    })))
    settled.forEach((s, i) => {
      if (s.status === 'rejected') {
        logWarn(MODULE, 'publish failed; the sweeper cron will pick the row up', { id: queued[i], err: s.reason })
      }
    })
    return { queued }
  } catch (err) {
    logError(MODULE, 'unexpected failure queueing preparation', { err })
    return { queued: [] }
  }
}

// INVHARDEN.1 — the safety net. Every arrival path is meant to call
// queueInvoicePreparation, and the sweeper claims only stamped rows, so a path
// that forgets (or a stamp that fails) leaves a row unread forever. This finds
// rows that arrived a while ago and were never queued or prepared, and queues
// them. Rows the reader already stopped on (a duplicate, an unreadable file)
// have prepared_at set and are left alone.
export const MISSED_AFTER_MINUTES = 10
export const MISSED_LIMIT = 20

/**
 * @param {import('@/lib/supabase').Db} db
 * @param {{ now?: () => Date, limit?: number, publish?: typeof publishQueuePush }} [opts]
 * @returns {Promise<{ queued: string[] }>}
 */
export async function queueMissedInvoices(db, opts = {}) {
  try {
    const now = (opts.now || (() => new Date()))()
    const before = new Date(now.getTime() - MISSED_AFTER_MINUTES * 60_000).toISOString()
    const { data, error } = await db
      .from('invoices_queue')
      .select('id')
      .eq('status', 'received')
      .is('analysis_queued_at', null)
      .is('prepared_at', null)
      .lt('created_at', before)
      .order('created_at', { ascending: true })
      .limit(opts.limit ?? MISSED_LIMIT)
    if (error) {
      logWarn(MODULE, 'could not look for missed invoices', { err: error })
      return { queued: [] }
    }
    const ids = (data || []).map((r) => r.id)
    if (ids.length === 0) return { queued: [] }
    logWarn(MODULE, 'found invoices that were never queued for reading; queueing them now', { count: ids.length })
    return queueInvoicePreparation(db, ids, opts.publish ? { publish: opts.publish } : undefined)
  } catch (err) {
    logError(MODULE, 'unexpected failure looking for missed invoices', { err })
    return { queued: [] }
  }
}

