import { describe, it, expect } from 'vitest'
import { resolveDayWindows, resolveServeWindows, desiredState } from './desired-state.js'

// All instants are UTC ISO; Dublin is UTC+1 on these July dates (IST).
const DAY = '2026-07-06' // a Monday
const T = (hhmm) => new Date(`${DAY}T${hhmm}:00+01:00`).getTime() // Dublin wall-clock → ms

const fixedDevice = {
  enabled: true, schedule_mode: 'fixed',
  fixed_windows: [{ days: [1, 2, 3, 4, 5], on: '07:00', off: '21:30' }],
  class_rule: {}, override: null,
}
const classDevice = {
  enabled: true, schedule_mode: 'class',
  fixed_windows: [], class_rule: { lead_min: 15, lag_min: 10 }, override: null,
}
const occ = (on, off, cancelled = false) => ({
  starts_at: new Date(`${DAY}T${on}:00+01:00`).toISOString(),
  ends_at: new Date(`${DAY}T${off}:00+01:00`).toISOString(),
  cancelled_at: cancelled ? new Date().toISOString() : null,
})

describe('resolveDayWindows — fixed', () => {
  it('weekday window resolves to concrete on/off ms', () => {
    const w = resolveDayWindows(fixedDevice, DAY, [])
    expect(w).toHaveLength(1)
    expect(w[0].on_at).toBe(T('07:00'))
    expect(w[0].off_at).toBe(T('21:30'))
  })
  it('day not in days → no windows', () => {
    const sunday = { ...fixedDevice, fixed_windows: [{ days: [7], on: '09:00', off: '17:00' }] }
    expect(resolveDayWindows(sunday, DAY, [])).toEqual([]) // 2026-07-06 is Monday
  })
  it('overnight window (off < on) spans midnight into next day', () => {
    const night = { ...fixedDevice, fixed_windows: [{ days: [1], on: '22:00', off: '02:00' }] }
    const w = resolveDayWindows(night, DAY, [])
    expect(w[0].on_at).toBe(T('22:00'))
    expect(w[0].off_at).toBe(T('22:00') + 4 * 3600 * 1000) // 02:00 next day
  })
})

describe('resolveDayWindows — class', () => {
  it('lead/lag around first and last non-cancelled occurrence', () => {
    const w = resolveDayWindows(classDevice, DAY, [occ('06:00', '06:45'), occ('18:30', '19:15')])
    expect(w).toHaveLength(1)
    expect(w[0].on_at).toBe(T('06:00') - 15 * 60 * 1000)
    expect(w[0].off_at).toBe(T('19:15') + 10 * 60 * 1000)
  })
  it('cancelled occurrences are ignored', () => {
    const w = resolveDayWindows(classDevice, DAY, [occ('06:00', '06:45', true), occ('10:00', '10:45')])
    expect(w[0].on_at).toBe(T('10:00') - 15 * 60 * 1000)
  })
  it('no occurrences → no windows', () => {
    expect(resolveDayWindows(classDevice, DAY, [])).toEqual([])
  })
  it('missing lead/lag default to 15/10', () => {
    const bare = { ...classDevice, class_rule: {} }
    const w = resolveDayWindows(bare, DAY, [occ('09:00', '09:45')])
    expect(w[0].on_at).toBe(T('09:00') - 15 * 60 * 1000)
    expect(w[0].off_at).toBe(T('09:45') + 10 * 60 * 1000)
  })
})

describe('resolveDayWindows — DST transitions', () => {
  // Spring-forward: Dublin skips 01:00→02:00 on 2026-03-29 (Sunday). A window
  // boundary after 01:00 must NOT be a flat offset from midnight (that resolves
  // one hour late). Each HH:MM is resolved against its own Dublin wall-clock.
  it('spring-forward: fixed window boundaries hold Dublin wall-clock', () => {
    const dev = {
      enabled: true, schedule_mode: 'fixed',
      fixed_windows: [{ days: [7], on: '07:00', off: '21:30' }],
      class_rule: {}, override: null,
    }
    const w = resolveDayWindows(dev, '2026-03-29', [])
    expect(w).toHaveLength(1)
    // Dublin is IST (UTC+1) after the 01:00→02:00 jump, so 07:00 local = 06:00Z.
    expect(w[0].on_at).toBe(Date.parse('2026-03-29T07:00:00+01:00'))
    expect(w[0].off_at).toBe(Date.parse('2026-03-29T21:30:00+01:00'))
  })

  // Overnight window that straddles the spring-forward jump: Sat 22:00 → Sun 02:00.
  // Saturday 22:00 is still GMT (UTC+0); Sunday 02:00 is IST (UTC+1). That's only
  // 3 real hours, NOT 4 — a flat +24h/+DAY_MS offset would be wrong.
  it('overnight across spring-forward is 3 real hours, not 4', () => {
    const dev = {
      enabled: true, schedule_mode: 'fixed',
      fixed_windows: [{ days: [6], on: '22:00', off: '02:00' }],
      class_rule: {}, override: null,
    }
    const w = resolveDayWindows(dev, '2026-03-28', []) // Saturday
    expect(w).toHaveLength(1)
    expect(w[0].on_at).toBe(Date.parse('2026-03-28T22:00:00+00:00'))
    expect(w[0].off_at).toBe(Date.parse('2026-03-29T02:00:00+01:00'))
    expect(w[0].off_at - w[0].on_at).toBe(3 * 3600 * 1000)
  })

  // Fall-back: Dublin repeats 01:00→02:00 on 2026-10-25. 01:30 is ambiguous.
  // The single guess-and-correct pass resolves it deterministically to the
  // SECOND occurrence (01:30 GMT / UTC+0), which is fine — a deterministic
  // nearby instant is all we require. 05:00 is unambiguous (GMT after fall-back).
  it('fall-back: ambiguous boundary resolves deterministically', () => {
    const dev = {
      enabled: true, schedule_mode: 'fixed',
      fixed_windows: [{ days: [7], on: '01:30', off: '05:00' }],
      class_rule: {}, override: null,
    }
    const w = resolveDayWindows(dev, '2026-10-25', []) // Sunday
    expect(w).toHaveLength(1)
    expect(w[0].off_at).toBe(Date.parse('2026-10-25T05:00:00+00:00'))
    // Our implementation lands on the SECOND 01:30 (the +00:00 occurrence).
    expect(w[0].on_at).toBe(Date.parse('2026-10-25T01:30:00+00:00'))
  })
})

