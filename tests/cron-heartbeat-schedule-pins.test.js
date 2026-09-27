// CLASSSYNCHB.1 — a heartbeat row is only right while its cron keeps the
// schedule it was sized for. Three times a vercel.json schedule changed with
// no heartbeat migration (HR-WAVE1 P0-8 restored sync-class-occurrences to
// */15 with its row still daily; ADS-REPORT moved ad-insights-sync to every
// 4 h; #894 slowed two drains to */2), and each time the health-check judged
// the cron on the wrong clock for months. Mig 644 re-sized those four rows;
// this pins their schedules so the NEXT change fails here, in the PR that
// makes it, instead of in production.
//
// If this fails because you changed one of these schedules on purpose: ship a
// NEW migration re-sizing that cron_heartbeats row (read the live row first,
// not the migration text), then update the pin below to name it.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'))
const MIG_644 = readFileSync(path.join(root, 'supabase/migrations/644_cron_heartbeat_cadence.sql'), 'utf8')

const schedulesOf = (route) => vercel.crons.filter((c) => c.path === `/api/cron/${route}`).map((c) => c.schedule)

const PINNED = [
  { route: 'sync-class-occurrences', schedule: '*/15 * * * *', interval: 900, grace: 1200 },
  { route: 'ad-insights-sync', schedule: '0 */4 * * *', interval: 14400, grace: 18000 },
  { route: 'process-class-bookings', schedule: '*/2 * * * *', interval: 120, grace: 240 },
  { route: 'process-contact-imports', schedule: '*/2 * * * *', interval: 120, grace: 240 },
]

describe('cron schedules that mig 644 sized a heartbeat row for', () => {
  it.each(PINNED)('$route still runs on "$schedule" (row $interval + $grace)', ({ route, schedule }) => {
    expect(
      schedulesOf(route),
      `vercel.json changed the ${route} schedule. Ship a NEW migration re-sizing its cron_heartbeats row in this PR, then update this pin.`,
    ).toEqual([schedule])
  })

  it.each(PINNED)('mig 644 seeds $route as $interval + $grace (the pin and the SQL agree)', ({ route, interval, grace }) => {
    expect(MIG_644).toMatch(new RegExp(`'${route}',\\s*${interval},\\s*${grace},`))
    expect(MIG_644).toMatch(new RegExp(`\\('${route}', ${interval}, ${grace}\\)`)) // the self-check row
  })
})
