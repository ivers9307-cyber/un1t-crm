// climate-sonos.tz.test.js — TZ.10. Sonos windows, the Sonos health check and
// "off until midnight", and the class/bathroom-climate excluded-slot keys follow
// each studio's own timezone. Shelly already did (SHELLY.1/.2); its files only
// changed imports.
//
//   • Europe/Dublin: pinned by fixed values around both 2026 EU DST changes.
//     The byte-identity sweep against a frozen pre-change copy ran in TZ.10
//     and was retired in TZ.18b; zoned-time ≡ dublin-time stays proven by
//     shared/zoned-time.parity.test.js.
//   • America/New_York: the studio's own clock across both 2026 US DST changes.
//   • A failed locations.timezone read skips the location for the tick, logged,
//     before ANY device call. Never a guessed zone.
process.env.TZ = 'America/Los_Angeles' // host zone is none of the zones under test: proves nothing reads the host clock
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { planAction } = await import('./sonos/groups.js')
const { runSonosReconcile } = await import('./sonos/reconcile.js')
const { resolveServeWindows, resolveDayWindows, desiredState } = await import('./schedule/desired-state.js')
const { slotKey, planClassClimate } = await import('./class-climate.js')
const { planBathroomClimate } = await import('./bathroom-climate.js')
const { describeClass } = await import('./fleet-health.js')
const { scheduleHealth, untilMidnightTonightIso, fmtScheduleTime } = await import('../components/automations/SonosScheduleClient.jsx')
const { resetLocationZoneCache, dayStrIn } = await import('./location-time.js')
const { logWarn } = await import('@/lib/log')

const D = 'Europe/Dublin'
const NY = 'America/New_York'
// US DST 2026: spring forward Sun 8 Mar 02:00 → 03:00; fall back Sun 1 Nov 02:00 → 01:00.
// EU DST 2026: spring forward Sun 29 Mar 01:00Z; fall back Sun 25 Oct 01:00Z.
// Windows that exercise every boundary class: plain, overnight, a 23:xx edge
// (the SHELLY.2 class), a 00:00 start, and an overnight span into 01:30.
const WINDOWS = [
  { days: [1, 2, 3, 4, 5], on: '06:00', off: '21:30', volume: 35, favorite_id: 'fv-1' },
  { days: [6], on: '22:00', off: '02:00', volume: 20, favorite_id: 'fv-2' },
  { days: [7], on: '23:15', off: '23:45', volume: 25, favorite_id: 'fv-3' },
  { days: [3], on: '00:00', off: '01:30', volume: 15, favorite_id: 'fv-4' },
]
const schedule = (over = {}) => ({
  id: 's1', location_id: 'loc-1', enabled: true, player_ids: ['RINCON_1'],
  windows: WINDOWS, override: null, last_applied: null, last_state: null, ...over,
})

const fixedDevice = { enabled: true, schedule_mode: 'fixed', fixed_windows: WINDOWS }
const spans = (ws) => ws.map((w) => [new Date(w.on_at).toISOString(), new Date(w.off_at).toISOString(), w.source?.favorite_id])
const iso = (t) => new Date(t).toISOString()

