// src/lib/agent/checkin-day-rollup.test.js
// CHECKINSTALL.1 — the check-in tally must survive the night. last_outcome
// .checkins is overwritten every 15 min (and reads only quiet_hours from 20:00),
// so the heartbeat carries a per-Dublin-day rollup plus the day before.
import { describe, it, expect } from 'vitest'
import { rollupCheckinDay } from './checkin-day-rollup'

const DAY = '2026-09-30'
const tick = (over = {}) => ({ candidates: 2, freeform: 0, templates: 0, skipped: 2, reasons: { human_active: 1, too_soon: 1 }, ...over })

describe('rollupCheckinDay', () => {
  it('first tick of a day with nothing before: counts = the tick, no previous', () => {
    const out = rollupCheckinDay(null, tick(), { day: DAY })
    expect(out).toEqual({
      day: DAY, ticks: 1, daytime_ticks: 1, failed_ticks: 0,
      candidates: 2, freeform: 0, templates: 0, skipped: 2,
      reasons: { human_active: 1, too_soon: 1 }, previous: null,
    })
  })

  it('same-day ticks add up, reasons merge per key', () => {
    const a = rollupCheckinDay(null, tick(), { day: DAY })
    const b = rollupCheckinDay(a, tick({ templates: 1, skipped: 1, reasons: { human_active: 1 } }), { day: DAY })
    expect(b).toMatchObject({ ticks: 2, daytime_ticks: 2, candidates: 4, templates: 1, skipped: 3 })
    expect(b.reasons).toEqual({ human_active: 2, too_soon: 1 })
    expect(a.reasons).toEqual({ human_active: 1, too_soon: 1 }) // input not mutated
  })

  it('a quiet-hours tick counts as a tick, never as daytime work', () => {
    const a = rollupCheckinDay(null, tick(), { day: DAY })
    const b = rollupCheckinDay(a, { freeform: 0, templates: 0, skipped: 0, reasons: {}, reason: 'quiet_hours' }, { day: DAY })
    expect(b).toMatchObject({ ticks: 2, daytime_ticks: 1, candidates: 2, skipped: 2 })
  })

  it('a new Dublin day keeps the old day as previous (one level deep only)', () => {
    const d1 = rollupCheckinDay({ day: '2026-09-28', ticks: 9, previous: { day: '2026-09-27' } }, tick(), { day: '2026-09-29' })
    const d2 = rollupCheckinDay(d1, tick(), { day: DAY })
    expect(d2.day).toBe(DAY)
    expect(d2.ticks).toBe(1)
    expect(d2.previous.day).toBe('2026-09-29')
    expect(d2.previous.candidates).toBe(2)
    expect(d2.previous).not.toHaveProperty('previous')
  })

  it('a runner that threw (tick null) is a failed tick, not a quiet one', () => {
    const out = rollupCheckinDay(null, null, { day: DAY })
    expect(out).toMatchObject({ ticks: 1, daytime_ticks: 0, failed_ticks: 1, skipped: 0 })
  })

  it('an unreadable previous heartbeat restarts the day FLAGGED, and the flag sticks', () => {
    const a = rollupCheckinDay(null, tick(), { day: DAY, carryFailed: true })
    expect(a.carry_failed).toBe(true)
    const b = rollupCheckinDay(a, tick(), { day: DAY })
    expect(b.carry_failed).toBe(true)
    expect(b.ticks).toBe(2)
  })

  it('garbage in the previous slot is treated as nothing', () => {
    expect(rollupCheckinDay('x', tick(), { day: DAY }).previous).toBeNull()
    expect(rollupCheckinDay({ ticks: 3 }, tick(), { day: DAY }).ticks).toBe(1)
  })
})
