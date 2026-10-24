import { describe, it, expect } from 'vitest'
import {
  SCREEN_MODE_KEY,
  SCREEN_MODES,
  REPORTED_MODES,
  OVERRIDE_MINUTES,
  PACKAGE_NAME_RE,
  PACKAGE_NAME_MAX,
  PLAN_LOOKBACK_MS,
  PLAN_LOOKAHEAD_MS,
  PLAN_POLL_SECONDS,
  DEFAULT_CLASS_MS,
  DEFAULT_SCREEN_CONFIG,
  resolveScreenConfig,
  planScreenWindows,
  modeAt,
} from './screen-mode'

const occ = (id, s, e, name = 'UN1T Strength') => ({ glofox_event_id: id, name, starts_at: s, ends_at: e })
const cfg = resolveScreenConfig({ class_app_package: 'com.franchise.app' })

describe('screen-mode: constants', () => {
  it('exposes the agreed values', () => {
    expect(SCREEN_MODE_KEY).toBe('screen_mode')
    expect(SCREEN_MODES).toEqual(['class_app', 'marketing'])
    expect(REPORTED_MODES).toEqual(['class_app', 'marketing', 'unknown'])
    expect(OVERRIDE_MINUTES).toEqual([30, 60, 120, 240])
    expect(PACKAGE_NAME_MAX).toBe(200)
    expect(PLAN_LOOKBACK_MS).toBe(6 * 3_600_000)
    expect(PLAN_LOOKAHEAD_MS).toBe(36 * 3_600_000)
    expect(PLAN_POLL_SECONDS).toBe(600)
    expect(DEFAULT_CLASS_MS).toBe(3_600_000)
    expect(Object.isFrozen(SCREEN_MODES)).toBe(true)
    expect(Object.isFrozen(REPORTED_MODES)).toBe(true)
    expect(Object.isFrozen(OVERRIDE_MINUTES)).toBe(true)
    expect(Object.isFrozen(DEFAULT_SCREEN_CONFIG)).toBe(true)
  })
  it('PACKAGE_NAME_RE accepts dotted package names only', () => {
    expect(PACKAGE_NAME_RE.test('com.franchise.app')).toBe(true)
    expect(PACKAGE_NAME_RE.test('com.x_y.App2')).toBe(true)
    expect(PACKAGE_NAME_RE.test('singleword')).toBe(false)
    expect(PACKAGE_NAME_RE.test('com.x; rm -rf /')).toBe(false)
    expect(PACKAGE_NAME_RE.test('com..app')).toBe(false)
    expect(PACKAGE_NAME_RE.test('1com.app')).toBe(false)
  })
})

describe('screen-mode: resolveScreenConfig', () => {
  it('applies defaults for junk input', () => {
    expect(resolveScreenConfig(undefined)).toEqual(DEFAULT_SCREEN_CONFIG)
    expect(resolveScreenConfig(null)).toEqual(DEFAULT_SCREEN_CONFIG)
    expect(resolveScreenConfig('nope')).toEqual(DEFAULT_SCREEN_CONFIG)
    expect(resolveScreenConfig({})).toEqual(DEFAULT_SCREEN_CONFIG)
  })
  it('coerces arrays, lower-cases the filter, clamps numbers', () => {
    const c = resolveScreenConfig({
      device_names: ['tv-1', null, 7, '', 'tv-2'],
      lead_in_min: '12',
      lead_out_min: -1,
      class_filter: ['Strength', '', null],
      excluded_slots: ['Thu 06:00', '', 4],
    })
    expect(c.device_names).toEqual(['tv-1', 'tv-2'])
    expect(c.lead_in_min).toBe(12)
    expect(c.lead_out_min).toBe(0)
    expect(c.class_filter).toEqual(['strength'])
    expect(c.excluded_slots).toEqual(['Thu 06:00'])
  })
  it('falls back to the default lead for a non-numeric value', () => {
    expect(resolveScreenConfig({ lead_in_min: 'abc' }).lead_in_min).toBe(10)
    expect(resolveScreenConfig({ lead_out_min: 'abc' }).lead_out_min).toBe(5)
  })
  it('refuses a bad package name and a bad stale mode', () => {
    expect(resolveScreenConfig({ class_app_package: 'com.x; rm -rf /' }).class_app_package).toBeNull()
    expect(resolveScreenConfig({ class_app_package: 'com.franchise.app' }).class_app_package).toBe('com.franchise.app')
    expect(resolveScreenConfig({ class_app_package: 42 }).class_app_package).toBeNull()
    expect(resolveScreenConfig({ class_app_package: 'com.' + 'a'.repeat(PACKAGE_NAME_MAX) }).class_app_package).toBeNull()
    expect(resolveScreenConfig({ stale_plan_mode: 'blank' }).stale_plan_mode).toBe('class_app')
    expect(resolveScreenConfig({ stale_plan_mode: 'marketing' }).stale_plan_mode).toBe('marketing')
    expect(resolveScreenConfig({ lead_in_min: -4 }).lead_in_min).toBe(0)
  })
})

