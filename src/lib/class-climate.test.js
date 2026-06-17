import { describe, it, expect } from 'vitest'
import {
  toMillis,
  durationToMinutes,
  mapEventToOccurrence,
  DEFAULT_CLASS_MINUTES,
} from './class-occurrences'
import {
  resolveConfig,
  classMatchesFilter,
  planClassClimate,
  autoOffAtFor,
  DEFAULT_CONFIG,
} from './class-climate'

describe('class-occurrences: toMillis', () => {
  it('treats sub-1e12 numbers as unix seconds', () => {
    expect(toMillis(1_700_000_000)).toBe(1_700_000_000_000)
  })
  it('treats >=1e12 numbers as unix millis', () => {
    expect(toMillis(1_700_000_000_000)).toBe(1_700_000_000_000)
  })
  it('parses ISO strings', () => {
    expect(toMillis('2026-06-17T18:00:00.000Z')).toBe(Date.parse('2026-06-17T18:00:00.000Z'))
  })
  it('returns null for junk', () => {
    expect(toMillis(null)).toBeNull()
    expect(toMillis(undefined)).toBeNull()
    expect(toMillis('not a date')).toBeNull()
  })
})

describe('class-occurrences: durationToMinutes', () => {
  it('passes minutes through', () => { expect(durationToMinutes(45)).toBe(45) })
  it('converts seconds', () => { expect(durationToMinutes(2700)).toBe(45) })
  it('converts millis', () => { expect(durationToMinutes(2_700_000)).toBe(45) })
  it('returns null for non-positive / junk', () => {
    expect(durationToMinutes(0)).toBeNull()
    expect(durationToMinutes(-5)).toBeNull()
    expect(durationToMinutes('x')).toBeNull()
  })
})

describe('class-occurrences: mapEventToOccurrence', () => {
  const loc = 'a0000000-0000-0000-0000-000000000001'
  const startSec = 1_700_000_000

  it('maps a well-formed event', () => {
    const row = mapEventToOccurrence({
      _id: 'evt1', name: 'Strength 45', time_start: startSec, duration: 45,
      size: 16, trainers: ['Coach Mia', 'deadbeefdeadbeefdeadbeef'],
      program_obj: { name: 'Strength' },
    }, loc)
    expect(row.location_id).toBe(loc)
    expect(row.glofox_event_id).toBe('evt1')
    expect(row.name).toBe('Strength 45')
    expect(row.program).toBe('Strength')
    expect(row.capacity).toBe(16)
    expect(row.instructor).toBe('Coach Mia') // 24-hex id dropped
    expect(Date.parse(row.starts_at)).toBe(startSec * 1000)
    expect(Date.parse(row.ends_at)).toBe(startSec * 1000 + 45 * 60_000)
  })

  it('falls back to DEFAULT_CLASS_MINUTES when duration is missing', () => {
    const row = mapEventToOccurrence({ _id: 'e', time_start: startSec }, loc)
    expect(Date.parse(row.ends_at) - Date.parse(row.starts_at)).toBe(DEFAULT_CLASS_MINUTES * 60_000)
  })

  it('returns null without an _id or a start', () => {
    expect(mapEventToOccurrence({ time_start: startSec }, loc)).toBeNull()
    expect(mapEventToOccurrence({ _id: 'e' }, loc)).toBeNull()
    expect(mapEventToOccurrence({ _id: 'e', time_start: startSec }, null)).toBeNull()
  })

  it('reads capacity from an object shape', () => {
    const row = mapEventToOccurrence({ _id: 'e', time_start: startSec, size: { limit: 20 } }, loc)
    expect(row.capacity).toBe(20)
  })
})

describe('class-climate: resolveConfig', () => {
  it('applies defaults', () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG)
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG)
  })
  it('coerces + clamps', () => {
    const c = resolveConfig({ device_ids: ['d1', null, 'd2'], offset_on_min: -3, offset_off_min: '7', class_filter: ['Strength', ''] })
    expect(c.device_ids).toEqual(['d1', 'd2'])
    expect(c.offset_on_min).toBe(0)
    expect(c.offset_off_min).toBe(7)
    expect(c.class_filter).toEqual(['strength'])
  })
})

describe('class-climate: classMatchesFilter', () => {
  it('matches everything on empty filter', () => {
    expect(classMatchesFilter({ name: 'Anything' }, [])).toBe(true)
  })
  it('matches case-insensitive substring', () => {
    expect(classMatchesFilter({ name: 'Strength 45' }, ['strength'])).toBe(true)
    expect(classMatchesFilter({ name: 'Conditioning' }, ['strength'])).toBe(false)
  })
})

describe('class-climate: planClassClimate', () => {
  const now = Date.parse('2026-06-17T18:00:00.000Z')
  const cfg = resolveConfig({ device_ids: ['d1'], offset_on_min: 15, offset_off_min: 5 })
  const occ = (id, startOffsetMin, durMin = 45) => ({
    glofox_event_id: id,
    name: 'Strength 45',
    starts_at: new Date(now + startOffsetMin * 60_000).toISOString(),
    ends_at: new Date(now + (startOffsetMin + durMin) * 60_000).toISOString(),
  })

  it('fires when inside the pre-class lead window', () => {
    const plan = planClassClimate({ occurrences: [occ('a', 10)], config: cfg, nowMs: now }) // starts in 10m, offset 15
    expect(plan.map((p) => p.glofox_event_id)).toEqual(['a'])
  })
  it('fires while the class is running', () => {
    const plan = planClassClimate({ occurrences: [occ('b', -10)], config: cfg, nowMs: now }) // started 10m ago, 45m long
    expect(plan.map((p) => p.glofox_event_id)).toEqual(['b'])
  })
  it('does not fire before the lead window opens', () => {
    const plan = planClassClimate({ occurrences: [occ('c', 30)], config: cfg, nowMs: now }) // starts in 30m, offset 15
    expect(plan).toEqual([])
  })
  it('does not fire after the class has ended', () => {
    const plan = planClassClimate({ occurrences: [occ('d', -60, 45)], config: cfg, nowMs: now }) // ended 15m ago
    expect(plan).toEqual([])
  })
  it('respects the class filter', () => {
    const filtered = resolveConfig({ device_ids: ['d1'], class_filter: ['conditioning'] })
    const plan = planClassClimate({ occurrences: [occ('e', 10)], config: filtered, nowMs: now })
    expect(plan).toEqual([])
  })
})

describe('class-climate: autoOffAtFor', () => {
  const now = Date.parse('2026-06-17T18:00:00.000Z')
  const cfg = resolveConfig({ offset_off_min: 5 })
  it('is class end + offset_off', () => {
    const occ = { starts_at: new Date(now).toISOString(), ends_at: new Date(now + 45 * 60_000).toISOString() }
    expect(Date.parse(autoOffAtFor(occ, cfg, now))).toBe(now + (45 + 5) * 60_000)
  })
  it('never returns a past time', () => {
    const occ = { starts_at: new Date(now - 120 * 60_000).toISOString(), ends_at: new Date(now - 60 * 60_000).toISOString() }
    expect(Date.parse(autoOffAtFor(occ, cfg, now))).toBeGreaterThanOrEqual(now)
  })
})
