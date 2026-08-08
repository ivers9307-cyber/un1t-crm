// HOMEYD.1 — pure mapper + planCommands tests. Port of the champ-bridge
// src/homey.test.js matrix (git show 4511353:src/homey.test.js), adapted
// to the `sidecar_device_id` row shape (renamed from `id`) and extended
// with the planCommands diff cases this repo's reconcile cron needs.
import { describe, it, expect } from 'vitest'
import { mapHomeyDevices, mapHomeyStates, planCommands } from './devices.js'

// Realistic slice of Homey's object-map response.
const homeyRaw = {
  'abc-1': {
    id: 'abc-1', name: 'Front TVs', class: 'socket', available: true,
    driverId: 'homey:app:com.tplink.tapo:plug',
    capabilities: ['onoff', 'measure_power'],
    capabilitiesObj: { onoff: { value: true } },
  },
  'abc-2': {
    id: 'abc-2', name: 'Bathroom light', class: 'light', available: false,
    driverId: 'homey:app:com.tplink.tapo:switch',
    capabilities: ['onoff'],
    capabilitiesObj: { onoff: { value: false } },
  },
  'abc-3': { // no onoff — must be invisible
    id: 'abc-3', name: 'Motion sensor', class: 'sensor', available: true,
    capabilities: ['alarm_motion'], capabilitiesObj: { alarm_motion: { value: false } },
  },
}

describe('mapHomeyDevices', () => {
  it('filters to onoff devices, prefixes ids, maps socket→plug else switch', () => {
    expect(mapHomeyDevices(homeyRaw)).toEqual([
      { sidecar_device_id: 'homey:abc-1', kind: 'plug', name_hint: 'Front TVs' },
      { sidecar_device_id: 'homey:abc-2', kind: 'switch', name_hint: 'Bathroom light' },
    ])
  })
  it('tolerates arrays, null, junk entries', () => {
    expect(mapHomeyDevices(Object.values(homeyRaw))).toHaveLength(2)
    expect(mapHomeyDevices(null)).toEqual([])
    expect(mapHomeyDevices({ x: null, y: 42, z: { name: 'no id' } })).toEqual([])
  })
  it('falls back to capabilitiesObj.onoff when capabilities array is absent', () => {
    const raw = { a: { id: 'a', class: 'socket', capabilitiesObj: { onoff: { value: true } } } }
    expect(mapHomeyDevices(raw)).toEqual([{ sidecar_device_id: 'homey:a', kind: 'plug' }])
  })
  it('an empty capabilities array excludes the device even if capabilitiesObj.onoff is present', () => {
    const raw = { a: { id: 'a', class: 'socket', capabilities: [], capabilitiesObj: { onoff: { value: true } } } }
    expect(mapHomeyDevices(raw)).toEqual([])
  })
  it('omits name_hint when the device has no name', () => {
    const raw = { a: { id: 'a', class: 'socket', available: true, capabilities: ['onoff'], capabilitiesObj: { onoff: { value: true } } } }
    expect(mapHomeyDevices(raw)).toEqual([{ sidecar_device_id: 'homey:a', kind: 'plug' }])
  })
})

describe('mapHomeyStates', () => {
  it('maps onoff value to on/off and available to reachable', () => {
    expect(mapHomeyStates(homeyRaw)).toEqual([
      { sidecar_device_id: 'homey:abc-1', state: 'on', reachable: true },
      { sidecar_device_id: 'homey:abc-2', state: null, reachable: false }, // unavailable → state unknown
    ])
  })
  it('non-boolean onoff value → state null (never guess)', () => {
    const raw = { a: { id: 'a', class: 'socket', available: true, capabilities: ['onoff'], capabilitiesObj: { onoff: { value: null } } } }
    expect(mapHomeyStates(raw)).toEqual([{ sidecar_device_id: 'homey:a', state: null, reachable: true }])
  })
  it('tolerates null and junk entries', () => {
    expect(mapHomeyStates(null)).toEqual([])
    expect(mapHomeyStates({ x: null, y: 42, z: { name: 'no id' } })).toEqual([])
  })
  it('an empty capabilities array excludes the device from states too (filter precedence pin)', () => {
    const raw = { a: { id: 'a', class: 'socket', available: true, capabilities: [], capabilitiesObj: { onoff: { value: true } } } }
    expect(mapHomeyStates(raw)).toEqual([])
  })
})