describe('screen-mode: planScreenWindows', () => {
  it('a class with no ends_at lasts 60 minutes', () => {
    const [w] = planScreenWindows({ occurrences: [occ('un1t:1', '2026-10-27T06:00:00Z', null)], config: cfg })
    expect(w.from).toBe('2026-10-27T05:50:00.000Z')
    expect(w.until).toBe('2026-10-27T07:05:00.000Z')
    expect(w.classes).toEqual([
      { id: 'un1t:1', name: 'UN1T Strength', starts_at: '2026-10-27T06:00:00.000Z', ends_at: '2026-10-27T07:00:00.000Z' },
    ])
  })
  it('touching windows merge', () => {
    const ws = planScreenWindows({
      occurrences: [
        occ('un1t:1', '2026-10-27T06:00:00Z', '2026-10-27T06:50:00Z'),
        occ('un1t:2', '2026-10-27T07:00:00Z', '2026-10-27T07:50:00Z'),
      ],
      config: cfg,
    })
    expect(ws).toHaveLength(1)
    expect(ws[0].from).toBe('2026-10-27T05:50:00.000Z')
    expect(ws[0].until).toBe('2026-10-27T07:55:00.000Z')
    expect(ws[0].classes.map((c) => c.id)).toEqual(['un1t:1', 'un1t:2'])
  })
  it('windows that merely touch (until === next from) merge', () => {
    // lead 5/5: the first window ends 06:55, the second begins 06:55
    const c = resolveScreenConfig({ lead_in_min: 5, lead_out_min: 5 })
    const ws = planScreenWindows({
      occurrences: [
        occ('a', '2026-10-27T06:00:00Z', '2026-10-27T06:50:00Z'), // until 06:55
        occ('b', '2026-10-27T07:00:00Z', '2026-10-27T07:50:00Z'), // from 06:55
      ],
      config: c,
    })
    expect(ws).toHaveLength(1)
    expect(ws[0].from).toBe('2026-10-27T05:55:00.000Z')
    expect(ws[0].until).toBe('2026-10-27T07:55:00.000Z')
  })
  it('a gap wider than lead-out plus lead-in stays two windows', () => {
    const ws = planScreenWindows({
      occurrences: [
        occ('un1t:1', '2026-10-27T06:00:00Z', '2026-10-27T06:50:00Z'),
        occ('un1t:2', '2026-10-27T07:30:00Z', '2026-10-27T08:20:00Z'),
      ],
      config: cfg,
    })
    expect(ws).toHaveLength(2)
    expect(ws[0]).toMatchObject({ from: '2026-10-27T05:50:00.000Z', until: '2026-10-27T06:55:00.000Z' })
    expect(ws[1]).toMatchObject({ from: '2026-10-27T07:20:00.000Z', until: '2026-10-27T08:25:00.000Z' })
    expect(ws[0].classes.map((c) => c.id)).toEqual(['un1t:1'])
    expect(ws[1].classes.map((c) => c.id)).toEqual(['un1t:2'])
  })
  it('sorts unsorted input and merges overlapping windows, keeping the latest until', () => {
    const ws = planScreenWindows({
      occurrences: [
        occ('late', '2026-10-27T06:30:00Z', '2026-10-27T06:40:00Z'),
        occ('long', '2026-10-27T06:00:00Z', '2026-10-27T08:00:00Z'),
      ],
      config: cfg,
    })
    expect(ws).toHaveLength(1)
    expect(ws[0].from).toBe('2026-10-27T05:50:00.000Z')
    expect(ws[0].until).toBe('2026-10-27T08:05:00.000Z') // the long class's, not the later-starting one's
    expect(ws[0].classes.map((c) => c.id)).toEqual(['long', 'late'])
  })
  it('class_filter and excluded_slots drop classes before merging', () => {
    // 2026-10-27 is a Tuesday, after the 25 Oct clock change: Dublin = GMT = UTC.
    const c = resolveScreenConfig({ class_filter: ['strength'], excluded_slots: ['Tue 06:00'] })
    const ws = planScreenWindows({
      occurrences: [
        occ('excluded', '2026-10-27T06:00:00Z', '2026-10-27T06:50:00Z', 'UN1T Strength'),
        occ('filtered', '2026-10-27T12:00:00Z', '2026-10-27T12:50:00Z', 'Mobility'),
        occ('kept', '2026-10-27T18:00:00Z', '2026-10-27T18:50:00Z', 'UN1T Strength'),
      ],
      config: c,
    })
    expect(ws).toHaveLength(1)
    expect(ws[0].classes.map((x) => x.id)).toEqual(['kept'])
    expect(ws[0].from).toBe('2026-10-27T17:50:00.000Z')
  })
  it('reads excluded slots in the zone passed in', () => {
    // 06:00Z on 27 Oct is 02:00 in New York (EDT, UTC-4, until 1 Nov).
    const c = resolveScreenConfig({ excluded_slots: ['Tue 02:00'] })
    const o = [occ('x', '2026-10-27T06:00:00Z', '2026-10-27T06:50:00Z')]
    expect(planScreenWindows({ occurrences: o, config: c, zone: 'America/New_York' })).toEqual([])
    expect(planScreenWindows({ occurrences: o, config: c })).toHaveLength(1)
  })
  it('skips rows with no id or an unparseable start, and tolerates junk input', () => {
    const ws = planScreenWindows({
      occurrences: [
        occ(null, '2026-10-27T06:00:00Z', null),
        occ('nostart', null, null),
        occ('badstart', 'nonsense', null),
        occ('ok', '2026-10-27T06:00:00Z', null),
      ],
      config: cfg,
    })
    expect(ws).toHaveLength(1)
    expect(ws[0].classes.map((c) => c.id)).toEqual(['ok'])
    expect(planScreenWindows({ occurrences: null, config: cfg })).toEqual([])
    expect(planScreenWindows({ occurrences: [], config: cfg })).toEqual([])
  })
  it('falls back to 60 minutes for an unparseable or non-positive ends_at', () => {
    const [a] = planScreenWindows({ occurrences: [occ('a', '2026-10-27T06:00:00Z', 'junk')], config: cfg })
    expect(a.classes[0].ends_at).toBe('2026-10-27T07:00:00.000Z')
    const [b] = planScreenWindows({ occurrences: [occ('b', '2026-10-27T06:00:00Z', '2026-10-27T05:00:00Z')], config: cfg })
    expect(b.classes[0].ends_at).toBe('2026-10-27T07:00:00.000Z')
  })
  it('keeps a null name as null', () => {
    const [w] = planScreenWindows({ occurrences: [occ('n', '2026-10-27T06:00:00Z', null, null)], config: cfg })
    expect(w.classes[0].name).toBeNull()
  })
})

