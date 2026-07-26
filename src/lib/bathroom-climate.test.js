// BATHROOM-CLIMATE.1 — table tests for the pure bathroom-climate planner.
// Mirrors class-climate.test.js. All times UTC ISO; slot exclusion goes
// through the shared Dublin slotKey.

import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG, resolveConfig, planBathroomClimate, autoOffAtFor } from './bathroom-climate.js'
import { slotKey } from './class-climate.js'

// A class starting 10:00 UTC. delay 45 + duration 30 → window 10:45–11:15 UTC.
const START = '2026-07-27T10:00:00.000Z'
const occ = (over = {}) => ({ glofox_event_id: 'ev1', name: 'DR1VE', starts_at: START, ends_at: '2026-07-27T10:50:00.000Z', ...over })
const CFG = resolveConfig({ device_ids: ['d1'], delay_after_start_min: 45, run_duration_min: 30 })
const at = (iso) => Date.parse(iso)

describe('resolveConfig', () => {
  it('applies defaults on empty/garbage input', () => {
    for (const input of [null, undefined, 'nope', 42, {}]) {
      const c = resolveConfig(input)
      expect(c.delay_after_start_min).toBe(DEFAULT_CONFIG.delay_after_start_min)
      expect(c.run_duration_min).toBe(DEFAULT_CONFIG.run_duration_min)
      expect(c.device_ids).toEqual([])
      expect(c.class_filter).toEqual([])
      expect(c.excluded_slots).toEqual([])
    }
  })
  it('coerces strings, floors delay at 0 and duration at 1', () => {
    const c = resolveConfig({ delay_after_start_min: '20', run_duration_min: '0' })
    expect(c.delay_after_start_min).toBe(20)
    expect(c.run_duration_min).toBe(1)
    expect(resolveConfig({ delay_after_start_min: -5 }).delay_after_start_min).toBe(0)
    expect(resolveConfig({ run_duration_min: -5 }).run_duration_min).toBe(1)
  })
  it('lowercases class_filter and drops falsy entries', () => {
    expect(resolveConfig({ class_filter: ['DR1VE', '', null] }).class_filter).toEqual(['dr1ve'])
  })
})

describe('planBathroomClimate window maths', () => {
  it.each([
    ['before window opens', '2026-07-27T10:44:00.000Z', 0],
    ['at window open (start+45)', '2026-07-27T10:45:00.000Z', 1],
    ['inside window', '2026-07-27T11:00:00.000Z', 1],
    ['at window close (start+75)', '2026-07-27T11:15:00.000Z', 1],
    ['after window closes', '2026-07-27T11:16:00.000Z', 0],
  ])('%s → %i planned', (_label, nowIso, count) => {
    const out = planBathroomClimate({ occurrences: [occ()], config: CFG, nowMs: at(nowIso) })
    expect(out).toHaveLength(count)
    if (count) expect(out[0].glofox_event_id).toBe('ev1')
  })

  it('ignores ends_at entirely — a 20-min class still fires at start+45', () => {
    const short = occ({ ends_at: '2026-07-27T10:20:00.000Z' })
    const out = planBathroomClimate({ occurrences: [short], config: CFG, nowMs: at('2026-07-27T10:50:00.000Z') })
    expect(out).toHaveLength(1)
  })

  it('drops occurrences with missing/bad starts_at or missing event id', () => {
    const bad = [occ({ starts_at: null }), occ({ starts_at: 'not-a-date' }), occ({ glofox_event_id: null })]
    expect(planBathroomClimate({ occurrences: bad, config: CFG, nowMs: at('2026-07-27T11:00:00.000Z') })).toEqual([])
  })

  it('respects class_filter (name-contains, case-insensitive)', () => {
    const cfg = resolveConfig({ ...CFG, class_filter: ['tempo'] })
    const now = at('2026-07-27T11:00:00.000Z')
    expect(planBathroomClimate({ occurrences: [occ()], config: cfg, nowMs: now })).toEqual([])
    expect(planBathroomClimate({ occurrences: [occ({ name: 'TEMPO 45' })], config: cfg, nowMs: now })).toHaveLength(1)
  })

  it('skips excluded weekly slots (keyed on class START, not on-time)', () => {
    const cfg = resolveConfig({ ...CFG, excluded_slots: [slotKey(START)] })
    expect(planBathroomClimate({ occurrences: [occ()], config: cfg, nowMs: at('2026-07-27T11:00:00.000Z') })).toEqual([])
  })
})

describe('autoOffAtFor', () => {
  it('anchors to the class schedule: start + delay + duration', () => {
    const iso = autoOffAtFor(occ(), CFG, at('2026-07-27T10:46:00.000Z'))
    expect(iso).toBe('2026-07-27T11:15:00.000Z')
  })
  it('a late cron tick still switches off at the same wall-clock time', () => {
    const iso = autoOffAtFor(occ(), CFG, at('2026-07-27T11:05:00.000Z'))
    expect(iso).toBe('2026-07-27T11:15:00.000Z')
  })
  it('never returns a past time (clamps to now + 60s)', () => {
    const now = at('2026-07-27T11:14:30.000Z')
    expect(Date.parse(autoOffAtFor(occ(), CFG, now))).toBe(now + 60_000)
  })
})
