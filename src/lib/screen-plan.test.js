import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/location-time', async (importOriginal) => ({
  ...(await importOriginal()),
  getLocationZone: vi.fn(),
}))

import { buildScreenPlan, expectedModesFor, SCREEN_DEVICE_COLUMNS } from './screen-plan.js'
import { getLocationZone, LocationZoneReadError } from '@/lib/location-time'
import { PLAN_LOOKBACK_MS, PLAN_LOOKAHEAD_MS } from '@/lib/screen-mode'
import { makeFakeDb, readsOf } from './tv-admin.test-helpers.js'

const LOC = 'a0000000-0000-4000-8000-0000000000a1'
const LOC_2 = 'a0000000-0000-4000-8000-0000000000a2'
const DISPLAY = 'e0000000-0000-4000-8000-0000000000e1'
const T = Date.parse('2026-10-24T17:00:00.000Z')
const MIN = 60_000

const DEVICE = {
  device_name: 'hatch-screen1', role: 'screen', location_id: LOC,
  tv_display_id: DISPLAY, override_mode: null, override_until: null,
}

const CLASS_A = { glofox_event_id: 'ev-1', name: 'Hyrox', starts_at: '2026-10-24T17:30:00.000Z', ends_at: '2026-10-24T18:30:00.000Z' }
// Starts as CLASS_A's tail window closes (18:30 + 5 min out vs 18:35 - 10 min in): merges.
const CLASS_B = { glofox_event_id: 'ev-2', name: 'Strength', starts_at: '2026-10-24T18:45:00.000Z', ends_at: '2026-10-24T19:45:00.000Z' }

const AUTOMATION = {
  location_id: LOC,
  enabled: true,
  config: {
    device_names: ['hatch-screen1', 'hatch-screen2'],
    class_app_package: 'com.hatch.classes',
    lead_in_min: 10, lead_out_min: 5,
    class_filter: [], excluded_slots: [],
    stale_plan_mode: 'marketing',
  },
}

const DISPLAY_ROW = { id: DISPLAY, token: 'tok-1', active: true, location_id: LOC }

// answers keyed on table; a value of { error } is a failed read
function makeDb(over = {}) {
  const answers = {
    location_automations: { data: AUTOMATION, error: null },
    class_occurrences: { data: [CLASS_A, CLASS_B], error: null },
    tv_displays: { data: DISPLAY_ROW, error: null },
    ...over,
  }
  return makeFakeDb((call) => {
    const a = answers[call.table]
    return typeof a === 'function' ? a(call) : a
  })
}

const failed = (message) => ({ data: null, error: { message } })

beforeEach(() => {
  vi.clearAllMocks()
  getLocationZone.mockResolvedValue('Europe/Dublin')
})

describe('SCREEN_DEVICE_COLUMNS', () => {
  it('names the six columns the endpoint selects', () => {
    expect(SCREEN_DEVICE_COLUMNS).toBe('device_name, role, location_id, tv_display_id, override_mode, override_until')
  })
})

