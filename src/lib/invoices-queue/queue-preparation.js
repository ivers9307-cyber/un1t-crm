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
    // Rows without a file are included: preparation is what moves them to
    // not_invoice.
    const { data, error } = await db
      .from('invoices_queue')
      .update({ analysis_queued_at: new Date().toISOString(), analysis_claimed_at: null })
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
