// ZOOMSYNC.1 — nightly Vercel cron. Reconciles Zoom Phone's external-contacts
// directory against the CRM so inbound member calls show a name. Thin
// CRON_SECRET-guarded wrapper; runZoomContactSync (src/lib/zoom/reconcile.js)
// is the tested body — same thin-wrapper skeleton as the other reconcile crons.
//
// Operator query params (the scheduled run passes none of them):
//   ?dry=1   — compute and return the diff, enqueue nothing. First thing to
//              reach for when the deletion guard trips.
//   ?limit=N — enqueue at most N writes, creates first. Used for the go-live
//              pilot so a handset can be checked before 6,330 records move.
//   ?force=1 — bypass the deletion guard for ONE run. Without it a genuinely
//              large cleanup can never drain: suppressing the deletes keeps the
//              directory big, so the same batch trips the same threshold every
//              night. Run ?dry=1 first and read the sample before using this.
//
// Auth: CRON_SECRET.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { runZoomContactSync } from '@/lib/zoom/reconcile'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const url = new URL(request.url)
  const rawLimit = Number(url.searchParams.get('limit'))
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : null
  const dry = url.searchParams.get('dry') === '1'
  const force = url.searchParams.get('force') === '1'

  const db = createServerClient()
  const out = await runZoomContactSync({ db, dry, limit, force, trigger: 'cron' })

  // Pass the outcome, don't just stamp the time. Without it the only record of
  // what a night's run did is this HTTP response, which nobody reads at 04:30 —
  // a tripped deletion guard or a run that enqueued nothing would look
  // identical to a healthy one. Same shape as fleet-health.
  await stampHeartbeat('zoom-contact-sync', {
    counts: out.counts ?? null,
    enqueued: out.enqueued ?? 0,
    guardTripped: out.guardTripped ?? false,
    // ZOOMSYNC.4 — a run that enqueues nothing because everything left is
    // unusable must not read as "ran and idle", which is the exact distinction
    // last_outcome exists to draw.
    ...(out.withheld ? { withheld: out.withheld } : {}),
    ...(out.skipped ? { skipped: out.skipped } : {}),
    ...(out.failures?.length ? { failureCount: out.failures.length } : {}),
  }).catch((err) => logWarn('cron-zoom-contact-sync', 'heartbeat failed', { err }))

  // `out.ok !== false` deliberately: the unconfigured skip carries no `ok`
  // key and is not a dead cron. A tripped deletion guard DOES set ok:false
  // and should show red — that is the point of the guard.
  return NextResponse.json({ success: out.ok !== false, ...out })
}
