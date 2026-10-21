// PAIDTRIAL.1 — claim one queued trial purchase (status CAS + attempts bump),
// run the processor, and do the throw-path bookkeeping. Same shape as
// class-booking-queue.js so the QStash worker and the cron race safely.
import { processTrialPurchase } from '@/lib/trial-purchase-processor'
import { logWarn, logError } from '@/lib/log'

export const MAX_ATTEMPTS = 5

export async function claimAndProcessTrialPurchase(db, row) {
  const { data: claimed } = await db.from('trial_purchases')
    .update({ status: 'processing', attempts: (row.attempts || 0) + 1 })
    .eq('id', row.id).eq('status', 'queued').select('id').maybeSingle()
  if (!claimed) return { status: 'skipped' }
  try {
    const r = await processTrialPurchase(db, { ...row, status: 'processing' })
    return { status: 'processed', outcome: r.outcome, reason: r.reason }
  } catch (e) {
    const error = String(e?.message || e)
    const atCap = (row.attempts || 0) + 1 >= MAX_ATTEMPTS
    const next = atCap ? 'needs_review' : 'queued'
    try {
      const { error: stampErr } = await db.from('trial_purchases')
        .update({ status: next, last_error: error })
        .eq('id', row.id).eq('status', 'processing')
      if (stampErr) throw stampErr
    } catch (stampErr) {
      logWarn('trial-purchase-queue', 'failure bookkeeping failed; the sweeper reaper picks the row up', { purchaseId: row.id, err: stampErr })
    }
    if (atCap) logError('trial-purchase-queue', 'retries exhausted; row needs review', { purchaseId: row.id, error })
    return { status: 'failed', error, requeued: next === 'queued' }
  }
}
