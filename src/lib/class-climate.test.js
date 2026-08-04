import { describe, it, expect } from 'vitest'
import {
  toMillis,
  durationToMinutes,
  mapEventToOccurrence,
  extractTrainerIds,
  occurrenceIsLive,
  DEFAULT_CLASS_MINUTES,
} from './class-occurrences'
import {
  resolveConfig,
  classMatchesFilter,
  planClassClimate,
  autoOffAtFor,
  slotKey,
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

// STUDIO-KPI.2 — trainer-id → name mapping so the scorecard's floor
// table can group per coach instead of per class.
describe('class-occurrences: mapEventToOccurrence trainer-name map', () => {
  const loc = 'a0000000-0000-0000-0000-000000000001'
  const startSec = 1_700_000_000
  const ID1 = '61a38e7d0cf1970aae0fb3a9'
  const ID2 = 'deadbeefdeadbeefdeadbeef'

  it('resolves a trainer id through the map', () => {
    const row = mapEventToOccurrence(
      { _id: 'e', time_start: startSec, trainers: [ID1] }, loc, { [ID1]: 'Jess Murphy' })
    expect(row.instructor).toBe('Jess Murphy')
  })

  it('joins mapped ids with inline names; unmapped ids still drop', () => {
    const row = mapEventToOccurrence(
      { _id: 'e', time_start: startSec, trainers: [ID1, 'Coach Mia', ID2] }, loc, { [ID1]: 'Jess' })
    expect(row.instructor).toBe('Jess, Coach Mia')
  })

  it('resolves object-shaped trainer entries via _id', () => {
    const row = mapEventToOccurrence(
      { _id: 'e', time_start: startSec, trainers: [{ _id: ID1 }] }, loc, { [ID1]: 'Jess' })
    expect(row.instructor).toBe('Jess')
  })

  it('matches map keys case-insensitively', () => {
    const row = mapEventToOccurrence(
      { _id: 'e', time_start: startSec, trainers: [ID1.toUpperCase()] }, loc, { [ID1]: 'Jess' })
    expect(row.instructor).toBe('Jess')
  })

  it('behaves exactly as before when no map is given', () => {
    const row = mapEventToOccurrence({ _id: 'e', time_start: startSec, trainers: [ID1] }, loc)
    expect(row.instructor).toBeNull()
  })
})

describe('class-occurrences: extractTrainerIds', () => {
  const ID1 = '61a38e7d0cf1970aae0fb3a9'
  const ID2 = 'DEADBEEFDEADBEEFDEADBEEF'

  it('collects distinct 24-hex ids (string + object entries), lowercased', () => {
    const events = [
      { trainers: [ID1, 'Coach Mia'] },
      { trainers: [{ _id: ID2 }, ID1] },
      { trainers: 'not-an-array' },
      null,
    ]
    expect(extractTrainerIds(events).sort()).toEqual([ID1, ID2.toLowerCase()].sort())
  })

  it('returns [] for empty / trainer-less input', () => {
    expect(extractTrainerIds([])).toEqual([])
    expect(extractTrainerIds(null)).toEqual([])
    expect(extractTrainerIds([{ trainers: ['Coach Mia'] }])).toEqual([])
  })
})

describe('class-occurrences: occurrenceIsLive (HR-CLASS-ALLOC.1)', () => {
  // A 06:00–07:00 class. Default grace: 20 min before, 10 min after.
  const occ = { starts_at: '2026-06-18T05:00:00Z', ends_at: '2026-06-18T06:00:00Z' }
  const at = (iso) => Date.parse(iso)

  it('is live mid-class', () => {
    expect(occurrenceIsLive(occ, at('2026-06-18T05:30:00Z'))).toBe(true)
  })
  it('is live inside the pre-start grace window (15 min early)', () => {
    expect(occurrenceIsLive(occ, at('2026-06-18T04:45:00Z'))).toBe(true)
  })
  it('is not live before the pre-start grace (25 min early)', () => {
    expect(occurrenceIsLive(occ, at('2026-06-18T04:35:00Z'))).toBe(false)
  })
  it('is live inside the post-end grace window (5 min after)', () => {
    expect(occurrenceIsLive(occ, at('2026-06-18T06:05:00Z'))).toBe(true)
  })
  it('is not live past the post-end grace (15 min after)', () => {
    expect(occurrenceIsLive(occ, at('2026-06-18T06:15:00Z'))).toBe(false)
  })
  it('honours custom grace windows', () => {
    expect(occurrenceIsLive(occ, at('2026-06-18T04:35:00Z'), { preMs: 30 * 60_000 })).toBe(true)
  })
  it('falls back to a 60-min duration when ends_at is missing', () => {
    const noEnd = { starts_at: '2026-06-18T05:00:00Z' }
    expect(occurrenceIsLive(noEnd, at('2026-06-18T05:55:00Z'))).toBe(true)
    expect(occurrenceIsLive(noEnd, at('2026-06-18T06:15:00Z'))).toBe(false)
  })
  it('returns false for a malformed / empty occurrence', () => {
    expect(occurrenceIsLive(null, at('2026-06-18T05:30:00Z'))).toBe(false)
    expect(occurrenceIsLive({}, at('2026-06-18T05:30:00Z'))).toBe(false)
    expect(occurrenceIsLive({ starts_at: 'nonsense' }, at('2026-06-18T05:30:00Z'))).toBe(false)
  })
})

describe('class-climate: slotKey', () => {
  it('derives a Dublin weekday+time key (BST = UTC+1)', () => {
    // 05:00 UTC on Thu 18 Jun 2026 = 06:00 Dublin (BST).
    expect(slotKey('2026-06-18T05:00:00Z')).toBe('Thu 06:00')
  })
  it('two occurrences a week apart share the same slot key', () => {
    expect(slotKey('2026-06-18T05:00:00Z')).toBe(slotKey('2026-06-25T05:00:00Z'))
  })
  it('returns null on junk', () => {
    expect(slotKey('nope')).toBeNull()
    expect(slotKey(null)).toBeNull()
  })
})

describe('class-climate: resolveConfig', () => {
  it('applies defaults', () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG)
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG)
  })
  it('coerces + clamps', () => {
    const c = resolveConfig({
      device_ids: ['d1', null, 'd2'], offset_on_min: -3, offset_off_min: '7',
      class_filter: ['Strength', ''], excluded_slots: ['Thu 06:00', ''],
    })
    expect(c.device_ids).toEqual(['d1', 'd2'])
    expect(c.offset_on_min).toBe(0)
    expect(c.offset_off_min).toBe(7)
    expect(c.class_filter).toEqual(['strength'])
    expect(c.excluded_slots).toEqual(['Thu 06:00'])
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
    const plan = planClassClimate({ occurrences: [occ('a', 10)], config: cfg, nowMs: now })
    expect(plan.map((p) => p.glofox_event_id)).toEqual(['a'])
  })
  it('fires while the class is running', () => {
    const plan = planClassClimate({ occurrences: [occ('b', -10)], config: cfg, nowMs: now })
    expect(plan.map((p) => p.glofox_event_id)).toEqual(['b'])
  })
  it('does not fire before the lead window opens', () => {
    const plan = planClassClimate({ occurrences: [occ('c', 30)], config: cfg, nowMs: now })
    expect(plan).toEqual([])
  })
  it('does not fire after the class has ended', () => {
    const plan = planClassClimate({ occurrences: [occ('d', -60, 45)], config: cfg, nowMs: now })
    expect(plan).toEqual([])
  })
  it('respects the class filter', () => {
    const filtered = resolveConfig({ device_ids: ['d1'], class_filter: ['conditioning'] })
    const plan = planClassClimate({ occurrences: [occ('e', 10)], config: filtered, nowMs: now })
    expect(plan).toEqual([])
  })
  it('skips an excluded weekly slot', () => {
    const one = occ('f', 10)
    const c = resolveConfig({ device_ids: ['d1'], offset_on_min: 15, excluded_slots: [slotKey(one.starts_at)] })
    expect(planClassClimate({ occurrences: [one], config: c, nowMs: now })).toEqual([])
    // ...but a non-excluded slot at the same moment still fires.
    const c2 = resolveConfig({ device_ids: ['d1'], offset_on_min: 15, excluded_slots: ['Mon 09:00'] })
    expect(planClassClimate({ occurrences: [one], config: c2, nowMs: now }).map((p) => p.glofox_event_id)).toEqual(['f'])
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