describe('TZ.10 Europe/Dublin pinned values', () => {
  it('the engine: serve windows on both DST weekends and an ordinary summer/winter day (zone omitted = Dublin)', () => {
    const SAT_SPRING = ['2026-03-28T22:00:00.000Z', '2026-03-29T01:00:00.000Z', 'fv-2'] // 22:00 GMT → 02:00 IST
    const SAT_FALL = ['2026-10-24T21:00:00.000Z', '2026-10-25T02:00:00.000Z', 'fv-2'] //  22:00 IST → 02:00 GMT
    const cases = [
      ['2026-03-28', [SAT_SPRING]],
      ['2026-03-29', [SAT_SPRING, ['2026-03-29T22:15:00.000Z', '2026-03-29T22:45:00.000Z', 'fv-3']]],
      ['2026-10-24', [SAT_FALL]],
      ['2026-10-25', [SAT_FALL, ['2026-10-25T23:15:00.000Z', '2026-10-25T23:45:00.000Z', 'fv-3']]],
      ['2026-07-01', [['2026-06-30T23:00:00.000Z', '2026-07-01T00:30:00.000Z', 'fv-4'], ['2026-07-01T05:00:00.000Z', '2026-07-01T20:30:00.000Z', 'fv-1']]],
      ['2026-12-30', [['2026-12-30T00:00:00.000Z', '2026-12-30T01:30:00.000Z', 'fv-4'], ['2026-12-30T06:00:00.000Z', '2026-12-30T21:30:00.000Z', 'fv-1']]],
    ]
    for (const [day, want] of cases) {
      for (const tz of [D, undefined, null, '']) expect(spans(resolveServeWindows(fixedDevice, day, [], tz))).toEqual(want)
    }
    // The day's own windows (no spill from the night before).
    expect(spans(resolveDayWindows(fixedDevice, '2026-03-29', [], D))).toEqual([['2026-03-29T22:15:00.000Z', '2026-03-29T22:45:00.000Z', 'fv-3']])
    expect(spans(resolveDayWindows(fixedDevice, '2026-10-25', [], D))).toEqual([['2026-10-25T23:15:00.000Z', '2026-10-25T23:45:00.000Z', 'fv-3']])
    expect(spans(resolveDayWindows(fixedDevice, '2026-10-24', [], undefined))).toEqual([SAT_FALL])
  })

  it('planAction with the Dublin day and zone', () => {
    const plan = (s, at) => {
      const t = Date.parse(at)
      const a = planAction(s, t, dayStrIn(t, D), D)
      return a && { ...a, windowOnAt: iso(a.windowOnAt) }
    }
    const applied = schedule({ last_applied: { window_on_at: 0, action: 'open' } })
    const overridden = schedule({ override: { state: 'off', until: '2026-07-01T00:00:00Z' } })
    // Spring-forward night: the Saturday window is open at 01:30 IST, closed by 02:30 IST.
    expect(plan(schedule(), '2026-03-29T00:30:00Z')).toEqual({ action: 'open', windowOnAt: '2026-03-28T22:00:00.000Z', volume: 20, favoriteId: 'fv-2' })
    expect(plan(schedule(), '2026-03-29T01:30:00Z')).toBeNull()
    expect(plan(applied, '2026-03-29T01:30:00Z')).toEqual({ action: 'close', windowOnAt: '1970-01-01T00:00:00.000Z' })
    expect(plan(overridden, '2026-03-29T00:30:00Z')).toBeNull()
    // Sunday 23:15 IST.
    expect(plan(schedule(), '2026-03-29T22:30:00Z')).toEqual({ action: 'open', windowOnAt: '2026-03-29T22:15:00.000Z', volume: 25, favoriteId: 'fv-3' })
    // Fall-back night: still open at 01:30 GMT, closed at 02:30 GMT.
    expect(plan(schedule(), '2026-10-25T01:30:00Z')).toEqual({ action: 'open', windowOnAt: '2026-10-24T21:00:00.000Z', volume: 20, favoriteId: 'fv-2' })
    expect(plan(applied, '2026-10-25T02:30:00Z')).toEqual({ action: 'close', windowOnAt: '1970-01-01T00:00:00.000Z' })
    // Ordinary summer (06:00 IST) and winter (06:00 GMT) weekday opens.
    expect(plan(schedule(), '2026-07-01T05:00:00Z')).toEqual({ action: 'open', windowOnAt: '2026-07-01T05:00:00.000Z', volume: 35, favoriteId: 'fv-1' })
    expect(plan(schedule(), '2026-07-01T20:30:00Z')).toBeNull() // 21:30 IST: closed
    expect(plan(schedule(), '2026-12-30T06:00:00Z')).toEqual({ action: 'open', windowOnAt: '2026-12-30T06:00:00.000Z', volume: 35, favoriteId: 'fv-1' })
  })

  it('the Sonos health check and its labels', () => {
    const s = schedule({ last_state: { at: '2026-03-29T00:30:00.000Z', playback_state: 'PLAYBACK_STATE_PLAYING' } })
    expect(scheduleHealth(s, Date.parse('2026-03-29T00:30:00Z'), D)).toStrictEqual({ tone: 'green', label: 'Playing', detail: 'Last acted Sun, 29 Mar, 00:30 (Sonos reports playing).' })
    expect(scheduleHealth(s, Date.parse('2026-03-29T01:30:00Z'), D)).toMatchObject({ tone: 'grey', label: 'Last acted Sun, 29 Mar, 00:30' })
    expect(scheduleHealth(s, Date.parse('2026-03-29T22:20:00Z'), D)).toStrictEqual({ tone: 'amber', label: 'Window just opened', detail: 'Opened at Sun, 29 Mar, 23:15 — waiting for the per-minute cron to apply it.' })
    expect(scheduleHealth(s, Date.parse('2026-03-29T22:30:00Z'), D)).toMatchObject({ tone: 'red', detail: expect.stringContaining('opened at Sun, 29 Mar, 23:15') })
    expect(scheduleHealth(s, Date.parse('2026-10-25T01:00:00Z'), D)).toMatchObject({ tone: 'red', detail: expect.stringContaining('opened at Sat, 24 Oct, 22:00') })
    expect(scheduleHealth(s, Date.parse('2026-07-01T12:00:00Z'), D)).toMatchObject({ tone: 'red', detail: expect.stringContaining('opened at Wed, 01 Jul, 06:00') })
    expect(fmtScheduleTime(Date.parse('2026-03-29T00:59:00Z'), D)).toBe('Sun, 29 Mar, 00:59')
    expect(fmtScheduleTime(Date.parse('2026-03-29T01:00:00Z'), D)).toBe('Sun, 29 Mar, 02:00')
    expect(fmtScheduleTime('2026-10-25T00:30:00Z', D)).toBe('Sun, 25 Oct, 01:30') // IST
    expect(fmtScheduleTime('2026-10-25T01:30:00Z', D)).toBe('Sun, 25 Oct, 01:30') // GMT
    expect(fmtScheduleTime('2026-07-01T23:30:00Z', D)).toBe('Thu, 02 Jul, 00:30')
    expect(fmtScheduleTime('2026-12-31T23:30:00Z', D)).toBe('Thu, 31 Dec, 23:30')
    expect(fmtScheduleTime(null, D)).toBe('')
    expect(fmtScheduleTime('', D)).toBe('')
    expect(fmtScheduleTime('not a date', D)).toBe('Invalid Date')
  })

  it('"off until midnight" is the next Dublin midnight across both changes', () => {
    const mid = (at) => untilMidnightTonightIso(D, Date.parse(at))
    expect(mid('2026-03-28T23:30:00Z')).toBe('2026-03-29T00:00:00.000Z') // Sat 23:30 GMT
    expect(mid('2026-03-29T01:00:00Z')).toBe('2026-03-29T23:00:00.000Z') // Sun 02:00 IST → Mon 00:00 IST
    expect(mid('2026-03-29T23:00:00Z')).toBe('2026-03-30T23:00:00.000Z') // Mon 00:00 IST
    expect(mid('2026-10-24T22:59:00Z')).toBe('2026-10-24T23:00:00.000Z') // Sat 23:59 IST
    expect(mid('2026-10-24T23:00:00Z')).toBe('2026-10-26T00:00:00.000Z') // Sun 00:00 IST → Mon 00:00 GMT (25-hour day)
    expect(mid('2026-07-01T12:00:00Z')).toBe('2026-07-01T23:00:00.000Z')
    expect(mid('2026-12-31T23:30:00Z')).toBe('2027-01-01T00:00:00.000Z')
  })

  it('the class-climate slot key', () => {
    expect(slotKey(Date.parse('2026-03-29T00:59:00Z'), D)).toBe('Sun 00:59')
    expect(slotKey('2026-03-29T01:00:00Z', D)).toBe('Sun 02:00')
    expect(slotKey('2026-10-25T00:30:00Z', D)).toBe('Sun 01:30') // IST
    expect(slotKey('2026-10-25T01:30:00Z', D)).toBe('Sun 01:30') // GMT
    expect(slotKey('2026-07-01T23:30:00Z', D)).toBe('Thu 00:30')
    expect(slotKey('2026-12-31T23:30:00Z', D)).toBe('Thu 23:30')
    for (const v of [null, '', 'garbage', undefined]) expect(slotKey(v, D)).toBeNull()
  })

  it('the fleet alert class label stays on the platform clock', () => {
    const at = (t) => describeClass({ name: 'CONVOY', starts_at: t })
    expect(at('2026-03-29T00:59:00Z')).toBe('CONVOY 00:59')
    expect(at('2026-03-29T01:00:00Z')).toBe('CONVOY 02:00')
    expect(at('2026-10-25T00:30:00Z')).toBe('CONVOY 01:30')
    expect(at('2026-10-25T01:30:00Z')).toBe('CONVOY 01:30')
    expect(at('2026-07-01T23:30:00Z')).toBe('CONVOY 00:30')
    expect(at('2026-12-31T23:30:00Z')).toBe('CONVOY 23:30')
    expect(describeClass({ program: 'Hyrox' })).toBe('Hyrox')
  })
})