describe('overnight fixed windows survive midnight (serve set)', () => {
  // Operator window Sat 22:00–02:00 (days:[6]) is day-attributed to Saturday.
  // After midnight the serving date is Sunday, whose own windows are empty —
  // the engine must still honour Saturday's live tail or the device is cut
  // off at 00:00 (both live via desiredState and offline via the bridge's
  // resolved_windows). 2026-07-11 is a Saturday, 2026-07-12 a Sunday (IST).
  const SUN = '2026-07-12'
  const night = {
    enabled: true, schedule_mode: 'fixed',
    fixed_windows: [{ days: [6], on: '22:00', off: '02:00' }],
    class_rule: {}, override: null,
  }
  it("desiredState honours yesterday's overnight tail after midnight", () => {
    const at0030 = Date.parse('2026-07-12T00:30:00+01:00')
    expect(desiredState(night, at0030, SUN, [])).toBe('on')  // inside the Sat tail
    const at0230 = Date.parse('2026-07-12T02:30:00+01:00')
    expect(desiredState(night, at0230, SUN, [])).toBe('off') // tail ended 02:00
  })
  it("resolveServeWindows includes Saturday's tail when serving Sunday", () => {
    const w = resolveServeWindows(night, SUN, [])
    expect(w).toHaveLength(1)
    expect(w[0].on_at).toBe(Date.parse('2026-07-11T22:00:00+01:00'))
    expect(w[0].off_at).toBe(Date.parse('2026-07-12T02:00:00+01:00'))
    // Day-attributed semantics of resolveDayWindows are unchanged:
    expect(resolveDayWindows(night, SUN, [])).toEqual([])
  })
})

describe('desiredState', () => {
  it('inside a window → on; outside → off', () => {
    expect(desiredState(fixedDevice, T('12:00'), DAY, [])).toBe('on')
    expect(desiredState(fixedDevice, T('23:00'), DAY, [])).toBe('off')
  })
  it('mode none / disabled → null (unmanaged)', () => {
    expect(desiredState({ ...fixedDevice, schedule_mode: 'none' }, T('12:00'), DAY, [])).toBe(null)
    expect(desiredState({ ...fixedDevice, enabled: false }, T('12:00'), DAY, [])).toBe(null)
  })
  it('active override wins; expired override falls back to schedule', () => {
    const until = new Date(T('13:00')).toISOString()
    const dev = { ...fixedDevice, override: { state: 'off', until, set_by: 'u1' } }
    expect(desiredState(dev, T('12:30'), DAY, [])).toBe('off') // override beats in-window 'on'
    expect(desiredState(dev, T('13:30'), DAY, [])).toBe('on')  // expired → schedule resumes
  })
  it('override works on a mode-none device (manual toggle before any schedule exists)', () => {
    const until = new Date(T('23:59')).toISOString()
    const dev = { enabled: true, schedule_mode: 'none', fixed_windows: [], class_rule: {}, override: { state: 'on', until, set_by: 'u1' } }
    expect(desiredState(dev, T('12:00'), DAY, [])).toBe('on')   // override drives it
    const later = new Date(T('13:00')).getTime()
    expect(desiredState({ ...dev, override: { ...dev.override, until: new Date(T('12:30')).toISOString() } }, later, DAY, [])).toBe(null) // expired → back to unmanaged
  })
  it('never throws on malformed config', () => {
    expect(desiredState({ enabled: true, schedule_mode: 'fixed', fixed_windows: null }, T('12:00'), DAY, [])).toBe('off')
    expect(desiredState(null, T('12:00'), DAY, [])).toBe(null)
  })
})

describe('resolveDayWindows source passthrough', () => {
  it('carries the originating window so callers can read its payload', () => {
    const device = {
      enabled: true,
      schedule_mode: 'fixed',
      fixed_windows: [
        { days: [1, 2, 3, 4, 5], on: '06:00', off: '21:30', volume: 35, favorite_id: 'fv-1' },
      ],
    }
    // 2026-08-24 is a Monday.
    const windows = resolveDayWindows(device, '2026-08-24')
    expect(windows).toHaveLength(1)
    expect(windows[0].source.volume).toBe(35)
    expect(windows[0].source.favorite_id).toBe('fv-1')
  })

  it('keeps carrying the source through the yesterday-tail path', () => {
    const device = {
      enabled: true,
      schedule_mode: 'fixed',
      // Saturday 22:00 -> Sunday 02:00. 2026-08-22 is a Saturday (ISO dow 6).
      fixed_windows: [{ days: [6], on: '22:00', off: '02:00', volume: 20, favorite_id: 'fv-late' }],
    }
    const windows = resolveServeWindows(device, '2026-08-23') // Sunday
    expect(windows).toHaveLength(1)
    expect(windows[0].source.favorite_id).toBe('fv-late')
  })
})
