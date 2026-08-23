import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveDayWindows } from '@/lib/schedule/desired-state'
import {
  SHELLY_DEVICE_ID,
  MAX_FIXED_WINDOWS,
  MAX_DEVICES_PER_LOCATION,
  MAX_OVERRIDE_HOURS,
  MIN_AUTH_KEY_LENGTH,
  MAX_CLASS_LEAD_LAG_MIN,
  DEFAULT_LEAD_MIN,
  DEFAULT_LAG_MIN,
  ShellyWindow,
  ShellyClassRule,
  ShellyConnectionPut,
  ShellyAdoptBody,
  ShellyDevicePatch,
  ShellyToggleBody,
  ShellyEnergyQuery,
  ShellyOverride,
} from './schemas'

const win = (over = {}) => ({ days: [1], on: '09:00', off: '17:00', ...over })
const rep = (n, c = 'a') => c.repeat(n)
const issuesOf = (r) => r.error?.issues ?? []
const messages = (r) => issuesOf(r).map((i) => i.message)

describe('constants', () => {
  it('are the values every downstream route and page compiles against', () => {
    expect(MAX_FIXED_WINDOWS).toBe(16)
    expect(MAX_DEVICES_PER_LOCATION).toBe(100)
    expect(MAX_OVERRIDE_HOURS).toBe(48)
    expect(MIN_AUTH_KEY_LENGTH).toBe(16)
    expect(MAX_CLASS_LEAD_LAG_MIN).toBe(180)
  })

  it('SHELLY_DEVICE_ID accepts 6..32 hex either case and nothing else', () => {
    expect(SHELLY_DEVICE_ID.test('a1b2c3')).toBe(true)
    expect(SHELLY_DEVICE_ID.test(rep(32, 'f'))).toBe(true)
    expect(SHELLY_DEVICE_ID.test('A1B2C3D4E5F6')).toBe(true)
    expect(SHELLY_DEVICE_ID.test('a1b2c')).toBe(false)
    expect(SHELLY_DEVICE_ID.test(rep(33, 'f'))).toBe(false)
    expect(SHELLY_DEVICE_ID.test('shelly-plug-s')).toBe(false)
  })
})

