// GET /api/cron/revolut-reconcile — REVPAY.3, every 15 minutes.
//
// The backstop for a lost or deferred Revolut webhook: finds the
// Revolut-backed payment rows (car deposits, race payments, paid class
// bookings, paid trials, offer purchases, donations) still waiting on the
// provider 10 minutes to 7 days after checkout, asks Revolut for each order's
// state and applies it through the webhooks' own helpers. At most 50 provider
// calls a tick. It then re-runs the side effects of paid Revolut donations
// whose receipt or contact link did not land (REVPAY.12, at most 25 a tick,
// counted as receipt_*; never unhealthy), and confirms Revolut refunds the
// refund route never heard back about (REFUNDCONFIRM.1, counted as refund_*;
// never unhealthy). Design, window, budget and backoff:
// src/lib/revolut-reconcile.js.
//
// Heartbeat 'revolut-reconcile' (mig 773, 900 + 1200). Stamped when the run
// was healthy, with counts only (no ids, no PII); a run with nothing due is
// healthy, and per-row failures are counts, never a missed stamp. A candidate
// list that could not be read, or a tick on which every provider call failed,
// answers 500 with the counts and leaves the row to go stale, so a fault
// lasting past one missed tick pages.
//
// defineCron owns the CRON_SECRET check, the error boundary and the heartbeat.
import { defineCron } from '@/lib/define-cron'
import { runRevolutReconcile } from '@/lib/revolut-reconcile'
import { logError, logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const GET = defineCron({ heartbeat: 'revolut-reconcile' }, async ({ db }) => {
  let result
  try {
    result = await runRevolutReconcile({ db })
  } catch (e) {
    // runRevolutReconcile isolates every list and row; this is belt-and-braces.
    logError('revolut-reconcile', 'run threw', { err: e })
    return { ok: false, body: { error: 'Reconcile run failed' } }
  }
  const { healthy, counts } = result
  logInfo('revolut-reconcile', 'run complete', counts)
  if (!healthy) return { ok: false, body: { error: 'Reconcile run incomplete', data: counts } }
  return { outcome: counts, body: { data: counts } }
})