describe('buildScreenPlan', () => {
  it('builds merged windows, the cast URL and the poll cadence', async () => {
    const db = makeDb()
    const plan = await buildScreenPlan(db, DEVICE, { nowMs: T })
    expect(plan.ok).toBe(true)
    expect(plan.poll_seconds).toBe(600)
    expect(plan.cast_url).toBe('https://crm.test/tv/cast/tok-1?kiosk=1')
    expect(plan.timezone).toBe('Europe/Dublin')
    expect(plan.class_app_package).toBe('com.hatch.classes')
    expect(plan.stale_plan_mode).toBe('marketing')
    expect(plan.server_now).toBe('2026-10-24T17:00:00.000Z')
    expect(plan.generated_at).toBe('2026-10-24T17:00:00.000Z')
    expect(plan.override).toBeNull()
    expect(plan.degraded).toBeUndefined()
    expect(plan.windows).toHaveLength(1)
    expect(plan.windows[0].from).toBe('2026-10-24T17:20:00.000Z')
    expect(plan.windows[0].until).toBe('2026-10-24T19:50:00.000Z')
    expect(plan.windows[0].classes.map((c) => c.id)).toEqual(['ev-1', 'ev-2'])
  })

  it('reads the automation row and the occurrences scoped to the device studio and window', async () => {
    const db = makeDb()
    await buildScreenPlan(db, DEVICE, { nowMs: T })

    const [auto] = readsOf(db, 'location_automations')
    expect(auto.filters).toEqual([['eq', 'location_id', LOC], ['eq', 'automation_key', 'screen_mode']])

    const [occ] = readsOf(db, 'class_occurrences')
    expect(occ.columns).toBe('glofox_event_id, name, starts_at, ends_at')
    expect(occ.filters).toEqual([
      ['eq', 'location_id', LOC],
      ['is', 'cancelled_at', null],
      ['gte', 'starts_at', new Date(T - PLAN_LOOKBACK_MS).toISOString()],
      ['lte', 'starts_at', new Date(T + PLAN_LOOKAHEAD_MS).toISOString()],
    ])
    expect(occ.order).toEqual(['starts_at', { ascending: true }])
  })

  it('reads in order: automation, zone, occurrences, display', async () => {
    const db = makeDb()
    getLocationZone.mockImplementation(async () => {
      db.calls.push({ table: 'zone-marker', op: 'select' })
      return 'Europe/Dublin'
    })
    await buildScreenPlan(db, DEVICE, { nowMs: T })
    expect(db.calls.map((c) => c.table)).toEqual(['location_automations', 'zone-marker', 'class_occurrences', 'tv_displays'])
  })

  it('a device not in device_names gets no windows but still the package name', async () => {
    const db = makeDb()
    const plan = await buildScreenPlan(db, { ...DEVICE, device_name: 'hatch-screen9' }, { nowMs: T })
    expect(plan.windows).toEqual([])
    expect(plan.class_app_package).toBe('com.hatch.classes')
    expect(plan.degraded).toBeUndefined()
    expect(readsOf(db, 'class_occurrences')).toHaveLength(0)
  })

  it('a disabled automation gives no windows, still echoes the package, and still returns the cast URL', async () => {
    const db = makeDb({ location_automations: { data: { ...AUTOMATION, enabled: false }, error: null } })
    const plan = await buildScreenPlan(db, DEVICE, { nowMs: T })
    expect(plan.windows).toEqual([])
    expect(plan.class_app_package).toBe('com.hatch.classes')
    expect(plan.cast_url).toBe('https://crm.test/tv/cast/tok-1?kiosk=1')
    expect(readsOf(db, 'class_occurrences')).toHaveLength(0)
    expect(getLocationZone).not.toHaveBeenCalled()
  })

  it('an absent automation gives no windows, a null package and the default stale mode', async () => {
    const db = makeDb({ location_automations: { data: null, error: null } })
    const plan = await buildScreenPlan(db, DEVICE, { nowMs: T })
    expect(plan.windows).toEqual([])
    expect(plan.class_app_package).toBeNull()
    expect(plan.stale_plan_mode).toBe('class_app')
    expect(plan.degraded).toBeUndefined()
  })

  it('reads the display scoped to its id and the device studio', async () => {
    const db = makeDb()
    await buildScreenPlan(db, DEVICE, { nowMs: T })
    const [disp] = readsOf(db, 'tv_displays')
    expect(disp.columns).toBe('id, token, active, location_id')
    expect(disp.filters).toEqual([['eq', 'id', DISPLAY], ['eq', 'location_id', LOC]])
  })

  it('a display at another studio (not found under the studio filter) yields cast_url null', async () => {
    const db = makeDb({ tv_displays: { data: null, error: null } })
    const plan = await buildScreenPlan(db, DEVICE, { nowMs: T })
    expect(plan.cast_url).toBeNull()
    expect(plan.degraded).toBeUndefined()
  })

  it('an inactive display yields cast_url null', async () => {
    const db = makeDb({ tv_displays: { data: { ...DISPLAY_ROW, active: false }, error: null } })
    const plan = await buildScreenPlan(db, DEVICE, { nowMs: T })
    expect(plan.cast_url).toBeNull()
  })

  it('a display row that names another studio is refused even if the filter let it through', async () => {
    const db = makeDb({ tv_displays: { data: { ...DISPLAY_ROW, location_id: LOC_2 }, error: null } })
    const plan = await buildScreenPlan(db, DEVICE, { nowMs: T })
    expect(plan.cast_url).toBeNull()
  })

  it('a device with no display skips the read and gets cast_url null', async () => {
    const db = makeDb()
    const plan = await buildScreenPlan(db, { ...DEVICE, tv_display_id: null }, { nowMs: T })
    expect(plan.cast_url).toBeNull()
    expect(readsOf(db, 'tv_displays')).toHaveLength(0)
  })

  it('a failed display read gives cast_url null and degraded display_unreadable, windows intact', async () => {
    const db = makeDb({ tv_displays: failed('boom') })
    const plan = await buildScreenPlan(db, DEVICE, { nowMs: T })
    expect(plan.ok).toBe(true)
    expect(plan.cast_url).toBeNull()
    expect(plan.degraded).toBe('display_unreadable')
    expect(plan.windows).toHaveLength(1)
  })

  it('a lapsed override is omitted; a live one is returned', async () => {
    const lapsed = await buildScreenPlan(makeDb(), {
      ...DEVICE, override_mode: 'marketing', override_until: new Date(T - MIN).toISOString(),
    }, { nowMs: T })
    expect(lapsed.override).toBeNull()

    const exactlyNow = await buildScreenPlan(makeDb(), {
      ...DEVICE, override_mode: 'marketing', override_until: new Date(T).toISOString(),
    }, { nowMs: T })
    expect(exactlyNow.override).toBeNull()

    const until = new Date(T + 30 * MIN).toISOString()
    const live = await buildScreenPlan(makeDb(), {
      ...DEVICE, override_mode: 'marketing', override_until: until,
    }, { nowMs: T })
    expect(live.override).toEqual({ mode: 'marketing', until })

    const noMode = await buildScreenPlan(makeDb(), {
      ...DEVICE, override_mode: null, override_until: until,
    }, { nowMs: T })
    expect(noMode.override).toBeNull()
  })

  it('an unreadable zone degrades instead of guessing', async () => {
    getLocationZone.mockRejectedValue(new LocationZoneReadError([LOC], new Error('x')))
    const db = makeDb()
    const plan = await buildScreenPlan(db, DEVICE, { nowMs: T })
    expect(plan.ok).toBe(true)
    expect(plan.degraded).toBe('zone_unreadable')
    expect(plan.windows).toEqual([])
    expect(plan.timezone).toBeNull()
    expect(plan.class_app_package).toBe('com.hatch.classes')
    expect(plan.cast_url).toBe('https://crm.test/tv/cast/tok-1?kiosk=1')
  })

  it('a zone failure that is not a LocationZoneReadError still throws', async () => {
    getLocationZone.mockRejectedValue(new TypeError('bug'))
    await expect(buildScreenPlan(makeDb(), DEVICE, { nowMs: T })).rejects.toThrow('bug')
  })

  it('a failed automation read degrades with no windows and still serves the display', async () => {
    const db = makeDb({ location_automations: failed('boom') })
    const plan = await buildScreenPlan(db, DEVICE, { nowMs: T })
    expect(plan.ok).toBe(true)
    expect(plan.degraded).toBe('automation_unreadable')
    expect(plan.windows).toEqual([])
    expect(plan.class_app_package).toBeNull()
    expect(plan.cast_url).toBe('https://crm.test/tv/cast/tok-1?kiosk=1')
    expect(readsOf(db, 'class_occurrences')).toHaveLength(0)
  })

  it('a failed occurrences read degrades with no windows but keeps the zone', async () => {
    const db = makeDb({ class_occurrences: failed('boom') })
    const plan = await buildScreenPlan(db, DEVICE, { nowMs: T })
    expect(plan.ok).toBe(true)
    expect(plan.degraded).toBe('occurrences_unreadable')
    expect(plan.windows).toEqual([])
    expect(plan.timezone).toBe('Europe/Dublin')
  })

  it('degraded keeps the first failure met', async () => {
    getLocationZone.mockRejectedValue(new LocationZoneReadError([LOC], new Error('x')))
    const db = makeDb({ tv_displays: failed('boom') })
    const plan = await buildScreenPlan(db, DEVICE, { nowMs: T })
    expect(plan.degraded).toBe('zone_unreadable')
    expect(plan.cast_url).toBeNull()
  })

  it('excluded_slots are matched in the studio zone', async () => {
    getLocationZone.mockResolvedValue('Europe/Dublin')
    // Sat 24 Oct 2026 17:30Z is 18:30 in Dublin (IST ended 25 Oct) -> "Sat 18:30"
    const db = makeDb({
      location_automations: {
        data: { ...AUTOMATION, config: { ...AUTOMATION.config, excluded_slots: ['Sat 18:30'] } },
        error: null,
      },
    })
    const plan = await buildScreenPlan(db, DEVICE, { nowMs: T })
    expect(plan.windows.map((w) => w.classes.map((c) => c.id))).toEqual([['ev-2']])
  })
})