describe('screen-mode: modeAt', () => {
  const windows = [{ from: '2026-10-27T05:50:00.000Z', until: '2026-10-27T07:55:00.000Z', classes: [] }]
  const T = Date.parse('2026-10-27T06:30:00Z')

  it('override wins, a lapsed override is ignored, inside a window is class_app', () => {
    expect(modeAt({ windows, override: { mode: 'marketing', until: '2026-10-27T07:00:00Z' } }, T)).toBe('marketing')
    expect(modeAt({ windows, override: { mode: 'marketing', until: '2026-10-27T06:00:00Z' } }, T)).toBe('class_app')
    expect(modeAt({ windows, override: null }, Date.parse('2026-10-27T09:00:00Z'))).toBe('marketing')
  })
  it('an override can force class_app outside any window', () => {
    const at = Date.parse('2026-10-27T09:00:00Z')
    expect(modeAt({ windows, override: { mode: 'class_app', until: '2026-10-27T10:00:00Z' } }, at)).toBe('class_app')
  })
  it('an override with a missing or unparseable until is lapsed', () => {
    expect(modeAt({ windows, override: { mode: 'marketing' } }, T)).toBe('class_app')
    expect(modeAt({ windows, override: { mode: 'marketing', until: 'junk' } }, T)).toBe('class_app')
  })
  it('an override until exactly now has lapsed (until must be > now)', () => {
    expect(modeAt({ windows, override: { mode: 'marketing', until: '2026-10-27T06:30:00Z' } }, T)).toBe('class_app')
  })
  it('an override with an unknown mode is ignored', () => {
    expect(modeAt({ windows, override: { mode: 'blank', until: '2026-10-27T07:00:00Z' } }, T)).toBe('class_app')
  })
  it('window edges: from is inclusive, until is exclusive', () => {
    expect(modeAt({ windows, override: null }, Date.parse(windows[0].from))).toBe('class_app')
    expect(modeAt({ windows, override: null }, Date.parse(windows[0].until))).toBe('marketing')
  })
  it('no windows, no override is marketing', () => {
    expect(modeAt({ windows: [], override: null }, T)).toBe('marketing')
    expect(modeAt({}, T)).toBe('marketing')
  })
})
