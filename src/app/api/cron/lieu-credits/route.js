// LIEU.1 — nightly Vercel cron (03:40 UTC). Credits time in lieu for every
// completed FTE shift on a Sunday or a public holiday in the last 14 days
// (src/lib/lieu-credits.js runLieuCreditSweep), once per shift assignment.
// defineCron owns the CRON_SECRET check, the service-role client and the
// heartbeat stamp.
//
// `?days=N` (1..400) widens the window for a hand-run backfill; the sweep is
// idempotent, so a wider window only adds what is missing.
//
// Heartbeat: stamped on a sweep that read the estate; NOT stamped when the
// locations read failed or every studio failed (a green heartbeat over a sweep
// that credited nothing is the failure the row exists to catch, the
// extend-roster-horizon rule). A partial failure stamps and rides in
// last_outcome.failures as { location_id, step }: the database's error text
// goes to the log only, never into the response or the heartbeat row.
import { defineCron } from '@/lib/define-cron'
import { runLieuCreditSweep, LIEU_SWEEP_LOOKBACK_DAYS, LIEU_SWEEP_MAX_LOOKBACK_DAYS } from '@/lib/lieu-credits'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const SWEEP_FAILED = 'Lieu credit sweep failed'
const EVERY_STUDIO_FAILED = 'Every studio failed'

/** The sweep's stats with its error text reduced to fixed strings and names. */
function publicStats(stats) {
  const { error, failures, ...rest } = stats
  return {
    ...rest,
    ...(error === undefined ? {} : { error: error === EVERY_STUDIO_FAILED ? EVERY_STUDIO_FAILED : SWEEP_FAILED }),
    failures: (failures || []).map(({ location_id, step }) => ({ location_id, step })),
  }
}

export const GET = defineCron({ heartbeat: 'lieu-credits' }, async ({ db, request }) => {
  const url = new URL(request.url)
  const daysRaw = url.searchParams.get('days')
  let lookbackDays = LIEU_SWEEP_LOOKBACK_DAYS
  if (daysRaw !== null) {
    const n = Number(daysRaw)
    if (!Number.isInteger(n) || n < 1 || n > LIEU_SWEEP_MAX_LOOKBACK_DAYS) {
      return { ok: false, status: 400, body: { error: `days must be an integer from 1 to ${LIEU_SWEEP_MAX_LOOKBACK_DAYS}` } }
    }
    lookbackDays = n
  }

  let stats
  try {
    stats = await runLieuCreditSweep(db, { lookbackDays })
  } catch (err) {
    logWarn('lieu-credits', 'sweep threw', { err })
    return { ok: false, body: { error: SWEEP_FAILED } }
  }

  if (!stats.ok) {
    logWarn('lieu-credits', 'sweep failed — heartbeat not stamped', { stats })
    const out = publicStats(stats)
    return { ok: false, body: { error: out.error || SWEEP_FAILED, stats: out } }
  }

  if (stats.failures?.length) {
    logWarn('lieu-credits', 'sweep finished with studio failures', { failures: stats.failures })
  }
  const out = publicStats(stats)
  return { body: { stats: out }, outcome: out }
})
