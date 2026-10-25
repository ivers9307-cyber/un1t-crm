// AUDIT-13.A — the Vercel cron table, pinned.
//
// Two things this file exists to stop:
//
//   1. A cron path in vercel.json that no route file answers. Vercel
//      would fire it forever and get a 404 — silent, because a cron
//      that never runs looks exactly like a cron with nothing to do.
//
//   2. A cron path listed twice. It fires twice. The one deliberate pair
//      there ever was, /api/cron/receipt-coverage-weekly at 07:00 AND 08:00
//      UTC on Fridays (a straddle onto 08:00 Europe/Dublin across DST),
//      became a single hourly entry in TZ.6: the daily-slot gate
//      (src/lib/cron-daily-slot.js, a local-anchored slot) now picks each
//      location's Friday 08:xx local hour, and its claim absorbs any retry.
//      src/lib/cron-daily-slot.test.js proves it acts at exactly the instants
//      the old pair + Dublin-hour gate did, every Friday of 2026.

import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import vercelConfig from '../vercel.json'

const ROOT = join(import.meta.dirname, '..')
const crons = vercelConfig.crons

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

describe('vercel.json crons — no path is listed twice', () => {
  it('names no duplicated path', () => {
    const dupes = [...countByPath()].filter(([, n]) => n > 1).map(([p]) => p)
    expect(dupes, 'a cron path listed twice fires twice').toEqual([])
  })

  it('receipt-coverage-weekly runs hourly; the daily-slot gate picks Friday 08:xx local (TZ.6)', () => {
    expect(crons.filter((c) => c.path === '/api/cron/receipt-coverage-weekly').map((c) => c.schedule)).toEqual(['0 * * * *'])
  })
})
