import { describe, it, expect } from 'vitest'
import { planDeviceAction, overrideKey, windowKey, isLiveOverride } from './plan'

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

// Sequences, not single ticks. Each rule reads simply on its own; what a relay
// actually DOES is the composition, and these are the compositions that decide
// whether a room is lit.
describe('planDeviceAction — sequences and edges', () => {
  it('touching windows hand over cleanly: exactly one on at the seam, never an off', () => {
    const two = dev({
      fixed_windows: [
        { days: [1, 2, 3, 4, 5], on: '07:00', off: '12:00' },
        { days: [1, 2, 3, 4, 5], on: '12:00', off: '21:30' },
      ],
      last_applied: { key: W, action: 'on' },
    })
    // 12:00 is the first window's off_at (exclusive) and the second's on_at
    // (inclusive), so the seam is served by the later window, not by a close.
    expect(plan(two, '12:00')).toEqual({ action: 'on', reason: 'window_open', key: 'w:' + T('12:00') })
  })

  it('overlapping windows: earliest wins, and the handover re-issues one idempotent on', () => {
    const overlap = dev({
      fixed_windows: [
        { days: [1, 2, 3, 4, 5], on: '07:00', off: '14:00' },
        { days: [1, 2, 3, 4, 5], on: '12:00', off: '21:30' },
      ],
    })
    // Inside both, .find() over the on_at-sorted list keeps the earlier one.
    expect(plan(overlap, '13:00')).toMatchObject({ action: 'on', key: W })
    // When the earlier one ends the key changes, so a redundant `on` is
    // re-issued under the later key — harmless for a relay, and the reason
    // this planner can do what the Sonos one could not.
    expect(plan(dev({ ...overlap, last_applied: { key: W, action: 'on' } }), '14:00'))
      .toEqual({ action: 'on', reason: 'window_open', key: 'w:' + T('12:00') })
  })

  it('disabling mid-window leaves the relay as it is — rule 2 returns before rule 4 can close', () => {
    expect(plan(dev({ enabled: false, last_applied: { key: W, action: 'on' } }), '12:00')).toBe(null)
    expect(plan(dev({ enabled: false, last_applied: { key: W, action: 'on' } }), '22:00')).toBe(null)
    expect(plan(dev({ schedule_mode: 'none', last_applied: { key: W, action: 'on' } }), '22:00')).toBe(null)
  })

  it('an expired override closes once, then the next day opens and settles', () => {
    const o = ov('on', '2026-07-06T23:00:00.000Z')          // expires at local midnight
    const K = overrideKey(o)
    const TUE = '2026-07-07'
    const tick = (last_applied, hhmm, day) =>
      planDeviceAction({ ...base, override: o, last_applied }, T(hhmm, day), day, [], 'Europe/Dublin')

    // 00:01 Tuesday: the override has expired and no window is open, so the one
    // `on` we are responsible for is undone — once, tagged as the override.
    expect(tick({ key: K, action: 'on' }, '00:01', TUE))
      .toEqual({ action: 'off', reason: 'override_expired', key: K })
    // Stamped with that close, the morning window still opens on its own key.
    const open = tick({ key: K, action: 'off' }, '07:00', TUE)
    expect(open).toEqual({ action: 'on', reason: 'window_open', key: 'w:' + T('07:00', TUE) })
    // And having opened it, the next tick inside the same window is quiet.
    expect(tick({ key: open.key, action: 'on' }, '07:01', TUE)).toBe(null)
  })

  it('an off override beats a live CLASS window (rule 1 precedes the schedule)', () => {
    const o = ov('off', '2026-07-06T23:00:00.000Z')
    const cls = dev({ schedule_mode: 'class', fixed_windows: [], override: o })
    const occ = [{ starts_at: new Date(T('12:00')).toISOString(), ends_at: new Date(T('13:00')).toISOString() }]
    expect(planDeviceAction(cls, T('12:15'), DAY, occ, 'Europe/Dublin'))
      .toEqual({ action: 'off', reason: 'override', key: overrideKey(o) })
  })

  it('an off override spanning the window close swallows it — and fires no second off later', () => {
    const o = ov('off', '2026-07-06T21:00:00.000Z')          // 22:00 local, after the 21:30 close
    const d = dev({ override: o, last_applied: { key: overrideKey(o), action: 'off' } })
    expect(plan(d, '21:30')).toBe(null)                       // already off: no window_close
    expect(plan(d, '22:01')).toBe(null)                       // expired, but we never turned it ON
  })

  it('a hostile class_rule never throws', () => {
    const cls = dev({ schedule_mode: 'class', fixed_windows: [], class_rule: { lead_min: {}, lag_min: 'NaN' } })
    const occ = [{ starts_at: new Date(T('12:00')).toISOString(), ends_at: new Date(T('13:00')).toISOString() }]
    expect(planDeviceAction(cls, T('12:15'), DAY, occ, 'Europe/Dublin')).toBe(null)
  })
})

// Exported because Task 8's reconcile needs it to decide whether a class-mode
// device may be skipped on an occurrence LOAD ERROR (a live override must still
// be applied), and PR 2's toggle route needs it to answer "is one in force?".
// Both must agree with the planner exactly, so there is one predicate.
describe('isLiveOverride', () => {
  const NOW = T('12:00')
  const LIVE = new Date(NOW + 3600_000).toISOString()

  it('is true only for a recognised state with a parseable, future until', () => {
    expect(isLiveOverride({ state: 'on', until: LIVE }, NOW)).toBe(true)
    expect(isLiveOverride({ state: 'off', until: LIVE }, NOW)).toBe(true)
  })

  it('is false for an unrecognised state, an undatable until, an expired until, or no override', () => {
    for (const state of ['ON', 'on ', 'toggle', true, 1, '', null, undefined]) {
      expect(isLiveOverride({ state, until: LIVE }, NOW)).toBe(false)
    }
    for (const until of ['soon', null, '', {}, 0, String(Date.parse(LIVE))]) {
      expect(isLiveOverride({ state: 'on', until }, NOW)).toBe(false)
    }
    expect(isLiveOverride({ state: 'on', until: new Date(NOW).toISOString() }, NOW)).toBe(false) // until === now is over
    expect(isLiveOverride(null, NOW)).toBe(false)
    expect(isLiveOverride(undefined, NOW)).toBe(false)
    expect(isLiveOverride('on', NOW)).toBe(false)
    expect(isLiveOverride({ state: 'on', until: LIVE }, NaN)).toBe(false)
  })

  it('is the predicate planDeviceAction itself uses, for every shape', () => {
    for (const state of ['on', 'off', 'ON', 'toggle', true, null]) {
      for (const until of [LIVE, 'soon', null, new Date(NOW - 1).toISOString()]) {
        const o = { state, until, set_at: 's1' }
        const acted = planDeviceAction(dev({ override: o }), NOW, DAY, [], 'Europe/Dublin')?.reason === 'override'
        expect(acted).toBe(isLiveOverride(o, NOW))
      }
    }
  })
})