// planCommands fixtures — fixed offsets (+01:00 Dublin summer time) so the
// instants are exact regardless of the process TZ (the engine's own suite
// covers the TZ/DST matrix; we only need to prove pass-through here).
const DAY = '2026-07-06' // a Monday
const T = (hhmm) => new Date(`${DAY}T${hhmm}:00+01:00`).getTime()
const farFutureIso = new Date(`${DAY}T23:59:00+01:00`).toISOString()

const inWindowDevice = {
  sidecar_device_id: 'homey:abc-1', enabled: true, schedule_mode: 'fixed',
  fixed_windows: [{ days: [1, 2, 3, 4, 5], on: '07:00', off: '21:30' }],
  class_rule: {}, override: null,
}

describe('planCommands', () => {
  it('emits a command when actual state mismatches desired', () => {
    const devices = [inWindowDevice]
    const states = [{ sidecar_device_id: 'homey:abc-1', state: 'off', reachable: true }]
    expect(planCommands(devices, states, T('12:00'), DAY, [])).toEqual([
      { sidecar_device_id: 'homey:abc-1', on: true },
    ])
  })

  it('no command when actual already matches desired', () => {
    const devices = [inWindowDevice]
    const states = [{ sidecar_device_id: 'homey:abc-1', state: 'on', reachable: true }]
    expect(planCommands(devices, states, T('12:00'), DAY, [])).toEqual([])
  })

  it('no command when the device is unreachable', () => {
    const devices = [inWindowDevice]
    const states = [{ sidecar_device_id: 'homey:abc-1', state: 'off', reachable: false }]
    expect(planCommands(devices, states, T('12:00'), DAY, [])).toEqual([])
  })

  it('no command when the device is unknown to Homey (no matching state row)', () => {
    const devices = [inWindowDevice]
    expect(planCommands(devices, [], T('12:00'), DAY, [])).toEqual([])
  })

  it('no command when schedule_mode is none and there is no override (desired null)', () => {
    const devices = [{ ...inWindowDevice, schedule_mode: 'none' }]
    const states = [{ sidecar_device_id: 'homey:abc-1', state: 'off', reachable: true }]
    expect(planCommands(devices, states, T('12:00'), DAY, [])).toEqual([])
  })

  it('no command for a disabled row even though the caller is expected to have filtered it', () => {
    const devices = [{ ...inWindowDevice, enabled: false }]
    const states = [{ sidecar_device_id: 'homey:abc-1', state: 'off', reachable: true }]
    expect(planCommands(devices, states, T('12:00'), DAY, [])).toEqual([])
  })

  it('a reachable device with unknown state (null) still gets commanded toward desired (unknown ≠ skip)', () => {
    // mapHomeyStates emits state:null when the onoff value is missing/non-
    // boolean but the device IS reachable (available !== false) — distinct
    // from the unreachable case above. planCommands must not treat "unknown"
    // as "assume already correct"; null !== desired, so it commands.
    const devices = [inWindowDevice]
    const states = [{ sidecar_device_id: 'homey:abc-1', state: null, reachable: true }]
    expect(planCommands(devices, states, T('12:00'), DAY, [])).toEqual([
      { sidecar_device_id: 'homey:abc-1', on: true },
    ])
  })

  it('an active override passes through and wins over the underlying schedule', () => {
    // Fixed window says 'on' at 12:00, but an override forces 'off' — actual
    // is 'on', so planCommands must emit the override's off, not skip it.
    const overridden = {
      ...inWindowDevice,
      override: { state: 'off', until: farFutureIso, set_by: 'u1' },
    }
    const devices = [overridden]
    const states = [{ sidecar_device_id: 'homey:abc-1', state: 'on', reachable: true }]
    expect(planCommands(devices, states, T('12:00'), DAY, [])).toEqual([
      { sidecar_device_id: 'homey:abc-1', on: false },
    ])
  })
})