describe('TZ.10 America/New_York follows New York across DST', () => {
  const nyWin = { days: [1, 2, 3, 4, 5, 6, 7], on: '06:00', off: '22:00', volume: 30, favorite_id: 'fv' }

  it('the engine: the house windows resolve on New York\'s clock across both US DST weekends', () => {
    const SAT_SPRING = ['2026-03-08T03:00:00.000Z', '2026-03-08T06:00:00.000Z', 'fv-2'] // 22:00 EST → 02:00 EDT
    const SAT_FALL = ['2026-11-01T02:00:00.000Z', '2026-11-01T07:00:00.000Z', 'fv-2'] //  22:00 EDT → 02:00 EST
    expect(spans(resolveServeWindows(fixedDevice, '2026-03-07', [], NY))).toEqual([SAT_SPRING])
    expect(spans(resolveServeWindows(fixedDevice, '2026-03-08', [], NY))).toEqual([SAT_SPRING, ['2026-03-09T03:15:00.000Z', '2026-03-09T03:45:00.000Z', 'fv-3']])
    expect(spans(resolveServeWindows(fixedDevice, '2026-10-31', [], NY))).toEqual([SAT_FALL])
    expect(spans(resolveServeWindows(fixedDevice, '2026-11-01', [], NY))).toEqual([SAT_FALL, ['2026-11-02T04:15:00.000Z', '2026-11-02T04:45:00.000Z', 'fv-3']])
    expect(spans(resolveServeWindows(fixedDevice, '2026-07-01', [], NY))).toEqual([['2026-07-01T04:00:00.000Z', '2026-07-01T05:30:00.000Z', 'fv-4'], ['2026-07-01T10:00:00.000Z', '2026-07-02T01:30:00.000Z', 'fv-1']])
    const state = (at) => { const t = Date.parse(at); return desiredState(fixedDevice, t, dayStrIn(t, NY), [], NY) }
    expect(state('2026-03-08T03:30:00Z')).toBe('on') //  Sat 22:30 EST
    expect(state('2026-03-08T07:30:00Z')).toBe('off') // Sun 03:30 EDT
    expect(state('2026-11-01T05:30:00Z')).toBe('on') //  Sun 01:30 EDT (before the fall-back)
    expect(state('2026-11-01T12:00:00Z')).toBe('off') // Sun 07:00 EST
    expect(state('2026-07-01T04:30:00Z')).toBe('on') //  Wed 00:30 EDT
  })

  it('a 06:00–22:00 window on Sun 8 Mar 2026 (spring forward) is 10:00Z → 02:00Z', () => {
    const w = resolveDayWindows({ enabled: true, schedule_mode: 'fixed', fixed_windows: [nyWin] }, '2026-03-08', [], NY)
    expect(w.map((x) => [new Date(x.on_at).toISOString(), new Date(x.off_at).toISOString()]))
      .toEqual([['2026-03-08T10:00:00.000Z', '2026-03-09T02:00:00.000Z']])
    // The day before is still EST: 06:00 is 11:00Z.
    const sat = resolveDayWindows({ enabled: true, schedule_mode: 'fixed', fixed_windows: [nyWin] }, '2026-03-07', [], NY)
    expect(new Date(sat[0].on_at).toISOString()).toBe('2026-03-07T11:00:00.000Z')
    // Fall back: Sun 1 Nov 06:00 EST = 11:00Z; Sat 31 Oct 06:00 EDT = 10:00Z.
    const nov = resolveDayWindows({ enabled: true, schedule_mode: 'fixed', fixed_windows: [nyWin] }, '2026-11-01', [], NY)
    expect(new Date(nov[0].on_at).toISOString()).toBe('2026-11-01T11:00:00.000Z')
    const oct = resolveDayWindows({ enabled: true, schedule_mode: 'fixed', fixed_windows: [nyWin] }, '2026-10-31', [], NY)
    expect(new Date(oct[0].on_at).toISOString()).toBe('2026-10-31T10:00:00.000Z')
  })

  it('planAction opens a New York window by New York\'s clock, not Dublin\'s', () => {
    const s = schedule({ windows: [nyWin] })
    // 10:30Z Sun 8 Mar = 06:30 EDT: open in New York (Dublin would say 10:30 too, but on its own windows).
    const t = Date.parse('2026-03-08T10:30:00Z')
    expect(planAction(s, t, dayStrIn(t, NY), NY)).toMatchObject({ action: 'open', windowOnAt: Date.parse('2026-03-08T10:00:00Z') })
    // 07:30Z = 03:30 EDT: closed in New York, though 07:30 is inside 06:00–22:00 in Dublin.
    const early = Date.parse('2026-03-08T07:30:00Z')
    expect(planAction(s, early, dayStrIn(early, NY), NY)).toBeNull()
    expect(planAction(s, early, dayStrIn(early, D), D)).not.toBeNull() // 07:30 GMT in Dublin
  })

  it('a 23:15–23:45 Sunday window (the SHELLY.2 23:xx class) resolves on the right NY day', () => {
    const w = resolveDayWindows({ enabled: true, schedule_mode: 'fixed', fixed_windows: [WINDOWS[2]] }, '2026-03-08', [], NY)
    expect(w.map((x) => new Date(x.on_at).toISOString())).toEqual(['2026-03-09T03:15:00.000Z'])
    const d = resolveDayWindows({ enabled: true, schedule_mode: 'fixed', fixed_windows: [WINDOWS[2]] }, '2026-03-29', [], D)
    expect(d.map((x) => new Date(x.on_at).toISOString())).toEqual(['2026-03-29T22:15:00.000Z'])
  })

  it('the health check reads the studio\'s window, as the cron does', () => {
    const s = schedule({ windows: [nyWin], last_state: { at: '2026-03-07T00:00:00.000Z' } })
    const early = Date.parse('2026-03-08T07:30:00Z') // 03:30 EDT
    expect(scheduleHealth(s, early, NY).tone).toBe('grey')
    expect(scheduleHealth(s, early, D).tone).toBe('red') // what the Dublin-only check used to say
    const open = Date.parse('2026-03-08T10:30:00Z')
    expect(scheduleHealth(s, open, NY)).toMatchObject({ tone: 'red' })
    expect(scheduleHealth(s, open, NY).detail).toContain('Sun, 08 Mar, 06:00')
  })

  it('"off until midnight" is the NEXT New York midnight across both changes', () => {
    expect(untilMidnightTonightIso(NY, Date.parse('2026-03-08T03:00:00Z'))).toBe('2026-03-08T05:00:00.000Z') // Sat 22:00 EST → Sun 00:00 EST
    expect(untilMidnightTonightIso(NY, Date.parse('2026-03-08T12:00:00Z'))).toBe('2026-03-09T04:00:00.000Z') // Sun → Mon 00:00 EDT
    expect(untilMidnightTonightIso(NY, Date.parse('2026-11-01T12:00:00Z'))).toBe('2026-11-02T05:00:00.000Z') // Sun → Mon 00:00 EST
    expect(untilMidnightTonightIso(NY, Date.parse('2026-11-01T03:59:00Z'))).toBe('2026-11-01T04:00:00.000Z') // Sat 23:59 EDT
  })

  it('the excluded-slot key is the studio\'s weekday + wall clock, in both runners', () => {
    // 10:00Z on Sun 8 Mar is 06:00 EDT; a week earlier 11:00Z is 06:00 EST. Same weekly slot.
    expect(slotKey('2026-03-08T10:00:00Z', NY)).toBe('Sun 06:00')
    expect(slotKey('2026-03-01T11:00:00Z', NY)).toBe('Sun 06:00')
    expect(slotKey('2026-03-08T10:00:00Z', D)).toBe('Sun 10:00')
    expect(slotKey('2026-11-01T11:00:00Z', NY)).toBe('Sun 06:00')
    const occ = { glofox_event_id: 'e1', name: 'HIIT', starts_at: '2026-03-08T10:00:00Z', ends_at: '2026-03-08T10:45:00Z' }
    const nowMs = Date.parse('2026-03-08T09:50:00Z')
    const cls = { device_ids: ['d'], offset_on_min: 15, offset_off_min: 5, class_filter: [], excluded_slots: ['Sun 06:00'] }
    expect(planClassClimate({ occurrences: [occ], config: cls, nowMs, zone: NY })).toEqual([])
    expect(planClassClimate({ occurrences: [occ], config: cls, nowMs, zone: D })).toHaveLength(1)
    const bath = { device_ids: ['d'], delay_after_start_min: 0, run_duration_min: 30, class_filter: [], excluded_slots: ['Sun 06:00'] }
    const later = Date.parse('2026-03-08T10:05:00Z')
    expect(planBathroomClimate({ occurrences: [occ], config: bath, nowMs: later, zone: NY })).toEqual([])
    expect(planBathroomClimate({ occurrences: [occ], config: bath, nowMs: later, zone: D })).toHaveLength(1)
  })

  it('no excluded slots: the planners need no zone at all', () => {
    const occ = { glofox_event_id: 'e1', name: 'HIIT', starts_at: '2026-03-08T10:00:00Z', ends_at: '2026-03-08T10:45:00Z' }
    const cls = { device_ids: ['d'], offset_on_min: 15, offset_off_min: 5, class_filter: [], excluded_slots: [] }
    expect(planClassClimate({ occurrences: [occ], config: cls, nowMs: Date.parse('2026-03-08T09:50:00Z') })).toHaveLength(1)
  })
})

