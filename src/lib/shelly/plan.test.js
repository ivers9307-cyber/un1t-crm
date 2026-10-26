import { describe, it, expect } from 'vitest'
import {
  planDeviceAction, overrideKey, windowKey, isLiveOverride,
  safetyCap, isManagedTarget, SAFETY_MARGIN_MS, CAP_REARM_SLACK_MS,
} from './plan'

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
// Timers on by default in this file (SHELLYTIMERS.5's switch); the
// 'switched off' describe below pins the default-off answers.
const TIMERS = { timers: true }
const plan = (d, hhmm, opts) => planDeviceAction(d, T(hhmm), DAY, [], 'Europe/Dublin', { ...TIMERS, ...opts })
const iso = (ms) => new Date(ms).toISOString()
// The 07:00–21:30 window's safety cap: 21:30 + 30 min = 22:00 local.
const CAP = iso(T('22:00'))
// What the planner answers at 12:00 inside that window: 10 h to the cap.
const OPEN_NOON = { action: 'on', reason: 'window_open', key: W, toggleAfterSec: 36_000, capAt: CAP }

describe('planDeviceAction — windows', () => {
  it('1. first tick inside the window opens it', () => {
    expect(plan(dev(), '07:00')).toEqual({ action: 'on', reason: 'window_open', key: W, toggleAfterSec: 54_000, capAt: CAP })
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
    // Armed at until + 30 min (23:30Z), 4.5 h after 20:00 local.
    expect(plan(d, '20:00')).toEqual({
      action: 'on', reason: 'override', key: overrideKey(d.override), toggleAfterSec: 16_200, capAt: '2026-07-06T23:30:00.000Z',
    })
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
      expect(plan(dev(ovBad(state)), '12:00')).toEqual(OPEN_NOON)
      expect(plan(dev({ ...ovBad(state), enabled: false }), '12:00')).toBe(null)
    })
  }

  // An override we cannot date has not been shown to be live, and a relay is
  // not switched on a guess. Falling through to the schedule is the only
  // reading that cannot act on a value we failed to understand.
  for (const until of ['soon', null, '', String(Date.parse(LIVE)), {}, 0]) {
    it(`an override whose until is ${JSON.stringify(until)} is not live`, () => {
      expect(plan(dev({ override: { state: 'off', until, set_at: 's1' } }), '12:00'))
        .toEqual(OPEN_NOON)
    })
  }

  it('a null options argument does not throw (a default only covers undefined)', () => {
    // null options = timers off: the plain pre-timer answer.
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
    expect(plan(dev({ last_applied: { key: W, action: 'on' } }), '12:00', { force: true }))
      .toEqual({ ...OPEN_NOON, reason: 'run_now' })
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
    expect(plan(two, '12:00')).toEqual({ ...OPEN_NOON, key: 'w:' + T('12:00') })
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
      .toEqual({ action: 'on', reason: 'window_open', key: 'w:' + T('12:00'), toggleAfterSec: 28_800, capAt: CAP })
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
      planDeviceAction({ ...base, override: o, last_applied }, T(hhmm, day), day, [], 'Europe/Dublin', TIMERS)

    // 00:01 Tuesday: the override has expired and no window is open, so the one
    // `on` we are responsible for is undone — once, tagged as the override.
    expect(tick({ key: K, action: 'on' }, '00:01', TUE))
      .toEqual({ action: 'off', reason: 'override_expired', key: K })
    // Stamped with that close, the morning window still opens on its own key.
    const open = tick({ key: K, action: 'off' }, '07:00', TUE)
    expect(open).toEqual({
      action: 'on', reason: 'window_open', key: 'w:' + T('07:00', TUE), toggleAfterSec: 54_000, capAt: iso(T('22:00', TUE)),
    })
    // And having opened it (stamped with its cap), the next tick is quiet.
    expect(tick({ key: open.key, action: 'on', cap_at: open.capAt }, '07:01', TUE)).toBe(null)
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

// SHELLYTIMERS.2 — the device-side safety cap. Pure maths on instants, so the
// whole file runs identically under TZ=Europe/Dublin and TZ=America/New_York
// (CI runs both); the location zone is always passed explicitly.
describe('safetyCap', () => {
  const NOW = Date.parse('2026-07-06T11:00:00.000Z')
  it('rounds the cap UP to the minute and counts whole seconds from now', () => {
    expect(safetyCap(NOW + 90 * 60_000, NOW)).toEqual({ toggleAfterSec: 5400, capAt: '2026-07-06T12:30:00.000Z' })
    // 12:30:20 → 12:31:00: never earlier than wanted.
    expect(safetyCap(NOW + 90 * 60_000 + 20_000, NOW)).toEqual({ toggleAfterSec: 5460, capAt: '2026-07-06T12:31:00.000Z' })
  })
  it('a now that is not on a second boundary still yields a whole-second timer at or after the cap', () => {
    const now = NOW + 400
    const c = safetyCap(NOW + 60 * 60_000, now)
    expect(Number.isInteger(c.toggleAfterSec)).toBe(true)
    expect(Date.parse(c.capAt)).toBeGreaterThanOrEqual(NOW + 60 * 60_000)
  })
  it('nothing to arm for a cap that is not in the future, or an unusable instant', () => {
    for (const [cap, now] of [[NOW, NOW], [NOW - 1, NOW], [NaN, NOW], [NOW + 1, NaN], [Infinity, NOW]]) {
      expect(safetyCap(cap, now)).toBe(null)
    }
  })
  it('margin and slack are the ruled values', () => {
    expect(SAFETY_MARGIN_MS).toBe(30 * 60_000)
    expect(CAP_REARM_SLACK_MS).toBe(60_000)
  })
})

describe('isManagedTarget', () => {
  it('is enabled AND a schedule that is not none', () => {
    expect(isManagedTarget(dev())).toBe(true)
    expect(isManagedTarget(dev({ schedule_mode: 'class' }))).toBe(true)
    expect(isManagedTarget(dev({ enabled: false }))).toBe(false)
    expect(isManagedTarget(dev({ schedule_mode: 'none' }))).toBe(false)
    expect(isManagedTarget(null)).toBe(false)
  })
})

describe('planDeviceAction — safety cap (SHELLYTIMERS.2)', () => {
  const until = '2026-07-06T23:00:00.000Z' // local midnight
  const stamped = (extra = {}) => ({ key: W, action: 'on', reason: 'window_open', at: 'x', cap_at: CAP, ...extra })
  const longer = (off) => ({ fixed_windows: [{ days: [1, 2, 3, 4, 5], on: '07:00', off }] })

  it('an armed window is quiet while its cap still covers it', () => {
    expect(plan(dev({ last_applied: stamped() }), '12:00', { relayOn: true })).toBe(null)
  })

  it('the window GREW (off 21:30 → 23:00): re-sent on with the later cap, tagged cap_extend', () => {
    expect(plan(dev({ ...longer('23:00'), last_applied: stamped() }), '12:00', { relayOn: true }))
      .toEqual({ action: 'on', reason: 'cap_extend', key: W, toggleAfterSec: 41_400, capAt: iso(T('23:30')) })
  })

  it('a growth of exactly the slack is not worth a request; one minute more is', () => {
    // 21:31 → cap 22:01, exactly 60 s past the armed 22:00.
    expect(plan(dev({ ...longer('21:31'), last_applied: stamped() }), '12:00', { relayOn: true })).toBe(null)
    expect(plan(dev({ ...longer('21:32'), last_applied: stamped() }), '12:00', { relayOn: true }))
      .toMatchObject({ action: 'on', reason: 'cap_extend', capAt: iso(T('22:02')) })
  })

  it('a SHRINKING window is never re-sent — the cron closes it, the later timer is harmless', () => {
    expect(plan(dev({ ...longer('20:00'), last_applied: stamped() }), '12:00', { relayOn: true })).toBe(null)
  })

  it('a re-arm never undoes a human: a relay read OFF, or not read at all, is left alone', () => {
    const d = dev({ ...longer('23:00'), last_applied: stamped() })
    for (const relayOn of [false, null, undefined, 'on', 1]) {
      expect(plan(d, '12:00', { relayOn })).toBe(null)
    }
  })

  it('once the armed cap has PASSED inside a live window, an UNREAD (or on) relay is re-opened', () => {
    // Armed for 12:00 (say the window was 07:00–11:30 when it opened), now
    // 12:05 and the window runs to 21:30.
    const d = dev({ last_applied: stamped({ cap_at: iso(T('12:00')) }) })
    for (const relayOn of [true, null, undefined]) {
      expect(plan(d, '12:05', { relayOn })).toEqual({
        action: 'on', reason: 'cap_extend', key: W, toggleAfterSec: 35_700, capAt: CAP,
      })
    }
  })

  it('…but a relay READ as off after the cap passed stays off: a human off always wins', () => {
    const d = dev({ last_applied: stamped({ cap_at: iso(T('12:00')) }) })
    expect(plan(d, '12:05', { relayOn: false })).toBe(null)
  })

  it('LEGACY: a stamp with no cap_at is re-armed ONCE (relay on), and the re-stamped row is then quiet', () => {
    const legacy = dev({ last_applied: { key: W, action: 'on', reason: 'window_open', at: 'x' } })
    const p = plan(legacy, '12:00', { relayOn: true })
    expect(p).toEqual({ ...OPEN_NOON, reason: 'cap_extend' })
    const restamped = dev({ last_applied: { key: p.key, action: p.action, reason: p.reason, at: 'y', cap_at: p.capAt } })
    expect(plan(restamped, '12:01', { relayOn: true })).toBe(null)
    // …and a legacy row whose relay reads off (or unread) is never touched.
    expect(plan(legacy, '12:00', { relayOn: false })).toBe(null)
    expect(plan(legacy, '12:00')).toBe(null)
  })

  it('LEGACY: an unreadable cap_at reads as "not armed", never as a crash', () => {
    for (const cap_at of ['soon', 42, {}, null, '', ['x'], true]) {
      expect(plan(dev({ last_applied: stamped({ cap_at }) }), '12:00', { relayOn: true }))
        .toEqual({ ...OPEN_NOON, reason: 'cap_extend' })
      expect(plan(dev({ last_applied: stamped({ cap_at }) }), '12:00')).toBe(null)
    }
  })

  it('a live ON override on a managed target is armed at until + 30 min, and quiet once stamped with it', () => {
    const o = ov('on', until)
    const first = plan(dev({ override: o }), '20:00')
    expect(first).toMatchObject({ action: 'on', reason: 'override', toggleAfterSec: 16_200, capAt: '2026-07-06T23:30:00.000Z' })
    const d = dev({ override: o, last_applied: { key: overrideKey(o), action: 'on', reason: 'override', at: 'x', cap_at: first.capAt } })
    expect(plan(d, '20:01', { relayOn: true })).toBe(null)
    // A press stamped before timers existed is re-armed once, like a window.
    const legacy = dev({ override: o, last_applied: { key: overrideKey(o), action: 'on' } })
    expect(plan(legacy, '20:00', { relayOn: true })).toMatchObject({ action: 'on', reason: 'cap_extend', key: overrideKey(o) })
  })

  it('UNMANAGED targets never get a timer — not on a press, not as a re-arm (the "stays until changed" promise)', () => {
    const o = ov('on', until)
    for (const over of [{ enabled: false }, { schedule_mode: 'none', fixed_windows: [] }]) {
      const p = plan(dev({ ...over, override: o }), '20:00')
      expect(p).toEqual({ action: 'on', reason: 'override', key: overrideKey(o) })
      expect(plan(dev({ ...over, override: o, last_applied: { key: overrideKey(o), action: 'on' } }), '20:00', { relayOn: true })).toBe(null)
      expect(plan(dev({ ...over, override: o }), '20:00', { force: true })).toEqual({ action: 'on', reason: 'run_now', key: overrideKey(o) })
    }
  })

  it('an OFF never carries a timer: off override, window close, override expiry, run-now off', () => {
    const offOv = ov('off', until)
    expect(plan(dev({ override: offOv }), '20:00')).toEqual({ action: 'off', reason: 'override', key: overrideKey(offOv) })
    expect(plan(dev({ last_applied: stamped() }), '21:30')).toEqual({ action: 'off', reason: 'window_close', key: W })
    expect(Object.keys(plan(dev(), '22:00', { force: true }))).toEqual(['action', 'reason', 'key'])
    const onOv = ov('on', until)
    expect(planDeviceAction(dev({ override: onOv, last_applied: { key: overrideKey(onOv), action: 'on' } }), Date.parse(until) + 60_000, '2026-07-07', [], 'Europe/Dublin', TIMERS))
      .toEqual({ action: 'off', reason: 'override_expired', key: overrideKey(onOv) })
  })

  it('force (run-now) always arms, even over a cap that still covers the window', () => {
    expect(plan(dev({ last_applied: stamped() }), '12:00', { force: true })).toEqual({ ...OPEN_NOON, reason: 'run_now' })
  })

  it('a cap_extend stamp still closes at the window end (it is an on, keyed on the window)', () => {
    expect(plan(dev({ last_applied: stamped({ reason: 'cap_extend' }) }), '21:30')).toEqual({ action: 'off', reason: 'window_close', key: W })
  })

  it('class mode: the cap is the class window end (class end + lag) + 30 min', () => {
    const cls = dev({ schedule_mode: 'class', fixed_windows: [], class_rule: { lead_min: 15, lag_min: 10 } })
    const occ = [{ starts_at: iso(T('12:00')), ends_at: iso(T('13:00')) }]
    // Window 11:45–13:10, cap 13:40; at 12:15 that is 85 min.
    expect(planDeviceAction(cls, T('12:15'), DAY, occ, 'Europe/Dublin', TIMERS))
      .toEqual({ action: 'on', reason: 'window_open', key: 'w:' + T('11:45'), toggleAfterSec: 5100, capAt: iso(T('13:40')) })
    // A class added after it: the joined window now ends 14:10, so it re-arms to 14:40.
    const more = [...occ, { starts_at: iso(T('13:15')), ends_at: iso(T('14:00')) }]
    const d = { ...cls, last_applied: { key: 'w:' + T('11:45'), action: 'on', cap_at: iso(T('13:40')) } }
    expect(planDeviceAction(d, T('12:15'), DAY, more, 'Europe/Dublin', { ...TIMERS, relayOn: true }))
      .toMatchObject({ action: 'on', reason: 'cap_extend', capAt: iso(T('14:40')) })
  })

  it('DST: an overnight tail across the Dublin fall-back counts REAL seconds, not wall-clock ones', () => {
    // Sat 24 Oct 22:00 → Sun 25 Oct 02:00 local. Clocks go back at 02:00 IST,
    // so 00:30 IST (23:30Z Sat) to 02:30 GMT (02:30Z) is THREE hours, not two.
    const night = dev({ fixed_windows: [{ days: [6], on: '22:00', off: '02:00' }] })
    const now = Date.parse('2026-10-24T23:30:00.000Z')
    expect(planDeviceAction(night, now, '2026-10-25', [], 'Europe/Dublin', TIMERS))
      .toMatchObject({ action: 'on', toggleAfterSec: 10_800, capAt: '2026-10-25T02:30:00.000Z' })
  })

  it('a location in New York: the cap follows THAT zone\'s off time', () => {
    const ny = dev()
    const now = Date.parse('2026-07-06T16:00:00.000Z') // 12:00 EDT
    // 21:30 EDT = 01:30Z next day; + 30 min = 02:00Z.
    expect(planDeviceAction(ny, now, DAY, [], 'America/New_York', TIMERS))
      .toMatchObject({ action: 'on', reason: 'window_open', toggleAfterSec: 36_000, capAt: '2026-07-07T02:00:00.000Z' })
  })
})

// SHELLYTIMERS.5 — the per-studio switch. Off (the default, and any value but
// an explicit true) must be byte-identical to the planner before timers: no
// toggleAfterSec/capAt, and never a cap_extend re-send.
describe('planDeviceAction — safety timers switched OFF (the default)', () => {
  const off = (d, hhmm, opts) => planDeviceAction(d, T(hhmm), DAY, [], 'Europe/Dublin', opts)
  const until = '2026-07-06T23:00:00.000Z'
  for (const opts of [undefined, null, {}, { timers: false }, { timers: 'true' }, { timers: 1 }]) {
    it(`options ${JSON.stringify(opts)}: plain answers, no timer, no re-arm`, () => {
      expect(off(dev(), '07:00', opts)).toEqual({ action: 'on', reason: 'window_open', key: W })
      const o = ov('on', until)
      expect(off(dev({ override: o }), '20:00', opts)).toEqual({ action: 'on', reason: 'override', key: overrideKey(o) })
      expect(off(dev({ last_applied: { key: W, action: 'on' } }), '12:00', { ...opts, relayOn: true })).toBe(null)
      // A window that grew past an old cap, a cap that has passed: still quiet.
      const grown = dev({ fixed_windows: [{ days: [1, 2, 3, 4, 5], on: '07:00', off: '23:00' }], last_applied: { key: W, action: 'on', cap_at: iso(T('11:00')) } })
      expect(off(grown, '12:00', { ...opts, relayOn: true })).toBe(null)
      expect(off(dev(), '12:00', { ...opts, force: true })).toEqual({ action: 'on', reason: 'run_now', key: W })
    })
  }
})
