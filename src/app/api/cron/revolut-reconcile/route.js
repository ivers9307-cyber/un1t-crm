// GET /api/cron/revolut-reconcile — REVPAY.3, every 15 minutes.
//
// The backstop for a lost or deferred Revolut webhook: finds the
// Revolut-backed payment rows (car deposits, race payments, paid class
// bookings, paid trials, offer purchases, donations) still waiting on the
// provider 10 minutes to 7 days after checkout, asks Revolut for each order's
// state and applies it through the webhooks' own helpers. At most 50 provider
// calls a tick. It then re-runs the side effects of paid Revolut donations
// whose receipt or contact link did not land (REVPAY.12, at most 25 a tick,
// counted as receipt_*; never unhealthy). Design, window, budget and backoff:
// src/lib/revolut-reconcile.js.
//
// Heartbeat 'revolut-reconcile' (mig 773, 900 + 1200). Stamped when the run
// was healthy, with counts only (no ids, no PII); a run with nothing due is
// healthy, and per-row failures are counts, never a missed stamp. A candidate
// list that could not be read, or a tick on which every provider call failed,
// answers 500 with the counts and leaves the row to go stale, so a fault
// lasting past one missed tick pages.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { runRevolutReconcile } from '@/lib/revolut-reconcile'
import { logError, logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const HEARTBEAT = 'revolut-reconcile'

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  let result
  try {
    result = await runRevolutReconcile({ db })
  } catch (e) {
    // runRevolutReconcile isolates every list and row; this is belt-and-braces.
    logError('revolut-reconcile', 'run threw', { err: e })
    return NextResponse.json({ success: false, error: 'Reconcile run failed' }, { status: 500 })
  }
  const { healthy, counts } = result
  logInfo('revolut-reconcile', 'run complete', counts)
  if (!healthy) {
    return NextResponse.json({ success: false, error: 'Reconcile run incomplete', data: counts }, { status: 500 })
  }
  await stampHeartbeat(HEARTBEAT, counts)
  return NextResponse.json({ success: true, data: counts })
}
