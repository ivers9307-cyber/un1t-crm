// ROSTER-FIX.5 — nightly Vercel cron. Keeps 8 weeks of shift_blocks
// materialised ahead of this week's Monday for every active shift template,
// so the roster is never empty just because nobody scrolled the calendar
// far enough to trigger the old lazy extend. Auth: CRON_SECRET.
import { defineCron } from '@/lib/define-cron'
import { extendRosterHorizon } from '@/lib/roster-horizon'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export const GET = defineCron({ heartbeat: 'extend-roster-horizon' }, async ({ db }) => {
  // A throw is a failed sweep: the wrapper logs it, answers 500 and does not
  // stamp, so Sentinel never sees a healthy horizon while blocks stop.
  const stats = await extendRosterHorizon(db)
  // ROSTER-FIX.5 — extendRosterHorizon returns normally when every template
  // failed individually, so a sweep that generated NOTHING used to stamp a
  // healthy heartbeat. A total failure is a failed run — 500, no stamp.
  //
  // A PARTIAL failure still stamps, deliberately: the horizon did advance for
  // the rest of the estate, and the per-template failures ride along in
  // last_outcome.failed, where the heartbeat's own notes say to look for them.
  // Withholding the stamp there would page the on-call for one malformed
  // template while everything else worked.
  if (stats.failed > 0 && stats.failed === stats.templates) {
    logWarn('roster-horizon', 'every template failed — heartbeat not stamped', { stats })
    return { ok: false, body: { error: 'Every template failed to generate', stats } }
  }
  return { body: { stats }, outcome: stats }
})
