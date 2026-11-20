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
// Auth: CRON_SECRET, via defineCron (src/lib/define-cron.js).
//
// ROUTEWRAP.C9 — on defineCron with the same stamps as before: every run that
// read its inputs stamps 'zoom-contact-sync' with its outcome, a tripped guard
// included (ok: false + stamp: true, still answered 200); a run that could not
// read its inputs answers 500 and stamps nothing.

import { defineCron } from '@/lib/define-cron'
import { runZoomContactSync } from '@/lib/zoom/reconcile'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const GET = defineCron({ heartbeat: 'zoom-contact-sync' }, async ({ db, request }) => {
  const url = new URL(request.url)
  const rawLimit = Number(url.searchParams.get('limit'))
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : null
  const dry = url.searchParams.get('dry') === '1'
  const force = url.searchParams.get('force') === '1'

  const out = await runZoomContactSync({ db, dry, limit, force, trigger: 'cron' })

  // ZOOMSYNC.5 — a run that could not read the CRM's contacts or Zoom's
  // directory did nothing: it used to stamp anyway, so a sync dead for a week
  // looked healthy. It now answers a fixed line (the detail goes to the log
  // and the run history) and leaves the heartbeat to go stale.
  if (out.ok === false && !out.counts) {
    logError('cron-zoom-contact-sync', 'run could not read its inputs; not stamping', { err: out.error ?? null })
    return { ok: false, status: 500, body: { error: 'Zoom contact sync could not read its inputs' } }
  }

  // `out.ok !== false` deliberately: the unconfigured skip carries no `ok`
  // key and is not a dead cron. A tripped deletion guard DOES set ok:false
  // and should show red — that is the point of the guard — but it is still
  // stamped (stamp: true) and still answered 200, as before.
  const ok = out.ok !== false
  return {
    ok,
    stamp: true,
    status: 200,
    // Pass the outcome, don't just stamp the time. Without it the only record
    // of what a night's run did is this HTTP response, which nobody reads at
    // 04:30 — a tripped deletion guard or a run that enqueued nothing would
    // look identical to a healthy one. Same shape as fleet-health.
    outcome: {
      counts: out.counts ?? null,
      enqueued: out.enqueued ?? 0,
      guardTripped: out.guardTripped ?? false,
      // ZOOMSYNC.4 — a run that enqueues nothing because everything left is
      // unusable must not read as "ran and idle", which is the exact
      // distinction last_outcome exists to draw.
      ...(out.withheld ? { withheld: out.withheld } : {}),
      ...(out.skipped ? { skipped: out.skipped } : {}),
      ...(out.failures?.length ? { failureCount: out.failures.length } : {}),
    },
    body: publicResult(out),
  }
})

// ZOOMSYNC.5 — what the scheduled run's response may say. `failures` are
// "<op> <phone number>: <provider error>" strings and the tripped guard
// carries a sample of numbers: counts only here (the run history keeps the
// detail for staff). A dry run (?dry=1, the operator's tool, behind the cron
// secret) still answers in full: its sample is what decides a ?force=1.
export function publicResult(out) {
  if (out?.dry) return out
  const { failures, guard, ...rest } = out || {}
  return {
    ...rest,
    ...(failures?.length ? { failureCount: failures.length } : {}),
    ...(guard ? { guard: guardSummary(guard) } : {}),
  }
}

function guardSummary(guard) {
  const counts = {}
  for (const [k, v] of Object.entries(guard || {})) {
    if (typeof v === 'number' || typeof v === 'boolean') counts[k] = v
    else if (Array.isArray(v)) counts[`${k}Count`] = v.length
  }
  return counts
}
