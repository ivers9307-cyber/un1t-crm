// AUDIT-13.A — the Vercel cron table, pinned.
//
// Two things this file exists to stop:
//
//   1. A cron path in vercel.json that no route file answers. Vercel
//      would fire it forever and get a 404 — silent, because a cron
//      that never runs looks exactly like a cron with nothing to do.
//
//   2. Someone "fixing" the ONE duplicated path. The 2026-08 platform
//      audit flagged /api/cron/receipt-coverage-weekly appearing twice
//      (07:00 and 08:00 UTC on Fridays) as a double-fire bug. It is
//      NOT a bug — it is a deliberate DST straddle, documented in the
//      route header and in shouldRunFridayCron()'s own comment:
//      Vercel cron expressions are UTC only, and 08:00 Europe/Dublin
//      is 07:00 UTC under IST (summer) and 08:00 UTC under GMT
//      (winter). Both entries fire; the route's Dublin-hour gate lets
//      exactly the one landing in the 08:xx Dublin hour do work, and
//      the alreadyRanToday check absorbs the other firing plus any
//      retry. Delete either entry and the weekly receipt-coverage
//      report goes silent for half the year.
//
// So: duplicates are allowed, but ONLY this pair, and only with the
// gate that makes it safe.

import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import vercelConfig from '../vercel.json'
import { shouldRunFridayCron } from '../src/lib/recon/report-email.js'

const ROOT = join(import.meta.dirname, '..')
const crons = vercelConfig.crons

const DST_STRADDLE_PATH = '/api/cron/receipt-coverage-weekly'
const DST_STRADDLE_SCHEDULES = ['0 7 * * 5', '0 8 * * 5']

function countByPath() {
  const counts = new Map()
  for (const entry of crons) counts.set(entry.path, (counts.get(entry.path) || 0) + 1)
  return counts
}

describe('vercel.json crons — every entry maps to a route', () => {
  it('has a non-empty cron table', () => {
    expect(Array.isArray(crons)).toBe(true)
    expect(crons.length).toBeGreaterThan(0)
  })

  for (const { path } of crons) {
    it(`${path} has a route handler on disk`, () => {
      const dir = join(ROOT, 'src/app', path)
      const hasHandler = existsSync(join(dir, 'route.js')) || existsSync(join(dir, 'route.ts'))
      expect(hasHandler, `${path} is scheduled but src/app${path}/route.js does not exist`).toBe(true)
    })
  }

  it('every schedule is a five-field cron expression', () => {
    for (const { path, schedule } of crons) {
      expect(String(schedule).trim().split(/\s+/), `${path} has a malformed schedule`).toHaveLength(5)
    }
  })
})

describe('vercel.json crons — the only duplicate is the deliberate DST straddle', () => {
  it('names exactly one duplicated path', () => {
    const dupes = [...countByPath()].filter(([, n]) => n > 1).map(([p]) => p)
    expect(
      dupes,
      'a cron path listed twice fires twice — unless it is the documented Dublin DST straddle',
    ).toEqual([DST_STRADDLE_PATH])
  })

  it('the straddle is exactly the 07:00/08:00 UTC Friday pair', () => {
    const schedules = crons.filter((c) => c.path === DST_STRADDLE_PATH).map((c) => c.schedule).sort()
    expect(schedules).toEqual(DST_STRADDLE_SCHEDULES)
  })

  it('and the route gates on the Dublin hour, so only one firing works', () => {
    // 07:00 UTC in summer === 08:00 Dublin → runs.
    expect(shouldRunFridayCron({ dublinMinutes: 8 * 60, alreadyRanToday: false })).toBe(true)
    // The other firing lands at 09:xx Dublin that same day → skipped by
    // the hour gate even before alreadyRanToday is consulted.
    expect(shouldRunFridayCron({ dublinMinutes: 9 * 60, alreadyRanToday: false })).toBe(false)
    // Winter: 07:00 UTC is 07:00 Dublin → skipped; 08:00 UTC runs.
    expect(shouldRunFridayCron({ dublinMinutes: 7 * 60, alreadyRanToday: false })).toBe(false)
    // Belt and braces: a same-day re-fire never doubles the report.
    expect(shouldRunFridayCron({ dublinMinutes: 8 * 60, alreadyRanToday: true })).toBe(false)
  })
})
