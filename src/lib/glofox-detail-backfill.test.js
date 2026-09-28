// DETAILBACKFILL.1 — the glofox-detail-backfill cursor rules. The cron used to
// pick "plan IS NULL or synced > 14 days ago", plan-NULL first, in a select
// PostgREST caps at 1,000 rows: 2,926 contacts that legitimately have no plan
// were re-read every ~30 minutes forever, and 2,917 with a plan waited since
// 3 Jul. These rules make the cursor advance on every attempt.
import { describe, it, expect } from 'vitest'
import {
  DETAIL_PER_TICK, DETAIL_SWEEP_DAYS, DETAIL_RETRY_HOURS,
  nextDetailDueAt, detailDueFilter,
} from './glofox-detail-backfill.js'

const NOW = Date.parse('2026-10-01T09:00:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const at = (iso) => Date.parse(iso)

describe('DETAILBACKFILL.1 — budget', () => {
  it('reads 100 a tick, sweeps every ~14 days, retries a failure in 6 hours', () => {
    expect(DETAIL_PER_TICK).toBe(100)
    expect(DETAIL_SWEEP_DAYS).toBe(14)
    expect(DETAIL_RETRY_HOURS).toBe(6)
  })

  it('one tick is one page: the budget stays under PostgREST\'s 1,000-row cap', () => {
    expect(DETAIL_PER_TICK).toBeGreaterThan(0)
    expect(DETAIL_PER_TICK).toBeLessThan(1000)
  })
})

describe('DETAILBACKFILL.1 — nextDetailDueAt', () => {
  const ANSWERED = ['create', 'update', 'leave', 'member_refused', 'ambiguous', 'invalid']
  const FAILED = ['fetch_failed', 'error', undefined, null, 'something-new']

  it('an answered read is due again in 10.5–17.5 days (mean 14), jittered', () => {
    for (const o of ANSWERED) {
      expect(at(nextDetailDueAt(o, NOW, () => 0))).toBe(NOW + 10.5 * DAY)
      expect(at(nextDetailDueAt(o, NOW, () => 0.5))).toBe(NOW + 14 * DAY)
      const top = at(nextDetailDueAt(o, NOW, () => 0.999999))
      expect(top).toBeGreaterThan(NOW + 17 * DAY)
      expect(top).toBeLessThan(NOW + 17.5 * DAY)
    }
  })

  it('a refusal is an answer: Glofox will say the same thing next tick', () => {
    expect(at(nextDetailDueAt('member_refused', NOW, () => 0.5))).toBe(NOW + 14 * DAY)
  })

  it('a failed read (or an outcome it does not know) is retried in exactly 6 hours, never next tick', () => {
    for (const o of FAILED) {
      expect(at(nextDetailDueAt(o, NOW, () => 0.5))).toBe(NOW + 6 * HOUR)
      expect(at(nextDetailDueAt(o, NOW, () => 0))).toBe(NOW + 6 * HOUR)
    }
  })

  it('a broken random source cannot push the due date outside the window', () => {
    for (const r of [NaN, -1, 1, 7]) {
      const due = at(nextDetailDueAt('update', NOW, () => r))
      expect(due).toBeGreaterThanOrEqual(NOW + 10.5 * DAY)
      expect(due).toBeLessThan(NOW + 17.5 * DAY)
    }
  })

  it('returns an ISO UTC string (what PostgREST stores in a timestamptz)', () => {
    expect(nextDetailDueAt('update', NOW, () => 0.5)).toBe('2026-10-15T09:00:00.000Z')
    expect(nextDetailDueAt('fetch_failed', NOW)).toBe('2026-10-01T15:00:00.000Z')
  })

  it('defaults to the real clock and Math.random', () => {
    const before = Date.now()
    const due = at(nextDetailDueAt('update'))
    expect(due).toBeGreaterThanOrEqual(before + 10.5 * DAY)
    expect(due).toBeLessThan(Date.now() + 17.5 * DAY)
  })
})

describe('DETAILBACKFILL.1 — detailDueFilter', () => {
  it('is due when never attempted, or when the due time has passed', () => {
    expect(detailDueFilter('2026-10-01T09:00:00.000Z'))
      .toBe('glofox_detail_due_at.is.null,glofox_detail_due_at.lte.2026-10-01T09:00:00.000Z')
  })

  it('never mentions the plan: a contact with no plan is not "missing" anything', () => {
    expect(detailDueFilter('2026-10-01T09:00:00.000Z')).not.toContain('glofox_membership_plan')
  })

  it('refuses anything but a UTC ISO timestamp (it is spliced into a PostgREST or= string)', () => {
    for (const bad of ['', 'now', '2026-10-01', '2026-10-01T09:00:00+01:00', 'x),id.neq.(y', null, undefined, 42]) {
      expect(() => detailDueFilter(bad)).toThrow(/UTC ISO/)
    }
  })
})