// ── the reconcile cron, end to end with fakes ─────────────────────────────
const groupsBody = {
  groups: [{ id: 'GRP_A', name: 'Studio', playbackState: 'PLAYBACK_STATE_IDLE', playerIds: ['RINCON_1', 'RINCON_2'] }],
  players: [{ id: 'RINCON_1', name: 'Floor' }, { id: 'RINCON_2', name: 'Lobby' }],
}
function makeDb(schedules, { zones = {}, zoneError = null } = {}) {
  const updates = []
  const zoneReads = []
  return {
    updates,
    zoneReads,
    from(table) {
      if (table === 'sonos_schedules') {
        return {
          select: () => ({ eq: () => ({ limit: async () => ({ data: schedules, error: null }) }) }),
          update(patch) { return { eq: async (_c, id) => { updates.push({ id, patch }); return { error: null } } } },
        }
      }
      if (table === 'locations') {
        return {
          select: () => ({
            in: (_c, ids) => ({
              order: async () => {
                zoneReads.push(ids)
                if (zoneError) return { data: null, error: zoneError }
                return { data: ids.filter((id) => id in zones).map((id) => ({ id, timezone: zones[id] })), error: null }
              },
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}
const deps = (nowMs, over = {}) => ({
  now: () => nowMs,
  getConfig: () => ({ clientId: 'a', clientSecret: 'b', redirectUri: 'https://x/cb' }),
  getToken: vi.fn(async () => ({ ok: true, token: 'tok', householdId: 'HH1' })),
  getGroups: vi.fn(async () => ({ ok: true, statusCode: 200, body: groupsBody })),
  setVolume: vi.fn(async () => ({ ok: true, statusCode: 200 })),
  loadFavorite: vi.fn(async () => ({ ok: true, statusCode: 200 })),
  pause: vi.fn(async () => ({ ok: true, statusCode: 200 })),
  ...over,
})

describe('TZ.10 runSonosReconcile acts per location zone', () => {
  beforeEach(() => { resetLocationZoneCache(); logWarn.mockClear() })

  // Sat 7 Mar 2026 22:30 EST = Sun 8 Mar 03:30 GMT. A Saturday-only evening
  // window is open in New York and is not Dublin's day at all.
  const t = Date.parse('2026-03-08T03:30:00Z')
  const satEvening = { days: [6], on: '20:00', off: '23:00', volume: 40, favorite_id: 'fv-sat' }

  it('one tick: New York opens on its own Saturday; Dublin, on its Sunday, does nothing', async () => {
    const ny = schedule({ id: 'ny', location_id: 'loc-ny', player_ids: ['RINCON_1'], windows: [satEvening] })
    const dub = schedule({ id: 'dub', location_id: 'loc-dub', player_ids: ['RINCON_2'], windows: [satEvening] })
    const db = makeDb([ny, dub], { zones: { 'loc-ny': NY, 'loc-dub': D } })
    const d = deps(t)
    const out = await runSonosReconcile(db, d)
    expect(out).toMatchObject({ ok: true, applied: 1, failed: 0 })
    expect(db.updates).toHaveLength(1)
    expect(db.updates[0]).toMatchObject({ id: 'ny', patch: { last_applied: { window_on_at: Date.parse('2026-03-08T01:00:00Z'), action: 'open' } } })
    expect(d.loadFavorite).toHaveBeenCalledWith('tok', 'GRP_A', 'fv-sat')
    // The zones were read ONCE for the whole tick, before the loop.
    expect(db.zoneReads).toEqual([['loc-ny', 'loc-dub']])
  })

  it('the Dublin day (Sunday) would not have opened the Saturday window', () => {
    const ny = schedule({ windows: [satEvening] })
    expect(planAction(ny, t, dayStrIn(t, D), D)).toBeNull()
  })

  it('a Dublin studio opens on Dublin\'s clock', async () => {
    const mon = Date.parse('2026-08-24T05:00:00Z') // Mon 06:00 IST
    const s = schedule({ location_id: 'loc-dub', windows: [WINDOWS[0]] })
    const db = makeDb([s], { zones: { 'loc-dub': D } })
    await runSonosReconcile(db, deps(mon))
    expect(db.updates[0].patch.last_applied).toMatchObject({ window_on_at: mon, action: 'open' })
    expect(planAction(s, mon, dayStrIn(mon, D), D)).toMatchObject({ action: 'open', windowOnAt: mon })
  })

  it('a failed timezone read skips every location this tick, logged, with NO device call', async () => {
    const ny = schedule({ id: 'ny', location_id: 'loc-ny', windows: [satEvening] })
    const db = makeDb([ny], { zoneError: { message: 'connection reset' } })
    const d = deps(t)
    const out = await runSonosReconcile(db, d)
    expect(out).toMatchObject({ ok: true, applied: 0, failed: 0, zoneUnreadable: 1 })
    expect(d.getToken).not.toHaveBeenCalled()
    expect(d.getGroups).not.toHaveBeenCalled()
    expect(d.setVolume).not.toHaveBeenCalled()
    expect(d.loadFavorite).not.toHaveBeenCalled()
    expect(d.pause).not.toHaveBeenCalled()
    expect(db.updates).toEqual([])
    expect(logWarn).toHaveBeenCalledWith('sonos-reconcile', expect.stringMatching(/timezone/), expect.objectContaining({ locationId: 'loc-ny' }))
  })

  it('a failed read is not cached: the next tick reads again and acts', async () => {
    const ny = schedule({ id: 'ny', location_id: 'loc-ny', windows: [satEvening] })
    await runSonosReconcile(makeDb([ny], { zoneError: { message: 'down' } }), deps(t))
    const db = makeDb([ny], { zones: { 'loc-ny': NY } })
    const out = await runSonosReconcile(db, deps(t))
    expect(out).toMatchObject({ applied: 1 })
    expect(out.zoneUnreadable).toBeUndefined()
  })

  it('an open window is closed on the zone it was opened in', async () => {
    const after = Date.parse('2026-03-08T04:30:00Z') // 23:30 EST Sat: the 20:00–23:00 window has ended
    const ny = schedule({ id: 'ny', location_id: 'loc-ny', windows: [satEvening], last_applied: { window_on_at: Date.parse('2026-03-08T01:00:00Z'), action: 'open' } })
    const db = makeDb([ny], { zones: { 'loc-ny': NY } })
    const d = deps(after)
    await runSonosReconcile(db, d)
    expect(d.pause).toHaveBeenCalledWith('tok', 'GRP_A')
    expect(db.updates[0].patch.last_applied).toMatchObject({ action: 'close' })
  })
})
