import { describe, it, expect } from 'vitest'
import { planDeviceAction, overrideKey, windowKey } from './plan'

const DAY = '2026-07-06' // Monday, Dublin IST (+01:00)
const T = (hhmm, day = DAY) => Date.parse(`${day}T${hhmm}:00+01:00`)
const W = 'w:' + T('07:00')

const base = {
  enabled: true, schedule_mode: 'fixed',
  fixed_windows: [{ days: [1, 2, 3, 4, 5], on: '07:00', off: '21:30' }],
  class_rule: {}, override: null, last_applied: null,
}
const dev = (over = {}) => ({ ...base, ...over })
const ov = (state, until, set_at = '2026-07-06T19:00:00.000Z') => ({ state, until, set_at, set_by: 'u1' })
const plan = (d, hhmm, opts) => planDeviceAction(d, T(hhmm), DAY, [], 'Europe/Dublin', opts)

describe('planDeviceAction — windows', () => {
  it('1. first tick inside the window opens it', () => {
    expect(plan(dev(), '07:00')).toEqual({ action: 'on', reason: 'window_open', key: W })
  })
  it('2. a missed boundary tick self-heals', () => {
    expect(plan(dev(), '07:07')).toMatchObject({ action: 'on', key: W })
  })
  it('3. a human who switched off mid-window is left alone', () => {
    expect(plan(dev({ last_applied: { key: W, action: 'on' } }), '12:00')).toBe(null)
  })
  it('4. the window closes once', () => {
    expect(plan(dev({ last_applied: { key: W, action: 'on' } }), '21:30')).toEqual({ action: 'off', reason: 'window_close', key: W })
  })
  it('5. no double close', () => {
    expect(plan(dev({ last_applied: { key: W, action: 'off' } }), '21:35')).toBe(null)
  })
  it('6. never closes what we did not open (CRM down all day)', () => {
    expect(plan(dev(), '21:35')).toBe(null)
  })
  it('7. re-opens after its own close when the window is still active (differs from Sonos)', () => {
    expect(plan(dev({ last_applied: { key: W, action: 'off' } }), '12:00')).toMatchObject({ action: 'on', key: W })
  })
  it('14. serves the Sat 22:00–02:00 overnight tail at 00:30 Sunday', () => {
    const night = dev({ fixed_windows: [{ days: [6], on: '22:00', off: '02:00' }] })
    const sunday = '2026-07-12'
    const p = planDeviceAction(night, T('00:30', sunday), sunday, [], 'Europe/Dublin')
    expect(p).toMatchObject({ action: 'on', key: 'w:' + T('22:00', '2026-07-11') })
  })
  it('19. a numeric last_applied key never matches (string keys only)', () => {
    expect(plan(dev({ last_applied: { key: T('07:00'), action: 'on' } }), '12:00')).toMatchObject({ action: 'on' })
  })
  it('21. class mode with no occurrences closes — which is why the reconcile skips class devices on a LOAD ERROR', () => {
    const cls = dev({ schedule_mode: 'class', fixed_windows: [], last_applied: { key: 'w:1', action: 'on' } })
    expect(plan(cls, '12:00')).toMatchObject({ action: 'off', reason: 'window_close' })
  })
})

