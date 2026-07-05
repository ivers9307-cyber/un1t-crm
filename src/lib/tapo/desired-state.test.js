import { describe, it, expect } from 'vitest'
import { resolveDayWindows, desiredState } from './desired-state.js'

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
