// CLASSSYNCHB.1 — a heartbeat row is only right while its cron keeps the
// schedule it was sized for. Three times a vercel.json schedule changed with
// no heartbeat migration (HR-WAVE1 P0-8 restored sync-class-occurrences to
// */15 with its row still daily; ADS-REPORT moved ad-insights-sync to every
// 4 h; #894 slowed two drains to */2), and each time the health-check judged
// the cron on the wrong clock for months. Mig 644 re-sized those four rows;
// this pins their schedules so the NEXT change fails here, in the PR that
// makes it, instead of in production.
//
// Changing a schedule: ship a NEW migration, then update
// schedule/interval/grace/migration on this row. Never edit an applied
// migration to keep this green (migrations are forward-only): each row names
// the migration that sized it, and the test reads THAT file. Read the live
// row before sizing, not the migration text.
//
// Each row also carries the sizing rule, so a new migration cannot pass by
// being self-consistent but wrong: the interval is the cron's period (derived
// from the schedule string), and the grace is bigger than the interval, so a
// single missed tick never pages.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'))
const readMigration = (file) => readFileSync(path.join(root, 'supabase/migrations', file), 'utf8')

const schedulesOf = (route) => vercel.crons.filter((c) => c.path === `/api/cron/${route}`).map((c) => c.schedule)

/**
 * The period in seconds of the cron shapes these pins use. Anything else
 * throws: teach the parser the new shape rather than guessing.
 *   `*\/N * * * *` → N minutes;  `0 *\/H * * *` → H hours.
 */
function cronPeriodSeconds(schedule) {
  const minutes = schedule.match(/^\*\/(\d+) \* \* \* \*$/)
  if (minutes) return Number(minutes[1]) * 60
  const hours = schedule.match(/^0 \*\/(\d+) \* \* \*$/)
  if (hours) return Number(hours[1]) * 3600
  throw new Error(
    `cronPeriodSeconds: unknown cron shape "${schedule}" (knows only "*/N * * * *" and "0 */H * * *"); extend the parser in tests/cron-heartbeat-schedule-pins.test.js`,
  )
}

const PINNED = [
  { route: 'sync-class-occurrences', schedule: '*/15 * * * *', interval: 900, grace: 1200, migration: '644_cron_heartbeat_cadence.sql' },
  { route: 'ad-insights-sync', schedule: '0 */4 * * *', interval: 14400, grace: 18000, migration: '644_cron_heartbeat_cadence.sql' },
  { route: 'process-class-bookings', schedule: '*/2 * * * *', interval: 120, grace: 240, migration: '644_cron_heartbeat_cadence.sql' },
  { route: 'process-contact-imports', schedule: '*/2 * * * *', interval: 120, grace: 240, migration: '644_cron_heartbeat_cadence.sql' },
  { route: 'glofox-detail-backfill', schedule: '*/10 * * * *', interval: 600, grace: 900, migration: '645_contacts_glofox_detail_due_at.sql' },
]

describe('cronPeriodSeconds', () => {
  it('reads the two shapes the pins use', () => {
    expect(cronPeriodSeconds('*/15 * * * *')).toBe(900)
    expect(cronPeriodSeconds('*/2 * * * *')).toBe(120)
    expect(cronPeriodSeconds('0 */4 * * *')).toBe(14400)
  })

  it('refuses a shape it does not know, rather than guessing', () => {
    expect(() => cronPeriodSeconds('0 4 * * *')).toThrow(/unknown cron shape "0 4 \* \* \*"/)
    expect(() => cronPeriodSeconds('*/15 6-22 * * *')).toThrow(/unknown cron shape/)
  })
})

describe('cron schedules pinned to the migration that sized their heartbeat row', () => {
  it.each(PINNED)('$route still runs on "$schedule" (row $interval + $grace, $migration)', ({ route, schedule, migration }) => {
    expect(
      schedulesOf(route),
      `vercel.json changed the ${route} schedule. Ship a NEW migration re-sizing its cron_heartbeats row in this PR, then update schedule/interval/grace/migration on its PINNED row (migration is now '${migration}').`,
    ).toEqual([schedule])
  })

  it.each(PINNED)('$route: interval is the cron period and grace clears one missed tick', ({ route, schedule, interval, grace, migration }) => {
    expect(
      interval,
      `${route}: PINNED interval ${interval} is not the period of "${schedule}". The row the migration field names ('${migration}') must be sized to the schedule.`,
    ).toBe(cronPeriodSeconds(schedule))
    expect(
      grace,
      `${route}: PINNED grace ${grace} must exceed the interval ${interval}, or a single missed tick pages ('${migration}').`,
    ).toBeGreaterThan(interval)
  })

  it.each(PINNED)('$migration seeds $route as $interval + $grace (the pin and the SQL agree)', ({ route, interval, grace, migration }) => {
    const sql = readMigration(migration)
    expect(
      sql,
      `${route}: the file named by PINNED's migration field ('${migration}') does not seed the row as ${interval} + ${grace}. Point the migration field at the NEW migration that re-sized it; never edit an applied one.`,
    ).toMatch(new RegExp(`'${route}',\\s*${interval},\\s*${grace},`))
    expect(
      sql,
      `${route}: the self-check in '${migration}' (PINNED's migration field) does not name ${interval} + ${grace}.`,
    ).toMatch(new RegExp(`\\('${route}', ${interval}, ${grace}\\)`)) // the self-check row
  })
})