describe('planDeviceAction — overrides', () => {
  const until = '2026-07-06T23:00:00.000Z' // local midnight
  it('8. a live override wins and is keyed on set_at', () => {
    const d = dev({ override: ov('on', until), last_applied: { key: W, action: 'on' } })
    expect(plan(d, '20:00')).toEqual({ action: 'on', reason: 'override', key: overrideKey(d.override) })
  })
  it('9. a live override beats the window close', () => {
    const d = dev({ override: ov('on', until), last_applied: { key: overrideKey(ov('on', until)), action: 'on' } })
    expect(plan(d, '21:30')).toBe(null)
  })
  it('10. an expired ON override outside every window fires one off tagged override_expired', () => {
    const o = ov('on', until)
    const d = dev({ override: o, last_applied: { key: overrideKey(o), action: 'on' } })
    expect(planDeviceAction(d, Date.parse(until) + 60_000, '2026-07-07', [], 'Europe/Dublin'))
      .toEqual({ action: 'off', reason: 'override_expired', key: overrideKey(o) })
  })
  it('11. an expired OFF override does nothing', () => {
    const o = ov('off', until)
    const d = dev({ override: o, last_applied: { key: overrideKey(o), action: 'off' } })
    expect(planDeviceAction(d, Date.parse(until) + 60_000, '2026-07-07', [], 'Europe/Dublin')).toBe(null)
  })
  it('12. an override that never applied (device offline) still lets the window close at midnight', () => {
    const d = dev({ override: ov('on', until), last_applied: { key: W, action: 'on' } })
    expect(planDeviceAction(d, Date.parse(until) + 60_000, '2026-07-07', [], 'Europe/Dublin'))
      .toEqual({ action: 'off', reason: 'window_close', key: W })
  })
  it('13. back inside the window after an OFF override expires → on', () => {
    const o = ov('off', '2026-07-06T13:00:00.000Z', '2026-07-06T11:00:00.000Z')
    const d = dev({ override: o, last_applied: { key: overrideKey(o), action: 'off' } })
    expect(plan(d, '14:00')).toMatchObject({ action: 'on', reason: 'window_open', key: W })
  })
  it('15. mode none: applied once, then never touched, even after expiry', () => {
    const o = ov('on', until)
    const d = dev({ schedule_mode: 'none', fixed_windows: [], override: o })
    expect(plan(d, '20:00')).toMatchObject({ action: 'on', reason: 'override' })
    expect(plan({ ...d, last_applied: { key: overrideKey(o), action: 'on' } }, '20:01')).toBe(null)
    expect(planDeviceAction({ ...d, last_applied: { key: overrideKey(o), action: 'on' } }, Date.parse(until) + 60_000, '2026-07-07', [], 'Europe/Dublin')).toBe(null)
  })
  it('16. exactly once per set_at', () => {
    const o = ov('off', until)
    expect(plan(dev({ override: o, last_applied: { key: overrideKey(o), action: 'off' } }), '20:00')).toBe(null)
  })
  it('20. a DISABLED device still gets its override (a manual action is not the schedule)', () => {
    expect(plan(dev({ enabled: false, override: ov('off', until) }), '20:00')).toMatchObject({ action: 'off', reason: 'override' })
    expect(plan(dev({ enabled: false }), '12:00')).toBe(null)
  })
  it('falls back to until+state when set_at is missing', () => {
    expect(overrideKey({ state: 'on', until })).toBe(`ov:${until}:on`)
    expect(windowKey({ on_at: 5 })).toBe('w:5')
  })
})