// The header promises this module never reaches Supabase, next/server or an
// env var, because src/lib/openapi.js imports it to render /api-docs. Nothing
// else in the repo enforces that, and the failure mode is remote (a docs page
// 500ing on a missing env var), so pin the import list itself.
describe('import surface', () => {
  // Every route and openapi.js will import this by its aliased path, never
  // relatively. Same module either way — so a schema swapped in a route is the
  // same object the tests here pin.
  it('resolves identically through the @/ alias a route uses', async () => {
    const viaAlias = await import('@/lib/shelly/schemas')
    expect(viaAlias.ShellyDevicePatch).toBe(ShellyDevicePatch)
    expect(viaAlias.ShellyOverride).toBe(ShellyOverride)
  })

  it('imports only zod, the shared window vocabulary and @/lib/schemas', () => {
    const src = readFileSync(new URL('./schemas.js', import.meta.url), 'utf8')
    const specifiers = [...src.matchAll(/^import[^'"]+from\s+'([^']+)'/gm)].map((m) => m[1])
    expect(specifiers.sort()).toEqual(['@/lib/schedule/windows', '@/lib/schemas', 'zod'])
  })
})

describe('ShellyWindow', () => {
  it('accepts a plain recurring window', () => {
    expect(ShellyWindow.safeParse(win()).success).toBe(true)
  })

  it('accepts an overnight window (off before on)', () => {
    expect(ShellyWindow.safeParse(win({ on: '22:00', off: '02:00' })).success).toBe(true)
  })

  it('rejects a same-boundary window — the engine reads it as 24h always-on', () => {
    const r = ShellyWindow.safeParse(win({ on: '09:00', off: '09:00' }))
    expect(r.success).toBe(false)
    expect(messages(r)).toContain('A window must not start and end at the same time')
  })

  it('bounds days at both edges', () => {
    expect(ShellyWindow.safeParse(win({ days: [1, 7] })).success).toBe(true)
    expect(ShellyWindow.safeParse(win({ days: [0] })).success).toBe(false)
    expect(ShellyWindow.safeParse(win({ days: [8] })).success).toBe(false)
    expect(ShellyWindow.safeParse(win({ days: [] })).success).toBe(false)
  })

  it('rejects a non-HH:MM boundary', () => {
    expect(ShellyWindow.safeParse(win({ on: '24:00' })).success).toBe(false)
    expect(ShellyWindow.safeParse(win({ off: '9:00' })).success).toBe(false)
    expect(ShellyWindow.safeParse(win({ off: '09:60' })).success).toBe(false)
  })
})

describe('ShellyClassRule', () => {
  it('defaults to the engine fallbacks, not zero', () => {
    expect(ShellyClassRule.parse({})).toEqual({ lead_min: DEFAULT_LEAD_MIN, lag_min: DEFAULT_LAG_MIN })
    expect(DEFAULT_LEAD_MIN).toBe(15)
    expect(DEFAULT_LAG_MIN).toBe(10)
  })

  // The whole point of mirroring 15/10 instead of 0/0: a class-mode device
  // whose rule was never opened stores '{}' (mig 562's column default) and
  // runs on the engine's fallbacks. If either side drifts, a PATCH that merely
  // touched class_rule would silently shift every plug by 15 minutes — so
  // prove the two agree by running the real engine over both shapes.
  it('a default-parsed rule resolves the same windows as an absent one', () => {
    const occurrences = [{ starts_at: '2026-08-24T09:00:00.000Z', ends_at: '2026-08-24T10:00:00.000Z' }]
    const base = { enabled: true, schedule_mode: 'class' }
    const absent = resolveDayWindows(base, '2026-08-24', occurrences)
    const defaulted = resolveDayWindows(
      { ...base, class_rule: ShellyClassRule.parse({}) },
      '2026-08-24',
      occurrences,
    )
    expect(defaulted).toEqual(absent)
    expect(defaulted[0].on_at).toBe(Date.parse('2026-08-24T08:45:00.000Z'))
    expect(defaulted[0].off_at).toBe(Date.parse('2026-08-24T10:10:00.000Z'))
  })

  it('accepts an explicit zero — an operator who wants no lead gets no lead', () => {
    expect(ShellyClassRule.parse({ lead_min: 0, lag_min: 0 })).toEqual({ lead_min: 0, lag_min: 0 })
  })

  it('bounds lead and lag at both edges', () => {
    expect(ShellyClassRule.safeParse({ lead_min: 180, lag_min: 180 }).success).toBe(true)
    expect(ShellyClassRule.safeParse({ lead_min: 181 }).success).toBe(false)
    expect(ShellyClassRule.safeParse({ lag_min: 181 }).success).toBe(false)
    expect(ShellyClassRule.safeParse({ lead_min: -1 }).success).toBe(false)
    expect(ShellyClassRule.safeParse({ lag_min: -1 }).success).toBe(false)
  })

  it('rejects a fractional or non-numeric minute', () => {
    expect(ShellyClassRule.safeParse({ lead_min: 7.5 }).success).toBe(false)
    expect(ShellyClassRule.safeParse({ lead_min: '15' }).success).toBe(false)
  })
})

describe('ShellyConnectionPut', () => {
  it('trims the server host', () => {
    const r = ShellyConnectionPut.safeParse({ server: '  shelly-55-eu.shelly.cloud  ' })
    expect(r.success).toBe(true)
    expect(r.data.server).toBe('shelly-55-eu.shelly.cloud')
  })

  it('accepts a missing auth_key — a re-paste keeps the stored one', () => {
    const r = ShellyConnectionPut.safeParse({ server: 'shelly-55-eu.shelly.cloud' })
    expect(r.success).toBe(true)
    expect(r.data.auth_key).toBeUndefined()
  })

  it('accepts a blank auth_key — MIN_AUTH_KEY_LENGTH is the route\'s job, not the schema\'s', () => {
    expect(ShellyConnectionPut.safeParse({ server: 'x', auth_key: '' }).success).toBe(true)
    expect(ShellyConnectionPut.safeParse({ server: 'x', auth_key: 'short' }).success).toBe(true)
  })

  it('bounds server and auth_key at both edges', () => {
    expect(ShellyConnectionPut.safeParse({ server: 'x' }).success).toBe(true)
    expect(ShellyConnectionPut.safeParse({ server: rep(200) }).success).toBe(true)
    expect(ShellyConnectionPut.safeParse({ server: rep(201) }).success).toBe(false)
    expect(ShellyConnectionPut.safeParse({ server: '' }).success).toBe(false)
    expect(ShellyConnectionPut.safeParse({ server: '   ' }).success).toBe(false)
    expect(ShellyConnectionPut.safeParse({ server: 'x', auth_key: rep(512) }).success).toBe(true)
    expect(ShellyConnectionPut.safeParse({ server: 'x', auth_key: rep(513) }).success).toBe(false)
  })

  it('requires a server', () => {
    expect(ShellyConnectionPut.safeParse({ auth_key: rep(20) }).success).toBe(false)
  })
})

describe('ShellyAdoptBody', () => {
  it('lowercases a pasted upper-case device id (the DB CHECK demands lower)', () => {
    const r = ShellyAdoptBody.safeParse({ device_id: '  A1B2C3D4E5F6  ' })
    expect(r.success).toBe(true)
    expect(r.data.device_id).toBe('a1b2c3d4e5f6')
  })

  it('defaults channel to 0', () => {
    expect(ShellyAdoptBody.parse({ device_id: 'a1b2c3d4e5f6' }).channel).toBe(0)
  })

  it('bounds the device id at both edges', () => {
    expect(ShellyAdoptBody.safeParse({ device_id: 'a1b2c3' }).success).toBe(true)
    expect(ShellyAdoptBody.safeParse({ device_id: rep(32, 'f') }).success).toBe(true)
    expect(ShellyAdoptBody.safeParse({ device_id: 'a1b2c' }).success).toBe(false)
    expect(ShellyAdoptBody.safeParse({ device_id: rep(33, 'f') }).success).toBe(false)
  })

  it('rejects a non-hex device id', () => {
    expect(ShellyAdoptBody.safeParse({ device_id: 'shellyplug' }).success).toBe(false)
    expect(ShellyAdoptBody.safeParse({ device_id: 'a1b2c3d4e5g6' }).success).toBe(false)
    expect(ShellyAdoptBody.safeParse({ device_id: 'a1b2-c3d4' }).success).toBe(false)
    expect(ShellyAdoptBody.safeParse({ device_id: '' }).success).toBe(false)
  })

  it('bounds channel at both edges — 8 is rejected', () => {
    expect(ShellyAdoptBody.safeParse({ device_id: 'a1b2c3', channel: 0 }).success).toBe(true)
    expect(ShellyAdoptBody.safeParse({ device_id: 'a1b2c3', channel: 7 }).success).toBe(true)
    expect(ShellyAdoptBody.safeParse({ device_id: 'a1b2c3', channel: 8 }).success).toBe(false)
    expect(ShellyAdoptBody.safeParse({ device_id: 'a1b2c3', channel: -1 }).success).toBe(false)
    expect(ShellyAdoptBody.safeParse({ device_id: 'a1b2c3', channel: 1.5 }).success).toBe(false)
  })

  it('bounds an optional name at both edges', () => {
    expect(ShellyAdoptBody.safeParse({ device_id: 'a1b2c3', name: 'x' }).success).toBe(true)
    expect(ShellyAdoptBody.safeParse({ device_id: 'a1b2c3', name: rep(80) }).success).toBe(true)
    expect(ShellyAdoptBody.safeParse({ device_id: 'a1b2c3', name: rep(81) }).success).toBe(false)
    expect(ShellyAdoptBody.safeParse({ device_id: 'a1b2c3', name: '   ' }).success).toBe(false)
  })
})

describe('ShellyDevicePatch', () => {
  it('accepts a single field', () => {
    expect(ShellyDevicePatch.safeParse({ enabled: false }).success).toBe(true)
    expect(ShellyDevicePatch.safeParse({ schedule_mode: 'class' }).success).toBe(true)
  })

  it('refuses an empty body rather than issuing a no-op UPDATE that reports success', () => {
    const r = ShellyDevicePatch.safeParse({})
    expect(r.success).toBe(false)
    expect(messages(r)).toContain('Nothing to update')
  })

  it('rejects an unknown key (strict) so a typo is a 400, not a silently ignored setting', () => {
    const r = ShellyDevicePatch.safeParse({ enabled: true, scheduel_mode: 'fixed' })
    expect(r.success).toBe(false)
    expect(issuesOf(r).some((i) => i.code === 'unrecognized_keys')).toBe(true)
  })

  it('rejects a schedule_mode outside the DB CHECK', () => {
    expect(ShellyDevicePatch.safeParse({ schedule_mode: 'auto' }).success).toBe(false)
  })

  it('bounds name and zone at both edges', () => {
    expect(ShellyDevicePatch.safeParse({ name: 'x' }).success).toBe(true)
    expect(ShellyDevicePatch.safeParse({ name: rep(80) }).success).toBe(true)
    expect(ShellyDevicePatch.safeParse({ name: rep(81) }).success).toBe(false)
    expect(ShellyDevicePatch.safeParse({ name: '  ' }).success).toBe(false)
    expect(ShellyDevicePatch.safeParse({ zone: 'x' }).success).toBe(true)
    expect(ShellyDevicePatch.safeParse({ zone: rep(40) }).success).toBe(true)
    expect(ShellyDevicePatch.safeParse({ zone: rep(41) }).success).toBe(false)
    expect(ShellyDevicePatch.safeParse({ zone: '  ' }).success).toBe(false)
  })

  it('trims name and zone', () => {
    const r = ShellyDevicePatch.safeParse({ name: '  Studio fan  ', zone: '  Main floor  ' })
    expect(r.success).toBe(true)
    expect(r.data).toEqual({ name: 'Studio fan', zone: 'Main floor' })
  })

  it('accepts an empty fixed_windows array (clearing the schedule is a real edit)', () => {
    const r = ShellyDevicePatch.safeParse({ fixed_windows: [] })
    expect(r.success).toBe(true)
    expect(r.data.fixed_windows).toEqual([])
  })

  it('accepts exactly MAX_FIXED_WINDOWS non-overlapping windows and rejects 17', () => {
    // Half-hour slots on the hour, all on Monday: 16 windows, none touching.
    const slot = (h) => win({ days: [1], on: `${String(h).padStart(2, '0')}:00`, off: `${String(h).padStart(2, '0')}:30` })
    const sixteen = Array.from({ length: MAX_FIXED_WINDOWS }, (_, i) => slot(i))
    expect(sixteen).toHaveLength(MAX_FIXED_WINDOWS)
    expect(ShellyDevicePatch.safeParse({ fixed_windows: sixteen }).success).toBe(true)

    // The 17th does not overlap either — the only thing wrong with it is the cap.
    const seventeen = [...sixteen, slot(MAX_FIXED_WINDOWS)]
    const r = ShellyDevicePatch.safeParse({ fixed_windows: seventeen })
    expect(r.success).toBe(false)
    expect(issuesOf(r).some((i) => i.code === 'too_big')).toBe(true)
  })

  it('rejects a same-boundary window inside the array, at that window\'s path', () => {
    const r = ShellyDevicePatch.safeParse({ fixed_windows: [win(), win({ on: '12:00', off: '12:00' })] })
    expect(r.success).toBe(false)
    const issue = issuesOf(r).find((i) => i.message === 'A window must not start and end at the same time')
    expect(issue).toBeTruthy()
    expect(issue.path).toEqual(['fixed_windows', 1])
  })

  it('rejects overlapping windows on a shared day, at the fixed_windows path', () => {
    const r = ShellyDevicePatch.safeParse({
      fixed_windows: [win({ days: [1, 2], on: '09:00', off: '17:00' }), win({ days: [2], on: '16:00', off: '18:00' })],
    })
    expect(r.success).toBe(false)
    const issue = issuesOf(r).find((i) => i.message.startsWith('Windows overlap on the same day'))
    expect(issue).toBeTruthy()
    expect(issue.message).toBe('Windows overlap on the same day: 09:00-17:00 and 16:00-18:00')
    expect(issue.path).toEqual(['fixed_windows'])
  })

  it('allows windows that only touch at a boundary, and ones on different days', () => {
    expect(ShellyDevicePatch.safeParse({
      fixed_windows: [win({ on: '07:00', off: '12:00' }), win({ on: '12:00', off: '21:30' })],
    }).success).toBe(true)
    expect(ShellyDevicePatch.safeParse({
      fixed_windows: [win({ days: [1], on: '09:00', off: '17:00' }), win({ days: [2], on: '09:00', off: '17:00' })],
    }).success).toBe(true)
  })

  it('applies the class-rule defaults through the patch', () => {
    const r = ShellyDevicePatch.safeParse({ schedule_mode: 'class', class_rule: {} })
    expect(r.success).toBe(true)
    expect(r.data.class_rule).toEqual({ lead_min: DEFAULT_LEAD_MIN, lag_min: DEFAULT_LAG_MIN })
  })

  it('rejects an out-of-range class rule through the patch', () => {
    expect(ShellyDevicePatch.safeParse({ class_rule: { lead_min: 181 } }).success).toBe(false)
  })
})

describe('ShellyToggleBody', () => {
  it('accepts auto with no until', () => {
    const r = ShellyToggleBody.safeParse({ state: 'auto' })
    expect(r.success).toBe(true)
    expect(r.data.until).toBeUndefined()
  })

  it('accepts on and off with an ISO until', () => {
    expect(ShellyToggleBody.safeParse({ state: 'on', until: '2026-08-23T18:00:00.000Z' }).success).toBe(true)
    expect(ShellyToggleBody.safeParse({ state: 'off', until: '2026-08-23T18:00:00Z' }).success).toBe(true)
  })

  it('rejects a non-ISO until', () => {
    expect(ShellyToggleBody.safeParse({ state: 'on', until: 'tomorrow' }).success).toBe(false)
    expect(ShellyToggleBody.safeParse({ state: 'on', until: '2026-08-23' }).success).toBe(false)
    expect(ShellyToggleBody.safeParse({ state: 'on', until: 1787000000000 }).success).toBe(false)
  })

  it('rejects a state outside the three verbs', () => {
    expect(ShellyToggleBody.safeParse({ state: 'ON' }).success).toBe(false)
    expect(ShellyToggleBody.safeParse({ state: true }).success).toBe(false)
    expect(ShellyToggleBody.safeParse({}).success).toBe(false)
  })
})

describe('ShellyEnergyQuery', () => {
  it('coerces a query-string number', () => {
    expect(ShellyEnergyQuery.parse({ days: '7' })).toEqual({ days: 7 })
  })

  it('defaults to 30 when days is absent', () => {
    expect(ShellyEnergyQuery.parse({})).toEqual({ days: 30 })
    expect(ShellyEnergyQuery.parse({ days: undefined })).toEqual({ days: 30 })
  })

  it('bounds days at both edges', () => {
    expect(ShellyEnergyQuery.safeParse({ days: '1' }).success).toBe(true)
    expect(ShellyEnergyQuery.safeParse({ days: '90' }).success).toBe(true)
    expect(ShellyEnergyQuery.safeParse({ days: '0' }).success).toBe(false)
    expect(ShellyEnergyQuery.safeParse({ days: '91' }).success).toBe(false)
    expect(ShellyEnergyQuery.safeParse({ days: '7.5' }).success).toBe(false)
  })

  it('rejects junk rather than silently defaulting', () => {
    expect(ShellyEnergyQuery.safeParse({ days: 'all' }).success).toBe(false)
    // The route must map an absent search param (null) to undefined — coercion
    // turns null into 0, which is out of range. This pins that obligation.
    expect(ShellyEnergyQuery.safeParse({ days: null }).success).toBe(false)
  })
})

describe('ShellyOverride', () => {
  const valid = {
    state: 'off',
    until: '2026-08-23T18:00:00.000Z',
    set_by: '11111111-2222-3333-4444-555555555555',
    set_at: '2026-08-23T09:00:00.000Z',
  }

  it('accepts the shape the toggle route writes', () => {
    expect(ShellyOverride.safeParse(valid).success).toBe(true)
  })

  it('rejects a missing set_at — it IS the exactly-once key in overrideKey()', () => {
    const { set_at: _drop, ...withoutSetAt } = valid
    const r = ShellyOverride.safeParse(withoutSetAt)
    expect(r.success).toBe(false)
    expect(issuesOf(r).some((i) => i.path.join('.') === 'set_at')).toBe(true)
  })

  it('rejects a non-ISO set_at or until', () => {
    expect(ShellyOverride.safeParse({ ...valid, set_at: 'now' }).success).toBe(false)
    expect(ShellyOverride.safeParse({ ...valid, until: 'tomorrow' }).success).toBe(false)
  })

  it('rejects a state that is not exactly on or off', () => {
    expect(ShellyOverride.safeParse({ ...valid, state: true }).success).toBe(false)
    expect(ShellyOverride.safeParse({ ...valid, state: 'auto' }).success).toBe(false)
    expect(ShellyOverride.safeParse({ ...valid, state: 'ON' }).success).toBe(false)
    expect(ShellyOverride.safeParse({ ...valid, state: 'off ' }).success).toBe(false)
  })

  it('rejects a set_by that is not uuid-shaped', () => {
    expect(ShellyOverride.safeParse({ ...valid, set_by: 'system' }).success).toBe(false)
    expect(ShellyOverride.safeParse({ ...valid, set_by: '' }).success).toBe(false)
  })
})
