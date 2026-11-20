// ATTR-3 — nightly attribution canary + Sunday weekly attribution report.
//
// Thin wrapper: decisions in src/lib/hr-attribution-health.js (pure), IO in
// src/lib/hr-attribution-sweep.js. Runs at 21:45 UTC — 22:45 Dublin in
// summer, 21:45 in winter, safely after the last class either way, so the
// canary judges a COMPLETE day (a mid-afternoon run would call a strap worn
// in the 18:15 class "unattributed" simply because it hadn't happened yet).
//
// ?dry=1 decides everything and sends nothing; ?weekly=1 forces the weekly
// section on a non-Sunday (manual probe after a fix).
//
// defineCron owns the CRON_SECRET check and the heartbeat stamp. Heartbeat
// only on a clean, real run: a half-failed sweep should read as stale rather
// than quietly healthy, and a dry run is a manual probe. Both still answer
// 200, as they always did, through the wrapper's no-stamp path (ok: false,
// so `success` is false).

import { defineCron } from '@/lib/define-cron'
import { runAttributionHealthSweep } from '@/lib/hr-attribution-sweep'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request) { return GET(request) }

/** The sweep's own error text stays in its log line (hr-attribution-sweep.js). */
function redactSection(section, fixed) {
  return section && section.error !== undefined ? { ...section, error: fixed } : section
}

export const GET = defineCron({ heartbeat: 'attribution-health' }, async ({ db, request }) => {
  const url = new URL(request.url)
  const dry = url.searchParams.get('dry') === '1'
  const forceWeekly = url.searchParams.get('weekly') === '1'

  const raw = await runAttributionHealthSweep({ db, dry, forceWeekly })
  const result = { ...raw }
  if ('daily' in raw) result.daily = redactSection(raw.daily, 'daily canary failed')
  if ('weekly' in raw) result.weekly = redactSection(raw.weekly, 'weekly report failed')

  if (!result.ok || dry) return { ok: false, status: 200, body: result }
  return { body: result }
})