describe('expectedModesFor', () => {
  const D1 = { ...DEVICE, device_name: 'hatch-screen1' }
  const D2 = { ...DEVICE, device_name: 'hatch-screen2', override_mode: 'class_app', override_until: new Date(T + 30 * MIN).toISOString() }
  const OTHER = { ...DEVICE, device_name: 'other-screen', location_id: LOC_2, tv_display_id: null }
  const UNLISTED = { ...DEVICE, device_name: 'hatch-screen9' }

  const NOW_IN_CLASS = Date.parse('2026-10-24T17:40:00.000Z')

  it('answers per device from one read per studio', async () => {
    const db = makeDb({
      location_automations: (call) => {
        const loc = call.filters.find((f) => f[1] === 'location_id')[2]
        return loc === LOC
          ? { data: AUTOMATION, error: null }
          : { data: { ...AUTOMATION, location_id: LOC_2, enabled: false }, error: null }
      },
    })
    const modes = await expectedModesFor(db, [D1, D2, UNLISTED, OTHER], { nowMs: NOW_IN_CLASS })

    expect(modes.get('hatch-screen1')).toBe('class_app')
    expect(modes.get('hatch-screen2')).toBe('class_app')
    expect(modes.get('hatch-screen9')).toBe('marketing') // not listed: never gets windows
    expect(modes.get('other-screen')).toBeNull() // disabled at that studio

    expect(readsOf(db, 'location_automations')).toHaveLength(2)
    const occ = readsOf(db, 'class_occurrences')
    expect(occ).toHaveLength(1)
    expect(occ[0].filters[0]).toEqual(['eq', 'location_id', LOC])
    expect(readsOf(db, 'tv_displays')).toHaveLength(0)
  })

  it("applies each device's own override", async () => {
    const quiet = Date.parse('2026-10-24T12:00:00.000Z')
    const db = makeDb()
    const modes = await expectedModesFor(
      db,
      [
        { ...D1 },
        { ...D2, override_until: new Date(quiet + 30 * MIN).toISOString(), override_mode: 'class_app' },
      ],
      { nowMs: quiet },
    )
    expect(modes.get('hatch-screen1')).toBe('marketing')
    expect(modes.get('hatch-screen2')).toBe('class_app')
  })

  it('is null for a studio with no automation row', async () => {
    const db = makeDb({ location_automations: { data: null, error: null } })
    const modes = await expectedModesFor(db, [D1, D2], { nowMs: NOW_IN_CLASS })
    expect(modes.get('hatch-screen1')).toBeNull()
    expect(modes.get('hatch-screen2')).toBeNull()
    expect(readsOf(db, 'class_occurrences')).toHaveLength(0)
  })

  it('is null for every device at a studio whose reads failed, without throwing', async () => {
    const autoFail = await expectedModesFor(makeDb({ location_automations: failed('x') }), [D1, D2], { nowMs: NOW_IN_CLASS })
    expect([...autoFail.values()]).toEqual([null, null])

    const occFail = await expectedModesFor(makeDb({ class_occurrences: failed('x') }), [D1, D2], { nowMs: NOW_IN_CLASS })
    expect([...occFail.values()]).toEqual([null, null])

    getLocationZone.mockRejectedValue(new LocationZoneReadError([LOC], new Error('x')))
    const zoneFail = await expectedModesFor(makeDb(), [D1, D2], { nowMs: NOW_IN_CLASS })
    expect([...zoneFail.values()]).toEqual([null, null])
  })

  it('an empty device list reads nothing', async () => {
    const db = makeDb()
    const modes = await expectedModesFor(db, [], { nowMs: NOW_IN_CLASS })
    expect(modes.size).toBe(0)
    expect(db.calls).toHaveLength(0)
  })
})