// A device row is jsonb: every one of these shapes can reach the planner from
// the database, and a planner that throws takes the whole location's tick with
// it. Probed exhaustively (62 shapes, identical under both host zones); these
// pin the answers that are decisions rather than accidents.
describe('planDeviceAction — hostile rows', () => {
  const LIVE = '2026-07-06T23:00:00.000Z'
  const ovBad = (state) => ({ override: { state, until: LIVE, set_at: 's1' } })

  // The dangerous half of the ternary the engine's desiredState uses: with
  // `x === 'on' ? 'on' : 'off'`, a casing typo, a stray space or a jsonb
  // BOOLEAN true — which plainly means ON — all cut the power instead.
  // An unrecognised state is therefore not a live override at all: the
  // device follows its schedule, which is defined behaviour, and the
  // corrupt row is visible in the next tick's window action rather than
  // silently inverted into a physical off.
  for (const state of ['ON', 'On', 'on ', 'toggle', true, 1, '', null]) {
    it(`an unrecognised override state (${JSON.stringify(state)}) is not a live override`, () => {
      expect(plan(dev(ovBad(state)), '12:00')).toEqual({ action: 'on', reason: 'window_open', key: W })
      expect(plan(dev({ ...ovBad(state), enabled: false }), '12:00')).toBe(null)
    })
  }

  // An override we cannot date has not been shown to be live, and a relay is
  // not switched on a guess. Falling through to the schedule is the only
  // reading that cannot act on a value we failed to understand.
  for (const until of ['soon', null, '', String(Date.parse(LIVE)), {}, 0]) {
    it(`an override whose until is ${JSON.stringify(until)} is not live`, () => {
      expect(plan(dev({ override: { state: 'off', until, set_at: 's1' } }), '12:00'))
        .toEqual({ action: 'on', reason: 'window_open', key: W })
    })
  }

  it('a null options argument does not throw (a default only covers undefined)', () => {
    expect(planDeviceAction(dev(), T('12:00'), DAY, [], 'Europe/Dublin', null))
      .toEqual({ action: 'on', reason: 'window_open', key: W })
  })

  it('a non-object last_applied is ignored, never dereferenced', () => {
    for (const la of ['w:1', 42, ['w:1', 'on'], true]) {
      expect(plan(dev({ last_applied: la }), '12:00')).toMatchObject({ action: 'on', key: W })
      expect(plan(dev({ last_applied: la }), '22:00')).toBe(null)
    }
  })

  it('a last_applied whose key is not a string never closes (nothing to close against)', () => {
    for (const key of [null, {}, T('07:00')]) {
      expect(plan(dev({ last_applied: { key, action: 'on' } }), '22:00')).toBe(null)
    }
  })

  it('survives a junk device row: null, a string, junk windows, junk occurrences', () => {
    expect(planDeviceAction(null, T('12:00'), DAY, [], 'Europe/Dublin')).toBe(null)
    expect(planDeviceAction('a device', T('12:00'), DAY, [], 'Europe/Dublin')).toBe(null)
    for (const fixed_windows of [null, 'x', [null], [{ days: [1], on: '25:99', off: 'x' }], [{ days: 1, on: '07:00', off: '21:30' }]]) {
      expect(plan(dev({ fixed_windows }), '12:00')).toBe(null)
    }
    for (const occ of [null, [null, {}], [{ starts_at: 'x', ends_at: 'y' }]]) {
      expect(planDeviceAction(dev({ schedule_mode: 'class' }), T('12:00'), DAY, occ, 'Europe/Dublin')).toBe(null)
    }
  })

  // The engine's documented contract: a non-empty invalid zone THROWS, and can
  // only do so on a path that resolves a wall-clock. Pinned here because the
  // reconcile relies on it — resolveTz at the edge is the ONLY thing between a
  // typo'd locations.timezone and a studio silently running on Dublin time.
  it('a garbage tz throws for fixed mode only — override, disabled, none and class answer', () => {
    expect(() => planDeviceAction(dev(), T('12:00'), DAY, [], 'Europe/Dubln')).toThrow(RangeError)
    expect(planDeviceAction(dev({ override: ov('on', '2026-07-06T23:00:00.000Z') }), T('12:00'), DAY, [], 'Europe/Dubln'))
      .toMatchObject({ action: 'on', reason: 'override' })
    expect(planDeviceAction(dev({ enabled: false }), T('12:00'), DAY, [], 'Europe/Dubln')).toBe(null)
    expect(planDeviceAction(dev({ schedule_mode: 'none' }), T('12:00'), DAY, [], 'Europe/Dubln')).toBe(null)
    expect(planDeviceAction(dev({ schedule_mode: 'class' }), T('12:00'), DAY, [], 'Europe/Dubln')).toBe(null)
  })
})

describe('planDeviceAction — force (run-now)', () => {
  it('17. inside a window force re-applies even when already stamped, as run_now', () => {
    expect(plan(dev({ last_applied: { key: W, action: 'on' } }), '12:00', { force: true })).toEqual({ action: 'on', reason: 'run_now', key: W })
  })
  it('18. outside every window force means off with a run key, and the next plain tick is quiet', () => {
    const p = plan(dev(), '22:00', { force: true })
    expect(p).toMatchObject({ action: 'off', reason: 'run_now' })
    expect(p.key.startsWith('run:')).toBe(true)
    expect(plan(dev({ last_applied: { ...p } }), '22:01')).toBe(null)
  })
  it('force honours a live override', () => {
    const o = ov('off', '2026-07-06T23:00:00.000Z')
    expect(plan(dev({ override: o, last_applied: { key: overrideKey(o), action: 'off' } }), '20:00', { force: true }))
      .toEqual({ action: 'off', reason: 'run_now', key: overrideKey(o) })
  })
})
